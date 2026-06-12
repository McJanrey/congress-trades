// Supplemental importer: kadoa-org/congress-trading-monitor public dataset.
// Adds Senate coverage, party/state metadata, late-filing flags, and precomputed
// returns on top of our own House Clerk parsing. Trades land in trades/ as
// kadoa_<chamber>.json files in our standard shape so the app picks them up.
//
// Their data also only has amount ranges — exact amounts are not disclosed
// by Congress, full stop.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let TRADES_DIR = path.join(__dirname, 'trades');

// Packaged builds redirect storage to the userData dir (see main.js).
export function setKadoaTradesDir(dir) {
  TRADES_DIR = dir;
}
const SRC_URL = 'https://raw.githubusercontent.com/kadoa-org/congress-trading-monitor/main/public/data/trades.json';

const TX_MAP = {
  Purchase: 'P',
  Sale: 'S',
  'Sale (Partial)': 'S (partial)',
  'Sale (Full)': 'S',
  Exchange: 'E',
};

function isoToUs(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

// Doc IDs we already parsed ourselves (with at least one transaction) — skip those
// kadoa House rows to avoid double counting. Keeps kadoa rows for scanned PDFs
// our parser couldn't read.
function locallyParsedDocIds() {
  const ids = new Set();
  if (!fs.existsSync(TRADES_DIR)) return ids;
  for (const f of fs.readdirSync(TRADES_DIR)) {
    if (!f.endsWith('.json') || f.startsWith('kadoa_')) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(TRADES_DIR, f), 'utf8'));
      if ((d.transactions || []).length > 0) ids.add(String(d.doc_id));
    } catch {}
  }
  return ids;
}

export async function importKadoa() {
  const res = await fetch(SRC_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching kadoa dataset`);
  let rows = await res.json();

  const localIds = locallyParsedDocIds();
  rows = rows.filter((r) => {
    if (r.chamber !== 'house') return true;
    const m = /\/(\d+)\.pdf$/.exec(r.doc_url || '');
    return !(m && localIds.has(m[1]));
  });

  // Group by filer so each output file mirrors our per-filing shape.
  const byFiler = new Map();
  for (const r of rows) {
    const key = r.filer_id || r.filer_name;
    if (!byFiler.has(key)) {
      byFiler.set(key, {
        member: r.filer_name,
        chamber: r.chamber,
        party: r.party,
        state: r.state,
        transactions: [],
      });
    }
    byFiler.get(key).transactions.push({
      owner: r.owner || null,
      asset: r.asset_name,
      ticker: r.ticker || null,
      asset_type: r.asset_type || null,
      transaction_type: TX_MAP[r.transaction_type] || r.transaction_type,
      transaction_date: isoToUs(r.transaction_date),
      notification_date: isoToUs(r.filing_date),
      amount_range: r.amount_range_label,
      amount_low: r.amount_range_low,
      amount_high: r.amount_range_high,
      days_to_file: r.days_to_file,
      is_late: r.is_late === 1,
      ret_since: r.ret_since,
      doc_url: r.doc_url || null,
      source: 'kadoa',
    });
  }

  fs.mkdirSync(TRADES_DIR, { recursive: true });

  // Remove previous kadoa imports so re-runs don't duplicate.
  for (const f of fs.readdirSync(TRADES_DIR)) {
    if (f.startsWith('kadoa_')) fs.unlinkSync(path.join(TRADES_DIR, f));
  }

  let fileCount = 0;
  let txCount = 0;
  for (const [key, filer] of byFiler) {
    const safe = key.replace(/[^a-z0-9_]/gi, '_');
    const docId = `kadoa_${safe}`;
    fs.writeFileSync(
      path.join(TRADES_DIR, `${docId}.json`),
      JSON.stringify(
        {
          source: 'kadoa-org/congress-trading-monitor',
          doc_id: docId,
          member: filer.member,
          state_district: filer.state,
          chamber: filer.chamber,
          party: filer.party,
          transaction_count: filer.transactions.length,
          transactions: filer.transactions,
        },
        null,
        2,
      ),
    );
    fileCount++;
    txCount += filer.transactions.length;
  }
  return { filers: fileCount, transactions: txCount };
}

// CLI usage: node import-kadoa.js
if (process.argv[1] && process.argv[1].endsWith('import-kadoa.js')) {
  importKadoa()
    .then((r) => console.log(`Imported ${r.transactions} transactions from ${r.filers} filers.`))
    .catch((e) => { console.error(e); process.exit(1); });
}
