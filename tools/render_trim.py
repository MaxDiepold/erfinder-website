#!/usr/bin/env python3
from pathlib import Path
import sys, base64

if len(sys.argv) != 2:
    raise SystemExit("usage: render_trim.py <upstream-dir>")

upstream = Path(sys.argv[1])
cargo = upstream / "Cargo.toml"
text = cargo.read_text()
old = '    "local-apps",\n    "pio-usb-host",'
new = '    "pio-usb-host",'
count = text.count(old)
if count != 1:
    raise RuntimeError(f"expected exactly one local-apps host feature block, got {count}")
cargo.write_text(text.replace(old, new, 1))
print("Removed local-apps from RP2040 USB Host build feature")

parts = [Path(f"web/ui_v03_{i:02d}.b64") for i in range(1, 7)]
missing = [str(p) for p in parts if not p.exists()]
if missing:
    raise RuntimeError(f"missing V0.3 UI chunks: {missing}")
encoded = "".join(p.read_text().strip() for p in parts)
html = base64.b64decode(encoded, validate=True)
out = upstream / "src" / "esp_flasher.html"
out.write_bytes(html)
print(f"Installed ESP Phone Flasher V0.3 UI: {len(html)} bytes")
