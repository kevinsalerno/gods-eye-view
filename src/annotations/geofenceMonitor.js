/**
 * Geofence monitor — drives geofenceWatch on every live position update.
 *
 * On each data refresh it reads live entity positions straight off the Cesium
 * datasources (source-agnostic: flights, vessels, traffic, satellites all land
 * as entities), tests them against the drawn AREA annotations, and dispatches
 * `gev:geofence-enter` (on window) once per entity on the initial outside→inside
 * crossing (the de-duplicated alert), plus `gev:geofence` for full enter/exit
 * state. On a breach it also shows a visual alert and POSTs the webhook; a Test
 * button POSTs a mock payload to check connectivity. No data source is touched —
 * the check is orthogonal, run after positions land.
 *
 * The Cesium/DOM half; the containment maths lives in the pure geofenceWatch.js.
 */
import * as Cesium from 'cesium';
import { createGeofenceWatch } from './geofenceWatch.js';
import { greatCircleM } from './drawMode.js';
import { isPostableUrl, buildBreachPayload } from './breachAlert.js';

// Where the breach webhook URL is configured (DISPLAY ▸ Draw controls).
const WEBHOOK_INPUT_ID = 'geofence-webhook-url';

const readTargetUrl = () => {
  if (typeof document === 'undefined') return '';
  return document.getElementById(WEBHOOK_INPUT_ID)?.value?.trim() || '';
};

/** POST a breach payload. Returns the fetch promise so callers can await it. */
function sendBreach(url, payload) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true, // survive a tab close between breach and send
  });
}

/** Fire-and-forget POST of a breach payload; never throws into the caller. */
function postBreach(url, payload) {
  try {
    sendBreach(url, payload).catch((err) =>
      console.warn('[Geofence] breach POST failed:', err),
    );
  } catch (err) {
    console.warn('[Geofence] breach POST failed:', err);
  }
}

// Annotation-owned datasources hold the geofences and the draw preview — never
// test those entities against their own rings.
const SKIP_SOURCES = new Set(['gev-annotations', 'gev-draw-preview']);

/** A drawn area with a usable ring — the only annotation kind that is a fence. */
const isActiveArea = (a) =>
  a?.type === 'area' && Array.isArray(a.ring) && a.ring.length >= 3;

/**
 * @param {{viewer: Cesium.Viewer, dataManager: {subscribeActivity: Function},
 *   annotations: {list: Function}}} deps
 * @returns {{evaluateNow: () => void, dispose: () => void}}
 */
export function installGeofenceMonitor({ viewer, dataManager, annotations }) {
  const noop = { evaluateNow() {}, dispose() {} };
  if (!viewer || !dataManager?.subscribeActivity || !annotations?.list) {
    return noop;
  }

  const hasWindow = typeof window !== 'undefined';
  const emit = (name, detail) => {
    if (!hasWindow) return; // headless → no listeners to notify
    window.dispatchEvent(new CustomEvent(name, { detail }));
  };

  // Visual alert surface: the status line under the webhook input doubles as the
  // breach banner and the connectivity-test result. Missing DOM → silent no-op.
  const statusEl =
    typeof document !== 'undefined'
      ? document.getElementById('geofence-status')
      : null;
  let statusTimer = null;
  const showStatus = (text, kind, autoClearMs = 0) => {
    if (!statusEl) return;
    clearTimeout(statusTimer);
    statusEl.textContent = text;
    statusEl.className = `draw-hint geofence-status is-${kind}`;
    if (autoClearMs > 0) {
      statusTimer = setTimeout(() => {
        statusEl.textContent = '';
        statusEl.className = 'draw-hint geofence-status';
      }, autoClearMs);
    }
  };

  // Ground speed is derived, not read: Cesium entity positions carry no
  // velocity, so each scan diffs an entity's position against the previous one.
  const lastSeen = new Map(); // entityId -> { lon, lat, t } from the prior scan
  const speeds = new Map(); // entityId -> m/s for the current scan

  const watch = createGeofenceWatch({
    // The alert: fired once, on the initial outside→inside crossing only.
    onEnter: (hit) => {
      emit('gev:geofence-enter', hit);
      showStatus(`⚠ Breach — ${hit.entityId}`, 'breach', 6000);
      const url = readTargetUrl();
      if (!isPostableUrl(url)) return; // no/invalid webhook configured
      postBreach(
        url,
        buildBreachPayload(hit, { speed: speeds.get(hit.entityId) }),
      );
    },
    // Full transition state (enters + exits) for anything that wants both.
    onChange: (detail) => emit('gev:geofence', detail),
  });

  // Test toggle: POST a mock payload to the configured URL and report whether
  // the webhook answered — a connectivity check that draws no real breach.
  const testButton =
    typeof document !== 'undefined'
      ? document.getElementById('geofence-test')
      : null;
  const onTest = async () => {
    const url = readTargetUrl();
    if (!isPostableUrl(url)) {
      showStatus('Enter a valid http(s) URL first', 'error', 4000);
      return;
    }
    showStatus('Testing…', 'pending');
    const payload = buildBreachPayload(
      { entityId: 'test-entity', lon: 0, lat: 0 },
      { speed: 0 },
    );
    payload.test = true; // a connectivity probe, not a real breach
    try {
      const res = await sendBreach(url, payload);
      showStatus(
        res.ok ? `Webhook OK (${res.status})` : `Webhook error ${res.status}`,
        res.ok ? 'ok' : 'error',
        6000,
      );
    } catch {
      showStatus('Webhook unreachable', 'error', 6000);
    }
  };
  testButton?.addEventListener('click', onTest);

  const activeAreas = () =>
    annotations
      .list()
      .filter(isActiveArea)
      .map((a) => ({ id: a.id, ring: a.ring }));

  const liveEntities = () => {
    const time = viewer.clock?.currentTime;
    const t = Date.now();
    const collections = [viewer.entities];
    const sources = viewer.dataSources;
    for (let i = 0; i < (sources?.length || 0); i += 1) {
      const src = sources.get(i);
      if (src && !SKIP_SOURCES.has(src.name)) collections.push(src.entities);
    }
    const out = [];
    const seen = new Set();
    speeds.clear();
    for (const collection of collections) {
      for (const entity of collection?.values || []) {
        const cart = entity.position?.getValue?.(time);
        if (!cart) continue;
        const carto = Cesium.Cartographic.fromCartesian(cart);
        if (!carto) continue;
        const id = entity.id;
        const lon = Cesium.Math.toDegrees(carto.longitude);
        const lat = Cesium.Math.toDegrees(carto.latitude);
        const prev = lastSeen.get(id);
        if (prev && t > prev.t) {
          const mps = (greatCircleM(prev, { lon, lat }) / (t - prev.t)) * 1000;
          speeds.set(id, mps);
        }
        lastSeen.set(id, { lon, lat, t });
        seen.add(id);
        out.push({ id, lon, lat });
      }
    }
    // Forget entities that vanished so lastSeen stays bounded by what's live.
    for (const id of lastSeen.keys()) if (!seen.has(id)) lastSeen.delete(id);
    return out;
  };

  // ponytail: full O(entities × areas) rescan per update; fine at whiteboard
  // fence counts. If fences or entities ever balloon, index by bounding box.
  const evaluateNow = () => {
    const areas = activeAreas();
    // No fence → drop prior "inside" state so re-drawing one doesn't replay
    // stale enters for entities that never actually crossed a new boundary.
    if (!areas.length) {
      watch.reset();
      lastSeen.clear(); // stale positions would poison the next speed diff
      return;
    }
    watch.evaluate(liveEntities(), areas);
  };

  // Coalesce: several layers can publish data-updated within one tick; run one
  // scan per microtask rather than once per layer.
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      evaluateNow();
    });
  };

  const unsubscribe = dataManager.subscribeActivity((change) => {
    if (change?.type === 'data-updated') schedule();
  });

  return {
    evaluateNow,
    dispose() {
      unsubscribe();
      testButton?.removeEventListener('click', onTest);
      clearTimeout(statusTimer);
    },
  };
}
