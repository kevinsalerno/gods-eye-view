/**
 * Geofence breach alert — the pure bits of the outbound webhook: validating the
 * configured target URL and shaping the POST body. `fetch` itself lives in the
 * Cesium/DOM half (geofenceMonitor.js); keeping these here makes them testable.
 */

/** A configured alert URL we're willing to POST to: a valid http(s) URL. */
export function isPostableUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false;
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/**
 * The structured breach payload.
 * @param {{entityId:string, lon:number, lat:number}} hit  The breaching entity.
 * @param {{speed?:number, now?:number}} [ctx]  `speed` in m/s (null if unknown);
 *   `now` epoch ms for the ISO timestamp (defaults to Date.now()).
 */
export function buildBreachPayload(
  hit,
  { speed = null, now = Date.now() } = {},
) {
  return {
    entityId: hit.entityId,
    timestamp: new Date(now).toISOString(),
    coordinates: { lon: hit.lon, lat: hit.lat },
    speed: Number.isFinite(speed) ? speed : null,
  };
}
