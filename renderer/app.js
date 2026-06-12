(() => {
const api = window.api;

const $ = (sel) => document.querySelector(sel);
const statusEl = $('#status');
const memberFilter = $('#member-filter');
const typeFilter = $('#type-filter');
const searchEl = $('#search');
const tbody = $('#trades-table tbody');
const emptyEl = $('#empty');
const statsEl = $('#stats');

let allTrades = [];
let currentConfig = null;
let sortKey = 'signal';
let sortDir = 'desc';
let gainsMap = null; // "docId|ticker|txdate" -> { entry, last, ret }

function gainFor(t) {
  const fromYahoo = gainsMap && gainsMap[`${t.doc_id}|${t.ticker}|${t.transaction_date}`];
  if (fromYahoo) return fromYahoo;
  // kadoa rows ship a precomputed return-since-transaction (percent).
  if (typeof t.ret_since === 'number') return { entry: null, last: null, ret: t.ret_since / 100 };
  return null;
}

function gainCell(t) {
  const g = gainFor(t);
  if (!g) return '<span class="muted">—</span>';
  const pct = (g.ret * 100).toFixed(1);
  const color = g.ret >= 0 ? '#22c55e' : '#ef4444';
  const sign = g.ret >= 0 ? '+' : '';
  const title = g.entry != null ? `Entry $${g.entry} → now $${g.last}` : 'Precomputed return since transaction';
  return `<span style="color:${color};font-weight:600" title="${title}">${sign}${pct}%</span>`;
}
let signalByTicker = new Map();  // ticker -> distinct-member buy count in last 30d

function buildSignalIndex() {
  const cutoff = Date.now() - 30 * 86400_000;
  signalByTicker = new Map();
  const seen = new Map(); // ticker -> Set(member)
  for (const t of allTrades) {
    if (!t.ticker) continue;
    if (t.transaction_type !== 'P') continue;
    const dt = parseDate(t.transaction_date);
    if (!dt || dt < cutoff) continue;
    if (!seen.has(t.ticker)) seen.set(t.ticker, new Set());
    seen.get(t.ticker).add(t.member);
  }
  for (const [k, s] of seen) signalByTicker.set(k, s.size);
}

function signalFor(t) {
  if (!t.ticker || t.transaction_type !== 'P') return 0;
  return signalByTicker.get(t.ticker) || 0;
}

function signalPill(n) {
  const cls = `signal-${Math.min(n, 5)}`;
  return `<span class="signal-pill ${cls}">${n || ''}</span>`;
}

function amountMidpoint(range) {
  // e.g. "$1,001 - $15,000" -> 8000.5
  const m = /\$([\d,]+)\s*-\s*\$?([\d,]+)/.exec(range || '');
  if (!m) return 0;
  const lo = Number(m[1].replace(/,/g, ''));
  const hi = Number(m[2].replace(/,/g, ''));
  return (lo + hi) / 2;
}

async function ensureConfig() {
  if (!currentConfig) currentConfig = await api.getConfig();
  return currentConfig;
}

function showToast(text, kind = 'success') {
  const t = $('#toast');
  t.textContent = text;
  t.className = `toast ${kind}`;
  setTimeout(() => t.classList.add('fade-out'), 1800);
  setTimeout(() => t.classList.add('hidden'), 2200);
}

function shortType(t) {
  if (t === 'P') return 'BUY';
  if (t === 'S') return 'SELL';
  if (t === 'S (partial)') return 'SELL (part)';
  if (t === 'E') return 'EXCHANGE';
  return t;
}

function typeClass(t) {
  if (t === 'P') return 'type-P';
  if (t === 'S' || t === 'S (partial)') return 'type-S';
  if (t === 'E') return 'type-E';
  return '';
}

function fmtFiled(t) {
  if (t.doc_url) return `<a href="#" data-href="${t.doc_url}" class="muted">PDF↗</a>`;
  if (String(t.doc_id).startsWith('kadoa_')) return '<span class="muted">—</span>';
  return `<a href="#" data-doc="${t.doc_id}" class="muted">PDF↗</a>`;
}

function copyButtonHtml(t) {
  if (!t.ticker) return '<button class="copy-btn disabled" disabled title="No ticker">—</button>';
  if (t.asset_type === 'OP') return '<button class="copy-btn disabled" disabled title="Option — Wealthsimple Trade does not support options">opt</button>';
  const action = t.transaction_type === 'P' ? 'BUY' : 'SELL';
  return `<button class="copy-btn" data-ticker="${t.ticker}" data-action="${action}">📋 ${action}</button>`;
}

function render() {
  const memberSel = memberFilter.value;
  const typeSel = typeFilter.value;
  const q = searchEl.value.trim().toLowerCase();

  const rows = allTrades.filter((t) => {
    if (memberSel && t.member !== memberSel) return false;
    if (typeSel && t.transaction_type !== typeSel) return false;
    if (q) {
      const hay = `${t.ticker || ''} ${t.asset || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const dir = sortDir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    let av, bv;
    switch (sortKey) {
      case 'signal':
        av = signalFor(a); bv = signalFor(b);
        if (av === bv) { av = effectiveTxDate(a).ms; bv = effectiveTxDate(b).ms; }
        break;
      case 'date': av = effectiveTxDate(a).ms; bv = effectiveTxDate(b).ms; break;
      case 'member': return (a.member || '').localeCompare(b.member || '') * dir;
      case 'type': return (a.transaction_type || '').localeCompare(b.transaction_type || '') * dir;
      case 'ticker': return (a.ticker || 'zzz').localeCompare(b.ticker || 'zzz') * dir;
      case 'amount': av = amountMidpoint(a.amount_range); bv = amountMidpoint(b.amount_range); break;
      case 'gain': {
        const ga = gainFor(a), gb = gainFor(b);
        av = ga ? ga.ret : -Infinity; bv = gb ? gb.ret : -Infinity;
        break;
      }
      default: av = 0; bv = 0;
    }
    return (av - bv) * dir;
  });

  document.querySelectorAll('th.sortable').forEach((th) => {
    const active = th.dataset.sort === sortKey;
    th.classList.toggle('active', active);
    const label = th.textContent.replace(/[▾▴]\s*$/, '').trim();
    th.innerHTML = active ? `${label} ${sortDir === 'asc' ? '▴' : '▾'}` : label;
  });

  tbody.innerHTML = rows.map((t) => {
    const eff = effectiveTxDate(t);
    return `
    <tr>
      <td>${signalPill(signalFor(t))}</td>
      <td title="${eff.suspect ? `Filer wrote ${t.transaction_date} but notified ${t.notification_date} — likely off-by-one-year typo` : ''}">${eff.display}${eff.suspect ? ' <span style="color:#f59e0b" title="suspected typo in PDF">⚠</span>' : ''}</td>
      <td>${fmtFiled(t)}</td>
      <td>${t.member || ''}${t.chamber === 'senate' ? ' <span class="muted" style="font-size:10px">SEN</span>' : ''}${t.party ? ` <span class="muted" style="font-size:10px">(${t.party})</span>` : ''}</td>
      <td class="${typeClass(t.transaction_type)}">${shortType(t.transaction_type)}</td>
      <td class="ticker">${t.ticker || '—'}</td>
      <td>${t.amount_range}</td>
      <td>${gainCell(t)}</td>
      <td title="${(t.asset || '').replace(/"/g, '&quot;')}">${(t.asset || '').slice(0, 60)}</td>
      <td>${copyButtonHtml(t)}</td>
    </tr>
  `;
  }).join('');

  emptyEl.classList.toggle('hidden', rows.length > 0);

  const buys = rows.filter((t) => t.transaction_type === 'P').length;
  const sells = rows.filter((t) => t.transaction_type.startsWith('S')).length;
  const members = new Set(rows.map((t) => t.member)).size;
  statsEl.innerHTML = `
    <div class="row"><span class="muted">Total</span><span class="num">${rows.length}</span></div>
    <div class="row"><span class="muted">Buys</span><span class="num">${buys}</span></div>
    <div class="row"><span class="muted">Sells</span><span class="num">${sells}</span></div>
    <div class="row"><span class="muted">Members</span><span class="num">${members}</span></div>
  `;

  tbody.querySelectorAll('a[data-doc]').forEach((a) => {
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      const cfg = await ensureConfig();
      const url = `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${cfg.year}/${a.dataset.doc}.pdf`;
      api.openPdf(url);
    });
  });

  tbody.querySelectorAll('a[data-href]').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); api.openPdf(a.dataset.href); });
  });

  tbody.querySelectorAll('button.copy-btn[data-ticker]').forEach((b) => {
    b.addEventListener('click', async () => {
      const cfg = await ensureConfig();
      const ticker = b.dataset.ticker;
      const action = b.dataset.action;
      const amount = cfg.copyTradeAmountCad ?? 500;
      await navigator.clipboard.writeText(ticker);
      showToast(`📋 ${ticker} copied — ${action} ~CA$${amount} on Wealthsimple`);
    });
  });
}

function populateMemberFilter() {
  const members = [...new Set(allTrades.map((t) => t.member).filter(Boolean))].sort();
  memberFilter.innerHTML = '<option value="">All members</option>' +
    members.map((m) => `<option value="${m}">${m}</option>`).join('');
}

async function reload() {
  allTrades = await api.listTrades();
  buildSignalIndex();
  populateMemberFilter();
  render();
}

document.querySelectorAll('th.sortable').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (sortKey === key) {
      sortDir = sortDir === 'desc' ? 'asc' : 'desc';
    } else {
      sortKey = key;
      sortDir = ['date', 'signal', 'amount'].includes(key) ? 'desc' : 'asc';
    }
    render();
  });
});

// ---------- Auto-compute orchestration ----------
// Everything recomputes itself: no manual data buttons.
const STALE_MS = 30 * 60_000;
let gainsAt = 0, picksAt = 0, perfAt = 0;
let gainsBusy = false, picksBusy = false, perfBusy = false;
let gainsTimer = null;

async function autoGains(force = false) {
  if (gainsBusy) return;
  if (!force && Date.now() - gainsAt < STALE_MS) return;
  gainsBusy = true;
  try {
    gainsMap = await api.computeGains();
    gainsAt = Date.now();
    render();
  } catch {} finally { gainsBusy = false; }
}

async function autoPicks(force = false) {
  if (picksBusy) return;
  if (!force && Date.now() - picksAt < STALE_MS) return;
  picksBusy = true;
  try {
    const picks = await api.computePicks({ windowDays: Number($('#picks-window').value) });
    picksAt = Date.now();
    renderPicks(picks);
  } catch {} finally { picksBusy = false; }
}

async function autoPerf(force = false) {
  if (perfBusy) return;
  if (!force && Date.now() - perfAt < STALE_MS) return;
  perfBusy = true;
  try {
    const metric = $('#perf-metric').value;
    const minTrades = Number($('#perf-min').value) || 3;
    const rows = await api.computePerformance({ metric, minTrades });
    perfAt = Date.now();
    drawPerfChart(rows, metric);
  } catch {} finally { perfBusy = false; }
}

// After any data refresh settles, recompute everything stale (debounced —
// trades-updated fires repeatedly during a long refresh).
function scheduleRecompute() {
  clearTimeout(gainsTimer);
  gainsTimer = setTimeout(() => {
    gainsAt = 0; picksAt = 0; perfAt = 0;
    autoGains(true);
    const active = document.querySelector('.tab.active')?.dataset.tab;
    if (active === 'picks') autoPicks(true);
    if (active === 'performance') autoPerf(true);
    if (active === 'portfolio') refreshPortfolio();
  }, 8000);
}

$('#open-ws').addEventListener('click', async () => {
  const cfg = await ensureConfig();
  api.openPdf(cfg.wealthsimpleTradeUrl || 'https://my.wealthsimple.com/app/trade');
});

api.onProgress((msg) => {
  if (msg.type === 'status') statusEl.textContent = msg.text;
});
api.onTradesUpdated(() => { reload(); scheduleRecompute(); });

memberFilter.addEventListener('change', render);
typeFilter.addEventListener('change', render);
searchEl.addEventListener('input', render);

// Settings modal
const modal = $('#settings-modal');
$('#settings-btn').addEventListener('click', async () => {
  const cfg = await api.getConfig();
  $('#cfg-year').value = cfg.year;
  $('#cfg-lookback').value = cfg.lookbackDays;
  $('#cfg-autorefresh').value = cfg.autoRefreshMinutes ?? 60;
  $('#cfg-amount').value = cfg.copyTradeAmountCad ?? 500;
  $('#cfg-watchlist').value = (cfg.watchlist || []).join('\n');
  modal.classList.remove('hidden');
});
$('#cfg-cancel').addEventListener('click', () => modal.classList.add('hidden'));
$('#cfg-save').addEventListener('click', async () => {
  currentConfig = await api.saveConfig({
    year: Number($('#cfg-year').value),
    lookbackDays: Number($('#cfg-lookback').value),
    autoRefreshMinutes: Number($('#cfg-autorefresh').value),
    copyTradeAmountCad: Number($('#cfg-amount').value),
    refreshOnLaunch: true,
    wealthsimpleTradeUrl: 'https://my.wealthsimple.com/app/trade',
    watchlist: $('#cfg-watchlist').value.split('\n').map((s) => s.trim()).filter(Boolean),
    minTransactionUsd: 0,
  });
  modal.classList.add('hidden');
  showToast('Settings saved');
});
$('#reset-state-btn').addEventListener('click', async () => {
  await api.resetState();
  statusEl.textContent = 'Seen-history cleared. Next refresh will re-fetch everything.';
});

// ---------- Tabs ----------
const panes = document.querySelectorAll('.tab-pane');
const tabs = document.querySelectorAll('.tab');
tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.toggle('active', t === tab));
    panes.forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== tab.dataset.tab));
    if (tab.dataset.tab === 'consensus') renderConsensus();
    if (tab.dataset.tab === 'members') loadMembersList();
    if (tab.dataset.tab === 'performance') autoPerf();
    if (tab.dataset.tab === 'picks') autoPicks();
    if (tab.dataset.tab === 'portfolio') refreshPortfolio();
  });
});

// ---------- Consensus tab ----------
function renderConsensus() {
  const windowDays = Number($('#consensus-window').value);
  const minMembers = Number($('#consensus-min').value);
  const dir = $('#consensus-dir').value;

  const cutoff = Date.now() - windowDays * 86400_000;
  const filtered = allTrades.filter((t) => {
    if (!t.ticker) return false;
    if (dir !== 'all') {
      if (dir === 'P' && t.transaction_type !== 'P') return false;
      if (dir === 'S' && !t.transaction_type.startsWith('S')) return false;
    }
    const dt = parseDate(t.transaction_date);
    return dt && dt >= cutoff;
  });

  const byTicker = new Map();
  for (const t of filtered) {
    if (!byTicker.has(t.ticker)) byTicker.set(t.ticker, { ticker: t.ticker, members: new Map(), buys: 0, sells: 0, dates: [] });
    const g = byTicker.get(t.ticker);
    g.members.set(t.member, true);
    g.dates.push(t.transaction_date);
    if (t.transaction_type === 'P') g.buys++;
    else if (t.transaction_type.startsWith('S')) g.sells++;
  }

  const rows = [...byTicker.values()]
    .filter((g) => g.members.size >= minMembers)
    .map((g) => ({
      ...g,
      memberCount: g.members.size,
      memberList: [...g.members.keys()],
      earliest: [...g.dates].sort()[0],
      latest: [...g.dates].sort().pop(),
    }))
    .sort((a, b) => b.memberCount - a.memberCount || (b.buys + b.sells) - (a.buys + a.sells));

  const tbody2 = $('#consensus-table tbody');
  tbody2.innerHTML = rows.map((g) => `
    <tr>
      <td class="ticker">${g.ticker}</td>
      <td><span class="num" style="font-weight:600">${g.memberCount}</span></td>
      <td><span class="type-P">${g.buys} BUY</span>${g.sells ? ` / <span class="type-S">${g.sells} SELL</span>` : ''}</td>
      <td>${g.earliest}</td>
      <td>${g.latest}</td>
      <td class="members-cell" title="${g.memberList.join(', ')}">${g.memberList.join(', ')}</td>
    </tr>
  `).join('');
  $('#consensus-empty').classList.toggle('hidden', rows.length > 0);
}

function parseDate(s) {
  const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(s || '');
  if (!m) return null;
  return Date.parse(`${m[3]}-${m[1]}-${m[2]}`);
}

// Politicians sometimes mistype the year on the Tx Date column (e.g. wrote 2026 instead
// of 2025 in a January filing). If Tx Date > Notification Date, treat it as off-by-one.
function effectiveTxDate(t) {
  const tx = parseDate(t.transaction_date);
  const nf = parseDate(t.notification_date);
  if (tx && nf && tx > nf + 86400_000) {
    // Decrement year on the display string for sort.
    const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(t.transaction_date);
    if (m) {
      const corrected = `${m[1]}/${m[2]}/${Number(m[3]) - 1}`;
      return { ms: parseDate(corrected), display: corrected, suspect: true };
    }
  }
  return { ms: tx || 0, display: t.transaction_date, suspect: false };
}

['consensus-window', 'consensus-min', 'consensus-dir'].forEach((id) =>
  $('#' + id).addEventListener('change', renderConsensus),
);

// ---------- Members tab ----------
// Generates a colored-circle-with-initials avatar as an SVG data URI.
function initialsAvatar(name, size = 80) {
  const parts = (name || '?').replace(/^Hon\.?\s+/i, '').split(/\s+/).filter(Boolean);
  const initials = ((parts[0]?.[0] || '') + (parts[parts.length - 1]?.[0] || '')).toUpperCase();
  // Deterministic hue from the name so each member keeps their color.
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" fill="hsl(${h},35%,24%)"/>
    <text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle"
      font-family="Segoe UI,sans-serif" font-weight="600" font-size="${size * 0.38}"
      fill="hsl(${h},45%,75%)">${initials}</text>
  </svg>`;
  return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
}

async function loadMembersList() {
  const members = await api.listMembers();
  const list = $('#members-list');
  list.innerHTML = members.map((m) => `
    <div class="member-row" data-member="${m.name.replace(/"/g, '&quot;')}">
      <img loading="lazy" src="${initialsAvatar(m.name, 36)}" data-name="${m.name.replace(/"/g, '&quot;')}" />
      <div class="info">
        <div class="name">${m.name}</div>
        <div class="meta">${m.state_district || ''} • ${m.tradeCount} trades</div>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.member-row').forEach((row) => {
    row.addEventListener('click', () => {
      list.querySelectorAll('.member-row').forEach((r) => r.classList.remove('active'));
      row.classList.add('active');
      showDossier(row.dataset.member);
    });
  });

  // Upgrade placeholders to real photos where available; fall back on error.
  for (const img of list.querySelectorAll('img[data-name]')) {
    const fallback = img.src;
    api.getMemberDossier(img.dataset.name).then((d) => {
      if (d?.info?.photoUrl) {
        img.onerror = () => { img.onerror = null; img.src = fallback; };
        img.src = d.info.photoUrl;
      }
    });
  }
}

async function showDossier(name) {
  const d = $('#dossier');
  d.innerHTML = '<div class="empty">Loading dossier...</div>';
  const data = await api.getMemberDossier(name);
  if (!data) { d.innerHTML = '<div class="empty">Not found.</div>'; return; }
  const i = data.info || {};
  const fallbackAvatar = initialsAvatar(data.name, 150);
  const photo = `<img src="${i.photoUrl || fallbackAvatar}" onerror="this.onerror=null;this.src='${fallbackAvatar}'" />`;
  const age = i.birthYear ? `${new Date().getFullYear() - Number(i.birthYear)} years old` : '—';
  const party = i.party || '—';
  const state = i.state || data.holdings && data.holdings[0]?.state_district || '—';
  const profileLink = i.profileUrl ? `<a href="#" data-href="${i.profileUrl}" class="muted">bioguide.congress.gov ↗</a>` : '';

  d.innerHTML = `
    <div class="dossier-header">
      ${photo}
      <div>
        <h1>${data.name}</h1>
        <div class="subtitle">${party} • ${state} • ${age} ${profileLink}</div>
        <div class="dossier-grid">
          <div class="dossier-stat"><div class="label">Trades</div><div class="value">${data.tradeCount}</div></div>
          <div class="dossier-stat"><div class="label">Buys</div><div class="value" style="color:#22c55e">${data.buys}</div></div>
          <div class="dossier-stat"><div class="label">Sells</div><div class="value" style="color:#ef4444">${data.sells}</div></div>
          <div class="dossier-stat"><div class="label">Unique tickers</div><div class="value">${data.uniqueTickers}</div></div>
          <div class="dossier-stat"><div class="label">Net worth</div><div class="value muted" style="font-size:13px">N/A (not public)</div></div>
        </div>
      </div>
    </div>

    <h2>Top tickers</h2>
    <table class="holdings-table">
      <thead><tr><th>Ticker</th><th>Buys</th><th>Sells</th><th>Last seen</th><th>Asset</th></tr></thead>
      <tbody>
        ${data.holdings.slice(0, 30).map((h) => `
          <tr>
            <td class="ticker">${h.ticker}</td>
            <td style="color:#22c55e">${h.buys}</td>
            <td style="color:#ef4444">${h.sells}</td>
            <td>${h.last}</td>
            <td class="muted">${(h.asset || '').slice(0, 60)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  d.querySelectorAll('a[data-href]').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); api.openPdf(a.dataset.href); });
  });
}

// ---------- Performance tab ----------
let perfChart = null;
$('#perf-metric').addEventListener('change', () => autoPerf(true));
$('#perf-min').addEventListener('change', () => autoPerf(true));
api.onPerfProgress((msg) => { $('#perf-status').textContent = msg; });

function drawPerfChart(rows, metric) {
  const ctx = $('#perf-chart').getContext('2d');
  const labels = rows.map((r) => r.member);
  const values = rows.map((r) => metric === 'winrate' ? r.winRate * 100 : r.avg * 100);
  const colors = values.map((v) => v >= 0 ? '#22c55e' : '#ef4444');
  if (perfChart) perfChart.destroy();
  perfChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: metric === 'winrate' ? 'Win rate (%)' : 'Avg return on buys (%)',
        data: values,
        backgroundColor: colors,
      }],
    },
    options: {
      indexAxis: 'y',
      plugins: {
        legend: { labels: { color: '#c5cad6' } },
        tooltip: { callbacks: { label: (c) => `${c.parsed.x.toFixed(1)}% (${rows[c.dataIndex].n} trades)` } },
      },
      scales: {
        x: { ticks: { color: '#6b7280', callback: (v) => v + '%' }, grid: { color: '#1f2230' } },
        y: { ticks: { color: '#c5cad6' }, grid: { display: false } },
      },
    },
  });
}

// ---------- Picks tab ----------
$('#picks-window').addEventListener('change', () => autoPicks(true));

let lastPicks = [];

function renderPicks(picks) {
  lastPicks = picks;
  $('#picks-empty').classList.toggle('hidden', picks.length > 0);
  $('#picks-table tbody').innerHTML = picks.map((p, idx) => {
    const runColor = p.runupPct == null ? '#6b7280' : p.runupPct > 5 ? '#f59e0b' : '#22c55e';
    const retColor = p.avgBuyerReturn >= 0 ? '#22c55e' : '#ef4444';
    const scoreColor = idx < 5 ? '#22c55e' : idx < 15 ? '#c5cad6' : '#6b7280';
    return `<tr>
      <td class="muted">#${idx + 1}</td>
      <td class="ticker">${p.ticker}${p.committee ? ` <span title="Committee oversight: ${p.committee} — backtested +2.45%/trade EV" style="cursor:help">🏛</span>` : ''}</td>
      <td>$${p.price}</td>
      <td><span class="signal-pill signal-${Math.min(p.buyers, 5)}">${p.buyers}</span></td>
      <td>${p.sellers ? `<span style="color:#ef4444">${p.sellers}</span>` : '<span class="muted">0</span>'}</td>
      <td>${p.lastBuy}</td>
      <td style="color:${runColor}" title="Price change since first congressional buy in window">${p.runupPct != null ? (p.runupPct > 0 ? '+' : '') + p.runupPct + '%' : '—'}</td>
      <td style="color:${retColor}" title="Average historical return of these buyers' past trades">${p.avgBuyerReturn > 0 ? '+' : ''}${p.avgBuyerReturn}%</td>
      <td style="color:${scoreColor};font-weight:700" title="${(p.reasons || []).join(' • ')}">${p.score}</td>
      <td class="members-cell" title="${p.buyerNames.join(', ')}">${p.buyerNames.join(', ')}</td>
      <td><button class="copy-btn" data-ticker="${p.ticker}" data-action="BUY">📋 BUY</button></td>
    </tr>`;
  }).join('');

  $('#picks-table tbody').querySelectorAll('button.copy-btn[data-ticker]').forEach((b) => {
    b.addEventListener('click', async () => {
      const cfg = await ensureConfig();
      await navigator.clipboard.writeText(b.dataset.ticker);
      showToast(`📋 ${b.dataset.ticker} copied — BUY ~CA$${cfg.copyTradeAmountCad ?? 500} on Wealthsimple`);
    });
  });
}

// ---------- My TFSA tab ----------
let pfChart = null;
const fmtCad = (n) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(n);

$('#pf-date').value = new Date().toISOString().slice(0, 10);

$('#pf-add').addEventListener('click', async () => {
  const ticker = $('#pf-ticker').value.trim().toUpperCase();
  const cad = Number($('#pf-cad').value);
  const date = $('#pf-date').value;
  if (!ticker || !cad || cad <= 0 || !date) { showToast('Fill ticker, amount, and date', 'error'); return; }
  await api.portfolioAdd({ ticker, cad, date });
  $('#pf-ticker').value = ''; $('#pf-cad').value = '';
  showToast(`${ticker} added`);
  refreshPortfolio();
});

$('#pf-budget').addEventListener('change', async () => {
  const p = await api.portfolioGet();
  p.budgetCad = Number($('#pf-budget').value) || 0;
  await api.portfolioSave(p);
  refreshPortfolio();
});

// Score-weighted allocation of available cash across top picks not yet held.
function buildAdvice(cashCad, heldTickers) {
  if (cashCad < 15) {
    return { note: cashCad <= 0 ? 'Fully invested — no cash to allocate.' : `Only ${fmtCad(cashCad)} cash — below the ${fmtCad(15)} minimum sensible order.`, rows: [] };
  }
  const excluded = [];
  const candidates = [];
  for (const pk of lastPicks) {
    if (candidates.length >= 8) break;
    if (heldTickers.has(pk.ticker)) { excluded.push({ ticker: pk.ticker, why: 'already in your TFSA' }); continue; }
    if (pk.sellers > 0) { excluded.push({ ticker: pk.ticker, why: `${pk.sellers} member(s) selling it` }); continue; }
    if (pk.conviction != null && pk.conviction < 0.3) { excluded.push({ ticker: pk.ticker, why: 'managed-account flow, weak intent' }); continue; }
    if (pk.score <= 0) continue;
    candidates.push(pk);
  }
  if (candidates.length === 0) {
    return { note: 'No fresh picks to suggest — picks are still computing, or you already hold the top candidates.', rows: [], excluded };
  }
  // Position count scales with cash: ~$25-50 per position, max 4.
  const nPos = Math.max(1, Math.min(4, Math.floor(cashCad / 25), candidates.length));
  const chosen = candidates.slice(0, nPos);
  const sumScore = chosen.reduce((a, c) => a + c.score, 0);
  let rows = chosen.map((c) => ({
    ...c,
    cad: Math.max(15, Math.floor((cashCad * c.score / sumScore) / 5) * 5),
  }));
  // Trim overshoot from the smallest allocation.
  let total = rows.reduce((a, r) => a + r.cad, 0);
  while (total > cashCad && rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last.cad - 5 >= 15) { last.cad -= 5; }
    else { rows.pop(); }
    total = rows.reduce((a, r) => a + r.cad, 0);
  }
  return { note: null, rows, leftover: cashCad - total, excluded };
}

// Wealthsimple charges ~1.5% on CAD→USD conversion for US stocks.
const WS_FX_FEE = 0.015;
let fxCached = null;
async function getFx() {
  if (!fxCached) {
    try {
      fxCached = api.fxRate ? await api.fxRate() : 1.37;
    } catch {
      fxCached = 1.37; // fallback rate — panel still renders, footer shows it
    }
  }
  return fxCached;
}

async function renderAdvice(cashCad, heldTickers) {
  const el = $('#pf-advice');
  try {
    await renderAdviceInner(el, cashCad, heldTickers);
  } catch (e) {
    el.innerHTML = `<div class="advice-card"><h3>Suggested buys</h3><div class="muted" style="font-size:12px">Couldn't build suggestions (${e.message}). Will retry on next refresh.</div></div>`;
  }
}

async function renderAdviceInner(el, cashCad, heldTickers) {
  // Picks power the advice — compute them if we haven't yet.
  if (lastPicks.length === 0) {
    el.innerHTML = '<div class="advice-card"><h3>Suggested buys</h3><div class="muted" style="font-size:12px">Scoring congressional buys…</div></div>';
    if (picksBusy) {
      // Another compute is in flight — wait for it rather than racing it.
      for (let i = 0; i < 60 && picksBusy; i++) await new Promise((r) => setTimeout(r, 1000));
    } else {
      await autoPicks(true);
    }
  }
  const advice = buildAdvice(cashCad, heldTickers);
  if (advice.rows.length === 0) {
    el.innerHTML = `<div class="advice-card"><h3>Suggested buys</h3><div class="muted" style="font-size:12px">${advice.note || ''}</div></div>`;
    return;
  }
  const fx = await getFx();
  const effFx = fx * (1 + WS_FX_FEE); // what a CAD dollar actually buys after WS conversion fee

  el.innerHTML = `
    <div class="advice-card">
      <h3>Suggested buys — ${fmtCad(cashCad)} available</h3>
      ${advice.rows.map((r) => {
        const usd = r.cad / effFx;
        const units = r.price ? usd / r.price : null;
        const unitsStr = units != null ? units.toFixed(4) : '?';
        const wholeShareCad = r.price ? r.price * effFx : null;
        const wholeShareAlt = units != null && units < 1 && wholeShareCad <= cashCad
          ? ` (or 1 whole share ≈ ${fmtCad(wholeShareCad)})` : '';
        return `
        <div class="advice-row">
          <span class="advice-amount" style="min-width:150px">BUY ${unitsStr} ×</span>
          <span class="advice-ticker ticker">${r.ticker}</span>
          <span class="advice-why">
            <b style="color:#c5cad6">= ${fmtCad(r.cad)}</b> (US$${usd.toFixed(2)} @ $${r.price}/share)${wholeShareAlt}<br/>
            ${(r.reasons || []).join(' • ') || `score ${r.score}`}
          </span>
          <button class="copy-btn" data-adv-copy="${r.ticker}">📋 Copy</button>
          <button class="copy-btn" data-adv-log="${r.ticker}" data-adv-cad="${r.cad}" title="Log this buy into your TFSA after executing it on Wealthsimple">✓ Bought</button>
        </div>`;
      }).join('')}
      <div class="muted" style="font-size:11px;margin-top:8px">
        USD/CAD ${fx.toFixed(4)} • unit counts include Wealthsimple's ~1.5% FX fee • WS supports fractional shares
        ${advice.leftover >= 5 ? ` • ${fmtCad(advice.leftover)} left unallocated` : ''}
      </div>
      ${(advice.excluded || []).length ? `
        <div class="muted" style="font-size:11px;margin-top:10px;border-top:1px solid #181b26;padding-top:8px">
          Skipped: ${advice.excluded.slice(0, 5).map((x) => `<b>${x.ticker}</b> (${x.why})`).join(' · ')}
        </div>` : ''}
    </div>
  `;

  el.querySelectorAll('button[data-adv-copy]').forEach((b) => {
    b.addEventListener('click', async () => {
      await navigator.clipboard.writeText(b.dataset.advCopy);
      showToast(`📋 ${b.dataset.advCopy} copied`);
    });
  });
  el.querySelectorAll('button[data-adv-log]').forEach((b) => {
    b.addEventListener('click', async () => {
      await api.portfolioAdd({
        ticker: b.dataset.advLog,
        cad: Number(b.dataset.advCad),
        date: new Date().toISOString().slice(0, 10),
      });
      showToast(`${b.dataset.advLog} logged — ${fmtCad(Number(b.dataset.advCad))}`);
      refreshPortfolio();
    });
  });
}

async function refreshPortfolio() {
  const p = await api.portfolioGet();
  $('#pf-budget').value = p.budgetCad;

  if (p.positions.length === 0) {
    $('#pf-empty').classList.remove('hidden');
    $('#pf-summary').innerHTML = '';
    $('#pf-table tbody').innerHTML = '';
    $('#pf-cash').innerHTML = `<div class="row"><span class="muted">Available</span><span class="num">${fmtCad(p.budgetCad)}</span></div>`;
    if (pfChart) { pfChart.destroy(); pfChart = null; }
    renderAdvice(p.budgetCad, new Set());
    return;
  }
  $('#pf-empty').classList.add('hidden');

  const v = await api.portfolioValue();
  const t = v.totals;
  const plColor = t.plCad >= 0 ? '#22c55e' : '#ef4444';
  const sign = t.plCad >= 0 ? '+' : '';

  $('#pf-summary').innerHTML = `
    <div class="dossier-stat"><div class="label">Value</div><div class="value">${fmtCad(t.valueCad)}</div></div>
    <div class="dossier-stat"><div class="label">Cost</div><div class="value">${fmtCad(t.costCad)}</div></div>
    <div class="dossier-stat"><div class="label">P&L</div><div class="value" style="color:${plColor}">${sign}${fmtCad(t.plCad)}</div></div>
    <div class="dossier-stat"><div class="label">Return</div><div class="value" style="color:${plColor}">${sign}${t.plPct}%</div></div>
  `;

  $('#pf-cash').innerHTML = `
    <div class="row"><span class="muted">Budget</span><span class="num">${fmtCad(v.budgetCad)}</span></div>
    <div class="row"><span class="muted">Invested</span><span class="num">${fmtCad(t.costCad)}</span></div>
    <div class="row"><span class="muted">Available</span><span class="num" style="color:${t.cashCad < 0 ? '#ef4444' : '#e6e8ee'}">${fmtCad(t.cashCad)}</span></div>
    <div class="row"><span class="muted">USD/CAD</span><span class="num">${t.fxNow || '—'}</span></div>
  `;

  $('#pf-table tbody').innerHTML = v.enriched.map((e) => {
    if (e.error) {
      return `<tr><td class="ticker">${e.ticker}</td><td>${e.date}</td><td>${fmtCad(e.cad)}</td>
        <td colspan="5" class="muted">${e.error}</td>
        <td><button class="copy-btn" data-remove="${e.id}">✕</button></td></tr>`;
    }
    const c = e.plCad >= 0 ? '#22c55e' : '#ef4444';
    const s = e.plCad >= 0 ? '+' : '';
    return `<tr>
      <td class="ticker">${e.ticker}</td>
      <td>${e.date}</td>
      <td>${fmtCad(e.cad)}</td>
      <td>$${e.entryUsd}</td>
      <td>$${e.lastUsd}</td>
      <td>${e.shares}</td>
      <td>${fmtCad(e.valueCad)}</td>
      <td style="color:${c};font-weight:600">${s}${fmtCad(e.plCad)} (${s}${e.plPct}%)</td>
      <td><button class="copy-btn" data-remove="${e.id}" title="Remove position">✕</button></td>
    </tr>`;
  }).join('');

  $('#pf-table tbody').querySelectorAll('button[data-remove]').forEach((b) => {
    b.addEventListener('click', async () => {
      await api.portfolioRemove(b.dataset.remove);
      showToast('Position removed');
      refreshPortfolio();
    });
  });

  renderAdvice(t.cashCad, new Set(v.enriched.map((e) => e.ticker)));

  // Value-over-time line chart with a cost baseline.
  const ctx = $('#pf-chart').getContext('2d');
  if (pfChart) pfChart.destroy();
  pfChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: v.timeline.map((x) => x.date),
      datasets: [
        {
          label: 'Portfolio value (CA$)',
          data: v.timeline.map((x) => x.valueCad),
          borderColor: '#3a82f7',
          backgroundColor: '#3a82f733',
          fill: true,
          tension: 0.25,
          pointRadius: 0,
        },
        {
          label: 'Cost basis',
          data: v.timeline.map(() => t.costCad),
          borderColor: '#6b7280',
          borderDash: [6, 4],
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      plugins: { legend: { labels: { color: '#c5cad6' } } },
      scales: {
        x: { ticks: { color: '#6b7280', maxTicksLimit: 10 }, grid: { color: '#1f2230' } },
        y: { ticks: { color: '#6b7280', callback: (val) => 'CA$' + val }, grid: { color: '#1f2230' } },
      },
    },
  });
}

// ---------- App updates (user-consent flow) ----------
const updBanner = $('#update-banner');
const updText = $('#update-text');
const updAction = $('#update-action');

if (api.onUpdateAvailable) {
  api.onUpdateAvailable((info) => {
    updText.textContent = `Update v${info.version} available`;
    updAction.textContent = 'Download';
    updAction.onclick = () => {
      api.updateDownload();
      updAction.disabled = true;
      updAction.textContent = 'Downloading…';
    };
    updBanner.classList.remove('hidden');
  });
  api.onUpdateProgress((p) => {
    updAction.textContent = `Downloading… ${p.percent}%`;
  });
  api.onUpdateReady((info) => {
    updText.textContent = `v${info.version} ready to install`;
    updAction.disabled = false;
    updAction.textContent = 'Restart & install';
    updAction.onclick = () => api.updateInstall();
    updBanner.classList.remove('hidden');
  });
  if (api.onUpdateError) {
    api.onUpdateError((info) => {
      updText.textContent = `Update failed: ${info.message.slice(0, 60)}`;
      updAction.disabled = false;
      updAction.textContent = 'Retry';
      updAction.onclick = () => {
        api.updateDownload();
        updAction.disabled = true;
        updAction.textContent = 'Downloading…';
      };
      updBanner.classList.remove('hidden');
    });
  }
  $('#update-dismiss').addEventListener('click', () => updBanner.classList.add('hidden'));
}

// Boot: load data, then kick off background computations. Periodic re-check
// keeps prices fresh while the app sits open (computes are disk-cached, so
// repeats are cheap).
reload().then(() => autoGains(true));
setInterval(() => {
  autoGains();
  const active = document.querySelector('.tab.active')?.dataset.tab;
  if (active === 'picks') autoPicks();
  if (active === 'performance') autoPerf();
  if (active === 'portfolio') refreshPortfolio();
}, 10 * 60_000);
})();
