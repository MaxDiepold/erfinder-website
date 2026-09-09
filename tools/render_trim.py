#!/usr/bin/env python3
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("usage: render_trim.py <upstream-dir>")

cargo = Path(sys.argv[1]) / "Cargo.toml"
text = cargo.read_text()
old = '    "local-apps",\n    "pio-usb-host",'
new = '    "pio-usb-host",'
count = text.count(old)
if count != 1:
    raise RuntimeError(f"expected exactly one local-apps host feature block, got {count}")
cargo.write_text(text.replace(old, new, 1))
print("Removed local-apps from RP2040 USB Host build feature")
