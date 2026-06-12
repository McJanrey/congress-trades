// Politician metadata + Yahoo price helpers. Cached on disk to avoid re-fetching.
import fs from 'node:fs';
import path from 'node:path';

const UA = { 'User-Agent': 'congress-trades/0.1 (personal)' };

export class JsonCache {
  constructor(file) {
    this.file = file;
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  }
  get(key) { return this.data[key]; }
  set(key, value) { this.data[key] = { ...value, _ts: Date.now() }; this._dirty = true; }
  flush() {
    if (!this._dirty) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    this._dirty = false;
  }
  isStale(key, maxAgeMs) {
    const e = this.data[key];
    return !e || (Date.now() - (e._ts || 0)) > maxAgeMs;
  }
}

// ---------- Legislators directory (unitedstates/congress-legislators) ----------

const LEG_URL = 'https://unitedstates.github.io/congress-legislators/legislators-current.json';
const PHOTO_URL = (bioId) => `https://unitedstates.github.io/images/congress/450x550/${bioId}.jpg`;

let legislatorsIndex = null; // { byLast: Map, byLastFirst: Map }

async function ensureLegislators(cache) {
  if (legislatorsIndex) return legislatorsIndex;
  const day = 86400_000;
  let raw = cache.get('__roster__');
  if (!raw || !raw._ts || Date.now() - raw._ts > day) {
    const res = await fetch(LEG_URL, { headers: UA });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching legislators`);
    const data = await res.json();
    cache.set('__roster__', { data });
    cache.flush();
    raw = cache.get('__roster__');
  }
  const data = raw.data;
  const byLast = new Map();
  const byLastFirst = new Map();
  for (const m of data) {
    const name = m.name || {};
    const last = (name.last || '').toLowerCase();
    const first = (name.first || '').toLowerCase();
    const nick = (name.nickname || '').toLowerCase();
    const term = (m.terms || []).slice(-1)[0] || {};
    const entry = {
      bioId: m.id?.bioguide,
      first: name.first,
      last: name.last,
      official_full: name.official_full,
      birthday: m.bio?.birthday,
      party: term.party,
      state: term.state,
      district: term.district,
      chamber: term.type === 'sen' ? 'Senate' : 'House',
      url: term.url,
    };
    if (last) {
      if (!byLast.has(last)) byLast.set(last, []);
      byLast.get(last).push(entry);
    }
    if (last && first) byLastFirst.set(`${last}|${first}`, entry);
    if (last && nick) byLastFirst.set(`${last}|${nick}`, entry);
  }
  legislatorsIndex = { byLast, byLastFirst };
  return legislatorsIndex;
}

export async function lookupMember({ first, last }, cache) {
  const idx = await ensureLegislators(cache);
  const lk = last.toLowerCase();
  const fk = (first || '').toLowerCase();
  let entry = idx.byLastFirst.get(`${lk}|${fk}`);
  if (!entry) {
    // Fall back to any entry with this last name (handles middle-name first tokens).
    const candidates = idx.byLast.get(lk) || [];
    entry = candidates[0];
  }
  if (!entry || !entry.bioId) return { found: false };

  const birthYear = entry.birthday ? Number(entry.birthday.slice(0, 4)) : null;
  return {
    found: true,
    bioId: entry.bioId,
    first: entry.first,
    last: entry.last,
    fullName: entry.official_full,
    birthYear,
    party: entry.party,
    state: entry.state,
    district: entry.district,
    chamber: entry.chamber,
    photoUrl: PHOTO_URL(entry.bioId),
    profileUrl: entry.url || `https://bioguide.congress.gov/search/bio/${entry.bioId}`,
  };
}

// ---------- Yahoo Finance ----------

// Returns { price, timestamp } for the latest available close, or null.
export async function fetchSpotAndHistory(ticker, fromUnix, cache) {
  const key = ticker.toUpperCase();
  const hour = 3600_000;
  const cached = cache.get(key);
  if (cached && cached._ts && Date.now() - cached._ts < hour) return cached;

  try {
    // Yahoo expects period1/period2 in seconds.
    const period1 = Math.floor(fromUnix / 1000);
    const period2 = Math.floor(Date.now() / 1000);
    const url = `https://query1.finance.yahoo.com/v7/finance/chart/${encodeURIComponent(key)}?period1=${period1}&period2=${period2}&interval=1d&events=div%2Csplit`;
    const res = await fetch(url, { headers: UA });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const result = j?.chart?.result?.[0];
    if (!result) throw new Error('no result');
    const ts = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    // Build a date-keyed map for fast lookup.
    const series = {};
    for (let i = 0; i < ts.length; i++) {
      if (closes[i] != null) {
        const d = new Date(ts[i] * 1000).toISOString().slice(0, 10);
        series[d] = closes[i];
      }
    }
    const last = closes.filter((c) => c != null).pop();
    const info = { ticker: key, lastClose: last ?? null, series };
    cache.set(key, info);
    cache.flush();
    return info;
  } catch (e) {
    const info = { ticker: key, error: e.message, series: {} };
    cache.set(key, info);
    cache.flush();
    return info;
  }
}

// Find the first available close on/after a given YYYY-MM-DD.
export function closeOnOrAfter(series, dateStr) {
  if (!series) return null;
  if (series[dateStr] != null) return series[dateStr];
  // Walk forward up to 7 days for weekends/holidays.
  const d = new Date(dateStr + 'T00:00:00Z');
  for (let i = 1; i <= 7; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    const k = d.toISOString().slice(0, 10);
    if (series[k] != null) return series[k];
  }
  return null;
}

export function parseFilingDate(s) {
  // PTR transaction dates are MM/DD/YYYY.
  const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  if (!m) return null;
  return `${m[3]}-${m[1]}-${m[2]}`;
}
