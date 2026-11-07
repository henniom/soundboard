# Soundboard

Eine Web-App fürs iPhone: Sounds aufnehmen oder als Datei importieren und per Tastendruck abspielen.

**Live:** https://henniom.github.io/soundboard/

## Funktionen

- 🎙️ Sounds direkt mit dem Mikrofon aufnehmen (max. 2 Minuten) oder Audiodateien importieren
- 🔘 Beliebig viele Tasten mit eigenem Namen, Emoji und Farbe
- ▶️ Ein neuer Sound stoppt den vorherigen; nochmal tippen stoppt
- ✏️ Bearbeiten-Modus mit Drag & Drop zum Sortieren (⠿-Griff)
- 💾 Backup als JSON-Datei exportieren und importieren
- 📴 Offline nutzbar (Service Worker), installierbar als App

## Auf dem iPhone installieren

1. https://henniom.github.io/soundboard/ in **Safari** öffnen
2. Auf **Teilen** tippen → **Zum Home-Bildschirm**
3. Die App vom Home-Bildschirm starten

> **Wichtig:** Die Sounds werden nur lokal auf dem Gerät gespeichert. Die Home-Bildschirm-App und Safari haben getrennte Speicher. Mach regelmäßig ein Backup (⋯ → Backup exportieren → „In Dateien sichern“).

## Technik

Reines HTML/CSS/JavaScript ohne Build-Schritt und ohne Abhängigkeiten.

| Datei | Zweck |
|---|---|
| `index.html` | Aufbau der Oberfläche |
| `style.css` | Design (dunkel, große Kacheln) |
| `app.js` | Logik: Aufnahme (MediaRecorder), Wiedergabe (Web Audio API), Speicher (IndexedDB), Backup, Drag & Drop |
| `sw.js` | Service Worker für Offline-Betrieb |
| `manifest.webmanifest`, `icons/` | App-Installation |

Änderungen werden nach einem Push automatisch über GitHub Pages veröffentlicht. Auf dem iPhone erscheinen sie spätestens beim zweiten Öffnen der App.
