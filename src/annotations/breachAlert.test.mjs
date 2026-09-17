// Pure tests for the breach-alert webhook helpers. Run with: npm test
// (node --test). No Cesium, no DOM, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPostableUrl, buildBreachPayload } from './breachAlert.js';

test('isPostableUrl accepts only non-empty http(s) URLs', () => {
  assert.equal(isPostableUrl('https://example.com/hook'), true);
  assert.equal(isPostableUrl('http://10.0.0.1:8080/x'), true);
  assert.equal(isPostableUrl('  https://example.com  '), true); // trimmed
  assert.equal(isPostableUrl(''), false);
  assert.equal(isPostableUrl('   '), false);
  assert.equal(isPostableUrl('not a url'), false);
  assert.equal(isPostableUrl('ftp://example.com'), false);
  assert.equal(isPostableUrl('javascript:alert(1)'), false);
  assert.equal(isPostableUrl(null), false);
});

test('buildBreachPayload shapes entity id, timestamp, coordinates, speed', () => {
  const payload = buildBreachPayload(
    { entityId: 'icao-abc', lon: 12.5, lat: -3.25 },
    { speed: 231.4, now: 0 },
  );
  assert.deepEqual(payload, {
    entityId: 'icao-abc',
    timestamp: '1970-01-01T00:00:00.000Z',
    coordinates: { lon: 12.5, lat: -3.25 },
    speed: 231.4,
  });
});

test('buildBreachPayload nulls an unknown/invalid speed', () => {
  assert.equal(buildBreachPayload({ entityId: 'x', lon: 0, lat: 0 }).speed, null);
  assert.equal(
    buildBreachPayload(
      { entityId: 'x', lon: 0, lat: 0 },
      { speed: Number.NaN, now: 0 },
    ).speed,
    null,
  );
});
