// One-off: builds scripts/ais/gulf-coast.json (the coastline drawn behind the LNG ship map,
// and pasted into GULF_LAND in site/gas_dashboard.html) from us-atlas, clipped to the Gulf Coast.
// Run in a scratch folder: npm i us-atlas@3.0.1 topojson-client@3.1.0 topojson-simplify@3.0.3 d3-geo@3.1.1
// then: node build-coastline.mjs 0
import fs from 'node:fs';
import * as topo from 'topojson-client';
import * as simp from 'topojson-simplify';
import { geoIdentity } from 'd3-geo';
const us = JSON.parse(fs.readFileSync('node_modules/us-atlas/nation-10m.json'));
const t = simp.simplify(simp.presimplify(us), Number(process.argv[2] || 0.0005));
const nation = topo.feature(t, t.objects.nation);
const rings = []; let cur = null;
const sink = { point(x, y) { cur.push([+x.toFixed(3), +y.toFixed(3)]); }, lineStart() { cur = []; }, lineEnd() { if (cur.length > 2) rings.push(cur); }, polygonStart() {}, polygonEnd() {}, sphere() {} };
const id = geoIdentity().clipExtent([[-98.2, 26.2], [-88.3, 31.2]]);
const s = id.stream(sink);
for (const f of nation.features ?? [nation]) {
  const g = f.geometry; const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (const p of polys) { s.polygonStart(); for (const r of p) { s.lineStart(); r.forEach(([x, y]) => s.point(x, y)); s.lineEnd(); } s.polygonEnd(); }
}
const out = rings.filter((r) => r.length > 3);
console.error('rings', out.length, 'points', out.reduce((a, r) => a + r.length, 0), 'bytes', JSON.stringify(out).length);
fs.writeFileSync('gulf.json', JSON.stringify(out));
