// Pure tests for the geofence containment evaluator. Run with: npm test
// (node --test). No Cesium, no DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateContainment,
  createGeofenceWatch,
} from './geofenceWatch.js';

// A unit square around the origin.
const SQUARE = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

test('evaluateContainment flags only entities inside a ring', () => {
  const hits = evaluateContainment(
    [
      { id: 'in', lon: 0, lat: 0 },
      { id: 'out', lon: 5, lat: 5 },
      { id: 'nan', lon: Number.NaN, lat: 0 },
    ],
    [{ id: 'fence', ring: SQUARE }],
  );
  assert.equal(hits.size, 1);
  assert.deepEqual(
    [...hits.values()][0],
    { entityId: 'in', areaId: 'fence', lon: 0, lat: 0 },
  );
});

test('evaluateContainment tolerates bad input and skips ringless areas', () => {
  assert.equal(evaluateContainment(null, [{ id: 'f', ring: SQUARE }]).size, 0);
  assert.equal(evaluateContainment([{ id: 'a', lon: 0, lat: 0 }], null).size, 0);
  assert.equal(
    evaluateContainment([{ id: 'a', lon: 0, lat: 0 }], [{ id: 'f' }]).size,
    0,
  );
});

test('the watch reports enter and exit transitions, not steady state', () => {
  const events = [];
  const watch = createGeofenceWatch({ onChange: (e) => events.push(e) });
  const areas = [{ id: 'fence', ring: SQUARE }];

  // Enter.
  let r = watch.evaluate([{ id: 'jet', lon: 0, lat: 0 }], areas);
  assert.equal(r.entered.length, 1);
  assert.equal(r.entered[0].entityId, 'jet');
  assert.equal(r.exited.length, 0);

  // Still inside → no transition, no onChange.
  r = watch.evaluate([{ id: 'jet', lon: 0.5, lat: 0.5 }], areas);
  assert.equal(r.entered.length, 0);
  assert.equal(r.exited.length, 0);
  assert.equal(r.inside.length, 1);

  // Leave.
  r = watch.evaluate([{ id: 'jet', lon: 9, lat: 9 }], areas);
  assert.equal(r.exited.length, 1);
  assert.equal(r.exited[0].entityId, 'jet');
  assert.equal(r.inside.length, 0);

  // onChange fired only on the two transitions, not the steady-state pass.
  assert.equal(events.length, 2);
});

test('onEnter fires once per crossing, never for a still-inside entity', () => {
  const enters = [];
  const watch = createGeofenceWatch({ onEnter: (h) => enters.push(h) });
  const areas = [{ id: 'fence', ring: SQUARE }];

  watch.evaluate([{ id: 'jet', lon: 0, lat: 0 }], areas); // outside→inside
  watch.evaluate([{ id: 'jet', lon: 0.5, lat: 0.5 }], areas); // still inside
  watch.evaluate([{ id: 'jet', lon: 0.2, lat: 0.2 }], areas); // still inside
  assert.equal(enters.length, 1); // no duplicate alerts
  assert.equal(enters[0].entityId, 'jet');

  watch.evaluate([{ id: 'jet', lon: 9, lat: 9 }], areas); // exit — not an enter
  assert.equal(enters.length, 1);

  watch.evaluate([{ id: 'jet', lon: 0, lat: 0 }], areas); // re-enter → alert again
  assert.equal(enters.length, 2);
});

test('reset() forgets prior containment so the next pass re-enters', () => {
  const watch = createGeofenceWatch();
  const areas = [{ id: 'fence', ring: SQUARE }];
  watch.evaluate([{ id: 'jet', lon: 0, lat: 0 }], areas);
  watch.reset();
  const r = watch.evaluate([{ id: 'jet', lon: 0, lat: 0 }], areas);
  assert.equal(r.entered.length, 1);
});
