# ESP32-C3 ROM Flash Protocol

V0.2 verwendet den ROM Loader ohne Stub.

Kommandos:

- `0x08` SYNC
- `0x0D` SPI_ATTACH
- `0x0B` SPI_SET_PARAMS
- `0x02` FLASH_BEGIN
- `0x03` FLASH_DATA
- `0x13` SPI_FLASH_MD5
- `0x04` FLASH_END

ESP32-C3 Besonderheiten:

- ROM-Antworten enden mit 4 Statusbytes.
- FLASH_BEGIN erhält beim C3-ROM ein fünftes 32-Bit-Wort für das Verschlüsselungs-Flag; V0.2 sendet `0`.
- SPI_ATTACH erhält im C3-ROM ein zusätzliches 32-Bit-Wort `0`.
- FLASH_DATA verwendet eine XOR-Prüfsumme mit Startwert `0xEF`.
- Der letzte Datenblock wird mit `0xFF` aufgefüllt.
- Nach dem Schreiben wird der Flashbereich per SPI_FLASH_MD5 geprüft.
