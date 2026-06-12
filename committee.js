// Committee-relevance signal: does this member's committee oversee the
// sector of the stock they traded? Backtested 2024–2026: relevant trades
// returned +2.45%/trade EV vs +0.17% for the rest (see backtest-experiments.js).

const UA = { 'User-Agent': 'congress-trades/0.4 (personal)' };
const WEEK = 7 * 86400_000;

// Committee code prefix → sectors/industries it plausibly oversees.
// Confident pairs only — a loose mapping would dilute the signal.
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

// Yahoo exchange codes for OTC markets (pink sheets, OTCQB, OTCQX) — these are
// generally NOT TFSA-qualified investments under CRA rules.
const OTC_EXCHANGES = new Set(['PNK', 'OQB', 'OQX', 'OTC', 'OEM', 'OBB']);

export async function sectorFor(ticker, sectorCache) {
  const cached = sectorCache.get(ticker);
  // 'exchange' missing = entry from an older app version — refetch.
  if (cached && 'exchange' in cached && !sectorCache.isStale(ticker, 30 * 86400_000)) return cached;
  try {
    const res = await fetch(
      `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&quotesCount=1&newsCount=0`,
      { headers: UA },
    );
    const j = await res.json();
    const q = (j.quotes || []).find((x) => x.symbol === ticker) || j.quotes?.[0];
    const info = {
      sector: q?.sector || q?.sectorDisp || null,
      industry: q?.industry || q?.industryDisp || null,
      exchange: q?.exchange || null,
      otc: OTC_EXCHANGES.has(q?.exchange),
    };
    sectorCache.set(ticker, info);
    sectorCache.flush();
    return info;
  } catch {
    return { sector: null, industry: null, exchange: null, otc: false };
  }
}

// Returns a lookup: (memberName) -> Set of parent committee codes, or null.
export async function loadCommitteeLookup(rosterCache) {
  const key = '__committees__';
  let entry = rosterCache.get(key);
  if (!entry || rosterCache.isStale(key, WEEK)) {
    const [mems, roster] = await Promise.all([
      fetch('https://unitedstates.github.io/congress-legislators/committee-membership-current.json', { headers: UA }).then((r) => r.json()),
      fetch('https://unitedstates.github.io/congress-legislators/legislators-current.json', { headers: UA }).then((r) => r.json()),
    ]);
    const byBio = {};
    for (const [code, members] of Object.entries(mems)) {
      const top = code.slice(0, 4); // roll subcommittees up to the parent
      for (const m of members) {
        (byBio[m.bioguide] = byBio[m.bioguide] || []).push(top);
      }
    }
    const byLast = {};
    for (const leg of roster) {
      const codes = byBio[leg.id?.bioguide];
      if (codes) byLast[leg.name.last.toLowerCase()] = [...new Set(codes)];
    }
    entry = { byLast };
    rosterCache.set(key, entry);
    rosterCache.flush();
  }
  const byLast = entry.byLast;
  return (memberName) => {
    const parts = (memberName || '').replace(/^Hon\.?\s+/i, '').split(/\s+/);
    const last = parts[parts.length - 1]?.toLowerCase();
    return byLast[last] || null;
  };
}

// Core check: is member's committee relevant to ticker's sector?
// Returns { relevant, committee } — committee is the human-readable name.
export function checkRelevance(committeeCodes, sectorInfo) {
  if (!committeeCodes || (!sectorInfo?.sector && !sectorInfo?.industry)) {
    return { relevant: false, committee: null };
  }
  for (const code of committeeCodes) {
    const rule = COMMITTEE_SECTORS[code];
    if (rule && rule.match(sectorInfo.sector || '', sectorInfo.industry || '')) {
      return { relevant: true, committee: rule.name };
    }
  }
  return { relevant: false, committee: null };
}
