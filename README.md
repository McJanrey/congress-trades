# Congress Trades

Desktop app (Electron) + CLI for tracking U.S. House Periodic Transaction Reports.
Pulls the official House Clerk feed, filters to a watchlist, parses each PTR PDF,
and shows structured trades (ticker, type, dates, amount range) in a sortable UI.

## Setup (one time)

```bash
npm install
pip install pdfplumber
```

## Run the app

```bash
npm start            # opens the desktop app
```

Click **Refresh** to fetch the latest filings. New filings since the last run
trigger a native desktop notification. The PDF ↗ link in each row opens the
original filing in your browser.

Click **⚙ Watchlist** to edit which members to track, the year, and the lookback
window. Settings persist in `config.json`.

## CLI (optional)

```bash
npm run fetch              # new filings only
npm run fetch:all          # everything in lookback window
```

## Package as a real .exe

```bash
npm run build:win
```

Produces an NSIS installer in `dist/`. Note: end users still need Python +
pdfplumber installed for the parser to work. (Bundling Python is on the v0.5
roadmap.)

## Architecture

- **main.js** — Electron main process. Owns IPC handlers, native notifications.
- **renderer/** — UI (vanilla HTML/CSS/JS). Filters, search, member breakdown.
- **preload.cjs** — Context-isolated bridge exposing `window.api` to the renderer.
- **lib.js** — Shared core: download index, parse XML, filter, spawn Python parser.
- **fetch-trades.js** — Thin CLI on top of lib.js.
- **parse_ptr.py** — pdfplumber-based parser; emits JSON to stdout.

## Coverage

- ✅ Typed PTRs (Gottheimer, Pelosi, etc.) — fully parsed
- ❌ Scanned image PTRs (some McCaul, Khanna filings) — produce 0 trades.
  Roadmap: OCR pass via pytesseract + pdf2image.
- ❌ Senate filings — efdsearch.senate.gov needs a terms-acceptance session.
