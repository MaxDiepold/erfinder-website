# ESP Phone Flasher V0.2
## iPhone → Adafruit Feather RP2040 USB Host → ESP32-C3

### Empfehlung

Für den ersten funktionierenden Aufbau verwenden wir den **Adafruit Feather RP2040 with USB Type A Host (Product 5723)**.

Das Board besitzt bereits genau die Hardware, die unser PIO-USB-Code erwartet:

- USB-C als native RP2040-USB-Schnittstelle zum iPhone
- USB-A als fertiger PIO-USB-Host-Ausgang
- D+ auf GP16
- D- auf GP17
- schaltbare Host-Versorgung auf GP18
- 5-V-Boost-Wandler für den Host-Ausgang
- rückstellbare Sicherung

Damit entfallen USB-C-Breakout, CC-Widerstände, D+/D--Verdrahtung und eigener Load-Switch im ersten Prototyp.

### Aufbau

    iPhone
      │
      │ USB-C ↔ USB-C Datenkabel
      ▼
    Adafruit Feather RP2040 USB Host
      │
      │ USB-A → USB-C Datenkabel
      ▼
    ESP32-C3 Super Mini

### Bedienung

Nach dem Start stellt der RP2040 ein lokales USB-Netz bereit:

    http://192.168.7.1/

Die Startseite ist unser ESP Phone Flasher.

Für V0.2 wird der ESP32-C3 zunächst manuell in den ROM-Downloadmodus gebracht:

1. ESP32-C3 anschließen.
2. BOOT gedrückt halten.
3. RESET kurz drücken.
4. RESET loslassen.
5. BOOT loslassen.
6. Safari → `http://192.168.7.1/`
7. **ESP verbinden**
8. **Synchronisieren**
9. merged `.bin` auswählen
10. Offset `0x0`
11. **FLASH STARTEN**

### Firmware für den Feather ohne PC bauen

Das Projekt enthält einen GitHub-Actions-Workflow.

1. GitHub → **Actions**
2. **Build ESP Phone Flasher**
3. **Run workflow**
4. Artifact `ESP-Phone-Flasher-Feather-RP2040` herunterladen.
5. Darin liegt `ESP-Phone-Flasher-Feather-RP2040.uf2`.

### UF2 vom iPhone auf den Feather

1. Feather abziehen.
2. BOOT gedrückt halten.
3. USB-C zum iPhone verbinden bzw. RESET betätigen.
4. BOOT loslassen.
5. RP2040-BOOTSEL-Laufwerk in der Dateien-App öffnen.
6. Die `.uf2` dorthin kopieren.
7. Der Feather startet mit der neuen Firmware.

### Softwarearchitektur

    Safari
      │ HTTP / WebSocket
      ▼
    USB CDC-NCM
      │
      ▼
    RP2040
      │ PIO USB Host / CDC-ACM
      ▼
    ESP32-C3 USB Serial/JTAG
      │
      ▼
    ESP32-C3 ROM Loader

Das eigentliche Espressif-Flashprotokoll läuft in JavaScript im Browser. Dadurch muss der RP2040 keine mehrere Megabyte große Firmware zwischenspeichern.

### ESP-Protokoll V0.2

Implementiert:

- SLIP
- SYNC
- SPI_ATTACH
- SPI_SET_PARAMS
- FLASH_BEGIN
- FLASH_DATA
- FLASH_END
- XOR-Prüfsumme 0xEF
- SPI_FLASH_MD5
- lokale MD5-Prüfung
- Fortschrittsanzeige

### Empfohlenes Firmwareformat

Für einen leeren ESP32-C3 eine **merged BIN** ab `0x0` verwenden.

Typische ESP-IDF-Einzeldateien liegen bei:
- Bootloader `0x0`
- Partitionstabelle `0x8000`
- App `0x10000`

V0.2 ist bewusst auf eine merged BIN optimiert, damit die Bedienung am iPhone simpel bleibt.

### Status

Die exakte Gesamtkette muss noch auf realer Hardware getestet werden.
