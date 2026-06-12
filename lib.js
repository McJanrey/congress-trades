// Shared core: fetches the House Clerk XML index, filters to watchlist,
// invokes the Python PTR parser on each matching PDF. Used by both the
// CLI (fetch-trades.js) and the Electron main process.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';

const TRADE_FILING_TYPES = new Set(['P', 'PA']);

export function pdfUrl(year, docId) {
  return `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${year}/${docId}.pdf`;
}

export function zipUrl(year) {
  return `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}FD.zip`;
}

export async function downloadIndex(year) {
  const url = zipUrl(year);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(buf);
  const entry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith('.xml'));
  if (!entry) throw new Error('No XML in zip');
  return entry.getData().toString('utf8');
}

export function parseFilings(xml) {
  const parser = new XMLParser({ ignoreAttributes: true, trimValues: true });
  const doc = parser.parse(xml);
  const root = doc.FinancialDisclosure || doc;
  let members = root.Member || [];
  if (!Array.isArray(members)) members = [members];
  return members.map((m) => ({
    last: String(m.Last ?? '').trim(),
    first: String(m.First ?? '').trim(),
    filingType: String(m.FilingType ?? '').trim(),
    stateDst: String(m.StateDst ?? '').trim(),
    filingDate: String(m.FilingDate ?? '').trim(),
    docId: String(m.DocID ?? '').trim(),
    year: String(m.Year ?? '').trim(),
  }));
}

export function filterFilings(filings, { watchlist = [], lookbackDays = 90 } = {}) {
  const cutoff = lookbackDays ? Date.now() - lookbackDays * 86400_000 : 0;
  const lowerWatch = watchlist.map((n) => n.toLowerCase());
  return filings
    .filter((f) => TRADE_FILING_TYPES.has(f.filingType))
    .filter((f) => lowerWatch.length === 0 || lowerWatch.includes(f.last.toLowerCase()))
    .filter((f) => {
      if (!cutoff) return true;
      const d = new Date(f.filingDate);
      return Number.isNaN(d.getTime()) ? true : d.getTime() >= cutoff;
    })
    .sort((a, b) => new Date(b.filingDate) - new Date(a.filingDate));
}

// Async so the Electron main process stays responsive during long backfills —
// a synchronous spawn here blocks the whole app window per PDF.
export function parsePtr(year, docId, { pythonBin = 'python', scriptDir } = {}) {
  return new Promise((resolve) => {
    const script = path.join(scriptDir, 'parse_ptr.py');
    const url = pdfUrl(year, docId);
    const child = spawn(pythonBin, [script, url, docId]);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) => {
      if (code !== 0) return resolve({ ok: false, error: err.trim() || `exit ${code}` });
      try {
        resolve({ ok: true, data: JSON.parse(out) });
      } catch (e) {
        resolve({ ok: false, error: `invalid JSON: ${e.message}` });
      }
    });
  });
}

export function loadState(file) {
  if (!fs.existsSync(file)) return { seenDocIds: [] };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function saveState(file, state) {
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

export function loadConfig(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function saveConfig(file, config) {
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}
