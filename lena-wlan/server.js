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
  user: process.env.FRITZBOX_USER || "",
  password: process.env.FRITZBOX_PASSWORD || "",
  targetIp: process.env.FRITZBOX_TARGET_IP || "192.168.178.40",
  appPin: process.env.APP_PIN || "2468",
  authSecret: process.env.APP_AUTH_SECRET || "change-me",
  tlsVerify: String(process.env.FRITZBOX_TLS_VERIFY || "false").toLowerCase() === "true"
};

const BASE = `https://${CFG.host}:${CFG.port}`;
const agent = new https.Agent({ rejectUnauthorized: CFG.tlsVerify });
const http = axios.create({
  baseURL: BASE,
  timeout: 12000,
  httpsAgent: agent,
  validateStatus: () => true,
  maxRedirects: 2
});

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
  const payload = String(exp);
  const sig = crypto.createHmac("sha256", CFG.authSecret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function isAuthed(req) {
  const token = parseCookies(req).lena_auth;
  if (!token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = crypto.createHmac("sha256", CFG.authSecret).update(exp).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

function requireAuth(req, res, next) {
  if (!isAuthed(req)) return res.status(401).json({ ok: false, error: "Nicht angemeldet." });
  next();
}

app.post("/api/login", (req, res) => {
  if (String(req.body?.pin ?? "") !== CFG.appPin) {
    return res.status(401).json({ ok: false, error: "Falscher PIN." });
  }
  const exp = Date.now() + 90 * 24 * 60 * 60 * 1000;
  res.setHeader("Set-Cookie", `lena_auth=${encodeURIComponent(signAuth(exp))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${90 * 24 * 60 * 60}`);
  res.json({ ok: true });
});

app.get("/api/auth", (req, res) => res.json({ ok: true, authenticated: isAuthed(req) }));

function xmlTag(xml, tag) {
  return String(xml).match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1]?.trim() ?? null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function md5Response(challenge, password) {
  const safe = [...`${challenge}-${password}`].map(ch => ch.codePointAt(0) > 255 ? "." : ch).join("");
  const digest = crypto.createHash("md5").update(Buffer.from(safe, "utf16le")).digest("hex");
  return `${challenge}-${digest}`;
}

function pbkdf2Response(challenge, password) {
  const p = challenge.split("$");
  if (p.length !== 5 || p[0] !== "2") throw new Error("Unbekanntes FRITZ!Box-Challenge-Format.");
  const iter1 = Number(p[1]);
  const salt1 = Buffer.from(p[2], "hex");
  const iter2 = Number(p[3]);
  const salt2 = Buffer.from(p[4], "hex");
  const hash1 = crypto.pbkdf2Sync(Buffer.from(password, "utf8"), salt1, iter1, 32, "sha256");
  const hash2 = crypto.pbkdf2Sync(hash1, salt2, iter2, 32, "sha256");
  return `${p[4]}$${hash2.toString("hex")}`;
}

async function getSid() {
  if (!CFG.user || !CFG.password) throw new Error("FRITZ!Box-Benutzer oder Passwort fehlt.");

  const first = await http.get("/login_sid.lua?version=2", { transformResponse: [d => d] });
  if (first.status < 200 || first.status >= 400) throw new Error(`FRITZ!Box Login-Seite HTTP ${first.status}`);

  const challenge = xmlTag(first.data, "Challenge");
  const blockTime = Number(xmlTag(first.data, "BlockTime") || 0);
  if (!challenge) throw new Error("Keine Login-Challenge von der FRITZ!Box erhalten.");
  if (blockTime > 0) await sleep(Math.min(blockTime, 60) * 1000);

  const response = challenge.startsWith("2$")
    ? pbkdf2Response(challenge, CFG.password)
    : md5Response(challenge, CFG.password);

  const body = new URLSearchParams({ username: CFG.user, response });
  const second = await http.post("/login_sid.lua?version=2", body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    transformResponse: [d => d]
  });

  const sid = xmlTag(second.data, "SID");
  if (!sid || sid === "0000000000000000") {
    throw new Error("FRITZ!Box-Anmeldung fehlgeschlagen. Benutzer, Passwort oder Fernzugriffsrechte prüfen.");
  }
  return sid;
}

async function dataPage(sid, page, extra = {}) {
  const body = new URLSearchParams({ xhr: "1", sid, page, ...extra });
  const r = await http.post("/data.lua", body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    transformResponse: [d => d]
  });
  if (r.status < 200 || r.status >= 400) throw new Error(`FRITZ!Box data.lua HTTP ${r.status}`);
  return String(r.data);
}

function findUidInObject(value, targetIp) {
  const candidates = ["UID", "uid", "Uid", "id", "ID", "dev", "deviceId", "deviceID"];
  const walk = obj => {
    if (!obj || typeof obj !== "object") return null;
    let contains = false;
    try { contains = JSON.stringify(obj).includes(targetIp); } catch {}
    if (contains) {
      for (const key of candidates) {
        const v = obj[key];
        if (typeof v === "string" && v.length > 1) return v;
      }
    }
    if (Array.isArray(obj)) {
      for (const x of obj) { const f = walk(x); if (f) return f; }
    } else {
      for (const x of Object.values(obj)) { const f = walk(x); if (f) return f; }
    }
    return null;
  };
  return walk(value);
}

function findUidInText(text, targetIp) {
  let parsed;
  try { parsed = JSON.parse(text); } catch {}
  if (parsed) {
    const found = findUidInObject(parsed, targetIp);
    if (found) return found;
  }

  const escaped = targetIp.replaceAll(".", "\\.");
  const around = text.match(new RegExp(`.{0,600}${escaped}.{0,600}`, "s"))?.[0] || "";
  const matches = [...around.matchAll(/\"(?:UID|uid|id|dev|deviceId)\"\s*:\s*\"([^\"]+)\"/g)];
  return matches[0]?.[1] || null;
}

async function getTargetUid(sid) {
  for (const [page, extra] of [["netDev", { type: "cleanup" }], ["kidLis", {}]]) {
    const raw = await dataPage(sid, page, extra);
    const uid = findUidInText(raw, CFG.targetIp);
    if (uid) return uid;
  }
  throw new Error(`Gerät ${CFG.targetIp} wurde in der FRITZ!Box-Geräteliste nicht gefunden.`);
}

async function setBlocked(blocked) {
  const sid = await getSid();
  const uid = await getTargetUid(sid);

  const body = new URLSearchParams({
    xhr: "1",
    sid,
    page: "kidLis",
    toBeBlocked: uid,
    blocked: blocked ? "1" : "0"
  });

  let r = await http.post("/data.lua", body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    transformResponse: [d => d]
  });

  if (r.status < 200 || r.status >= 400) {
    const fallback = new URLSearchParams({
      uid,
      sid,
      toBeBlocked: blocked ? "true" : "false",
      xhr: "1",
      useajax: "1"
    });
    r = await http.post("/internet/kids_userlist.lua", fallback.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      transformResponse: [d => d]
    });
  }

  if (r.status < 200 || r.status >= 400) throw new Error(`Sperrbefehl HTTP ${r.status}`);
  return { uid, blocked };
}

let state = {
  manualOff: false,
  timerEndsAt: null,
  timerMinutes: null,
  scheduleEnabled: true,
  nightStart: "20:00",
  nightEnd: "06:00",
  days: [0,1,2,3,4,5,6],
  lastError: null,
  lastSuccess: null
};

function publicState() {
  return {
    ok: true,
    ...state,
    targetIp: CFG.targetIp,
    host: CFG.host,
    port: CFG.port
  };
}

app.get("/api/status", requireAuth, (req, res) => res.json(publicState()));

app.post("/api/test", requireAuth, async (req, res) => {
  try {
    const sid = await getSid();
    const uid = await getTargetUid(sid);
    state.lastError = null;
    state.lastSuccess = new Date().toISOString();
    res.json({ ok: true, uid, targetIp: CFG.targetIp });
  } catch (e) {
    state.lastError = e instanceof Error ? e.message : String(e);
    res.status(502).json({ ok: false, error: state.lastError });
  }
});

app.post("/api/internet", requireAuth, async (req, res) => {
  const on = Boolean(req.body?.on);
  try {
    await setBlocked(!on);
    state.manualOff = !on;
    state.timerEndsAt = null;
    state.timerMinutes = null;
    state.lastError = null;
    state.lastSuccess = new Date().toISOString();
    res.json(publicState());
  } catch (e) {
    state.lastError = e instanceof Error ? e.message : String(e);
    res.status(502).json({ ok: false, error: state.lastError });
  }
});

app.post("/api/timer", requireAuth, async (req, res) => {
  const minutes = Number(req.body?.minutes);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
    return res.status(400).json({ ok: false, error: "Timer muss zwischen 1 und 1440 Minuten liegen." });
  }
  try {
    await setBlocked(false);
    state.manualOff = false;
    state.timerMinutes = minutes;
    state.timerEndsAt = Date.now() + minutes * 60000;
    state.lastError = null;
    res.json(publicState());
  } catch (e) {
    state.lastError = e instanceof Error ? e.message : String(e);
    res.status(502).json({ ok: false, error: state.lastError });
  }
});

app.post("/api/timer/stop", requireAuth, (req, res) => {
  state.timerEndsAt = null;
  state.timerMinutes = null;
  res.json(publicState());
});

app.post("/api/schedule", requireAuth, (req, res) => {
  const { enabled, start, end, days } = req.body || {};
  if (/^\d\d:\d\d$/.test(String(start))) state.nightStart = String(start);
  if (/^\d\d:\d\d$/.test(String(end))) state.nightEnd = String(end);
  state.scheduleEnabled = Boolean(enabled);
  state.days = Array.isArray(days) ? [...new Set(days.map(Number).filter(x => Number.isInteger(x) && x >= 0 && x <= 6))] : [];
  res.json(publicState());
});

let timerBusy = false;
setInterval(async () => {
  if (timerBusy || !state.timerEndsAt || Date.now() < state.timerEndsAt) return;
  timerBusy = true;
  try {
    await setBlocked(true);
    state.manualOff = true;
    state.timerEndsAt = null;
    state.timerMinutes = null;
    state.lastError = null;
    state.lastSuccess = new Date().toISOString();
  } catch (e) {
    state.lastError = e instanceof Error ? e.message : String(e);
  } finally {
    timerBusy = false;
  }
}, 5000);

app.use(express.static("public"));
app.get("*", (req, res) => res.sendFile(new URL("./public/index.html", import.meta.url).pathname));

app.listen(PORT, () => {
  console.log(`Lena WLAN läuft auf Port ${PORT}`);
  console.log(`FRITZ!Box Ziel: ${CFG.host}:${CFG.port}, Gerät ${CFG.targetIp}`);
  (async () => {
    try {
      const sid = await getSid();
      const uid = await getTargetUid(sid);
      console.log(`FRITZ!Box Verbindung OK, Geräte-UID: ${uid}`);
    } catch (e) {
      console.error(`FRITZ!Box Starttest fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    }
  })();
});
