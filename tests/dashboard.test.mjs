// Browser test: the dashboard renders every tab from sample relay data without errors.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve('site');
const fixture = (f) => fs.readFileSync(path.resolve('tests/fixtures', f), 'utf8');
const d3 = fs.readFileSync(path.resolve('node_modules/d3/dist/d3.min.js'), 'utf8');
let server, base, browser;

before(async () => {
  server = http.createServer((req, res) => {
    const p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
    if (!p.startsWith(root) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': p.endsWith('.html') ? 'text/html' : p.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); });

async function openDashboard(relayUp, ships = 'live', forecast = 'live') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => {
    const u = route.request().url();
    if (u.includes('d3.min.js')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: d3 });
    if (u.includes('forecast-data/forecast.json')) {
      if (forecast === 'down') return route.abort();
      const f = JSON.parse(fixture('forecast.json'));
      f.updated = new Date(Date.now() - (forecast === 'stale' ? 72 : 2) * 3600e3).toISOString();
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(f) });
    }
    if (u.includes('ais-data/ships.json')) {
      if (ships === 'down') return route.abort();
      const when = new Date(Date.now() - (ships === 'stale' ? 8 * 3600e3 : 20 * 60e3)).toISOString();
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: fixture('ships.json').replaceAll('__NOW__', when) });
    }
    if (!u.includes('sanjo-prices') || !relayUp) return route.abort();
    const body = u.includes('?dashboard') ? fixture('dashboard.json') : u.includes('?history') ? fixture('history.json') : fixture('prices.json');
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body });
  });
  await page.goto(base + '/gas_dashboard.html');
  await page.waitForTimeout(1500);
  return { page, errors };
}

test('every tab renders with live data and no script errors', async () => {
  const { page, errors } = await openDashboard(true);
  for (const tab of ['storage', 'supply', 'demand', 'infrastructure', 'market', 'lng']) {
    await page.click('#tab-' + tab);
    await page.waitForTimeout(300);
    if (tab === 'infrastructure') {
      const events = await page.$$eval('#infrastructure tbody tr', (n) => n.length);
      assert.ok(events > 0, 'infrastructure tab should list events');
    } else {
      const svgs = await page.$$eval(`#${tab} .ng-chart svg`, (n) => n.length);
      assert.ok(svgs > 0, `${tab} tab should draw at least one chart`);
    }
  }
  assert.match(await page.textContent('.ng-chip-live'), /Live/);
  assert.match(await page.textContent('#storage'), /Oct 23, 2026/);
  assert.deepEqual(errors, []);
  await page.close();
});

test('region table renders a zero net change without breaking', async () => {
  const { page, errors } = await openDashboard(true);
  const rows = await page.$$eval('#region-table tbody tr', (n) => n.length);
  assert.equal(rows, 8);
  assert.deepEqual(errors, []);
  await page.close();
});

test('falls back to the built-in snapshot when the relay is down', async () => {
  const { page, errors } = await openDashboard(false);
  assert.match(await page.textContent('.ng-chip-live'), /Snapshot/);
  assert.match(await page.textContent('#ng-live-src'), /could not be loaded/);
  await page.click('#tab-market');
  const svgs = await page.$$eval('#market .ng-chart svg', (n) => n.length);
  assert.ok(svgs > 0);
  assert.deepEqual(errors, []);
  await page.close();
});

test('LNG tab shows live ship positions from the AIS snapshot', async () => {
  const { page, errors } = await openDashboard(true);
  await page.click('#tab-lng');
  await page.waitForTimeout(300);
  assert.match(await page.textContent('#ais-pill'), /^Live · /);
  assert.equal(await page.$$eval('#ship-table tbody tr', (n) => n.length), 4);
  assert.match(await page.textContent('#ship-table'), /TEST LNG ONE.*At berth.*Corpus Christi/s);
  assert.equal(await page.$$eval('#ship-map svg circle', (n) => n.length), 3, 'stopped ships are dots');
  assert.equal(await page.$$eval('#ship-map svg path[transform]', (n) => n.length), 1, 'moving ship is an arrow');
  assert.match(await page.textContent('#ais-kpis'), /At a berth.*2/s);
  assert.ok(await page.$eval('#ais-empty', (n) => n.hidden));
  assert.deepEqual(errors, []);
  await page.close();
});

test('LNG tab labels old ship data and still draws the map when the feed is down', async () => {
  let { page, errors } = await openDashboard(true, 'stale');
  await page.click('#tab-lng');
  assert.match(await page.textContent('#ais-pill'), /^Not live · last updated /);
  await page.close();
  ({ page, errors } = await openDashboard(true, 'down'));
  await page.click('#tab-lng');
  await page.waitForTimeout(300);
  assert.equal(await page.textContent('#ais-pill'), 'Not available');
  assert.ok(await page.$$eval('#ship-map svg path', (n) => n.length) > 0, 'coastline still drawn');
  assert.equal(await page.$$eval('#ship-table tbody tr', (n) => n.length), 0);
  assert.ok(!(await page.$eval('#ais-empty', (n) => n.hidden)));
  assert.deepEqual(errors, []);
  await page.close();
});

test('Storage tab shows the machine-learning forecast with its backtest', async () => {
  const { page, errors } = await openDashboard(true);
  await page.click('#tab-storage');
  await page.waitForTimeout(300);
  assert.match(await page.textContent('#ml-pill'), /^Updated /);
  const k = await page.textContent('#ml-kpis');
  assert.match(k, /Forecast, week ending Oct 30\+79 Bcf/);
  assert.match(k, /80% range \+60 to \+101/);
  assert.match(k, /13\.7 Bcf.*31\.4 Bcf for the five-year average/s);
  assert.equal(await page.$$eval('#ml-chart svg path', (n) => n.filter((p) => p.getAttribute('d') && p.getAttribute('d').length > 50).length) >= 3, true);
  assert.deepEqual(errors, []);
  await page.close();
});

test('Storage tab says when the forecast is old or missing', async () => {
  let { page } = await openDashboard(true, 'live', 'stale');
  await page.click('#tab-storage');
  assert.match(await page.textContent('#ml-pill'), /^Not live · last updated /);
  await page.close();
  const r = await openDashboard(true, 'live', 'down');
  await r.page.click('#tab-storage');
  assert.equal(await r.page.textContent('#ml-pill'), 'Not available');
  assert.match(await r.page.textContent('#ml-chart'), /could not be loaded/);
  assert.deepEqual(r.errors, []);
  await r.page.close();
});
