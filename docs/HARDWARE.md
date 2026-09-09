# Hardware – V0.2

## Hauptplatine

**Adafruit Feather RP2040 with USB Type A Host – Product 5723**

Das Board bringt den zweiten USB-Port bereits fertig mit:

- Native USB-C → iPhone
- USB-A Host → ESP32
- USB Host D+ = GP16
- USB Host D- = GP17
- USB Host 5V Enable = GP18
- 5-V-Boost-Wandler TPS61023
- bis zu 1 A Peak am Boost-Wandler laut Hersteller
- 500-mA rückstellbare Sicherung am Host-Ausgang

## Kabel

1. iPhone → Feather: USB-C ↔ USB-C **Datenkabel**
2. Feather → ESP32-C3: USB-A ↔ USB-C **Datenkabel**

Keine reinen Ladekabel verwenden.

## Verdrahtung

Keine zusätzliche Datenverdrahtung nötig.

    iPhone USB-C
         │
         ▼
    Feather USB-C
    [RP2040]
    Feather USB-A
         │
         ▼
    ESP32-C3 USB-C

## Strom

Der Feather erzeugt für den USB-A-Host-Port die 5-V-Versorgung selbst. Trotzdem ist das gesamte System am iPhone durch dessen verfügbares USB-Strombudget begrenzt. Zunächst ohne zusätzliche Verbraucher am C3 testen.

Keine externe 5-V-Quelle parallel zum iPhone-USB-VBUS anschließen.
