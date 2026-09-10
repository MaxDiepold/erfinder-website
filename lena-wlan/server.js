import "dotenv/config";
import express from "express";
import helmet from "helmet";
import axios from "axios";
import https from "node:https";
import crypto from "node:crypto";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const CFG = {
  host: process.env.FRITZBOX_HOST || "45gl0wgtedkmzah3.myfritz.net",
  port: Number(process.env.FRITZBOX_PORT || 49414),
  targetIp: process.env.FRITZBOX_TARGET_IP || "192.168.178.40",
  appPin: process.env.APP_PIN || "2468",
  authSecret: process.env.APP_AUTH_SECRET || crypto.randomBytes(32).toString("hex"),
  envUser: process.env.FRITZBOX_USER || "",
  envPassword: process.env.FRITZBOX_PASSWORD || "",
  tlsVerify: String(process.env.FRITZBOX_TLS_VERIFY || "false").toLowerCase() === "true"
};

const BASE = `https://${CFG.host}:${CFG.port}`;
const agent = new https.Agent({ rejectUnauthorized: CFG.tlsVerify });
const http = axios.create({ baseURL: BASE, timeout: 15000, httpsAgent: agent, validateStatus: () => true, maxRedirects: 2 });

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function signAuth(exp) {
  const sig = crypto.createHmac("sha256", CFG.authSecret).update(String(exp)).digest("hex");
  return `${exp}.${sig}`;
}
function isAuthed(req) {
  const token = parseCookies(req).lena_auth;
  if (!token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = crypto.createHmac("sha256", CFG.authSecret).update(exp).digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch { return false; }
}
function requireAuth(req, res, next) {
  if (!isAuthed(req)) return res.status(401).json({ ok: false, error: "Nicht angemeldet." });
  next();
}

app.post("/api/login", (req, res) => {
  if (String(req.body?.pin ?? "") !== CFG.appPin) return res.status(401).json({ ok: false, error: "Falscher PIN." });
  const exp = Date.now() + 90 * 24 * 60 * 60 * 1000;
  res.setHeader("Set-Cookie", `lena_auth=${encodeURIComponent(signAuth(exp))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${90 * 24 * 60 * 60}`);
  res.json({ ok: true });
});
app.get("/api/auth", (req, res) => res.json({ ok: true, authenticated: isAuthed(req) }));

function credentialsFrom(req) {
  const user = String(req.headers["x-fritz-user"] || CFG.envUser || "");
  const password = String(req.headers["x-fritz-password"] || CFG.envPassword || "");
  if (!user || !password) throw new Error("FRITZ!Box-Zugangsdaten fehlen. Öffne Einstellungen und speichere Benutzer + Passwort auf diesem Handy.");
  return { user, password };
}
function xmlTag(xml, tag) {
  return String(xml).match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1]?.trim() ?? null;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function md5Response(challenge, password) {
  const safe = [...`${challenge}-${password}`].map(ch => ch.codePointAt(0) > 255 ? "." : ch).join("");
  return `${challenge}-${crypto.createHash("md5").update(Buffer.from(safe, "utf16le")).digest("hex")}`;
}
function pbkdf2Response(challenge, password) {
  const p = challenge.split("$");
  if (p.length !== 5 || p[0] !== "2") throw new Error("Unbekanntes FRITZ!Box-Challenge-Format.");
  const h1 = crypto.pbkdf2Sync(Buffer.from(password, "utf8"), Buffer.from(p[2], "hex"), Number(p[1]), 32, "sha256");
  const h2 = crypto.pbkdf2Sync(h1, Buffer.from(p[4], "hex"), Number(p[3]), 32, "sha256");
  return `${p[4]}$${h2.toString("hex")}`;
}

async function getSid(creds) {
  const first = await http.get("/login_sid.lua?version=2", { transformResponse: [d => d] });
  if (first.status < 200 || first.status >= 400) throw new Error(`FRITZ!Box Login-Seite HTTP ${first.status}`);
  const challenge = xmlTag(first.data, "Challenge");
  const blockTime = Number(xmlTag(first.data, "BlockTime") || 0);
  if (!challenge) throw new Error("Keine Login-Challenge von der FRITZ!Box erhalten.");
  if (blockTime > 0) await sleep(Math.min(blockTime, 60) * 1000);
  const response = challenge.startsWith("2$") ? pbkdf2Response(challenge, creds.password) : md5Response(challenge, creds.password);
  const body = new URLSearchParams({ username: creds.user, response });
  const second = await http.post("/login_sid.lua?version=2", body.toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded" }, transformResponse: [d => d] });
  const sid = xmlTag(second.data, "SID");
  if (!sid || sid === "0000000000000000") throw new Error("FRITZ!Box-Anmeldung fehlgeschlagen. Benutzer, Passwort oder Fernzugriffsrechte prüfen.");
  return sid;
}
async function dataPage(sid, page, extra = {}) {
  const body = new URLSearchParams({ xhr: "1", sid, page, ...extra });
  const r = await http.post("/data.lua", body.toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded" }, transformResponse: [d => d] });
  if (r.status < 200 || r.status >= 400) throw new Error(`FRITZ!Box data.lua HTTP ${r.status}`);
  return String(r.data);
}
function findUidInObject(value, targetIp) {
  const candidates = ["UID", "uid", "Uid", "id", "ID", "dev", "deviceId", "deviceID"];
  const walk = obj => {
    if (!obj || typeof obj !== "object") return null;
    let contains = false;
    try { contains = JSON.stringify(obj).includes(targetIp); } catch {}
    if (contains) for (const key of candidates) {
      const v = obj[key]; if (typeof v === "string" && v.length > 1) return v;
    }
    for (const x of Array.isArray(obj) ? obj : Object.values(obj)) { const f = walk(x); if (f) return f; }
    return null;
  };
  return walk(value);
}
function findUidInText(text, targetIp) {
  try { const f = findUidInObject(JSON.parse(text), targetIp); if (f) return f; } catch {}
  const escaped = targetIp.replaceAll(".", "\\.");
  const around = text.match(new RegExp(`.{0,1200}${escaped}.{0,1200}`, "s"))?.[0] || "";
  return [...around.matchAll(/\"(?:UID|uid|id|dev|deviceId)\"\s*:\s*\"([^\"]+)\"/g)][0]?.[1] || null;
}
async function getTargetUid(sid) {
  for (const [page, extra] of [["netDev", { type: "cleanup" }], ["kidLis", {}]]) {
    const raw = await dataPage(sid, page, extra);
    const uid = findUidInText(raw, CFG.targetIp);
    if (uid) return uid;
  }
  throw new Error(`Gerät ${CFG.targetIp} wurde in der FRITZ!Box-Geräteliste nicht gefunden.`);
}
async function setBlocked(blocked, creds) {
  const sid = await getSid(creds);
  const uid = await getTargetUid(sid);
  const body = new URLSearchParams({ xhr: "1", sid, page: "kidLis", toBeBlocked: uid, blocked: blocked ? "1" : "0" });
  let r = await http.post("/data.lua", body.toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded" }, transformResponse: [d => d] });
  if (r.status < 200 || r.status >= 400) {
    const fallback = new URLSearchParams({ uid, sid, toBeBlocked: blocked ? "true" : "false", xhr: "1", useajax: "1" });
    r = await http.post("/internet/kids_userlist.lua", fallback.toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded" }, transformResponse: [d => d] });
  }
  if (r.status < 200 || r.status >= 400) throw new Error(`Sperrbefehl HTTP ${r.status}`);
  return { uid, blocked };
}

let runtimeCreds = null;
let state = {
  manualOff: false,
  timerEndsAt: null,
  timerMinutes: null,
  scheduleEnabled: true,
  nightStart: "20:00",
  nightEnd: "06:00",
  days: [0,1,2,3,4,5,6],
  lastScheduleActive: null,
  lastError: null,
  lastSuccess: null
};

function berlinNow() {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const obj = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const dayMap = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
  return { day: dayMap[obj.weekday], minutes: Number(obj.hour) * 60 + Number(obj.minute) };
}
function hmToMin(v) {
  const [h,m] = String(v).split(":").map(Number);
  return h * 60 + m;
}
function nightActiveNow() {
  if (!state.scheduleEnabled || !state.days.length) return false;
  const now = berlinNow(), start = hmToMin(state.nightStart), end = hmToMin(state.nightEnd);
  if (start === end) return false;
  if (start < end) return state.days.includes(now.day) && now.minutes >= start && now.minutes < end;
  if (now.minutes >= start) return state.days.includes(now.day);
  if (now.minutes < end) return state.days.includes((now.day + 6) % 7);
  return false;
}
function remember(req) {
  const c = credentialsFrom(req);
  runtimeCreds = c;
  return c;
}
function tryRemember(req) { try { remember(req); } catch {} }
function publicState() {
  return { ok:true, ...state, nightActive:nightActiveNow(), runtimeReady:Boolean(runtimeCreds), targetIp:CFG.targetIp, host:CFG.host, port:CFG.port };
}

let schedulerBusy = false;
async function reconcileSchedule(force = false) {
  if (schedulerBusy || !runtimeCreds || state.timerEndsAt) return;
  const active = nightActiveNow();
  if (!force && state.lastScheduleActive === active) return;
  schedulerBusy = true;
  try {
    await setBlocked(active, runtimeCreds);
    state.manualOff = active;
    state.lastScheduleActive = active;
    state.lastError = null;
    state.lastSuccess = new Date().toISOString();
  } catch (e) {
    state.lastError = e instanceof Error ? e.message : String(e);
  } finally { schedulerBusy = false; }
}

app.get("/api/status", requireAuth, (req, res) => {
  const hadCreds = Boolean(runtimeCreds);
  tryRemember(req);
  if (!hadCreds && runtimeCreds) setTimeout(() => reconcileSchedule(true), 0);
  res.json(publicState());
});
app.post("/api/test", requireAuth, async (req, res) => {
  try {
    const creds = remember(req), sid = await getSid(creds), uid = await getTargetUid(sid);
    state.lastError = null; state.lastSuccess = new Date().toISOString();
    setTimeout(() => reconcileSchedule(state.lastScheduleActive === null), 0);
    res.json({ ok:true, uid, targetIp:CFG.targetIp });
  } catch (e) { state.lastError = e instanceof Error ? e.message : String(e); res.status(502).json({ ok:false, error:state.lastError }); }
});
app.post("/api/internet", requireAuth, async (req, res) => {
  const on = Boolean(req.body?.on);
  try {
    const creds = remember(req);
    await setBlocked(!on, creds);
    state.manualOff = !on;
    state.timerEndsAt = null;
    state.timerMinutes = null;
    state.lastScheduleActive = nightActiveNow();
    state.lastError = null; state.lastSuccess = new Date().toISOString();
    res.json(publicState());
  } catch (e) { state.lastError = e instanceof Error ? e.message : String(e); res.status(502).json({ ok:false, error:state.lastError }); }
});
app.post("/api/timer", requireAuth, async (req, res) => {
  const minutes = Number(req.body?.minutes);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) return res.status(400).json({ ok:false, error:"Timer muss zwischen 1 und 1440 Minuten liegen." });
  try {
    const creds = remember(req);
    await setBlocked(false, creds);
    state.manualOff = false;
    state.timerMinutes = minutes;
    state.timerEndsAt = Date.now() + minutes * 60000;
    state.lastScheduleActive = nightActiveNow();
    state.lastError = null; state.lastSuccess = new Date().toISOString();
    res.json(publicState());
  } catch (e) { state.lastError = e instanceof Error ? e.message : String(e); res.status(502).json({ ok:false, error:state.lastError }); }
});
app.post("/api/timer/stop", requireAuth, (req, res) => {
  tryRemember(req);
  state.timerEndsAt = null;
  state.timerMinutes = null;
  state.lastScheduleActive = null;
  setTimeout(() => reconcileSchedule(true), 0);
  res.json(publicState());
});
app.post("/api/schedule", requireAuth, (req, res) => {
  tryRemember(req);
  const { enabled, start, end, days } = req.body || {};
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(start))) state.nightStart = String(start);
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(end))) state.nightEnd = String(end);
  state.scheduleEnabled = Boolean(enabled);
  state.days = Array.isArray(days) ? [...new Set(days.map(Number).filter(x => Number.isInteger(x) && x >= 0 && x <= 6))] : [];
  state.lastScheduleActive = null;
  setTimeout(() => reconcileSchedule(true), 0);
  res.json(publicState());
});

setInterval(async () => {
  if (schedulerBusy || !runtimeCreds) return;
  if (state.timerEndsAt && Date.now() >= state.timerEndsAt) {
    schedulerBusy = true;
    try {
      await setBlocked(true, runtimeCreds);
      state.manualOff = true;
      state.timerEndsAt = null;
      state.timerMinutes = null;
      state.lastScheduleActive = nightActiveNow();
      state.lastError = null; state.lastSuccess = new Date().toISOString();
    } catch (e) { state.lastError = e instanceof Error ? e.message : String(e); }
    finally { schedulerBusy = false; }
    return;
  }
  await reconcileSchedule(false);
}, 5000);

app.use(express.static("public"));
app.get("*", (req, res) => res.sendFile(new URL("./public/index.html", import.meta.url).pathname));
app.listen(PORT, () => {
  console.log(`Lena WLAN läuft auf Port ${PORT}`);
  console.log(`FRITZ!Box Ziel: ${CFG.host}:${CFG.port}, Gerät ${CFG.targetIp}`);
  console.log("Zeitplan-Zeitzone: Europe/Berlin; IPv6-Egress muss beim Hoster aktiviert sein.");
});
