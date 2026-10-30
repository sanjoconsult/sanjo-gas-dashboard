// Tests for the Cloudflare price relay, run against mocked data sources.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let worker;
let calls = [];
let routes = {};

// Route fetch() calls to canned responses by URL substring
globalThis.fetch = async (input) => {
  const url = decodeURIComponent(String(input));
  calls.push(url);
  for (const [key, body] of Object.entries(routes)) {
    if (url.includes(key)) return typeof body === 'function' ? body(url) : new Response(JSON.stringify(body), { status: 200 });
  }
  return new Response('not found', { status: 404 });
};

const yahoo = (price, prev, time = 1793289878) => ({ chart: { result: [{ meta: { regularMarketPrice: price, chartPreviousClose: prev, regularMarketTime: time, shortName: 'test' } }] } });
const call = async (query, env = {}) => (await worker.fetch(new Request('https://relay.test/' + query), env)).json();

beforeEach(async () => {
  calls = [];
  routes = {};
  // Fresh module per test so in-memory caches start empty
  worker = (await import('../worker/worker.js?t=' + Math.random())).default;
});

test('picks the NYMEX front-month natural gas contract and reports its change', async () => {
  routes = { 'NGZ26.NYM': yahoo(2.95, 3.03), 'CL=F': yahoo(100, 101), 'BZ=F': yahoo(110, 111), 'TTF=F': yahoo(97.5, 98), 'EURUSD=X': yahoo(1.12, 1.12), 'oilpriceapi': { data: { price: 32.35, created_at: '2026-10-29T00:01:00Z' } } };
  const RealDate = Date;
  globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : ['2026-10-29T16:00:00Z'])); } static now() { return new RealDate('2026-10-29T16:00:00Z').getTime(); } };
  try {
    const j = await call('?debug=1', { OILPRICE_API_KEY: 'k' });
    assert.equal(j.quotes.ng1.symbol, 'NGZ26.NYM');
    assert.equal(j.quotes.ng1.contract, 'Dec 26');
    assert.ok(Math.abs(j.quotes.ng1.change - -0.08) < 1e-9);
  } finally { globalThis.Date = RealDate; }
});

test('JKM comes from OilPriceAPI and is cached between requests', async () => {
  routes = { 'oilpriceapi': { data: { price: 32.35, created_at: '2026-10-29T00:01:00Z' } }, 'finance.yahoo': yahoo(1, 1) };
  const env = { OILPRICE_API_KEY: 'k' };
  const a = await call('?debug=1', env);
  const b = await call('?debug=1', env);
  assert.equal(a.quotes.jkm.price, 32.35);
  assert.equal(b.quotes.jkm.price, 32.35);
  assert.equal(calls.filter((u) => u.includes('oilpriceapi')).length, 1, 'OilPriceAPI should be called once within the cache window');
});

test('JKM falls back to an error with the symbols tried when no source works', async () => {
  routes = { 'finance.yahoo': (u) => (u.includes('JKM') ? new Response('{}', { status: 404 }) : new Response(JSON.stringify(yahoo(1, 1)))) };
  const j = await call('?debug=1');
  assert.ok(j.quotes.jkm.error);
  assert.ok(Array.isArray(j.quotes.jkm.tried) && j.quotes.jkm.tried.length >= 1);
});

test('reads the EIA weekly storage report, including a region with zero change', async () => {
  const row = (name, cur, prev, ya, avg) => ({ name, data: [['2026-10-23', cur], ['2026-10-16', prev], ['2025-10-23', ya]], calculated: { net_change: cur - prev, '5yr-avg': avg, 'pct-change_yrago': +((cur - ya) / ya * 100).toFixed(1), 'pct-chg_5yr-avg': +((cur - avg) / avg * 100).toFixed(1) } });
  routes = {
    'wngsr.json': { release_date: '2026-10-29', series: [row('total lower 48 states', 3724, 3644, 3871, 3686), row('pacific region', 297, 297, 315, 281), row('south central salt region', 274, 251, 334, 310), row('south central region', 1168, 1125, 1278, 1196)] },
    'finance.yahoo': yahoo(2.95, 3.03),
  };
  const j = await call('?dashboard=1&debug=1');
  const byRegion = Object.fromEntries(j.storage_report.rows.map((r) => [r.region, r]));
  assert.equal(j.storage_report.week_ending, '2026-10-23');
  assert.equal(byRegion['Total Lower 48'].net_change_bcf, 80);
  assert.equal(byRegion['Pacific'].net_change_bcf, 0);
  assert.equal(byRegion['Salt'].region, 'Salt', 'salt must not be mistaken for South Central');
  assert.equal(byRegion['South Central'].working_gas_bcf, 1168);
});

test('dashboard sections that need keys report a clear error instead of failing', async () => {
  routes = { 'wngsr.json': { series: [] }, 'finance.yahoo': yahoo(2.95, 3.03) };
  const j = await call('?dashboard=1&debug=1');
  assert.equal(j.steo, null);
  assert.match(j.errors.steo, /EIA_API_KEY/);
  assert.match(j.errors.eu_storage, /AGSI_API_KEY/);
  assert.ok(j.futures && j.futures.price === 2.95, 'futures still load without keys');
});

test('weekly history converts TTF from EUR/MWh to USD/MMBtu and groups by Friday', async () => {
  const series = (closes) => ({ chart: { result: [{ timestamp: [1792800000, 1793404800], indicators: { quote: [{ close: closes }] } }] } });
  routes = { 'TTF=F': series([95, 97.5]), 'EURUSD=X': series([1.1, 1.12]), 'past_month': { data: { prices: [{ price: 29.8, created_at: '2026-10-19T00:01:00Z' }, { price: 32.35, created_at: '2026-10-29T00:01:00Z' }] } } };
  const j = await call('?history=1', { OILPRICE_API_KEY: 'k' });
  assert.deepEqual(j.errors, {});
  assert.equal(j.ttf[0].week_ending, '2026-10-30');
  assert.equal(j.ttf[0].usd_mmbtu, Math.round(95 * 1.1 / 3.412 * 100) / 100);
  for (const r of [...j.ttf, ...j.jkm]) assert.equal(new Date(r.week_ending + 'T00:00:00Z').getUTCDay(), 5, 'week_ending must be a Friday');
});

test('answers CORS preflight requests', async () => {
  const r = await worker.fetch(new Request('https://relay.test/', { method: 'OPTIONS' }), {});
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
});
