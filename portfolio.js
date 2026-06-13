// Personal portfolio engine. Positions are logged manually (Wealthsimple has no
// API), valued in CAD via Yahoo prices + USDCAD FX. Storage: portfolio.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSpotAndHistory, closeOnOrAfter } from './enrich.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let FILE = path.join(__dirname, 'portfolio.json');

// Packaged builds redirect storage to the userData dir (see main.js).
export function setPortfolioDir(dir) {
  FILE = path.join(dir, 'portfolio.json');
}

export function loadPortfolio() {
  if (!fs.existsSync(FILE)) {
    return { budgetCad: 100, accountType: 'TFSA', positions: [] };
  }
  // Strip a UTF-8 BOM if present (Notepad/PowerShell add one).
  return JSON.parse(fs.readFileSync(FILE, 'utf8').replace(/^﻿/, ''));
}

export function savePortfolio(p) {
  // Keep the previous version as a one-step rollback before every write —
  // this file is the user's real-money record.
  try {
    if (fs.existsSync(FILE)) fs.copyFileSync(FILE, FILE + '.bak');
  } catch {}
  fs.writeFileSync(FILE, JSON.stringify(p, null, 2));
  return p;
}

// position: { id, ticker, cad, date (YYYY-MM-DD), note?,
//             entryUsd (FROZEN cost-basis price), fxAtBuy (FROZEN), entrySource? }
// entryUsd is the cost basis. It is frozen once — either from the user's real
// Wealthsimple fill price or from the best price available at log time — and is
// NEVER recomputed on later valuations (recomputing it drifts the basis up with
// the live price and pins P&L near 0%). Valuation reads the frozen value.

// Capture the cost-basis price for a position at log time. Returns a patch with
// frozen entryUsd / fxAtBuy / entrySource. If the caller passed a manual fill
// price (manualEntryUsd), that wins; otherwise we snapshot the close on/after
// the buy date, falling back to the latest close for a same-day buy.
export async function freezeEntry(pos, priceCache) {
  const earliestTs = Date.parse(pos.date) - 7 * 86400_000;
  const pr = await fetchSpotAndHistory(pos.ticker.toUpperCase(), earliestTs, priceCache);
  const fx = await fetchSpotAndHistory('USDCAD=X', earliestTs, priceCache);
  const fxNow = fx.lastClose || 1.37;

  const manual = Number(pos.manualEntryUsd);
  let entryUsd = Number.isFinite(manual) && manual > 0 ? manual : null;
  let entrySource = entryUsd ? 'manual' : null;
  if (!entryUsd && pr && !pr.error) {
    const histClose = closeOnOrAfter(pr.series, pos.date);
    entryUsd = histClose ?? pr.lastClose ?? null;
    entrySource = histClose ? 'close' : (entryUsd ? 'live' : null);
  }
  const fxAtBuy = closeOnOrAfter(fx.series, pos.date) || fxNow;

  const patch = { fxAtBuy: round4(fxAtBuy) };
  if (entryUsd) {
    patch.entryUsd = round2(entryUsd);
    patch.entrySource = entrySource;
  }
  // Strip the transient manual hint — it lives on only long enough to freeze.
  return patch;
}

// One-time backfill for positions persisted before entry-price freezing
// existed (or that lack a frozen basis). Mutates p in place and returns true if
// anything changed (so the caller can persist). Never overwrites an entryUsd
// the user has already set.
async function backfillEntries(p, priceCache) {
  let changed = false;
  for (const pos of p.positions) {
    if (pos.entryUsd != null && pos.fxAtBuy != null) continue;
    const hadFx = pos.fxAtBuy != null;
    const { manualEntryUsd, ...clean } = pos; // ignore stale hints on stored data
    const patch = await freezeEntry(clean, priceCache);
    Object.assign(pos, patch);
    if (manualEntryUsd != null) delete pos.manualEntryUsd;
    if (patch.entryUsd != null) {
      if (!pos.entrySource) pos.entrySource = 'backfill';
      changed = true; // froze a real basis — worth persisting
    } else if (!hadFx && patch.fxAtBuy != null) {
      changed = true; // first-time fx snapshot; entryUsd still pending feed
    }
  }
  return changed;
}

// Valuation reads the FROZEN entry USD price + FX; only the current price and
// current FX are live. Backfills+persists any position missing a frozen basis.
export async function valuePortfolio(priceCache) {
  const p = loadPortfolio();
  if (p.positions.length === 0) {
    return { ...p, totals: { costCad: 0, valueCad: 0, plCad: 0, plPct: 0, cashCad: p.budgetCad }, enriched: [], timeline: [] };
  }

  // Freeze any un-frozen / migrated positions before valuing, then persist so
  // the basis never drifts again.
  if (await backfillEntries(p, priceCache)) savePortfolio(p);

  const earliest = p.positions.map((x) => x.date).sort()[0];
  const earliestTs = Date.parse(earliest) - 7 * 86400_000;

  const tickers = [...new Set(p.positions.map((x) => x.ticker.toUpperCase()))];
  const prices = {};
  for (const tk of tickers) {
    prices[tk] = await fetchSpotAndHistory(tk, earliestTs, priceCache);
  }
  const fx = await fetchSpotAndHistory('USDCAD=X', earliestTs, priceCache);
  const fxNow = fx.lastClose || 1.37;

  const enriched = [];
  for (const pos of p.positions) {
    const pr = prices[pos.ticker.toUpperCase()];
    // FROZEN cost basis — read it, never recompute it. (backfillEntries above
    // guarantees a value unless the price feed was down at log + backfill time,
    // in which case we leave the position unpriced rather than re-anchor live.)
    const entryUsd = pos.entryUsd ?? null;
    const fxAtBuy = pos.fxAtBuy || closeOnOrAfter(fx.series, pos.date) || fxNow;
    if (!entryUsd || !pr || !pr.lastClose) {
      enriched.push({ ...pos, error: 'no price data' });
      continue;
    }
    const usdSpent = pos.cad / fxAtBuy;
    const shares = pos.shares || (usdSpent / entryUsd);
    const valueCad = shares * pr.lastClose * fxNow;
    enriched.push({
      ...pos,
      entryUsd: round2(entryUsd),
      lastUsd: round2(pr.lastClose),
      fxAtBuy: round4(fxAtBuy),
      shares: Math.round(shares * 10000) / 10000,
      valueCad: round2(valueCad),
      plCad: round2(valueCad - pos.cad),
      plPct: round2(((valueCad - pos.cad) / pos.cad) * 100),
    });
  }

  // Daily portfolio value timeline in CAD, on FX-series trading days.
  const days = Object.keys(fx.series).filter((d) => d >= earliest).sort();
  const timeline = [];
  for (const d of days) {
    let v = 0;
    let any = false;
    for (const e of enriched) {
      if (e.error || d < e.date) continue;
      const pr = prices[e.ticker.toUpperCase()];
      const close = pr.series[d] ?? lastBefore(pr.series, d);
      const rate = fx.series[d] ?? fxNow;
      if (close != null) { v += e.shares * close * rate; any = true; }
    }
    if (any) timeline.push({ date: d, valueCad: round2(v) });
  }

  const costCad = enriched.filter((e) => !e.error).reduce((a, e) => a + e.cad, 0);
  const valueCad = enriched.filter((e) => !e.error).reduce((a, e) => a + e.valueCad, 0);
  const totals = {
    costCad: round2(costCad),
    valueCad: round2(valueCad),
    plCad: round2(valueCad - costCad),
    plPct: costCad > 0 ? round2(((valueCad - costCad) / costCad) * 100) : 0,
    cashCad: round2(p.budgetCad - costCad),
    fxNow: round4(fxNow),
  };
  return { ...p, totals, enriched, timeline };
}

function lastBefore(series, dateStr) {
  let best = null;
  for (const k of Object.keys(series)) {
    if (k <= dateStr && (!best || k > best)) best = k;
  }
  return best ? series[best] : null;
}

const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;
