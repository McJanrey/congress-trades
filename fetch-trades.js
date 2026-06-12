// CLI entrypoint. For Electron use, see main.js / lib.js.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig, loadState, saveState,
  downloadIndex, parseFilings, filterFilings,
  parsePtr, pdfUrl, zipUrl,
} from './lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOW_ALL = process.argv.includes('--all');
const NO_PARSE = process.argv.includes('--no-parse');

const config = loadConfig(path.join(__dirname, 'config.json'));
const stateFile = path.join(__dirname, 'state.json');
const tradesDir = path.join(__dirname, 'trades');

async function main() {
  const state = loadState(stateFile);
  const seen = new Set(state.seenDocIds);

  console.log(`Downloading ${zipUrl(config.year)} ...`);
  const xml = await downloadIndex(config.year);
  const all = parseFilings(xml);
  const hits = filterFilings(all, config);
  const newHits = SHOW_ALL ? hits : hits.filter((f) => !seen.has(f.docId));

  console.log(
    `\n${all.length} total filings | ${hits.length} on watchlist (last ${config.lookbackDays}d) | ${newHits.length} new\n`,
  );

  if (newHits.length === 0) {
    console.log('Nothing new. (Use --all to re-print everything on the watchlist.)');
    return;
  }

  if (!NO_PARSE) fs.mkdirSync(tradesDir, { recursive: true });

  for (const f of newHits) {
    console.log(`\n[${f.filingDate}] ${f.first} ${f.last} (${f.stateDst})  ${f.filingType}`);
    console.log(`  ${pdfUrl(config.year, f.docId)}`);

    if (NO_PARSE) continue;
    const r = await parsePtr(config.year, f.docId, { scriptDir: __dirname });
    if (!r.ok) {
      console.log(`  (parse failed: ${r.error})`);
      continue;
    }
    fs.writeFileSync(path.join(tradesDir, `${f.docId}.json`), JSON.stringify(r.data, null, 2));
    for (const t of r.data.transactions) {
      const ticker = t.ticker || '???';
      const owner = t.owner ? `${t.owner} ` : '';
      console.log(`    ${t.transaction_date}  ${t.transaction_type.padEnd(12)} ${ticker.padEnd(6)} ${t.amount_range.padEnd(22)} ${owner}${t.asset}`);
    }
  }

  for (const f of hits) seen.add(f.docId);
  saveState(stateFile, { seenDocIds: [...seen], lastRun: new Date().toISOString() });
}

main().catch((e) => { console.error(e); process.exit(1); });
