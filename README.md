# Mac Sensor Dashboard

Dashboard locale per macOS che mostra i principali dati e sensori del tuo Mac.

Il progetto ora puo` girare in due modalita`:

- web locale
- app desktop Electron con packaging `.app`

## Funzioni

- CPU (user/system/idle + load average)
- RAM (usata/libera/compressa)
- Batteria (carica, cicli, salute, voltaggio, amperaggio, temperatura)
- Stato termico da `pmset`
- Rete (IP, MAC, traffico totale + velocita download/upload)
- Dischi (utilizzo per mountpoint)
- Processi top per CPU

## Installazione

```bash
npm install
```

## Avvio Web

```bash
npm run start:web
```

Poi apri:

- `http://localhost:3492`

## Avvio Desktop

```bash
npm start
```

## Build `.app` macOS

Per generare una build macOS unpacked con bundle `.app`:

```bash
npm run build:app
```

Per una build macOS pacchettizzata:

```bash
npm run build:mac
```

## Note

- Alcuni sensori hardware avanzati su macOS non sono esposti senza strumenti aggiuntivi o privilegi elevati.
- La dashboard usa solo comandi di sistema standard (es. `pmset`, `ioreg`, `system_profiler`, `vm_stat`, `netstat`, `ps`).
- Le metriche `powermetrics` restano opzionali: per averle serve eseguire l'app o il server con privilegi adeguati.
