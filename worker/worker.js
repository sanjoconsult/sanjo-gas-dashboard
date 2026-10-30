// Sanjo Consult price relay: a Cloudflare Worker (free plan).
// Fetches futures quotes from Yahoo Finance server-side and returns them as JSON
// your website can read, cached for 60 seconds.
//
// ng1 = NYMEX Henry Hub natural gas front month, the same contract as
//       TradingView's NYMEX:NG1! (rolls at each contract's expiry).
// reports = latest EIA weekly inventory changes (crude, gasoline, distillate, natural gas storage).
//           Needs a free EIA API key saved in the Worker as a secret named EIA_API_KEY.
// dashboard = add ?dashboard=1 for the US natural gas dashboard's live data (storage, EIA STEO,
//             Henry Hub spot, LNG exports by country, NG futures, EU storage).
//             EIA data needs EIA_API_KEY; EU storage needs a free GIE key saved as AGSI_API_KEY.
// jkm = Asian LNG price; needs a free OilPriceAPI key saved as OILPRICE_API_KEY.
// history = add ?history=1 for weekly TTF and recent JKM prices (Henry Hub chart).
// Test it by opening the worker's address in a browser; add ?debug=1 for details.

const CACHE_MS = 60 * 1000;
const HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MONTH_CODES = 'FGHJKMNQUVXZ';
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

let memo = null;
let eiaMemo = null;
const EIA_CACHE_MS = 30 * 60 * 1000;
const EIA_SERIES = [
  { key: 'crude', id: 'PET.WCESTUS1.W', name: 'USA Crude Oil Inventories', kind: 'oil' },
  { key: 'gasoline', id: 'PET.WGTSTUS1.W', name: 'USA Gasoline Inventories', kind: 'oil' },
  { key: 'distillate', id: 'PET.WDISTUS1.W', name: 'USA Distillate Inventories', kind: 'oil' },
  { key: 'natgas', id: 'NG.NW2_EPG0_SWO_R48_BCF.W', name: 'USA Natural Gas Storage', kind: 'gas' },
];

async function getEiaSeries(s, key) {
  const url = `https://api.eia.gov/v2/seriesid/${s.id}?api_key=${encodeURIComponent(key)}&sort[0][column]=period&sort[0][direction]=desc&length=2`;
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`EIA HTTP ${r.status}`);
  const j = await r.json();
  const rows = ((j && j.response && j.response.data) || [])
    .map((d) => ({ period: d.period, value: Number(d.value) }))
    .filter((d) => d.period && isFinite(d.value))
    .sort((a, b) => (a.period < b.period ? 1 : -1));
  if (rows.length < 2) throw new Error('Not enough EIA data');
  const change = rows[0].value - rows[1].value; // thousand barrels, or Bcf for gas
  let headline;
  if (s.kind === 'gas') {
    headline = `${s.name} ${Math.abs(Math.round(change))} Bcf ${change >= 0 ? 'Injection' : 'Withdrawal'}`;
  } else {
    headline = `${s.name} ${(Math.abs(change) / 1000).toFixed(3)}M Barrel ${change >= 0 ? 'Build' : 'Draw'}`;
  }
  return { key: s.key, name: s.name, weekEnding: rows[0].period, level: rows[0].value, change, headline };
}

async function getReports(env) {
  const key = env && env.EIA_API_KEY;
  if (!key) return { error: 'Add your free EIA API key as a Worker secret named EIA_API_KEY.' };
  if (eiaMemo && Date.now() - eiaMemo.at < EIA_CACHE_MS) return eiaMemo.data;
  const results = await Promise.all(EIA_SERIES.map((s) => getEiaSeries(s, key).catch((e) => ({ key: s.key, name: s.name, error: String(e.message || e) }))));
  const data = { source: 'U.S. Energy Information Administration', items: results };
  if (results.some((x) => !x.error)) eiaMemo = { at: Date.now(), data };
  return data;
}

// NYMEX natural gas expires 3 business days before the first day of the delivery month.
// ROLL_DAYS = 0 keeps the expiring contract to its last day, like TradingView's NG1!.
// Set it to 2 to roll early, the way Investing.com and most quote sites do.
const ROLL_DAYS = 0;
function ngFrontMonth(now = new Date()) {
  // Today's date in Chicago (approximate offset is fine for a date comparison)
  const ct = new Date(now.getTime() - 5 * 3600 * 1000);
  const today = Date.UTC(ct.getUTCFullYear(), ct.getUTCMonth(), ct.getUTCDate());
  let y = ct.getUTCFullYear(), m = ct.getUTCMonth() + 1; // start with next month
  for (let i = 0; i < 3; i++, m++) {
    if (m > 11) { m = 0; y++; }
    let d = new Date(Date.UTC(y, m, 1)), biz = 0;
    while (biz < 3 + ROLL_DAYS) {
      d = new Date(d.getTime() - 86400000);
      const wd = d.getUTCDay();
      if (wd !== 0 && wd !== 6) biz++;
    }
    if (today <= d.getTime()) {
      return { symbol: `NG${MONTH_CODES[m]}${String(y).slice(2)}.NYM`, label: `${MONTH_NAMES[m]} ${String(y).slice(2)}`, code: `NG${MONTH_CODES[m]}${String(y).slice(3)}` };
    }
  }
  return { symbol: 'NG=F', label: '' };
}

async function getQuote(symbol) {
  let lastErr = 'unknown';
  for (const host of HOSTS) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m`;
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
      if (!r.ok) { lastErr = `Yahoo HTTP ${r.status} from ${host}`; continue; }
      const j = await r.json();
      const m = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
      if (!m || typeof m.regularMarketPrice !== 'number') { lastErr = `No quote from ${host}`; continue; }
      const price = m.regularMarketPrice;
      const prev = m.chartPreviousClose ?? m.previousClose ?? null;
      return {
        symbol, name: m.shortName || symbol, price, prevClose: prev,
        change: prev ? price - prev : null,
        changePct: prev ? ((price - prev) / prev) * 100 : null,
        currency: m.currency || 'USD', time: (m.regularMarketTime || 0) * 1000,
      };
    } catch (e) { lastErr = `${host}: ${e && e.message ? e.message : e}`; }
  }
  return { symbol, error: lastErr };
}

// JKM: CME/NYMEX "LNG Japan/Korea Marker (Platts)" futures. Yahoo lists single
// NYMEX contracts as e.g. JKMZ26.NYM (the same way it lists NGZ26.NYM).
// A JKM contract stops trading on the 15th of the month before delivery, so after
// the 15th the front month is two months ahead.
function jkmContracts(now = new Date()) {
  const ct = new Date(now.getTime() - 5 * 3600 * 1000);
  let y = ct.getUTCFullYear(), m = ct.getUTCMonth() + (ct.getUTCDate() > 15 ? 2 : 1);
  const out = [];
  for (let i = 0; i < 3; i++, m++) {
    const yy = y + Math.floor(m / 12), mm = m % 12;
    out.push({ symbol: `JKM${MONTH_CODES[mm]}${String(yy).slice(2)}.NYM`, label: `${MONTH_NAMES[mm]} ${String(yy).slice(2)}` });
  }
  return out;
}
const lastGood = {};
// OilPriceAPI (free key, 50 requests a day): front-month JKM, updated about once a day.
// Asked at most every 2 hours (plus the history twice a day), so the free limit is not reached.
const OPA_EVERY_MS = 2 * 60 * 60 * 1000;
let opaMemo = null;
async function getJkmOpa(key) {
  if (opaMemo && Date.now() - opaMemo.at < OPA_EVERY_MS) return opaMemo.q;
  const r = await fetch('https://api.oilpriceapi.com/v1/prices/latest?by_code=JKM_LNG_USD', { headers: { 'Authorization': `Token ${key}`, 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`OilPriceAPI HTTP ${r.status}`);
  const j = await r.json();
  const d = (j && j.data) || {};
  const price = Number(d.price);
  if (!isFinite(price) || price <= 0) throw new Error('No JKM price from OilPriceAPI');
  const t = Date.parse(d.created_at || d.updated_at || d.timestamp || '') || Date.now();
  const prev = opaMemo && opaMemo.q && opaMemo.q.time < t ? opaMemo.q.price : null;
  const q = { symbol: 'JKM_LNG_USD', name: 'JKM LNG (front month)', price, prevClose: prev, change: prev ? price - prev : null, changePct: prev ? (price - prev) / prev * 100 : null, currency: 'USD', time: t, contract: 'Front month', source: 'OilPriceAPI' };
  opaMemo = { at: Date.now(), q };
  return q;
}
async function getJkm(env) {
  let last;
  const key = env && env.OILPRICE_API_KEY;
  if (key) {
    try { const q = await getJkmOpa(key); lastGood.jkm = q; return q; }
    catch (e) { last = { symbol: 'JKM_LNG_USD', error: String(e.message || e) }; if (opaMemo) opaMemo.at = Date.now(); }
  }
  const tries = [...jkmContracts(), { symbol: 'JKM=F', label: '' }];
  for (const t of tries) {
    const q = await getQuote(t.symbol);
    if (!q.error) { q.contract = t.label ? t.label + ' contract' : 'Front month'; lastGood.jkm = q; return q; }
    last = q;
  }
  if (lastGood.jkm) return { ...lastGood.jkm, stale: true }; // most recent good quote, marked stale
  return { ...last, tried: (key ? ['OilPriceAPI'] : []).concat(tries.map((t) => t.symbol)), hint: key ? undefined : 'Add a free OilPriceAPI key as a secret named OILPRICE_API_KEY' };
}

// ---------------------------------------------------------------------------
// Weekly price history for the dashboard's Henry Hub chart (?history=1):
// TTF (Yahoo, weekly, converted to $/MMBtu) and JKM (OilPriceAPI, last 30 days).
// ---------------------------------------------------------------------------
let histMemo = null;
const HIST_CACHE_MS = 12 * 60 * 60 * 1000;
async function getChartSeries(symbol, range, interval) {
  let lastErr = 'unknown';
  for (const host of HOSTS) {
    try {
      const r = await fetch(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
      if (!r.ok) { lastErr = `Yahoo HTTP ${r.status}`; continue; }
      const j = await r.json();
      const res = j && j.chart && j.chart.result && j.chart.result[0];
      const ts = (res && res.timestamp) || [], cl = (res && res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) || [];
      const out = ts.map((t, i) => ({ t: t * 1000, v: cl[i] })).filter((p) => typeof p.v === 'number');
      if (out.length) return out;
      lastErr = 'No history';
    } catch (e) { lastErr = String(e.message || e); }
  }
  throw new Error(lastErr);
}
// The Friday that ends the week containing time t (weekly bars start on Monday)
function weekEnding(t) {
  const d = new Date(t), wd = d.getUTCDay();
  const add = (5 - wd + 7) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + add)).toISOString().slice(0, 10);
}
async function getTtfHistory() {
  const [ttf, fx] = await Promise.all([getChartSeries('TTF=F', '2y', '1wk'), getChartSeries('EURUSD=X', '2y', '1wk')]);
  const fxBy = {}; fx.forEach((p) => { fxBy[weekEnding(p.t)] = p.v; });
  const by = {};
  ttf.forEach((p) => { const w = weekEnding(p.t); const r = fxBy[w]; if (r) by[w] = { week_ending: w, eur_mwh: Math.round(p.v * 100) / 100, usd_mmbtu: Math.round(p.v * r / 3.412 * 100) / 100 }; });
  return Object.values(by).sort((a, b) => (a.week_ending < b.week_ending ? -1 : 1));
}
function findPriceRows(o, out = []) {
  if (Array.isArray(o)) o.forEach((x) => findPriceRows(x, out));
  else if (o && typeof o === 'object') {
    if (o.price !== undefined && (o.created_at || o.date || o.timestamp)) out.push(o);
    else Object.values(o).forEach((x) => findPriceRows(x, out));
  }
  return out;
}
async function getJkmHistory(key) {
  const r = await fetch('https://api.oilpriceapi.com/v1/prices/past_month?by_code=JKM_LNG_USD', { headers: { 'Authorization': `Token ${key}`, 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`OilPriceAPI HTTP ${r.status}`);
  const rows = findPriceRows(await r.json()).map((x) => ({ t: Date.parse(x.created_at || x.date || x.timestamp), v: Number(x.price) })).filter((x) => isFinite(x.t) && isFinite(x.v) && x.v > 0).sort((a, b) => a.t - b.t);
  if (!rows.length) throw new Error('No JKM history');
  const by = {}; rows.forEach((p) => { by[weekEnding(p.t)] = { week_ending: weekEnding(p.t), usd_mmbtu: Math.round(p.v * 100) / 100 }; });
  return Object.values(by);
}
async function buildHistory(env) {
  if (histMemo && Date.now() - histMemo.at < HIST_CACHE_MS) return histMemo.data;
  const out = { fetched: Date.now() }, errors = {};
  await Promise.all([
    getTtfHistory().then((v) => { out.ttf = v; }).catch((e) => { out.ttf = null; errors.ttf = String(e.message || e); }),
    (env && env.OILPRICE_API_KEY ? getJkmHistory(env.OILPRICE_API_KEY) : Promise.reject(new Error('Add OILPRICE_API_KEY'))).then((v) => { out.jkm = v; }).catch((e) => { out.jkm = null; errors.jkm = String(e.message || e); }),
  ]);
  out.errors = errors;
  if (out.ttf || out.jkm) histMemo = { at: Date.now(), data: out };
  return out;
}

async function buildPayload(env) {
  const front = ngFrontMonth();
  let ng1 = await getQuote(front.symbol);
  if (ng1.error && front.symbol !== 'NG=F') ng1 = await getQuote('NG=F'); // fallback
  else { ng1.contract = front.label; ng1.code = front.code; }
  const [wti, brent, ttf, eurusd, jkm, reports] = await Promise.all([
    getQuote('CL=F'), getQuote('BZ=F'),
    getQuote('TTF=F'),     // ICE Dutch TTF front month, EUR/MWh
    getQuote('EURUSD=X'),  // euro rate, to convert TTF to $/MMBtu
    getJkm(env),           // JKM LNG front month, $/MMBtu (OilPriceAPI key, else Yahoo)
    getReports(env).catch((e) => ({ error: String(e.message || e) })),
  ]);
  return { source: 'Yahoo Finance (delayed futures quotes)', fetched: Date.now(), quotes: { ng1, wti, brent, ttf, eurusd, jkm }, reports };
}

// ---------------------------------------------------------------------------
// US natural gas dashboard data (?dashboard=1)
// Each section is fetched on its own; if one fails, the others still load and
// the dashboard keeps its built-in numbers for the missing part.
// ---------------------------------------------------------------------------
let dashMemo = null;
const DASH_CACHE_MS = 10 * 60 * 1000;
const EIA = 'https://api.eia.gov/v2';

const REGION_NAMES = [
  ['south central salt', 'Salt'], ['south central nonsalt', 'Nonsalt'], ['south central', 'South Central'],
  ['total lower 48', 'Total Lower 48'], ['east', 'East'], ['midwest', 'Midwest'], ['mountain', 'Mountain'], ['pacific', 'Pacific'],
];
const REGION_ORDER = ['East', 'Midwest', 'Mountain', 'Pacific', 'South Central', 'Salt', 'Nonsalt', 'Total Lower 48'];

// STEO series. Where EIA has used more than one code over the years, the first one found wins.
const STEO_FIELDS = {
  dry_production: ['NGPRPUS'],
  pipeline_imports: ['NGIMPUS_PIPE', 'NGIMPPUS'],
  imports_total: ['NGIMPUS'],
  lng_imports: ['NGIMPUS_LNG', 'NGIMLPUS'],
  residential: ['NGRCPUS'],
  commercial: ['NGCCPUS'],
  industrial: ['NGINX', 'NGINPUS'],
  electric_power: ['NGEPCON', 'NGEUPUS', 'NGEPPUS'],
  lease_plant_fuel: ['NGLPPUS'],
  pipeline_distribution: ['NGACPUS', 'NGPDPUS'],
  vehicle: ['NGVHPUS'],
  total_consumption: ['NGTCPUS'],
  pipeline_exports: ['NGEXPUS_PIPE', 'NGEXPPUS'],
  lng_exports: ['NGEXPUS_LNG', 'NGEXLPUS'],
  exports_total: ['NGEXPUS'],
  end_inventories_bcf: ['NGWGPUS', 'NGUSPUS'],
  hh_price: ['NGHHUUS'],
  hh_price_mcf: ['NGHHMCF'],
};

const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const num = (v) => (v === null || v === undefined || v === '' || !isFinite(Number(v)) ? null : Number(v));
function chicagoToday() { const t = new Date(Date.now() - 5 * 3600 * 1000); return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate())); }
const iso = (d) => d.toISOString().slice(0, 10);

async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json', ...headers } });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).hostname}`);
  return r.json();
}
function eiaUrl(route, key, params) {
  const q = [`api_key=${encodeURIComponent(key)}`, 'data[0]=value', ...params];
  return `${EIA}/${route}/data/?${q.join('&')}`;
}
async function eiaRows(route, key, params) {
  const j = await getJson(eiaUrl(route, key, params));
  const rows = (j && j.response && j.response.data) || [];
  if (!rows.length) throw new Error(`No rows from EIA ${route}`);
  return rows;
}

// 1) Weekly storage report table: EIA's own JSON for the latest report (no key needed).
async function getStorageReport() {
  const j = await getJson('https://ir.eia.gov/ngs/wngsr.json');
  const rows = [];
  for (const s of j.series || []) {
    const nm = String(s.name || '').toLowerCase();
    const hit = REGION_NAMES.find(([k]) => nm.startsWith(k));
    if (!hit) continue;
    const data = (s.data || []).filter((d) => Array.isArray(d) && num(d[1]) !== null).sort((a, b) => (a[0] < b[0] ? 1 : -1));
    if (data.length < 2) continue;
    const c = s.calculated || {};
    const cur = num(data[0][1]), prev = num(data[1][1]), ya = data[2] ? num(data[2][1]) : null;
    rows.push({
      region: hit[1], week_ending: String(data[0][0]).slice(0, 10),
      working_gas_bcf: cur, prior_week_bcf: prev,
      net_change_bcf: num(c.net_change) ?? cur - prev,
      year_ago_bcf: ya,
      vs_year_ago_pct: num(c['pct-change_yrago']) ?? (ya ? r1((cur - ya) / ya * 100) : null),
      five_year_avg_bcf: num(c['5yr-avg']),
      vs_five_year_pct: num(c['pct-chg_5yr-avg']),
    });
  }
  if (!rows.some((r) => r.region === 'Total Lower 48')) throw new Error('Lower 48 total not found in EIA report');
  rows.sort((a, b) => REGION_ORDER.indexOf(a.region) - REGION_ORDER.indexOf(b.region));
  return { release_date: j.release_date || null, week_ending: rows[0].week_ending, rows };
}

// 2) Lower 48 storage history, last three calendar years (needs EIA key).
async function getStorageHistory(key) {
  const y = chicagoToday().getUTCFullYear();
  const rows = await eiaRows('natural-gas/stor/wkly', key, ['frequency=weekly', 'facets[series][]=NW2_EPG0_SWO_R48_BCF', `start=${y - 2}-01-01`, 'sort[0][column]=period', 'sort[0][direction]=asc', 'length=500']);
  return rows.map((r) => ({ week_ending: String(r.period).slice(0, 10), year: Number(String(r.period).slice(0, 4)), working_gas_bcf: num(r.value) }))
    .filter((r) => r.working_gas_bcf !== null);
}

// 3) Henry Hub spot: weekly history and this month's daily average (needs EIA key).
async function getHenryHub(key) {
  const today = chicagoToday(), y = today.getUTCFullYear(), m = today.getUTCMonth();
  const prevStart = iso(new Date(Date.UTC(y, m - 1, 1)));
  const [weekly, daily] = await Promise.all([
    eiaRows('natural-gas/pri/fut', key, ['frequency=weekly', 'facets[series][]=RNGWHHD', `start=${y - 1}-01-01`, 'sort[0][column]=period', 'sort[0][direction]=asc', 'length=200']),
    eiaRows('natural-gas/pri/fut', key, ['frequency=daily', 'facets[series][]=RNGWHHD', `start=${prevStart}`, 'sort[0][column]=period', 'sort[0][direction]=asc', 'length=100']),
  ]);
  const wk = weekly.map((r) => ({ week_ending: String(r.period).slice(0, 10), price_usd_mmbtu: num(r.value) })).filter((r) => r.price_usd_mmbtu !== null);
  const dd = daily.map((r) => ({ d: String(r.period).slice(0, 10), v: num(r.value) })).filter((r) => r.v !== null);
  const thisMonth = iso(new Date(Date.UTC(y, m, 1))).slice(0, 7);
  let cur = dd.filter((r) => r.d.startsWith(thisMonth));
  let monthKey = thisMonth;
  if (!cur.length) { monthKey = prevStart.slice(0, 7); cur = dd.filter((r) => r.d.startsWith(monthKey)); }
  const prevKey = iso(new Date(Date.UTC(Number(monthKey.slice(0, 4)), Number(monthKey.slice(5, 7)) - 2, 1))).slice(0, 7);
  const prev = dd.filter((r) => r.d.startsWith(prevKey));
  const avg = (a) => (a.length ? a.reduce((s, r) => s + r.v, 0) / a.length : null);
  const a = avg(cur), p = avg(prev);
  return {
    weekly: wk,
    month_to_date: a === null ? null : {
      month: monthKey, value: r2(a), days: cur.length, from: cur[0].d, through: cur[cur.length - 1].d,
      prev_month: prevKey, prev_month_avg: p === null ? null : r2(p), pct_vs_prev_month: p ? r1((a - p) / p * 100) : null,
    },
  };
}

// 4) EIA Short-Term Energy Outlook: balance, inventories and Henry Hub forecast (needs EIA key).
function qParts(period) { const m = String(period).match(/(\d{4})\D*Q(\d)/i); return m ? { y: Number(m[1]), q: Number(m[2]) } : null; }
async function getSteo(key) {
  const today = chicagoToday(), Y = today.getUTCFullYear(), M = today.getUTCMonth() + 1;
  const ids = [...new Set(Object.values(STEO_FIELDS).flat())];
  const facets = ids.map((id) => `facets[seriesId][]=${id}`);
  const [qRows, aRows, mRows] = await Promise.all([
    eiaRows('steo', key, ['frequency=quarterly', ...facets, `start=${Y}-Q1`, `end=${Y + 1}-Q4`, 'length=5000']),
    eiaRows('steo', key, ['frequency=annual', ...facets, `start=${Y - 1}`, `end=${Y + 1}`, 'length=5000']),
    eiaRows('steo', key, ['frequency=monthly', 'facets[seriesId][]=NGWGPUS', 'facets[seriesId][]=NGUSPUS', `start=${Y}-01`, `end=${Y + 1}-12`, 'length=500']),
  ]);
  const idOf = (r) => r.seriesId || r.series || r['series-id'];
  const used = {};
  function table(rows) {
    const byPeriod = {};
    for (const r of rows) { const v = num(r.value); if (v === null) continue; (byPeriod[r.period] = byPeriod[r.period] || {})[idOf(r)] = v; }
    return byPeriod;
  }
  function pick(vals, field) {
    for (const id of STEO_FIELDS[field]) if (vals[id] !== undefined) { used[field] = id; return vals[id]; }
    return null;
  }
  function row(label, vals) {
    const o = { period: label };
    for (const f of Object.keys(STEO_FIELDS)) o[f] = pick(vals, f);
    // Fill splits EIA may only publish as totals
    if (o.pipeline_imports === null && o.imports_total !== null) o.pipeline_imports = o.imports_total - (o.lng_imports || 0);
    if (o.pipeline_exports === null && o.exports_total !== null && o.lng_exports !== null) o.pipeline_exports = o.exports_total - o.lng_exports;
    const parts = ['residential', 'commercial', 'industrial', 'electric_power', 'lease_plant_fuel', 'pipeline_distribution', 'vehicle'];
    const missing = parts.filter((p) => o[p] === null);
    if (missing.length === 1 && o.total_consumption !== null) o[missing[0]] = o.total_consumption - parts.filter((p) => p !== missing[0]).reduce((s, p) => s + o[p], 0);
    if (o.hh_price === null && o.hh_price_mcf !== null) o.hh_price = o.hh_price_mcf / 1.037;
    for (const k of Object.keys(o)) if (typeof o[k] === 'number') o[k] = k === 'end_inventories_bcf' ? Math.round(o[k]) : (k === 'hh_price' ? r2(o[k]) : r1(o[k]));
    delete o.imports_total; delete o.exports_total; delete o.lng_imports; delete o.hh_price_mcf;
    return o;
  }
  const qt = table(qRows), at = table(aRows), mt = table(mRows);
  const balance = [], hhq = [];
  for (const p of Object.keys(qt).sort()) {
    const qp = qParts(p); if (!qp) continue;
    const forecast = qp.y > Y || (qp.y === Y && qp.q * 3 >= M);
    const r = row(`${qp.y} Q${qp.q}`, qt[p]);
    if (qp.y === Y) balance.push({ ...r, period: r.period + (forecast ? ' (forecast)' : '') });
    if (r.hh_price !== null) hhq.push({ quarter: r.period, mid_date: `${qp.y}-${String(qp.q * 3 - 1).padStart(2, '0')}-15`, price_usd_mmbtu: r.hh_price, kind: forecast ? 'Forecast' : 'Estimate' });
  }
  const annual = {};
  for (const p of Object.keys(at).sort()) {
    const y = Number(String(p).slice(0, 4)); if (!y) continue;
    const r = row(String(y) + (y > Y ? ' (forecast)' : ''), at[p]);
    balance.push(r); annual[y] = r;
  }
  // Working gas at the end of this month (EIA forecast)
  const mk = `${Y}-${String(M).padStart(2, '0')}`;
  const mv = mt[mk] || {};
  const endMonth = mv.NGWGPUS ?? mv.NGUSPUS ?? null;
  const hhAnnual = { [Y]: annual[Y] ? annual[Y].hh_price ?? null : null, [Y + 1]: annual[Y + 1] ? annual[Y + 1].hh_price ?? null : null };
  for (const b of balance) { delete b.hh_price; }
  if (!balance.length) throw new Error('No STEO balance rows');
  return {
    year: Y, balance, hh_quarterly: hhq,
    hh_annual: hhAnnual,
    storage_end_of_month: endMonth === null ? null : { month: mk, bcf: Math.round(endMonth) },
    series_used: used,
  };
}

// 5) US LNG exports by destination country, latest month EIA has published (needs EIA key).
async function getLngDestinations(key) {
  const today = chicagoToday();
  const start = iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 8, 1))).slice(0, 7);
  const rows = await eiaRows('natural-gas/move/expc', key, ['frequency=monthly', `start=${start}`, 'sort[0][column]=period', 'sort[0][direction]=desc', 'length=5000']);
  const byMonth = {};
  for (const r of rows) {
    const desc = String(r['series-description'] || r.seriesDescription || '');
    const proc = String(r['process-name'] || '');
    if (!/liquefied|lng|vessel/i.test(desc + ' ' + proc)) continue;
    if (/truck|re-?export|price/i.test(desc + ' ' + proc)) continue;
    if (!/mmcf/i.test(String(r.units || desc))) continue;
    const m = desc.match(/\bto\s+(.+?)\s*(\(|$)/i);
    const country = (m ? m[1] : String(r['area-name'] || '')).trim();
    if (!country || /^(total|u\.?s\.?|united states|world|other)/i.test(country)) continue;
    const v = num(r.value); if (v === null || v <= 0) continue;
    const per = String(r.period).slice(0, 7);
    (byMonth[per] = byMonth[per] || {})[country] = ((byMonth[per] || {})[country] || 0) + v;
  }
  const months = Object.keys(byMonth).filter((p) => Object.keys(byMonth[p]).length >= 5).sort().reverse();
  if (!months.length) throw new Error('No LNG export-by-country rows found');
  const per = months[0], y = Number(per.slice(0, 4)), mo = Number(per.slice(5, 7));
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const list = Object.entries(byMonth[per]).map(([country, mmcf]) => ({ country, bcfd: r1(mmcf / 1000 / days) }))
    .sort((a, b) => b.bcfd - a.bcfd).slice(0, 5);
  return { month: per, rows: list };
}

// 6) EU gas storage, % full, against the same day in the five previous years (needs GIE key).
async function getEuStorage(key) {
  const h = { 'x-key': key };
  const today = chicagoToday();
  const from = iso(new Date(today.getTime() - 10 * 86400000));
  const j = await getJson(`https://agsi.gie.eu/api?type=eu&from=${from}&to=${iso(today)}&size=30`, h);
  const latest = (j.data || []).filter((d) => num(d.full) !== null && d.status !== 'N').sort((a, b) => (a.gasDayStart < b.gasDayStart ? 1 : -1))[0];
  if (!latest) throw new Error('No EU storage data');
  const day = latest.gasDayStart;
  const past = await Promise.all([1, 2, 3, 4, 5].map(async (k) => {
    const d = `${Number(day.slice(0, 4)) - k}${day.slice(4)}`;
    try { const p = await getJson(`https://agsi.gie.eu/api?type=eu&from=${d}&to=${d}`, h); const x = (p.data || [])[0]; return x ? num(x.full) : null; } catch (e) { return null; }
  }));
  const ok = past.filter((v) => v !== null);
  const avg = ok.length === 5 ? ok.reduce((s, v) => s + v, 0) / 5 : null;
  return { date: day, full: r1(num(latest.full)), trend: latest.trend || '', five_year_avg: avg === null ? null : r1(avg), vs_five_year_pts: avg === null ? null : r1(num(latest.full) - avg) };
}

// 7) NYMEX Henry Hub front month (same contract as NG1!) from Yahoo.
async function getFrontMonth() {
  const front = ngFrontMonth();
  const q = await getQuote(front.symbol);
  if (q.error) throw new Error(q.error);
  return { ...q, contract: front.label, code: front.code };
}

async function settle(name, fn, out, errors) {
  try { out[name] = await fn(); } catch (e) { out[name] = null; errors[name] = String(e && e.message ? e.message : e); }
}

async function buildDashboard(env) {
  const eiaKey = env && env.EIA_API_KEY, gieKey = env && env.AGSI_API_KEY;
  const out = { source: 'EIA, GIE AGSI+, Yahoo Finance', fetched: Date.now() }, errors = {};
  const need = (k, name) => () => { if (!k) throw new Error(`Add the ${name} secret in Cloudflare`); };
  await Promise.all([
    settle('storage_report', getStorageReport, out, errors),
    settle('storage_history', eiaKey ? () => getStorageHistory(eiaKey) : need(0, 'EIA_API_KEY'), out, errors),
    settle('henry_hub', eiaKey ? () => getHenryHub(eiaKey) : need(0, 'EIA_API_KEY'), out, errors),
    settle('steo', eiaKey ? () => getSteo(eiaKey) : need(0, 'EIA_API_KEY'), out, errors),
    settle('lng_destinations', eiaKey ? () => getLngDestinations(eiaKey) : need(0, 'EIA_API_KEY'), out, errors),
    settle('eu_storage', gieKey ? () => getEuStorage(gieKey) : need(0, 'AGSI_API_KEY'), out, errors),
    settle('futures', getFrontMonth, out, errors),
  ]);
  out.errors = errors;
  return out;
}

export default {
  async fetch(request, env) {
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Cache-Control': 'public, max-age=60',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers });
    try {
      const params = new URL(request.url).searchParams;
      const debug = params.has('debug');
      if (params.has('history')) {
        const h = await buildHistory(env);
        return new Response(JSON.stringify(h, null, debug ? 2 : 0), { headers });
      }
      if (params.has('dashboard')) {
        if (!debug && dashMemo && Date.now() - dashMemo.at < DASH_CACHE_MS) return new Response(dashMemo.body, { headers });
        const d = await buildDashboard(env);
        const body = JSON.stringify(d, null, debug ? 2 : 0);
        if (d.storage_report || d.steo) dashMemo = { at: Date.now(), body };
        return new Response(body, { headers });
      }
      if (!debug && memo && Date.now() - memo.at < CACHE_MS) return new Response(memo.body, { headers });
      const payload = await buildPayload(env);
      const body = JSON.stringify(payload, null, debug ? 2 : 0);
      if (Object.values(payload.quotes).some((q) => !q.error)) memo = { at: Date.now(), body };
      return new Response(body, { headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e && e.message ? e.message : e) }), { status: 500, headers });
    }
  },
};
