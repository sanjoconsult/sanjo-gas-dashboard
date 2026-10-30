// Pure functions that turn raw aisstream.io messages into a list of LNG ships
// near the US Gulf Coast export terminals. No network access here, so it is unit-tested.

// Berth coordinates (approximate centre of the marine loading area), from GEM wiki terminal pages.
export const TERMINALS = [
  { name: 'Sabine Pass', lat: 29.7541, lon: -93.8741 },
  { name: 'Golden Pass', lat: 29.7614, lon: -93.9194 },
  { name: 'Cameron LNG', lat: 30.0354, lon: -93.3384 },
  { name: 'Calcasieu Pass', lat: 29.7729, lon: -93.3343 },
  { name: 'Corpus Christi', lat: 27.9135, lon: -97.2866 },
  { name: 'Freeport', lat: 28.932, lon: -95.3174 },
  { name: 'Plaquemines', lat: 29.6004, lon: -89.8864 },
];

// aisstream bounding box: [[lat, lon], [lat, lon]] covering Corpus Christi to the Mississippi delta.
export const BOX = [[26.2, -98.2], [31.2, -88.3]];

export const BERTH_KM = 3; // a stopped ship this close to a terminal is treated as at the berth
export const AREA_KM = 60; // ships further than this from every terminal are not shown
const MIN_LNG_LENGTH_M = 200; // LNG carriers are roughly 280–300 m; small tankers are excluded

const R = 6371;
const rad = (d) => (d * Math.PI) / 180;
export function distanceKm(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export function bearingDeg(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
export function nearestTerminal(p) {
  let best = null;
  for (const t of TERMINALS) {
    const km = distanceKm(p, t);
    if (!best || km < best.km) best = { name: t.name, km };
  }
  return best;
}

const clean = (s) => (typeof s === 'string' ? s.replace(/@+/g, ' ').replace(/\s+/g, ' ').trim() : '');

// Fold one aisstream message into the ship record keyed by MMSI.
export function applyMessage(ships, msg, now = new Date().toISOString()) {
  const meta = msg && msg.MetaData;
  if (!meta || !meta.MMSI) return ships;
  const id = String(meta.MMSI);
  const s = ships[id] || { mmsi: id };
  const name = clean(meta.ShipName);
  if (name) s.name = name;
  if (msg.MessageType === 'PositionReport') {
    const p = msg.Message && msg.Message.PositionReport;
    if (!p) return ships;
    const lat = p.Latitude ?? meta.Latitude, lon = p.Longitude ?? meta.Longitude;
    if (typeof lat !== 'number' || typeof lon !== 'number' || Math.abs(lat) > 90 || Math.abs(lon) > 180) return ships;
    Object.assign(s, {
      lat: +lat.toFixed(5), lon: +lon.toFixed(5),
      sog: typeof p.Sog === 'number' && p.Sog < 102.3 ? p.Sog : null, // 102.3 = not available
      cog: typeof p.Cog === 'number' && p.Cog < 360 ? p.Cog : null,
      nav_status: typeof p.NavigationalStatus === 'number' ? p.NavigationalStatus : null,
      seen: now,
    });
  } else if (msg.MessageType === 'ShipStaticData') {
    const d = msg.Message && msg.Message.ShipStaticData;
    if (!d) return ships;
    if (clean(d.Name)) s.name = clean(d.Name);
    if (typeof d.Type === 'number') s.ship_type = d.Type;
    const dim = d.Dimension || {};
    const len = (dim.A || 0) + (dim.B || 0);
    if (len > 0) s.length_m = len;
    if (clean(d.Destination)) s.destination = clean(d.Destination);
    if (typeof d.MaximumStaticDraught === 'number' && d.MaximumStaticDraught > 0) s.draught_m = d.MaximumStaticDraught;
    if (d.ImoNumber) s.imo = String(d.ImoNumber);
    s.static_seen = now;
  } else return ships;
  ships[id] = s;
  return ships;
}

// Is this ship an LNG carrier? Name, a previously confirmed MMSI, or a large tanker stopped at an LNG berth.
export function isLng(s, knownLng = new Set()) {
  if (knownLng.has(s.mmsi)) return true;
  if (/\bLNG\b/i.test(s.name || '')) return true;
  const tanker = s.ship_type >= 80 && s.ship_type <= 89;
  if (tanker && s.length_m >= MIN_LNG_LENGTH_M && typeof s.lat === 'number') {
    const t = nearestTerminal(s);
    return t.km <= BERTH_KM;
  }
  return false;
}

// Plain-English status from AIS navigational status, speed and position.
export function describe(s) {
  const t = nearestTerminal(s);
  const stopped = s.nav_status === 5 || s.nav_status === 1 || (s.sog != null && s.sog < 0.5);
  if (stopped && t.km <= BERTH_KM) return { status: 'At berth', terminal: t.name, km: t.km };
  if (stopped) return { status: 'Anchored / waiting', terminal: t.name, km: t.km };
  if (s.cog == null) return { status: 'Underway', terminal: t.name, km: t.km };
  const toward = Math.abs(((bearingDeg(s, TERMINALS.find((x) => x.name === t.name)) - s.cog + 540) % 360) - 180) < 60;
  return { status: toward ? 'Inbound' : 'Outbound', terminal: t.name, km: t.km };
}

// Merge the fresh window into the previous snapshot and build the published file.
export function buildSnapshot(prev, fresh, now = new Date().toISOString(), maxAgeHours = 3) {
  const all = {};
  for (const s of (prev && prev.ships) || []) all[s.mmsi] = { ...s };
  for (const [id, s] of Object.entries(fresh)) all[id] = { ...(all[id] || {}), ...s };
  const known = new Set([...((prev && prev.known_lng_mmsi) || [])]);
  const cutoff = Date.parse(now) - maxAgeHours * 3600e3;
  const ships = [];
  for (const s of Object.values(all)) {
    if (typeof s.lat !== 'number' || !s.seen || Date.parse(s.seen) < cutoff) continue;
    if (!isLng(s, known)) continue;
    known.add(s.mmsi);
    const d = describe(s);
    if (d.km > AREA_KM) continue;
    ships.push({ ...s, status: d.status, terminal: d.terminal, terminal_km: +d.km.toFixed(1) });
  }
  ships.sort((a, b) => a.terminal.localeCompare(b.terminal) || a.terminal_km - b.terminal_km);
  const by = (st) => ships.filter((s) => s.status === st).length;
  return {
    updated: now,
    source: 'aisstream.io (terrestrial AIS receivers)',
    area: 'US Gulf Coast LNG export terminals',
    counts: { total: ships.length, at_berth: by('At berth'), waiting: by('Anchored / waiting'), inbound: by('Inbound'), outbound: by('Outbound') },
    ships,
    known_lng_mmsi: [...known].sort().slice(-2000),
  };
}
