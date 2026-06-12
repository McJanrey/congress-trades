// Backtest: replay every congressional buy as if copied on its FILING date
// (the first day we could realistically act), measure forward returns over
// multiple horizons, and slice by signal profile to find what pays fastest.
//
// Usage: node backtest.js
// Reads trades/ + .cache/prices.json (extends the cache as needed).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonCache, fetchSpotAndHistory, closeOnOrAfter } from './enrich.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRADES_DIR = path.join(__dirname, 'trades');
const PRICE_CACHE = new JsonCache(path.join(__dirname, '.cache', 'prices.json'));

const HORIZONS = [5, 10, 21, 63]; // trading days ≈ 1w, 2w, 1m, 3m
const TARGET = 0.05; // +5% take-profit for "days to profit" metric

function collect() {
  const out = [];
  for (const f of fs.readdirSync(TRADES_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(TRADES_DIR, f), 'utf8'));
      for (const t of d.transactions || []) {
        out.push({ ...t, member: d.member, doc_id: d.doc_id });
      }
    } catch {}
  }
  return out;
}

function usToIso(s) {
  const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(s || '');
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

// Forward return over n trading days from a date, using the sorted day list.
function fwdReturn(series, days, startIdx, entry) {
  const idx = startIdx + days;
  if (idx >= days.length) return null;
  return null; // replaced below — kept for clarity
}

async function main() {
  const all = collect();
  const buys = all.filter((t) => t.ticker && t.transaction_type === 'P' && t.asset_type !== 'OP');

  // Member trade counts → conviction weight (same formula as the app).
  const counts = new Map();
  for (const t of all) counts.set(t.member, (counts.get(t.member) || 0) + 1);
  const conviction = (m) => Math.min(1, 50 / (counts.get(m) || 1));

  // Usable = has a filing date in the past with ≥3m of forward history.
  const cutoffIso = new Date(Date.now() - 100 * 86400_000).toISOString().slice(0, 10);
  const usable = buys.filter((t) => {
    const f = usToIso(t.notification_date);
    return f && f >= '2024-01-01' && f <= cutoffIso;
  });

  const tickers = [...new Set(usable.map((t) => t.ticker))];
  console.log(`${buys.length} congressional buys | ${usable.length} usable (filed 2024-01 → ${cutoffIso}) | ${tickers.length} tickers`);

  const earliest = Date.parse('2023-12-01');
  const prices = {};
  let i = 0;
  for (const tk of [...tickers, 'SPY']) {
    i++;
    if (i % 25 === 0) console.log(`  prices ${i}/${tickers.length + 1}...`);
    prices[tk] = await fetchSpotAndHistory(tk, earliest, PRICE_CACHE);
  }
  const spy = prices['SPY'];
  const spyDays = Object.keys(spy.series).sort();

  const rows = [];
  for (const t of usable) {
    const p = prices[t.ticker];
    if (!p || !p.series) continue;
    const days = Object.keys(p.series).sort();
    const fileIso = usToIso(t.notification_date);
    const entryIdx = days.findIndex((d) => d >= fileIso);
    if (entryIdx < 0 || entryIdx + 63 >= days.length) continue;
    const entry = p.series[days[entryIdx]];
    if (!entry) continue;

    const r = { conviction: conviction(t.member), member: t.member, ticker: t.ticker, filed: fileIso };
    for (const h of HORIZONS) {
      const px = p.series[days[entryIdx + h]];
      r[`h${h}`] = px != null ? (px - entry) / entry : null;
    }
    // SPY same-window benchmark (21d).
    const sIdx = spyDays.findIndex((d) => d >= fileIso);
    if (sIdx >= 0 && sIdx + 21 < spyDays.length) {
      r.spy21 = (spy.series[spyDays[sIdx + 21]] - spy.series[spyDays[sIdx]]) / spy.series[spyDays[sIdx]];
    }
    // Days until +5% (within 63 trading days), null if never.
    r.daysToTarget = null;
    for (let k = 1; k <= 63; k++) {
      const px = p.series[days[entryIdx + k]];
      if (px != null && (px - entry) / entry >= TARGET) { r.daysToTarget = k; break; }
    }
    rows.push(r);
  }

  console.log(`\n${rows.length} backtested copy-trades (entry = filing-date close)\n`);

  const fmt = (x) => x == null ? '   —  ' : ((x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%').padStart(7);
  const summarize = (label, rs) => {
    if (rs.length < 10) { console.log(`${label.padEnd(34)} n=${rs.length} (too few)`); return; }
    const avg = (key) => {
      const v = rs.map((r) => r[key]).filter((x) => x != null);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    const hitRate = rs.filter((r) => r.daysToTarget != null).length / rs.length;
    const med = (arr) => { const s = arr.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
    const mDays = med(rs.map((r) => r.daysToTarget).filter((x) => x != null));
    console.log(
      `${label.padEnd(34)} n=${String(rs.length).padStart(4)}  1w ${fmt(avg('h5'))}  2w ${fmt(avg('h10'))}  1m ${fmt(avg('h21'))}  3m ${fmt(avg('h63'))}  | +5% hit ${(hitRate * 100).toFixed(0)}% (med ${mDays}d)  | SPY 1m ${fmt(avg('spy21'))}`,
    );
  };

  summarize('ALL copy-trades', rows);
  summarize('High conviction (weight ≥ 0.8)', rows.filter((r) => r.conviction >= 0.8));
  summarize('Mid conviction (0.3–0.8)', rows.filter((r) => r.conviction >= 0.3 && r.conviction < 0.8));
  summarize('Managed-account flow (< 0.3)', rows.filter((r) => r.conviction < 0.3));

  // Consensus: tickers bought by 2+ distinct members within 30 days of each other.
  const byTickerDate = new Map();
  for (const r of rows) {
    if (!byTickerDate.has(r.ticker)) byTickerDate.set(r.ticker, []);
    byTickerDate.get(r.ticker).push(r);
  }
  const consensus = [];
  for (const [, rs] of byTickerDate) {
    for (const r of rs) {
      const others = rs.filter((o) => o.member !== r.member && Math.abs(Date.parse(o.filed) - Date.parse(r.filed)) < 30 * 86400_000);
      if (others.length >= 1) consensus.push(r);
    }
  }
  summarize('Consensus (2+ buyers within 30d)', consensus);
  summarize('Consensus AND conviction ≥ 0.8', consensus.filter((r) => r.conviction >= 0.8));

  fs.writeFileSync(path.join(__dirname, '.cache', 'backtest-results.json'), JSON.stringify(rows, null, 1));
  console.log('\nRaw rows → .cache/backtest-results.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
