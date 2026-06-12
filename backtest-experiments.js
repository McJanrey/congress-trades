// Experiment 1: stop-loss — exit at +5% TP or -5% SL, whichever hits first
//   (else close at 63 trading days). Does cutting the miss-bleed flip EV?
// Experiment 2: committee relevance — do trades where the member's committee
//   oversees the stock's sector outperform the rest?
//
// Usage: node backtest-experiments.js   (run backtest.js first to warm caches)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonCache, fetchSpotAndHistory } from './enrich.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRADES_DIR = path.join(__dirname, 'trades');
const CACHE = path.join(__dirname, '.cache');
const PRICE_CACHE = new JsonCache(path.join(CACHE, 'prices.json'));
const SECTOR_CACHE = new JsonCache(path.join(CACHE, 'sectors.json'));

const TP = 0.05, SL = -0.05, MAX_DAYS = 63;
const WS_ROUNDTRIP_FX = 0.03; // Wealthsimple ~1.5% CAD→USD each way

// Committee prefix → relevant sectors/industries (confident pairs only).
const COMMITTEE_SECTORS = {
  HSAS: { name: 'House Armed Services', match: (s, i) => /Defense|Aerospace/i.test(i) },
  SSAS: { name: 'Senate Armed Services', match: (s, i) => /Defense|Aerospace/i.test(i) },
  HSBA: { name: 'House Financial Services', match: (s) => /Financial/i.test(s) },
  SSBK: { name: 'Senate Banking', match: (s) => /Financial/i.test(s) },
  HSIF: { name: 'House Energy & Commerce', match: (s) => /Energy|Utilities|Healthcare|Communication/i.test(s) },
  SSEG: { name: 'Senate Energy & Nat. Resources', match: (s) => /Energy|Utilities|Basic Materials/i.test(s) },
  SSHR: { name: 'Senate HELP (health)', match: (s) => /Healthcare/i.test(s) },
  HSPW: { name: 'House Transportation & Infra', match: (s) => /Industrials/i.test(s) },
  SSCM: { name: 'Senate Commerce/Science/Transp', match: (s) => /Technology|Communication|Industrials/i.test(s) },
  HSSY: { name: 'House Science/Space/Tech', match: (s) => /Technology/i.test(s) },
  HSAG: { name: 'House Agriculture', match: (s) => /Consumer Defensive|Basic Materials/i.test(s) },
  SSAF: { name: 'Senate Agriculture', match: (s) => /Consumer Defensive|Basic Materials/i.test(s) },
};

const usToIso = (s) => { const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(s || ''); return m ? `${m[3]}-${m[1]}-${m[2]}` : null; };

function collect() {
  const out = [];
  for (const f of fs.readdirSync(TRADES_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(TRADES_DIR, f), 'utf8'));
      for (const t of d.transactions || []) out.push({ ...t, member: d.member });
    } catch {}
  }
  return out;
}

async function sectorFor(ticker) {
  const cached = SECTOR_CACHE.get(ticker);
  if (cached) return cached;
  try {
    const res = await fetch(
      `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&quotesCount=1&newsCount=0`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } },
    );
    const j = await res.json();
    const q = (j.quotes || []).find((x) => x.symbol === ticker) || j.quotes?.[0];
    const info = { sector: q?.sector || q?.sectorDisp || null, industry: q?.industry || q?.industryDisp || null };
    SECTOR_CACHE.set(ticker, info);
    SECTOR_CACHE.flush();
    return info;
  } catch {
    return { sector: null, industry: null };
  }
}

async function memberCommittees() {
  // bioguide -> committee codes
  const [mems, roster] = await Promise.all([
    fetch('https://unitedstates.github.io/congress-legislators/committee-membership-current.json').then((r) => r.json()),
    fetch('https://unitedstates.github.io/congress-legislators/legislators-current.json').then((r) => r.json()),
  ]);
  const byBio = new Map();
  for (const [code, members] of Object.entries(mems)) {
    const top = code.slice(0, 4); // subcommittees roll up to parent
    for (const m of members) {
      if (!byBio.has(m.bioguide)) byBio.set(m.bioguide, new Set());
      byBio.get(m.bioguide).add(top);
    }
  }
  // member display name (as it appears in filings) -> bioguide, via last+first
  const nameToCommittees = new Map();
  for (const leg of roster) {
    const bio = leg.id?.bioguide;
    const committees = byBio.get(bio);
    if (!committees) continue;
    nameToCommittees.set(`${leg.name.last.toLowerCase()}`, { committees, first: leg.name.first.toLowerCase() });
  }
  return (memberName) => {
    const parts = (memberName || '').replace(/^Hon\.?\s+/i, '').split(/\s+/);
    const last = parts[parts.length - 1]?.toLowerCase();
    const hit = nameToCommittees.get(last);
    return hit ? hit.committees : null;
  };
}

// Walk the price path: exit at TP/SL/63d. Returns {ret, days, exit}.
function simulate(series, days, entryIdx) {
  const entry = series[days[entryIdx]];
  for (let k = 1; k <= MAX_DAYS; k++) {
    const idx = entryIdx + k;
    if (idx >= days.length) break;
    const px = series[days[idx]];
    if (px == null) continue;
    const r = (px - entry) / entry;
    if (r >= TP) return { ret: TP, days: k, exit: 'tp' };
    if (r <= SL) return { ret: SL, days: k, exit: 'sl' };
  }
  const idx = Math.min(entryIdx + MAX_DAYS, days.length - 1);
  return { ret: (series[days[idx]] - entry) / entry, days: MAX_DAYS, exit: 'time' };
}

async function main() {
  const all = collect();
  const counts = new Map();
  for (const t of all) counts.set(t.member, (counts.get(t.member) || 0) + 1);
  const conviction = (m) => Math.min(1, 50 / (counts.get(m) || 1));

  const cutoffIso = new Date(Date.now() - 100 * 86400_000).toISOString().slice(0, 10);
  const buys = all.filter((t) => {
    const f = usToIso(t.notification_date);
    return t.ticker && t.transaction_type === 'P' && t.asset_type !== 'OP' && f && f >= '2024-01-01' && f <= cutoffIso;
  });

  console.log('Loading committee rosters + sectors...');
  const committeesOf = await memberCommittees();
  const tickers = [...new Set(buys.map((t) => t.ticker))];
  const sectors = {};
  let i = 0;
  for (const tk of tickers) {
    i++;
    if (i % 50 === 0) console.log(`  sectors ${i}/${tickers.length}...`);
    sectors[tk] = await sectorFor(tk);
    await new Promise((r) => setTimeout(r, 120)); // be polite to Yahoo search
  }

  const rows = [];
  for (const t of buys) {
    const p = PRICE_CACHE.get(t.ticker);
    if (!p?.series) continue;
    const days = Object.keys(p.series).sort();
    const fileIso = usToIso(t.notification_date);
    const entryIdx = days.findIndex((d) => d >= fileIso);
    if (entryIdx < 0 || entryIdx + 10 >= days.length || p.series[days[entryIdx]] == null) continue;

    const sim = simulate(p.series, days, entryIdx);
    const sec = sectors[t.ticker] || {};
    const comms = committeesOf(t.member);
    let relevant = false;
    let relevantCommittee = null;
    if (comms && (sec.sector || sec.industry)) {
      for (const code of comms) {
        const rule = COMMITTEE_SECTORS[code];
        if (rule && rule.match(sec.sector || '', sec.industry || '')) {
          relevant = true;
          relevantCommittee = rule.name;
          break;
        }
      }
    }
    rows.push({ ...sim, ticker: t.ticker, member: t.member, conviction: conviction(t.member), relevant, relevantCommittee, sector: sec.sector });
  }

  console.log(`\n${rows.length} simulated trades (entry filing-date close, TP +5% / SL -5% / 63d)\n`);

  const summarize = (label, rs) => {
    if (rs.length < 8) { console.log(`${label.padEnd(42)} n=${rs.length} (too few)`); return; }
    const ev = rs.reduce((a, r) => a + r.ret, 0) / rs.length;
    const tp = rs.filter((r) => r.exit === 'tp').length / rs.length;
    const sl = rs.filter((r) => r.exit === 'sl').length / rs.length;
    const avgDays = rs.reduce((a, r) => a + r.days, 0) / rs.length;
    const evNet = ev - WS_ROUNDTRIP_FX;
    console.log(
      `${label.padEnd(42)} n=${String(rs.length).padStart(4)}  EV ${(ev * 100).toFixed(2).padStart(6)}%  (net of FX ${(evNet * 100).toFixed(2).padStart(6)}%)  TP ${(tp * 100).toFixed(0)}% SL ${(sl * 100).toFixed(0)}%  avg hold ${avgDays.toFixed(0)}d`,
    );
  };

  console.log('=== Experiment 1: stop-loss strategy ===');
  summarize('ALL trades', rows);
  summarize('Conviction ≥ 0.3', rows.filter((r) => r.conviction >= 0.3));
  summarize('Conviction ≥ 0.8', rows.filter((r) => r.conviction >= 0.8));

  console.log('\n=== Experiment 2: committee relevance ===');
  summarize('Committee-RELEVANT trades', rows.filter((r) => r.relevant));
  summarize('Non-relevant trades', rows.filter((r) => !r.relevant));
  summarize('Relevant AND conviction ≥ 0.3', rows.filter((r) => r.relevant && r.conviction >= 0.3));

  const byComm = {};
  for (const r of rows.filter((x) => x.relevant)) {
    byComm[r.relevantCommittee] = byComm[r.relevantCommittee] || [];
    byComm[r.relevantCommittee].push(r);
  }
  console.log('\nPer committee:');
  for (const [c, rs] of Object.entries(byComm).sort((a, b) => b[1].length - a[1].length)) summarize(`  ${c}`, rs);

  fs.writeFileSync(path.join(CACHE, 'experiment-results.json'), JSON.stringify(rows, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
