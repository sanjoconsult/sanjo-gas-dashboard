// Listens to aisstream.io for a few minutes, then writes the LNG ship snapshot.
// Usage: AISSTREAM_API_KEY=... node scripts/ais/collect.mjs <previous.json|-> <output.json>
// Runs in GitHub Actions (.github/workflows/ais.yml); aisstream does not allow browser connections.
import fs from 'node:fs';
import { WORLD, applyMessage, buildSnapshot, buildFleet, fleetIndex } from './classify.mjs';

const KEY = process.env.AISSTREAM_API_KEY;
const SECONDS = Number(process.env.AIS_SECONDS || 420); // static data is broadcast every 6 minutes
const [prevPath = '-', outPath = 'ships.json'] = process.argv.slice(2);

if (!KEY) { console.error('AISSTREAM_API_KEY is not set'); process.exit(1); }

let prev = null;
if (prevPath !== '-' && fs.existsSync(prevPath)) {
  try { prev = JSON.parse(fs.readFileSync(prevPath, 'utf8')); } catch { console.warn('Previous snapshot unreadable; starting fresh'); }
}

// Reference list of LNG carriers in operation (name, IMO, capacity...)
const fleetFile = new URL('../../site/lng-fleet.json', import.meta.url);
const idx = fleetIndex(JSON.parse(fs.readFileSync(fleetFile, 'utf8')).ships);

const ships = {};
let count = 0, lastError = null;

function listen() {
  return new Promise((resolve) => {
    const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
    ws.binaryType = 'arraybuffer';
    const stop = setTimeout(() => ws.close(), SECONDS * 1000);
    ws.addEventListener('open', () => {
      // Must be sent within 3 seconds of connecting
      ws.send(JSON.stringify({ APIKey: KEY, BoundingBoxes: [WORLD], FilterMessageTypes: ['PositionReport', 'ShipStaticData'] }));
    });
    ws.addEventListener('message', (ev) => {
      try {
        const text = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
        const msg = JSON.parse(text);
        if (msg.error) { lastError = msg.error; return; }
        applyMessage(ships, msg);
        count++;
      } catch (e) { lastError = e.message; }
    });
    ws.addEventListener('error', (e) => { lastError = e.message || 'WebSocket error'; });
    ws.addEventListener('close', () => { clearTimeout(stop); resolve(); });
  });
}

await listen();
console.log(`Received ${count} messages from ${Object.keys(ships).length} ships`);
if (!count) {
  console.error('No AIS messages received' + (lastError ? ': ' + lastError : ''));
  process.exit(1); // keep the previous snapshot rather than publishing an empty one
}
const now = new Date().toISOString();
const snap = buildSnapshot(prev, ships, now, 3, idx);
Object.assign(snap, buildFleet(prev && prev.fleet, [...snap.ships, ...Object.values(ships)], idx, now));
snap.messages = count;
fs.writeFileSync(outPath, JSON.stringify(snap, null, 1));
console.log('Gulf LNG ships:', JSON.stringify(snap.counts));
console.log('Fleet:', JSON.stringify(snap.fleet_counts));
for (const s of snap.ships) console.log(` ${s.name || s.mmsi} | ${s.status} | ${s.terminal} ${s.terminal_km} km`);
