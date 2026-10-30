// Tests for the LNG ship classifier used by the AIS collector.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMessage, isLng, describe, buildSnapshot, nearestTerminal, distanceKm } from '../scripts/ais/classify.mjs';

const pos = (mmsi, name, lat, lon, sog, cog, nav = 0) => ({ MessageType: 'PositionReport', MetaData: { MMSI: mmsi, ShipName: name, latitude: lat, longitude: lon }, Message: { PositionReport: { Latitude: lat, Longitude: lon, Sog: sog, Cog: cog, NavigationalStatus: nav } } });
const stat = (mmsi, name, type, a, b) => ({ MessageType: 'ShipStaticData', MetaData: { MMSI: mmsi, ShipName: name }, Message: { ShipStaticData: { Name: name, Type: type, Dimension: { A: a, B: b, C: 20, D: 25 }, Destination: 'SABINE PASS', MaximumStaticDraught: 11.5 } } });
const NOW = '2026-10-30T18:00:00Z';

test('distances and nearest terminal are sensible', () => {
  assert.ok(Math.abs(distanceKm({ lat: 29.7541, lon: -93.8741 }, { lat: 29.7614, lon: -93.9194 }) - 4.45) < 0.2, 'Sabine Pass to Golden Pass is about 4.4 km');
  assert.equal(nearestTerminal({ lat: 27.91, lon: -97.28 }).name, 'Corpus Christi');
});

test('builds ship records from position and static messages, cleaning AIS padding', () => {
  const ships = {};
  applyMessage(ships, pos(1, 'CREOLE SPIRIT@@@@  ', 29.755, -93.875, 0.1, 10, 5), NOW);
  applyMessage(ships, stat(1, 'CREOLE SPIRIT', 84, 250, 44), NOW);
  assert.equal(ships['1'].name, 'CREOLE SPIRIT');
  assert.equal(ships['1'].length_m, 294);
  assert.equal(ships['1'].ship_type, 84);
  assert.equal(ships['1'].seen, NOW);
});

test('ignores speed and course values that mean "not available"', () => {
  const ships = {};
  applyMessage(ships, pos(2, 'X', 28, -95, 102.3, 360), NOW);
  assert.equal(ships['2'].sog, null);
  assert.equal(ships['2'].cog, null);
});

test('identifies LNG carriers by name, by a large tanker at an LNG berth, or by a remembered MMSI', () => {
  assert.ok(isLng({ mmsi: '1', name: 'LNG JUNO', lat: 25, lon: -90 }));
  assert.ok(isLng({ mmsi: '2', name: 'MARAN GAS', ship_type: 84, length_m: 295, lat: 29.755, lon: -93.875 }), 'big tanker at Sabine Pass berth');
  assert.ok(!isLng({ mmsi: '3', name: 'EAGLE', ship_type: 80, length_m: 183, lat: 29.755, lon: -93.875 }), 'small tanker is not LNG');
  assert.ok(!isLng({ mmsi: '4', name: 'BIG CRUDE', ship_type: 80, length_m: 330, lat: 28.9, lon: -90.0 }), 'big tanker offshore is not assumed LNG');
  assert.ok(isLng({ mmsi: '4', name: 'BIG CRUDE', lat: 28.9, lon: -90 }, new Set(['4'])));
  assert.ok(!isLng({ mmsi: '5', name: 'FLNG' }), 'LNG must be a separate word');
});

test('describes status: at berth, waiting, inbound and outbound', () => {
  assert.equal(describe({ lat: 27.913, lon: -97.287, sog: 0, nav_status: 5 }).status, 'At berth');
  assert.equal(describe({ lat: 29.3, lon: -93.9, sog: 0.2, nav_status: 1 }).status, 'Anchored / waiting');
  assert.equal(describe({ lat: 29.3, lon: -93.87, sog: 11, cog: 0 }).status, 'Inbound', 'heading north toward Sabine Pass');
  assert.equal(describe({ lat: 29.3, lon: -93.87, sog: 11, cog: 180 }).status, 'Outbound');
});

test('snapshot keeps known LNG ships, drops stale and far-away ones, and remembers MMSIs', () => {
  const ships = {};
  applyMessage(ships, pos(10, 'SABINE CARRIER', 29.755, -93.875, 0, 0, 5), NOW);
  applyMessage(ships, stat(10, 'SABINE CARRIER', 84, 250, 45), NOW);
  applyMessage(ships, pos(11, 'LNG FAR AWAY', 26.3, -88.4, 12, 90), NOW); // > 60 km from every terminal
  const prev = { known_lng_mmsi: ['12'], ships: [
    { mmsi: '12', name: 'OUTBOUND ONE', lat: 29.4, lon: -93.85, sog: 14, cog: 175, seen: '2026-10-30T17:30:00Z' },
    { mmsi: '13', name: 'LNG OLD', lat: 29.7, lon: -93.9, sog: 0, seen: '2026-10-30T10:00:00Z' },
  ] };
  const snap = buildSnapshot(prev, ships, NOW);
  const names = snap.ships.map((s) => s.name);
  assert.deepEqual(names.sort(), ['OUTBOUND ONE', 'SABINE CARRIER']);
  assert.equal(snap.counts.at_berth, 1);
  assert.equal(snap.counts.outbound, 1);
  assert.ok(snap.known_lng_mmsi.includes('10'), 'ship seen at a berth is remembered');
  assert.equal(snap.updated, NOW);
});

import { fleetIndex, fleetMatch, usBound, buildFleet } from '../scripts/ais/classify.mjs';
const FLEET = fleetIndex([{ name: 'Hyundai Peacepia', imo: '9761853', capacity_m3: 174000 }, { name: 'Al Bidda', imo: '9132741', capacity_m3: 137300 }, { name: 'Maran Gas Apollonia', imo: '9633422', capacity_m3: 161870 }]);

test('reference fleet matches ships by IMO or by name, ignoring case and punctuation', () => {
  assert.equal(fleetMatch({ imo: '9132741', name: 'WHATEVER' }, FLEET).name, 'Al Bidda');
  assert.equal(fleetMatch({ name: 'HYUNDAI  PEACEPIA' }, FLEET).imo, '9761853');
  assert.equal(fleetMatch({ name: 'MARAN-GAS APOLLONIA' }, FLEET).imo, '9633422');
  assert.equal(fleetMatch({ name: 'SOME TUG' }, FLEET), null);
  assert.ok(isLng({ mmsi: '9', name: 'AL BIDDA', lat: 25, lon: 51 }, new Set(), FLEET), 'fleet ships count as LNG without LNG in the name');
});

test('reads US destinations the way crews type them', () => {
  for (const d of ['USSAB', 'KRYOS>USSAB', 'SABINE PASS', 'CORPUS CHRISTI US', 'US CRP', 'FOR ORDERS > COVE POINT', 'USA']) assert.ok(usBound(d), d);
  for (const d of ['', 'BUSAN', 'USSAB>KRBUS', 'ROTTERDAM', 'FOR ORDERS', 'JPFUK']) assert.ok(!usBound(d), d);
});

test('fleet snapshot labels ships at, bound for and leaving the US, and keeps last positions for 7 days', () => {
  const ships = {};
  applyMessage(ships, pos(1, 'HYUNDAI PEACEPIA', 29.7545, -93.8745, 0, 0, 5), NOW); // at Sabine Pass
  applyMessage(ships, pos(2, 'AL BIDDA', 36.1, -6.0, 15, 270), NOW);
  applyMessage(ships, { MessageType: 'ShipStaticData', MetaData: { MMSI: 2, ShipName: 'AL BIDDA' }, Message: { ShipStaticData: { Name: 'AL BIDDA', ImoNumber: 9132741, Destination: 'USCAM', Type: 84, Dimension: { A: 200, B: 90 } } } }, NOW);
  applyMessage(ships, pos(3, 'NOT A CARRIER', 30, -40, 10, 90), NOW);
  const prev = [{ imo: '9633422', name: 'Maran Gas Apollonia', lat: 27.0, lon: -85.0, destination: 'ROTTERDAM', seen: '2026-10-29T00:00:00Z', last_us_terminal: 'Corpus Christi', last_us_seen: '2026-10-27T00:00:00Z' },
    { imo: '1111111', name: 'Gone', lat: 0, lon: 0, seen: '2026-10-01T00:00:00Z' }];
  const { fleet, fleet_counts: c } = buildFleet(prev, ships, FLEET, NOW);
  const by = Object.fromEntries(fleet.map((s) => [s.name, s]));
  assert.equal(by['Hyundai Peacepia'].us_status, 'At US terminal');
  assert.equal(by['Hyundai Peacepia'].last_us_terminal, 'Sabine Pass');
  assert.equal(by['Al Bidda'].us_status, 'Bound for US');
  assert.equal(by['Maran Gas Apollonia'].us_status, 'Left US');
  assert.ok(!by.Gone, 'positions older than 7 days are dropped');
  assert.deepEqual(c, { reference: 3, tracked: 3, at_us: 1, bound_us: 1, left_us: 1, elsewhere: 0 });
});

test('a carrier still at a berth from an earlier run counts as at the US terminal', () => {
  const gulf = [{ mmsi: '1', name: 'Hyundai Peacepia', imo: '9761853', lat: 29.7545, lon: -93.8745, sog: 0, seen: '2026-10-30T17:00:00Z' }];
  const { fleet } = buildFleet([], [...gulf, ...Object.values({})], FLEET, NOW);
  assert.equal(fleet[0].us_status, 'At US terminal');
});
