# Validierung V0.2

Stand: 10.09.2026

## Erfolgreich lokal geprüft

- `tools/patch_upstream.py`: Python-Syntaxprüfung bestanden
- `web/esp-flasher.html`: JavaScript-Syntaxprüfung mit Node.js bestanden
- MD5-Testvektor `abc`: `900150983cd24fb0d6963f7d28e17f72` korrekt
- `.github/workflows/build-rp2040.yml`: YAML erfolgreich geparst
- feste Adresse: RP2040 `192.168.7.1`, iPhone-Lease `192.168.7.2`
- ESP32-C3-Protokollfluss im Browser implementiert

## Bewusst nicht als bestanden behauptet

Die exakte Hardwarekette

    iPhone → CDC-NCM → Feather RP2040 → PIO USB Host → ESP32-C3

muss nach Erhalt der Hardware praktisch getestet werden.

Der GitHub-Actions-Workflow erzeugt das UF2-Artifact in der Cloud und pinnt `ulso/pico-io-bridge` auf:

    d6bf64f9d372f17fdc293f60eeb29d5152cb9d5c
