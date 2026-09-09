# Entwicklungsstatus V0.2

## Änderung gegenüber dem RP2040-Zero-Entwurf

Der Waveshare RP2040-Zero wird für den ersten Aufbau nicht verwendet.

Grund: Das gepinnte PIO-USB-Backend des Basisprojekts ist für den Host-Port fest auf GP16/GP17 ausgelegt. Beim RP2040-Zero hängt die RGB-LED an GP16. Statt Backend und Hardware unnötig umzubauen, verwenden wir das Board, für das dieser Host-Pfad bereits vorgesehen ist: **Adafruit Feather RP2040 USB Host**.

## Auf Hardware zu prüfen

1. iPhone erkennt CDC-NCM zuverlässig.
2. Safari erreicht 192.168.7.1.
3. Feather enumeriert den ESP32-C3 USB Serial/JTAG als CDC-ACM.
4. ROM SYNC läuft stabil.
5. vollständiges Flashen einer merged BIN.
6. MD5 stimmt überein.
7. C3 startet nach FLASH_END korrekt.

## Danach V0.3

- automatische ESP-Erkennung
- Chip-ID / Security-Info anzeigen
- BOOT/RESET-Automatik
- mehrere BIN-Segmente
- serieller Monitor
