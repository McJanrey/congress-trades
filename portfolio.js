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
  fs.writeFileSync(FILE, JSON.stringify(p, null, 2));
  return p;
}

// position: { id, ticker, cad, date (YYYY-MM-DD), note? }
// Valuation derives: entry USD price, FX at entry, fractional shares, current value.
export async function valuePortfolio(priceCache) {
  const p = loadPortfolio();
  if (p.positions.length === 0) {
    return { ...p, totals: { costCad: 0, valueCad: 0, plCad: 0, plPct: 0, cashCad: p.budgetCad }, enriched: [], timeline: [] };
  }

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
    // Same-day buys: no close exists yet for the buy date — fall back to the
    // most recent close until the market prints one.
    const entryUsd = pr ? (closeOnOrAfter(pr.series, pos.date) || pr.lastClose) : null;
    const fxAtBuy = closeOnOrAfter(fx.series, pos.date) || fxNow;
    if (!entryUsd || !pr.lastClose) {
      enriched.push({ ...pos, error: 'no price data' });
      continue;
    }
    const usdSpent = pos.cad / fxAtBuy;
    const shares = usdSpent / entryUsd;
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
