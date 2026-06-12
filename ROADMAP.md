# Roadmap

**Now:** v0.3.0 — desktop app, House 2025–2026 + Senate (supplemental), conviction-scored
picks, TFSA tracker with buy sizing, self-updating via GitHub releases.

**North star:** prove the signal works with my own money, then ship it as a public product.

---

## v0.4 — Data completeness

- [ ] **OCR for scanned PTRs** (pytesseract + pdf2image) — McCaul, Khanna, DelBene and
      other paper filers currently parse to 0 transactions. Closes the same-day gap that
      kadoa only backfills days later.
- [ ] **Drop the Python dependency** — port the PTR parser to JS (pdf-parse / pdf.js) or
      bundle a standalone binary. Blocks sharing the installer with anyone else.
- [ ] **Senate eFD direct scraper** — handle the terms-acceptance session at
      efdsearch.senate.gov. Currently Senate data arrives only via the kadoa mirror with
      a multi-day lag.
- [ ] Deeper House backfill (2023–2024) once OCR is in — older years are scan-heavy.

## v0.5 — Signal quality (the moat)

- [ ] **Backtest the picks score** — replay 2024–2025 trades against price history and
      measure whether the score actually predicts excess returns. Tune weights with data,
      not vibes. *Do this before scaling real money.*
- [ ] **Committee relevance** — flag trades where the member's committee oversees the
      stock's sector (Armed Services → defense, Energy → oil). Rosters are in the
      unitedstates/congress-legislators dataset. This is the "geopolitics" signal in
      data form.
- [ ] **Sell alerts for held positions** — if anyone in Congress sells a ticker that's in
      My TFSA, banner + notification immediately. Exit signal matters more than entry.
- [ ] Late-filer weighting — discount members who chronically file near the 45-day limit;
      their disclosures are stale by definition.
- [ ] Options flow as conviction signal — a member buying calls is a stronger bet than
      stock; currently options are excluded entirely.

## v0.6 — Daily-driver polish

- [ ] **Push notifications to phone** (Telegram bot or ntfy.sh) — high-score pick or sell
      alert without the app open.
- [ ] Realized P&L — closing a TFSA position records the sale instead of deleting the row;
      track lifetime performance vs. just open positions.
- [ ] App icon + signed installer (code-signing cert) — kill the Windows SmartScreen
      warning before sharing with anyone.
- [ ] System tray mode — run minimized, surface only on alerts.

## v1.0 — Public launch

- [ ] **Web app** — Next.js + Supabase (same stack as LineEdge), server cron doing what
      the desktop app does locally; the scoring engine ports as-is.
- [ ] Free tier: trades feed, member dossiers. Paid tier: picks scoring, real-time alerts,
      portfolio advisor.
- [ ] Auth + Stripe billing.
- [ ] Legal pass — prominent "not financial advice" disclaimers, data-source attribution,
      45-day-lag disclosure so users understand what they're buying.
- [ ] Landing page with live "Congress bought this week" teaser as the hook.

---

## Principles

1. **Eat my own cooking first** — nothing ships to the public that hasn't run my own TFSA
   for at least a month.
2. **Official sources over scrapes** — House Clerk and Senate eFD are ground truth;
   third-party mirrors are supplements, never the backbone.
3. **Honest about limits** — amounts are ranges, filings lag up to 45 days, scores are
   signals not advice. The product says so out loud.
