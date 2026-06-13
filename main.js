import { app, BrowserWindow, ipcMain, shell, Notification } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  loadConfig, saveConfig, loadState, saveState,
  downloadIndex, parseFilings, filterFilings,
  parsePtr,
} from './lib.js';
import { JsonCache, lookupMember, fetchSpotAndHistory, closeOnOrAfter, parseFilingDate } from './enrich.js';
import electronUpdater from 'electron-updater';
import { importKadoa, setKadoaTradesDir } from './import-kadoa.js';

const { autoUpdater } = electronUpdater;
import { loadPortfolio, savePortfolio, valuePortfolio, setPortfolioDir, freezeEntry } from './portfolio.js';
import { sectorFor, loadCommitteeLookup, checkRelevance } from './committee.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Packaged builds live inside read-only app.asar — all mutable data goes to
// %APPDATA%/congress-trades instead. Dev runs keep using the project folder.
const DATA_DIR = app.isPackaged ? app.getPath('userData') : __dirname;
// parse_ptr.py is asar-unpacked so Python can actually read it when packaged.
const SCRIPT_DIR = __dirname.includes('app.asar')
  ? __dirname.replace('app.asar', 'app.asar.unpacked')
  : __dirname;

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const TRADES_DIR = path.join(DATA_DIR, 'trades');
const CACHE_DIR = path.join(DATA_DIR, '.cache');

// First run of a packaged build: seed config from the bundled default.
if (!fs.existsSync(CONFIG_FILE)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'config.json'), CONFIG_FILE);
}

const MEMBER_CACHE = new JsonCache(path.join(CACHE_DIR, 'members.json'));
const PRICE_CACHE = new JsonCache(path.join(CACHE_DIR, 'prices.json'));
const SECTOR_CACHE = new JsonCache(path.join(CACHE_DIR, 'sectors.json'));

let committeeLookupPromise = null;
function getCommitteeLookup() {
  if (!committeeLookupPromise) {
    committeeLookupPromise = loadCommitteeLookup(MEMBER_CACHE).catch(() => () => null);
  }
  return committeeLookupPromise;
}

// Is this (member, ticker) trade committee-relevant? Cached sector lookups.
async function tradeRelevance(memberName, ticker) {
  const lookup = await getCommitteeLookup();
  const codes = lookup(memberName);
  if (!codes) return { relevant: false, committee: null };
  const sec = await sectorFor(ticker, SECTOR_CACHE);
  return checkRelevance(codes, sec);
}
setPortfolioDir(DATA_DIR);
setKadoaTradesDir(TRADES_DIR);

// Disk-persisted computed results (gains, picks) so a fresh launch shows
// data instantly instead of refetching hundreds of Yahoo tickers.
const COMPUTED_TTL = 3600_000; // 1h
function computedFile(name) { return path.join(CACHE_DIR, `computed-${name}.json`); }
function readComputed(name) {
  try {
    const j = JSON.parse(fs.readFileSync(computedFile(name), 'utf8'));
    // Version-stamped: a new app version means new scoring — never serve
    // results computed by older code.
    if (j.v === app.getVersion() && Date.now() - j.ts < COMPUTED_TTL) return j.data;
  } catch {}
  return null;
}
function writeComputed(name, data) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(computedFile(name), JSON.stringify({ ts: Date.now(), v: app.getVersion(), data }));
}
function invalidateComputed() {
  for (const f of ['gains', 'picks-30', 'picks-60', 'picks-90']) {
    try { fs.unlinkSync(computedFile(f)); } catch {}
  }
}

let mainWindow = null;
let refreshTimer = null;
let refreshInFlight = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    backgroundColor: '#0e0f13',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function send(channel, payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  } catch {} // window can be mid-teardown during background work
}

async function runRefresh({ background = false } = {}) {
  if (refreshInFlight) return { ok: false, error: 'refresh already running' };
  refreshInFlight = true;
  try {
    const config = loadConfig(CONFIG_FILE);
    const state = loadState(STATE_FILE);
    const seen = new Set(state.seenDocIds);

    // Multi-year backfill: when backfillYears is set, pull every year's index
    // and ignore the lookback window (we want full history).
    const years = config.backfillYears?.length ? config.backfillYears : [config.year];
    let all = [];
    for (const y of years) {
      send('refresh-progress', { type: 'status', text: `Fetching ${y} filings index...` });
      const xml = await downloadIndex(y);
      all = all.concat(parseFilings(xml).map((f) => ({ ...f, indexYear: y })));
    }
    const filterCfg = years.length > 1 ? { ...config, lookbackDays: 0 } : config;
    const hits = filterFilings(all, filterCfg);
    // Bound each cycle so a deep backfill can't pin the app for an hour —
    // the rest streams in on subsequent hourly refreshes.
    const MAX_PARSE_PER_CYCLE = 300;
    const newHits = hits.filter((f) => !seen.has(f.docId)).slice(0, MAX_PARSE_PER_CYCLE);

    send('refresh-progress', {
      type: 'status',
      text: `${all.length} filings • ${hits.length} on watchlist • ${newHits.length} new`,
    });

    fs.mkdirSync(TRADES_DIR, { recursive: true });

    let parsedCount = 0;
    let processed = 0;
    const buyers = new Set();
    const committeeHits = [];

    for (const f of newHits) {
      processed++;
      send('refresh-progress', {
        type: 'status',
        text: `[${processed}/${newHits.length}] Parsing ${f.first} ${f.last}...`,
      });
      const r = await parsePtr(f.indexYear || config.year, f.docId, { scriptDir: SCRIPT_DIR });
      if (r.ok) {
        fs.writeFileSync(path.join(TRADES_DIR, `${f.docId}.json`), JSON.stringify(r.data, null, 2));
        parsedCount += r.data.transactions.length;
        if (r.data.transactions.some((t) => t.transaction_type === 'P')) {
          buyers.add(r.data.member);
        }
        // The backtested high-edge signal: committee-relevant buys in fresh filings.
        for (const t of r.data.transactions) {
          if (t.transaction_type !== 'P' || !t.ticker || t.asset_type === 'OP') continue;
          const rel = await tradeRelevance(r.data.member, t.ticker);
          if (rel.relevant) {
            committeeHits.push({ member: r.data.member, ticker: t.ticker, committee: rel.committee });
          }
        }
      }
      seen.add(f.docId);

      // Re-emit trades list periodically so the UI grows during long refreshes.
      if (processed % 5 === 0 || processed === newHits.length) {
        send('trades-updated');
      }
    }
    // Only parsed filings are marked seen (inside the loop above) so an
    // interrupted backfill resumes where it left off next cycle.
    saveState(STATE_FILE, { seenDocIds: [...seen], lastRun: new Date().toISOString() });
    if (newHits.length > 0) invalidateComputed();

    send('refresh-progress', { type: 'status', text: 'Importing Senate + supplemental data...' });
    try {
      const k = await importKadoa();
      send('refresh-progress', { type: 'status', text: `Supplemental: ${k.transactions} trades from ${k.filers} filers.` });
    } catch (e) {
      send('refresh-progress', { type: 'status', text: `Supplemental import failed: ${e.message}` });
    }

    send('refresh-progress', {
      type: 'status',
      text: `Done. ${newHits.length} new filing(s), ${parsedCount} trade(s).`,
    });
    send('trades-updated');

    // Committee-relevant buys get their own loud notification — the
    // backtested edge worth acting on fast.
    if (committeeHits.length > 0) {
      const lines = committeeHits.slice(0, 3).map((h) => `${h.ticker} — ${h.member} (${h.committee})`);
      new Notification({
        title: '🏛 Committee signal',
        body: lines.join('\n'),
        urgency: 'critical',
      }).show();
      send('refresh-progress', { type: 'status', text: `🏛 Committee signal: ${committeeHits.map((h) => h.ticker).join(', ')}` });
    } else if (parsedCount > 0) {
      const title = background ? 'Congress Trades — background update' : 'Congress Trades';
      const buyerList = [...buyers].slice(0, 3).join(', ');
      new Notification({
        title,
        body: `${newHits.length} new filing(s), ${parsedCount} trade(s)${buyerList ? `. Buyers: ${buyerList}` : ''}`,
      }).show();
    }

    return { ok: true, totalFilings: all.length, watchlistHits: hits.length, newFilings: newHits.length, newTransactions: parsedCount };
  } catch (e) {
    send('refresh-progress', { type: 'status', text: `Error: ${e.message}` });
    return { ok: false, error: e.message };
  } finally {
    refreshInFlight = false;
  }
}

function scheduleAutoRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  const config = loadConfig(CONFIG_FILE);
  const minutes = Number(config.autoRefreshMinutes) || 0;
  if (minutes <= 0) return;
  refreshTimer = setInterval(() => {
    runRefresh({ background: true }).catch((e) => console.error('auto-refresh failed', e));
  }, minutes * 60_000);
  console.log(`Auto-refresh scheduled every ${minutes} min.`);
}

// Exactly one instance: two copies racing on portfolio.json corrupts the
// user's real-money record. A second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  createWindow();
  const config = loadConfig(CONFIG_FILE);
  if (config.refreshOnLaunch) {
    // Skip the launch refresh entirely if the last one was recent — the app
    // opens instantly on existing data and the hourly cycle takes over.
    const st = loadState(STATE_FILE);
    const freshMs = 30 * 60_000;
    const isFresh = st.lastRun && Date.now() - Date.parse(st.lastRun) < freshMs;
    if (!isFresh) {
      // Wait for renderer to be ready so progress messages reach it.
      setTimeout(() => runRefresh({ background: true }), 3000);
    }
  }
  scheduleAutoRefresh();

  // Self-update from GitHub releases — user-consent flow like a typical app:
  // check quietly, then ask in-app before downloading or installing anything.
  if (app.isPackaged) {
    autoUpdater.autoDownload = false;
    autoUpdater.on('update-available', (info) => {
      send('update-available', { version: info.version, notes: info.releaseNotes || '' });
    });
    autoUpdater.on('download-progress', (p) => {
      send('update-progress', { percent: Math.round(p.percent) });
    });
    autoUpdater.on('update-downloaded', (info) => {
      send('update-ready', { version: info.version });
    });
    autoUpdater.on('error', (e) => {
      send('update-error', { message: e?.message || 'update failed' });
    });
    // Unsigned builds sometimes fail differential updates — force full download.
    autoUpdater.disableDifferentialDownload = true;
    autoUpdater.checkForUpdates().catch(() => {});
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 3600_000);
  }
});

ipcMain.handle('update-download', () => { autoUpdater.downloadUpdate().catch(() => {}); });
ipcMain.handle('update-install', () => { autoUpdater.quitAndInstall(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ---------- IPC ----------

ipcMain.handle('get-config', () => loadConfig(CONFIG_FILE));

ipcMain.handle('save-config', (_e, config) => {
  saveConfig(CONFIG_FILE, config);
  scheduleAutoRefresh(); // pick up new interval
  return loadConfig(CONFIG_FILE);
});

ipcMain.handle('open-pdf', (_e, url) => shell.openExternal(url));

ipcMain.handle('list-trades', () =>
  collectAllTrades().sort((a, b) => new Date(b.transaction_date) - new Date(a.transaction_date)),
);

ipcMain.handle('refresh', () => runRefresh());

ipcMain.handle('reset-state', () => {
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  return true;
});

// Ranked buy candidates: everything Congress bought recently, scored.
ipcMain.handle('compute-picks', async (event, { windowDays = 60 } = {}) => {
  const cachedPicks = readComputed(`picks-${windowDays}`);
  if (cachedPicks) return cachedPicks;
  const send = (text) => event.sender.send('refresh-progress', { type: 'status', text });
  const all = collectAllTrades();
  const cutoff = Date.now() - windowDays * 86400_000;

  const parseUs = (s) => {
    const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(s || '');
    return m ? Date.parse(`${m[3]}-${m[1]}-${m[2]}`) : null;
  };

  // Per-member historical quality: average kadoa ret_since across their past buys.
  const memberRets = new Map();
  const memberTradeCounts = new Map();
  for (const t of all) {
    memberTradeCounts.set(t.member, (memberTradeCounts.get(t.member) || 0) + 1);
    if (t.transaction_type === 'P' && typeof t.ret_since === 'number') {
      if (!memberRets.has(t.member)) memberRets.set(t.member, []);
      memberRets.get(t.member).push(t.ret_since);
    }
  }
  const memberQuality = new Map(
    [...memberRets].map(([m, rets]) => [m, rets.reduce((a, b) => a + b, 0) / rets.length]),
  );
  // Conviction weight: a member with hundreds of trades is almost certainly a
  // professionally managed account robo-rebalancing (e.g. Cisneros's Morgan
  // Stanley UMA) — each individual buy carries little intent. A member with a
  // handful of deliberate trades carries full weight.
  const convictionWeight = (m) => Math.min(1, 50 / (memberTradeCounts.get(m) || 1));

  // Group recent buys by ticker.
  const groups = new Map();
  for (const t of all) {
    if (!t.ticker || t.asset_type === 'OP') continue;
    const ts = parseUs(t.transaction_date);
    if (!ts || ts < cutoff || ts > Date.now()) continue;
    if (!groups.has(t.ticker)) {
      groups.set(t.ticker, { ticker: t.ticker, asset: t.asset, buyers: new Set(), sellers: new Set(), firstBuyTs: Infinity, lastBuyTs: 0 });
    }
    const g = groups.get(t.ticker);
    if (t.transaction_type === 'P') {
      g.buyers.add(t.member);
      g.firstBuyTs = Math.min(g.firstBuyTs, ts);
      g.lastBuyTs = Math.max(g.lastBuyTs, ts);
    } else if (t.transaction_type.startsWith('S')) {
      g.sellers.add(t.member);
    }
  }

  const candidates = [...groups.values()].filter((g) => g.buyers.size > 0);
  send(`Pricing ${candidates.length} congressional buy candidates...`);

  let i = 0;
  const picks = [];
  for (const g of candidates) {
    i++;
    if (i % 15 === 0) send(`Pricing ${i}/${candidates.length}...`);
    const p = await fetchSpotAndHistory(g.ticker, g.firstBuyTs - 7 * 86400_000, PRICE_CACHE);
    if (!p.lastClose) continue;
    const entryDate = new Date(g.firstBuyTs).toISOString().slice(0, 10);
    const entry = closeOnOrAfter(p.series, entryDate);
    const runup = entry ? (p.lastClose - entry) / entry : null;

    const buyerQ = [...g.buyers].map((m) => memberQuality.get(m)).filter((q) => q != null);
    const avgQuality = buyerQ.length ? buyerQ.reduce((a, b) => a + b, 0) / buyerQ.length : 0;

    const daysSince = (Date.now() - g.lastBuyTs) / 86400_000;
    const recency = Math.max(0, 1 - daysSince / windowDays); // 1 fresh → 0 stale

    // Conviction = sum of per-buyer weights (hyperactive managed accounts ≈ 0).
    const conviction = [...g.buyers].reduce((a, m) => a + convictionWeight(m), 0);

    // Committee relevance: any buyer whose committee oversees this sector.
    // Backtested as the strongest signal in the dataset (+2.45%/trade EV).
    let committee = null;
    for (const m of g.buyers) {
      const rel = await tradeRelevance(m, g.ticker);
      if (rel.relevant) { committee = rel.committee; break; }
    }
    const secInfo = await sectorFor(g.ticker, SECTOR_CACHE);
    const otc = !!secInfo.otc;

    // Composite score, tuned for "follow deliberate buyers early":
    //  committee relevance is the strongest backtested edge, then
    //  conviction-weighted consensus, buyer quality, freshness,
    //  bonus if price hasn't run up yet, penalty for member sells.
    const score =
      (committee ? 5 : 0) +
      conviction * 4 +
      Math.max(-2, Math.min(2, avgQuality / 10)) * 2 +
      recency * 2 +
      (runup != null && runup < 0.05 ? 2 : 0) +
      (runup != null && runup < 0 ? 1 : 0) -
      g.sellers.size * 2;

    // Human-readable rationale so the ranking never looks arbitrary.
    const reasons = [];
    if (committee) reasons.push(`🏛 committee oversight: ${committee}`);
    if (g.buyers.size > 1) reasons.push(`${g.buyers.size} members buying`);
    if (conviction >= 0.8) reasons.push('deliberate buy (low-volume filer)');
    if (conviction < 0.3) reasons.push('managed-account flow (weak intent)');
    if (avgQuality > 5) reasons.push(`buyers avg +${Math.round(avgQuality)}% historically`);
    if (daysSince <= 10) reasons.push('fresh filing');
    if (runup != null && runup < 0) reasons.push('cheaper than their entry');
    else if (runup != null && runup < 0.05) reasons.push('hasn’t run up yet');
    else if (runup != null) reasons.push(`already +${Math.round(runup * 100)}% since entry`);
    if (g.sellers.size > 0) reasons.push(`${g.sellers.size} member(s) selling`);
    if (otc) reasons.push('⚠ OTC — not TFSA-eligible');

    picks.push({
      ticker: g.ticker,
      asset: g.asset,
      price: Math.round(p.lastClose * 100) / 100,
      buyers: g.buyers.size,
      buyerNames: [...g.buyers].slice(0, 4),
      sellers: g.sellers.size,
      lastBuy: new Date(g.lastBuyTs).toISOString().slice(0, 10),
      runupPct: runup != null ? Math.round(runup * 1000) / 10 : null,
      avgBuyerReturn: Math.round(avgQuality * 10) / 10,
      conviction: Math.round(conviction * 100) / 100,
      committee,
      otc,
      companyName: secInfo.name || g.asset || null,
      exchangeName: secInfo.exchangeName || null,
      reasons,
      score: Math.round(score * 10) / 10,
    });
  }

  picks.sort((a, b) => b.score - a.score);
  send(`Done — ${picks.length} candidates scored.`);
  writeComputed(`picks-${windowDays}`, picks);
  return picks;
});

ipcMain.handle('fx-rate', async () => {
  const fx = await fetchSpotAndHistory('USDCAD=X', Date.now() - 7 * 86400_000, PRICE_CACHE);
  return fx.lastClose || 1.37;
});

// ---------- Personal portfolio ----------
ipcMain.handle('portfolio-get', () => loadPortfolio());
ipcMain.handle('portfolio-save', (_e, p) => savePortfolio(p));
ipcMain.handle('portfolio-add', async (_e, pos) => {
  const p = loadPortfolio();
  // Freeze the cost-basis price NOW. Uses the user's manual fill price if they
  // typed one (pos.manualEntryUsd), else snapshots the best price at log time.
  // entryUsd is persisted and never recomputed on later valuations.
  const patch = await freezeEntry(pos, PRICE_CACHE);
  const { manualEntryUsd, ...clean } = pos;
  p.positions.push({ ...clean, ...patch, id: `pos_${Date.now()}` });
  return savePortfolio(p);
});
ipcMain.handle('portfolio-remove', (_e, id) => {
  const p = loadPortfolio();
  p.positions = p.positions.filter((x) => x.id !== id);
  return savePortfolio(p);
});
// Let the user correct a position's frozen entry price to their real WS fill.
// Passing a positive number overrides the basis; null/0 re-freezes from price
// history. Marked 'manual' so backfill never silently overwrites it.
ipcMain.handle('portfolio-set-entry', async (_e, { id, entryUsd }) => {
  const p = loadPortfolio();
  const pos = p.positions.find((x) => x.id === id);
  if (!pos) return p;
  const v = Number(entryUsd);
  if (Number.isFinite(v) && v > 0) {
    pos.entryUsd = Math.round(v * 100) / 100;
    pos.entrySource = 'manual';
  } else {
    // Re-derive from price history (drop the existing basis so freezeEntry runs).
    delete pos.entryUsd;
    delete pos.entrySource;
    const patch = await freezeEntry(pos, PRICE_CACHE);
    Object.assign(pos, patch);
    if (pos.entryUsd != null) pos.entrySource = 'close';
  }
  return savePortfolio(p);
});
ipcMain.handle('portfolio-value', () => valuePortfolio(PRICE_CACHE));

// All trades grouped + summarized per member, for the Members tab.
ipcMain.handle('list-members', () => {
  const trades = collectAllTrades();
  const map = new Map();
  for (const t of trades) {
    if (!t.member) continue;
    if (!map.has(t.member)) {
      map.set(t.member, { name: t.member, state_district: t.state_district, trades: [], tickers: new Set() });
    }
    const m = map.get(t.member);
    m.trades.push(t);
    if (t.ticker) m.tickers.add(t.ticker);
  }
  return [...map.values()]
    .map((m) => ({
      name: m.name,
      state_district: m.state_district,
      tradeCount: m.trades.length,
      tickerCount: m.tickers.size,
      lastTradeDate: m.trades.map((t) => t.transaction_date).sort().pop(),
    }))
    .sort((a, b) => b.tradeCount - a.tradeCount);
});

ipcMain.handle('get-member-dossier', async (_e, name) => {
  const trades = collectAllTrades().filter((t) => t.member === name);
  if (trades.length === 0) return null;

  // Try to split "First Last" or "Hon. First Middle Last" into (first, last) for bioguide lookup.
  const parts = name.replace(/^Hon\.?\s+/i, '').split(/\s+/);
  const first = parts[0];
  const last = parts[parts.length - 1];
  const info = await lookupMember({ first, last }, MEMBER_CACHE);

  // Aggregate holdings by ticker.
  const byTicker = new Map();
  for (const t of trades) {
    if (!t.ticker) continue;
    if (!byTicker.has(t.ticker)) byTicker.set(t.ticker, { ticker: t.ticker, buys: 0, sells: 0, asset: t.asset, last: t.transaction_date });
    const h = byTicker.get(t.ticker);
    if (t.transaction_type === 'P') h.buys++;
    else if (t.transaction_type.startsWith('S')) h.sells++;
    if (t.transaction_date > h.last) h.last = t.transaction_date;
  }
  const holdings = [...byTicker.values()].sort((a, b) => (b.buys + b.sells) - (a.buys + a.sells));

  const buys = trades.filter((t) => t.transaction_type === 'P').length;
  const sells = trades.filter((t) => t.transaction_type.startsWith('S')).length;

  return {
    name,
    info,
    tradeCount: trades.length,
    buys,
    sells,
    uniqueTickers: byTicker.size,
    holdings,
    trades: trades.slice(0, 50),
  };
});

// Per-trade gains for the Trades tab. Returns { "docId|ticker|txdate": { entry, last, ret } }.
ipcMain.handle('compute-gains', async (event) => {
  const cached = readComputed('gains');
  if (cached) return cached;
  const send = (text) => event.sender.send('refresh-progress', { type: 'status', text });
  const all = collectAllTrades().filter((t) => t.ticker && t.asset_type !== 'OP');
  const tickers = [...new Set(all.map((t) => t.ticker))];
  send(`Fetching prices for ${tickers.length} tickers...`);

  const earliestTs = Math.min(
    ...all.map((t) => {
      const iso = parseFilingDate(correctedTxDate(t));
      return iso ? Date.parse(iso) : Date.now();
    }),
  );

  const priceMap = {};
  let i = 0;
  for (const tk of tickers) {
    i++;
    if (i % 20 === 0) send(`Fetching prices ${i}/${tickers.length}...`);
    priceMap[tk] = await fetchSpotAndHistory(tk, earliestTs, PRICE_CACHE);
  }

  const gains = {};
  for (const t of all) {
    const p = priceMap[t.ticker];
    const iso = parseFilingDate(correctedTxDate(t));
    if (!p || !iso || !p.lastClose) continue;
    const entry = closeOnOrAfter(p.series, iso);
    if (!entry) continue;
    const ret = (p.lastClose - entry) / entry;
    if (!isFinite(ret)) continue;
    gains[`${t.doc_id}|${t.ticker}|${t.transaction_date}`] = {
      entry: Math.round(entry * 100) / 100,
      last: Math.round(p.lastClose * 100) / 100,
      ret,
    };
  }
  send(`Done — gains computed for ${Object.keys(gains).length} trades.`);
  writeComputed('gains', gains);
  return gains;
});

// Mirror of the renderer's off-by-one-year typo correction (tx date after notification date).
function correctedTxDate(t) {
  const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(t.transaction_date || '');
  const n = /(\d{2})\/(\d{2})\/(\d{4})/.exec(t.notification_date || '');
  if (m && n) {
    const tx = Date.parse(`${m[3]}-${m[1]}-${m[2]}`);
    const nf = Date.parse(`${n[3]}-${n[1]}-${n[2]}`);
    if (tx > nf + 86400_000) return `${m[1]}/${m[2]}/${Number(m[3]) - 1}`;
  }
  return t.transaction_date;
}

ipcMain.handle('compute-performance', async (event, { metric = 'avg', minTrades = 3 } = {}) => {
  const send = (text) => event.sender.send('perf-progress', text);
  const trades = collectAllTrades().filter((t) => t.transaction_type === 'P' && t.ticker && t.asset_type !== 'OP');
  const tickers = [...new Set(trades.map((t) => t.ticker))];
  send(`Fetching prices for ${tickers.length} tickers from Yahoo...`);

  // Earliest tx date across all trades — used as period1 for Yahoo.
  const earliestTs = Math.min(
    ...trades.map((t) => {
      const iso = parseFilingDate(t.transaction_date);
      return iso ? Date.parse(iso) : Date.now();
    }),
  );

  let i = 0;
  const priceMap = {};
  for (const tk of tickers) {
    i++;
    if (i % 10 === 0) send(`Fetching prices ${i}/${tickers.length}...`);
    priceMap[tk] = await fetchSpotAndHistory(tk, earliestTs, PRICE_CACHE);
  }

  send('Computing per-member returns...');
  const byMember = new Map();
  for (const t of trades) {
    const dt = parseFilingDate(t.transaction_date);
    const p = priceMap[t.ticker];
    if (!p || !dt || !p.lastClose) continue;
    const entry = closeOnOrAfter(p.series, dt);
    if (!entry || !p.lastClose) continue;
    const ret = (p.lastClose - entry) / entry;
    if (!isFinite(ret)) continue;
    if (!byMember.has(t.member)) byMember.set(t.member, { member: t.member, rets: [] });
    byMember.get(t.member).rets.push(ret);
  }

  const rows = [...byMember.values()]
    .filter((m) => m.rets.length >= minTrades)
    .map((m) => {
      const avg = m.rets.reduce((a, b) => a + b, 0) / m.rets.length;
      const winRate = m.rets.filter((r) => r > 0).length / m.rets.length;
      return { member: m.member, n: m.rets.length, avg, winRate };
    });

  rows.sort((a, b) => (metric === 'winrate' ? b.winRate - a.winRate : b.avg - a.avg));
  send(`Done — ${rows.length} members with ≥${minTrades} valid buys.`);
  return rows;
});

function collectAllTrades() {
  if (!fs.existsSync(TRADES_DIR)) return [];
  const files = fs.readdirSync(TRADES_DIR).filter((f) => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(TRADES_DIR, f), 'utf8'));
      for (const t of data.transactions || []) {
        out.push({
          ...t,
          member: data.member,
          doc_id: data.doc_id,
          state_district: data.state_district,
          chamber: data.chamber || 'house',
          party: data.party || null,
          // Exact PDF URL (carries the right year for backfilled filings).
          doc_url: t.doc_url || (typeof data.source === 'string' && data.source.startsWith('http') ? data.source : null),
        });
      }
    } catch {}
  }
  return out;
}
