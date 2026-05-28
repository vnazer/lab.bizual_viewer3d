// Google Photorealistic 3D Tiles + GLB del edificio.
// Library: https://github.com/NASA-AMMOS/3DTilesRendererJS (bundled in /libs/3dtiles/)
// API key: stored in localStorage[bizual_google_maps_key]; first run prompts.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader }    from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader }   from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader }    from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RGBELoader }    from 'three/addons/loaders/RGBELoader.js';

import { TilesRenderer, WGS84_ELLIPSOID } from '3d-tiles-renderer';
import {
  GoogleCloudAuthPlugin,
  GLTFExtensionsPlugin,
  UnloadTilesPlugin,
  TileCompressionPlugin,
} from '3d-tiles-renderer/plugins';

import { getSunParams, setSunDirection } from './sun-schedule.js?v=20260519';
import { hasCustomHDRI, loadCustomHDRI } from './hdri-store.js?v=20260519';
import { sanitizeGLB } from './sanitize.js?v=20260519';
import { PostFX } from './postfx.js?v=20260519';

// Shared LS prefix with viewer.js so the main UI sliders and the Google 3D
// panel agree on values. JSON-encoded to match the viewer's `ls.set/get`.
const LAB_LS_PREFIX = 'bizual_lab_';
function readLabSetting(key, fallback) {
  try {
    const raw = localStorage.getItem(LAB_LS_PREFIX + key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch { return fallback; }
}

const GOOGLE_TILES_URL = 'https://tile.googleapis.com/v1/3dtiles/root.json';
const DRACO_DECODER    = 'https://www.gstatic.com/draco/v1/decoders/';
// Basis Universal transcoder — Google Maxar tiles ship textures in KTX2,
// without this decoder GLTFLoader hits `texture.source.uri` undefined and
// the tile mesh crashes silently (only the global Landsat basemap renders).
const KTX2_TRANSCODER  = 'https://unpkg.com/three@0.184.0/examples/jsm/libs/basis/';

const LAB_HDRI_PRESETS = {
  street:     './hdri/wide_street_01_2k.hdr',
  kloofendal: './hdri/kloofendal_2k.hdr',
  studio:     './hdri/studio_small_03_2k.hdr',
  sunset:     './hdri/venice_sunset_2k.hdr',
  indoor:     './hdri/empty_warehouse_01_2k.hdr',
  overcast:   './hdri/overcast_soil_2k.hdr',
};

async function getActiveHDRIUrl() {
  if (hasCustomHDRI()) {
    try {
      const rec = await loadCustomHDRI();
      if (rec?.data) return URL.createObjectURL(new Blob([rec.data], { type: 'application/octet-stream' }));
    } catch {}
  }
  const preset = localStorage.getItem('bizual_lab_hdri') || 'street';
  return LAB_HDRI_PRESETS[preset] || LAB_HDRI_PRESETS.street;
}

function getGoogleApiKey() { return localStorage.getItem('bizual_google_maps_key') || ''; }
function saveGoogleApiKey(k) { localStorage.setItem('bizual_google_maps_key', (k || '').trim()); }

// ─── Geo math (WGS84 ellipsoid — the same model Google's tiles use) ─────────
// A naive sphere (mean radius + geocentric latitude) misplaces the model by
// ~20 km vs Google's geodetic tiles, so the building floats off the real
// ground. Use the renderer's own ellipsoid for proper geodetic → ECEF.
const DEG2RAD = Math.PI / 180;

function latLonToECEF(lat, lon, altitudeM = 0) {
  const v = new THREE.Vector3();
  WGS84_ELLIPSOID.getCartographicToPosition(lat * DEG2RAD, lon * DEG2RAD, altitudeM, v);
  return v;
}

// East-North-Up frame on the ellipsoid at lat/lon + altitude. Columns are
// (east, north, up) — matches the local axis convention the GLB expects.
function getLocalFrameMatrix(lat, lon, altitudeM = 0) {
  const m = new THREE.Matrix4();
  WGS84_ELLIPSOID.getEastNorthUpFrame(lat * DEG2RAD, lon * DEG2RAD, m);
  if (altitudeM) m.setPosition(latLonToECEF(lat, lon, altitudeM));
  return m;
}

function getSunDirectionECEF(lat, lon, azimutDeg, elevDeg) {
  const east = new THREE.Vector3();
  const north = new THREE.Vector3();
  const up = new THREE.Vector3();
  WGS84_ELLIPSOID.getEastNorthUpAxes(lat * DEG2RAD, lon * DEG2RAD, east, north, up);
  const az = azimutDeg * DEG2RAD;
  const el = elevDeg * DEG2RAD;
  return new THREE.Vector3()
    .addScaledVector(east,  Math.cos(el) * Math.sin(az))
    .addScaledVector(north, Math.cos(el) * Math.cos(az))
    .addScaledVector(up,    Math.sin(el))
    .normalize();
}

// ─── Camera tween ─────────────────────────────────────────────────────────
function animateCameraTo(camera, controls, targetPos, lookAt, durationMs) {
  const startPos = camera.position.clone();
  const startTarget = controls.target.clone();
  const start = performance.now();
  function tick() {
    const t = Math.min((performance.now() - start) / durationMs, 1);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    camera.position.lerpVectors(startPos, targetPos, e);
    controls.target.lerpVectors(startTarget, lookAt, e);
    camera.up.copy(camera.position).normalize();
    controls.update();
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ─── Lifecycle handles (one panel at a time) ──────────────────────────────
let _animFrame = null;
let _resizeObs = null;
let _activeRenderer = null;
let _activeTiles = null;

export function closeGoogle3DPanel() {
  if (_animFrame) { cancelAnimationFrame(_animFrame); _animFrame = null; }
  if (_resizeObs) { _resizeObs.disconnect(); _resizeObs = null; }
  if (_activeTiles) {
    if (_activeTiles._statsInterval)   clearInterval(_activeTiles._statsInterval);
    if (_activeTiles._anchorInterval)  clearInterval(_activeTiles._anchorInterval);
    if (_activeTiles._anchorWatch)     clearInterval(_activeTiles._anchorWatch);
    if (_activeTiles._reAnchorTimer)   clearInterval(_activeTiles._reAnchorTimer);
    if (_activeTiles._envBakeTimer)    clearInterval(_activeTiles._envBakeTimer);
    if (_activeTiles._envCleanup) { try { _activeTiles._envCleanup(); } catch {} }
    if (_activeTiles._postfx)     { try { _activeTiles._postfx.dispose(); } catch {} }
    if (_activeTiles._svCleanup) { try { _activeTiles._svCleanup(); } catch {} }
    try { _activeTiles.dispose(); } catch {}
    _activeTiles = null;
  }
  if (_activeRenderer) { try { _activeRenderer.dispose(); } catch {} _activeRenderer = null; }
  window.__tiles = null;
  document.getElementById('g3d-panel')?.remove();
  document.getElementById('g3d-key-dialog')?.remove();
}
window.closeGoogle3DPanel = closeGoogle3DPanel;

// ─── API key dialog ───────────────────────────────────────────────────────
function openApiKeyDialog(coords, modelUrl) {
  document.getElementById('g3d-key-dialog')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'g3d-key-dialog';
  overlay.innerHTML = `
    <div class="g3d-dialog">
      <h3>🔑 API key de Google Maps</h3>
      <p>Para cargar los tiles fotorealistas de Google necesitás una API key con
         <strong>Map Tiles API</strong> habilitada.</p>
      <ol>
        <li>Ir a <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">console.cloud.google.com</a></li>
        <li>APIs y Servicios → Biblioteca → buscar "Map Tiles API" → Habilitar</li>
        <li>Credenciales → Crear clave de API</li>
      </ol>
      <input type="text" id="g3d-key-input" placeholder="AIzaSy..." value="${escapeAttr(getGoogleApiKey())}" autocomplete="off" />
      <div class="g3d-dialog-note">
        💡 Se guarda en tu browser. No sale del dispositivo. Google da $200 USD de crédito mensual gratuito → ~10.000 sesiones/mes.
      </div>
      <div class="g3d-dialog-btns">
        <button id="btn-cancel-g3d-key">Cancelar</button>
        <button class="g3d-dialog-primary" id="btn-save-g3d-key">Guardar y continuar</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('btn-cancel-g3d-key').addEventListener('click', () => overlay.remove());
  document.getElementById('btn-save-g3d-key').addEventListener('click', () => {
    const key = (document.getElementById('g3d-key-input').value || '').trim();
    if (!key.startsWith('AIza')) {
      alert('La key debe empezar con "AIza..."');
      return;
    }
    saveGoogleApiKey(key);
    overlay.remove();
    openGoogle3DPanel(coords, modelUrl);
  });
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Preflight: validate the API key against tile.googleapis.com before opening
// the panel. Surfaces Google's specific error reason (much clearer than the
// 403 the user sees from inside the tiles renderer).
async function preflightKey(apiKey) {
  const url = `https://tile.googleapis.com/v1/3dtiles/root.json?key=${encodeURIComponent(apiKey)}`;
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      // No Referer override — let the browser send the real one so the test
      // matches what the tiles renderer will do.
    });
    if (res.ok) return { ok: true };
    let body = null;
    try { body = await res.json(); } catch {}
    const reason = body?.error?.message || body?.error?.status || `HTTP ${res.status}`;
    return { ok: false, status: res.status, reason, body };
  } catch (err) {
    return { ok: false, status: 0, reason: err.message || 'network error' };
  }
}

// Module-level loader for the Maps JS library. Several functions need
// google.maps.* without depending on the panel having opened first — make
// it reusable and idempotent.
let _gmapsJSPromise = null;
function ensureGoogleMapsJSLoaded(apiKey) {
  if (window.google?.maps?.ElevationService) return Promise.resolve();
  if (_gmapsJSPromise) return _gmapsJSPromise;
  _gmapsJSPromise = new Promise((resolve, reject) => {
    const cb = '__g3dGmapsReady_' + Math.random().toString(36).slice(2);
    window[cb] = () => { delete window[cb]; resolve(); };
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://maps.googleapis.com/maps/api/js'
      + '?key=' + encodeURIComponent(apiKey)
      + '&libraries=geometry'
      + '&callback=' + cb;
    s.onerror = () => { _gmapsJSPromise = null; reject(new Error('No se pudo cargar Maps JS')); };
    document.head.appendChild(s);
  });
  return _gmapsJSPromise;
}

// Ground elevation lookup via the Maps JS ElevationService (NOT a direct
// fetch to the REST endpoint — that one has no CORS headers so browser
// requests are blocked). Returns metres above sea level for the (lat, lon)
// point, or null if the service can't answer.
async function fetchGroundElevation(lat, lon, apiKey) {
  try {
    await ensureGoogleMapsJSLoaded(apiKey);
  } catch (e) {
    console.warn('[Google 3D] Maps JS no se cargó — Elevation no disponible:', e.message);
    return null;
  }
  if (!window.google?.maps?.ElevationService) {
    console.warn('[Google 3D] google.maps.ElevationService no existe — ¿"Maps JavaScript API" habilitada?');
    return null;
  }
  return new Promise((resolve) => {
    const elevator = new google.maps.ElevationService();
    elevator.getElevationForLocations(
      { locations: [{ lat: lat, lng: lon }] },
      (results, status) => {
        if (status !== 'OK' || !results || !results[0]) {
          console.warn('[Google 3D] ElevationService status=' + status + ' — fallback al raycast');
          resolve(null);
          return;
        }
        resolve(results[0].elevation);
      }
    );
  });
}

function showPreflightError(detail) {
  const overlay = document.createElement('div');
  overlay.id = 'g3d-key-dialog';
  const reasonEsc = detail.reason ? detail.reason.replace(/[<>]/g, '') : 'desconocido';
  overlay.innerHTML = `
    <div class="g3d-dialog">
      <h3>❌ Google rechazó la API key</h3>
      <p style="color:#ff9b9b;font-family:ui-monospace,monospace;font-size:12px;background:rgba(255,80,80,0.08);padding:8px;border-radius:4px;border:1px solid rgba(255,80,80,0.3);">
        ${detail.status || 'ERR'}: ${reasonEsc}
      </p>
      <p><strong>Causas más frecuentes</strong> (verificar EN ESTE ORDEN):</p>
      <ol>
        <li><strong>Billing</strong> sin habilitar en el proyecto Google Cloud (Map Tiles API requiere cuenta de facturación aunque uses el free tier de $200/mes).</li>
        <li><strong>Map Tiles API</strong> no habilitada en el proyecto al que pertenece esta key (no en otro proyecto).</li>
        <li><strong>Restricción HTTP referer</strong> mal configurada — Google requiere wildcard. Probá con <code>*.bizual.ai/*</code> y <code>https://lab.bizual.ai/*</code>. NO uses <code>lab.bizual.ai/v3d/</code> sin asterisco al final.</li>
        <li><strong>Restricción de API</strong> en la key sin incluir "Map Tiles API" en la lista de APIs permitidas.</li>
        <li><strong>Espera de propagación</strong>: si recién habilitaste algo, esperá 2-5 min.</li>
      </ol>
      <input type="text" id="g3d-key-input" placeholder="AIzaSy..." value="${escapeAttr(getGoogleApiKey())}" autocomplete="off" />
      <div class="g3d-dialog-note">
        💡 La key probada fue <code>${escapeAttr(getGoogleApiKey().slice(0, 12))}...</code> — pegá una nueva o cancelá.
      </div>
      <div class="g3d-dialog-btns">
        <button id="btn-cancel-g3d-key">Cancelar</button>
        <button class="g3d-dialog-primary" id="btn-save-g3d-key">Reintentar con nueva key</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('btn-cancel-g3d-key').addEventListener('click', () => overlay.remove());
  document.getElementById('btn-save-g3d-key').addEventListener('click', () => {
    const key = (document.getElementById('g3d-key-input').value || '').trim();
    if (!key.startsWith('AIza')) { alert('La key debe empezar con "AIza..."'); return; }
    saveGoogleApiKey(key);
    overlay.remove();
    // The caller will be re-invoked by the user clicking the button again.
    document.getElementById('btn-show-g3d')?.click();
  });
}

// ─── Main panel ───────────────────────────────────────────────────────────
export async function openGoogle3DPanel(coords, modelUrl) {
  // Force max-precision floats. Some callers (saved localStorage, URL params)
  // pass strings; implicit coercion happens later anyway but explicit
  // parseFloat avoids any silent truncation in the trig that follows.
  const lat = parseFloat(coords.lat);
  const lon = parseFloat(coords.lon ?? coords.lng);
  const display = coords.display;
  console.log('[Google 3D] abriendo panel · lat=' + lat + ' · lon=' + lon + ' · display="' + display + '"');
  const apiKey = getGoogleApiKey();
  if (!apiKey) { openApiKeyDialog(coords, modelUrl); return; }

  // Preflight — get a clear error message before painting the empty panel.
  console.log('[Google 3D] preflight: testing API key against tile.googleapis.com…');
  const pre = await preflightKey(apiKey);
  if (!pre.ok) {
    console.error('[Google 3D] preflight FAILED:', pre);
    showPreflightError(pre);
    return;
  }
  console.log('[Google 3D] preflight ✅ key works');

  // Definitive ground elevation via Elevation API — eliminates the raycast's
  // dependence on which tiles happen to be loaded first. If the API isn't
  // enabled on the key, falls back to raycast (existing behaviour).
  const _apiElevation = await fetchGroundElevation(lat, lon, apiKey);
  if (_apiElevation != null) {
    console.log('[Google 3D] ✅ Elevation API: terreno a ' + _apiElevation.toFixed(1) + ' m sobre nivel del mar (anchor determinístico)');
  } else {
    console.log('[Google 3D] Elevation API no disponible — usando raycast contra tiles. Para placement determinístico, habilitá "Elevation API" en tu Google Cloud key.');
  }

  closeGoogle3DPanel();

  const panel = document.createElement('div');
  panel.id = 'g3d-panel';
  const sR = parseFloat(localStorage.getItem('bizual_g3d_rot')   || 0);
  const sP = parseFloat(localStorage.getItem('bizual_g3d_pitch') || 0);
  const sL = parseFloat(localStorage.getItem('bizual_g3d_roll')  || 0);
  // bizual_g3d_alt_v2 = ALTURA SOBRE EL SUELO (post ground-anchor). The old
  // bizual_g3d_alt key was metres above the WGS84 ellipsoid and is now
  // semantically wrong — ignore it so users don't inherit a stale +16 m offset.
  const sA = parseFloat(localStorage.getItem('bizual_g3d_alt_v2') || 0);
  const sE = parseFloat(localStorage.getItem('bizual_g3d_offset_east')  || 0);
  const sN = parseFloat(localStorage.getItem('bizual_g3d_offset_north') || 0);
  const sS = parseFloat(localStorage.getItem('bizual_g3d_scale') || 1);
  // bizual_g3d_calidad: 1-10 scale where 10 = maximum detail. The old
  // bizual_g3d_quality key stored the raw errorTarget (inverted semantics:
  // lower = more detail), which confused the slider direction. We migrate
  // the old value to calidad if present.
  const sQ = (() => {
    const v2 = localStorage.getItem('bizual_g3d_calidad');
    if (v2 != null) return Math.max(1, Math.min(10, parseFloat(v2)));
    const oldErrorTarget = parseFloat(localStorage.getItem('bizual_g3d_quality') || 0);
    if (oldErrorTarget > 0) return Math.max(1, Math.min(10, Math.round((25 - oldErrorTarget) / 2.4)));
    return 8; // default: high-but-not-max
  })();

  // Calidad slider (1-10) ↔ errorTarget. Lower errorTarget = denser Maxar
  // tiles streamed. calidad=10 → 0.5 (ultra, near-native pixel density),
  // calidad=1 → 22 (fast, basemap-ish). Floor at 0.5 because errorTarget=0
  // makes the renderer thrash on tiles it can never satisfy.
  const calidadToErrorTarget = (c) => {
    if (c >= 10) return 0.1;
    if (c >= 9)  return 0.5;
    return Math.max(0.5, +(22.5 - c * 2.2).toFixed(1));
  };
  // Resolution scale (devicePixelRatio multiplier) follows quality so a
  // Fast preset doesn't push 4× pixel-density tile requests to the GPU.
  //   calidad 9-10  → native DPR (Retina-crisp)
  //   calidad 4-8   → 1.0
  //   calidad 1-3   → 0.75 (drastic fetch reduction; aliased but fast)
  const calidadToPixelRatio = (c) => {
    if (c >= 9) return window.devicePixelRatio || 1;
    if (c >= 4) return 1;
    return 0.75;
  };

  // Format helpers for slider display text.
  const fmtEW = (v) => Math.abs(v).toFixed(1) + ' m ' + (v >= 0 ? 'E' : 'O');
  const fmtNS = (v) => Math.abs(v).toFixed(1) + ' m ' + (v >= 0 ? 'N' : 'S');
  panel.innerHTML = `
    <div class="g3d-header">
      <div class="g3d-title">
        <span class="g3d-logo">🌍</span>
        <span>${escapeAttr((display || '').split(',').slice(0, 2).join(',').trim())}</span>
        <span class="g3d-badge">Google 3D</span>
      </div>
      <div class="g3d-header-actions">
        <button class="g3d-key-btn" id="btn-change-key" title="Cambiar API key">🔑</button>
        <button class="g3d-close" id="btn-close-g3d" title="Cerrar (Esc)">✕</button>
      </div>
    </div>
    <canvas id="g3d-canvas"></canvas>
    <div id="g3d-svfull" style="display:none;position:absolute;top:48px;left:0;right:0;bottom:88px;z-index:50;background:#000">
      <div id="g3d-svpano" style="position:absolute;inset:0"></div>
      <canvas id="g3d-svcanvas" style="position:absolute;inset:0;z-index:1;pointer-events:none"></canvas>
      <button id="g3d-svfull-close" title="Cerrar (Esc)"
              style="position:absolute;top:8px;right:8px;z-index:51;background:rgba(0,0,0,0.78);color:#fff;border:1px solid rgba(255,255,255,0.3);border-radius:4px;padding:6px 12px;cursor:pointer;font-size:13px;">✕ Cerrar</button>
      <div id="g3d-svfull-hint" style="position:absolute;top:8px;left:8px;z-index:51;background:rgba(0,0,0,0.78);color:#fff;border:1px solid rgba(255,255,255,0.3);border-radius:4px;padding:6px 12px;font-size:12px;max-width:380px;line-height:1.3;">
        🎬 <strong>Modelo sobre Street View real.</strong> Movete con las flechas del panorama. La cámara del modelo se sincroniza con la del Street View para que veas el edificio donde realmente va a estar.
      </div>
    </div>
    <div class="g3d-bottom">
      <div class="g3d-sliders">
        <label title="Rotación alrededor del eje vertical (yaw). 0° = orientación original.">🔄 Rot
          <input type="range" id="g3d-rot"   min="0"   max="360" step="1"    value="${sR}">
          <span id="g3d-rot-val">${sR}°</span>
        </label>
        <label title="Inclinación adelante (+) / atrás (−) sobre el eje Este. Para ajustar si el modelo no calza perfecto perpendicular al terreno.">⤴️ Pitch
          <input type="range" id="g3d-pitch" min="-15" max="15"  step="0.5"  value="${sP}">
          <span id="g3d-pitch-val">${sP}°</span>
        </label>
        <label title="Inclinación lateral derecha (+) / izquierda (−) sobre el eje Norte.">🌀 Roll
          <input type="range" id="g3d-roll"  min="-15" max="15"  step="0.5"  value="${sL}">
          <span id="g3d-roll-val">${sL}°</span>
        </label>
        <label title="Metros sobre el suelo real (Maxar). Negativo = hundir el modelo">↕️ Altura
          <input type="range" id="g3d-alt"   min="-30" max="60"  step="0.5"  value="${sA}">
          <span id="g3d-alt-val">${sA} m</span>
        </label>
        <label title="Mover el modelo en sentido Este (+) / Oeste (−) sobre el suelo. Rango ±300 m para compensar geocoders que devuelven el centroide de la calle en vez del lote.">↔️ E/O
          <input type="range" id="g3d-east"  min="-300" max="300" step="0.1"  value="${sE}">
          <span id="g3d-east-val">${fmtEW(sE)}</span>
        </label>
        <label title="Mover el modelo en sentido Norte (+) / Sur (−) sobre el suelo. Rango ±300 m.">🧭 N/S
          <input type="range" id="g3d-north" min="-300" max="300" step="0.1"  value="${sN}">
          <span id="g3d-north-val">${fmtNS(sN)}</span>
        </label>
        <label>📐 Escala
          <input type="range" id="g3d-scale" min="0.1" max="3"   step="0.05" value="${sS}">
          <span id="g3d-scale-val">${sS}×</span>
        </label>
        <label title="Calidad de los tiles de Maxar. 10 = máximo detalle (carga más pesado). 1 = más liviano. Usá los botones 📸/⚡ para presets.">🎯 Calidad
          <input type="range" id="g3d-quality" min="1" max="10" step="1" value="${sQ}">
          <span id="g3d-quality-val">${sQ}/10</span>
        </label>
      </div>
      <div class="g3d-quality">
        <button id="g3d-view-street" title="Cámara al pie del edificio, altura humana (1.65 m)">🚶 Calle</button>
        <button id="g3d-view-aerial" title="Vista aérea oblicua a 80 m">🛩 Aérea</button>
        <button id="g3d-view-sv" title="Sobrepone el modelo 3D sobre las fotos panorámicas reales de Google Street View. La cámara del modelo se sincroniza con la del panorama así caminás por la calle real y ves el edificio en su ubicación.">🎬 Modelo sobre Street View</button>
        <button id="g3d-view-sv-tab" title="Abre Google Street View en una pestaña nueva (sin el modelo 3D encima).">🌆 SV (pestaña)</button>
        <button id="g3d-capture" title="Descargar captura de pantalla del visor actual como PNG.">📷 Capturar</button>
        <button id="g3d-quality-photo" title="Sube la calidad de tiles al máximo (errorTarget=4) para que se vean ultra-nítidos. Tarda más en cargar pero ideal antes de capturar.">📸 Calidad</button>
        <button id="g3d-quality-fast"  title="Calidad balanceada para uso normal (errorTarget=14). Carga rápido.">⚡ Rápido</button>
        <label><input type="checkbox" id="g3d-hdri" checked> HDRI</label>
        <button id="g3d-env-rebake" title="Rehornea el environment map desde los tiles Maxar actualmente cargados. Los vidrios/metales del edificio van a reflejar la cuadra real. Se hornea automático al anclar, usá esto si querés actualizar cuando cargó más detalle.">✨ Reflejos</button>
        <label title="Sombras del sol desactivadas por defecto en este entorno — el shadow camera no escala bien a coordenadas ECEF"><input type="checkbox" id="g3d-shadows"> Sombras</label>
        <button id="g3d-save">💾 Guardar ajustes</button>
      </div>
    </div>
    <div id="g3d-anchorbadge" title="Origen y valor del anchor de altura del modelo. Verde = Elevation API determinística. Naranja = raycast no-determinístico (puede flotar)."
         style="position:absolute;top:54px;right:8px;z-index:40;background:rgba(0,0,0,0.78);color:#fff;border:1px solid rgba(255,255,255,0.25);border-radius:4px;padding:6px 10px;font-size:12px;font-family:ui-monospace,monospace;display:flex;gap:8px;align-items:center;">
      <span id="g3d-anchor-status">Anchor: ⏳ buscando…</span>
      <button id="g3d-reanchor" title="Re-intentar el anchor (vuelve a llamar a la API y al raycast)"
              style="background:rgba(80,160,240,0.35);color:#fff;border:1px solid rgba(255,255,255,0.3);border-radius:3px;padding:3px 8px;cursor:pointer;font-size:11px;">🎯 Re-anclar</button>
      <span style="opacity:0.6">·</span>
      <span>Forzar elev (m):</span>
      <input type="number" id="g3d-elev-override" step="1" min="-500" max="9000" placeholder="auto"
             style="width:64px;background:rgba(255,255,255,0.1);color:#fff;border:1px solid rgba(255,255,255,0.3);border-radius:3px;padding:2px 4px;font-size:11px;font-family:ui-monospace,monospace;">
      <button id="g3d-elev-apply" title="Plantar el modelo a esa elevación exacta (anula API y raycast)"
              style="background:rgba(120,200,120,0.35);color:#fff;border:1px solid rgba(255,255,255,0.3);border-radius:3px;padding:3px 8px;cursor:pointer;font-size:11px;">Aplicar</button>
      <span style="opacity:0.6">·</span>
      <span title="Mantené Shift y hacé click sobre el suelo Maxar para mover el edificio al punto exacto. Útil cuando el geocoder cae a la mitad de la calle.">⇧+click = snap</span>
    </div>
    <div class="g3d-attribution">© Google · Imagery ©2025 Maxar Technologies</div>
  `;
  document.body.appendChild(panel);

  document.getElementById('btn-close-g3d').addEventListener('click', closeGoogle3DPanel);
  document.getElementById('btn-change-key').addEventListener('click', () => {
    const k = (prompt('Google Maps API key:', getGoogleApiKey()) || '').trim();
    if (k) { saveGoogleApiKey(k); closeGoogle3DPanel(); openGoogle3DPanel(coords, modelUrl); }
  });
  const escHandler = (e) => {
    if (e.key !== 'Escape') return;
    // If the SV+3D overlay is open, Esc closes it first instead of the panel.
    const sv = document.getElementById('g3d-svfull');
    if (sv && sv.style.display === 'block') {
      document.getElementById('g3d-svfull-close')?.click();
      return;
    }
    closeGoogle3DPanel();
  };
  document.addEventListener('keydown', escHandler);
  panel._escHandler = escHandler;

  // ─── three.js setup ─────────────────────────────────────────────────────
  const canvas = document.getElementById('g3d-canvas');
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true,
    // Critical at ECEF scale: the camera near/far span ~1 to 1.6e8 m, which
    // ruins a linear 24-bit depth buffer (sub-metre fights mid-frame). Log
    // depth keeps every Maxar tile crisp from street level up to orbit.
    logarithmicDepthBuffer: true,
    // Required so canvas.toBlob() / toDataURL() can read the rendered frame
    // for the 📷 Capturar screenshot button.
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(window.devicePixelRatio);
  // Tone-map + exposure: clone whatever the main viewer is using so the
  // Google 3D panel doesn't visually drift from the rest of the app. Keys
  // are written by viewer.js via the LS_PREFIX = 'bizual_lab_' helper.
  const _labTonemapId = readLabSetting('tonemap', 'agx');
  const _labExposure  = readLabSetting('exposure', 1.0);
  const TONEMAP_MAP = {
    agx:      THREE.AgXToneMapping ?? THREE.ACESFilmicToneMapping,
    aces:     THREE.ACESFilmicToneMapping,
    neutral:  THREE.NeutralToneMapping ?? THREE.ACESFilmicToneMapping,
    cineon:   THREE.CineonToneMapping,
    reinhard: THREE.ReinhardToneMapping,
    linear:   THREE.LinearToneMapping,
    none:     THREE.NoToneMapping,
  };
  renderer.toneMapping         = TONEMAP_MAP[_labTonemapId] ?? THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = _labExposure;
  renderer.outputColorSpace    = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  _activeRenderer = renderer;

  function fitSize() {
    // Guard against the panel being briefly collapsed/hidden — clientWidth
    // can return 0, which made the renderer emit GL_INVALID_VALUE on
    // glViewport(negative w/h) and skip the frame entirely.
    const W = Math.max(8, canvas.clientWidth || window.innerWidth);
    const H = Math.max(8, canvas.clientHeight || (window.innerHeight - 110));
    renderer.setSize(W, H, false);
    return { W, H };
  }
  const { W, H } = fitSize();

  // Camera near/far: near=0.5 lets us inspect façades from a few cm away;
  // far=20_000 is the maximum useful range for street/aerial views around
  // a single lot. Previous far=160_000_000 (effectively unbounded) made the
  // tiles renderer keep distant low-LOD tiles inside the frustum, eating
  // download/parse budget that should have gone to the high-res Maxar
  // tiles immediately around the building. With logarithmicDepthBuffer the
  // 40 000× near/far ratio is fine for depth precision.
  const camera = new THREE.PerspectiveCamera(60, W / H, 0.5, 20_000);
  // Start close to the surface so screen-space error is high enough that the
  // tiles renderer refines past the global basemap into Maxar 3D tiles.
  // The ground anchor below re-frames the camera once it finds real terrain.
  const initPos = latLonToECEF(lat, lon, 800);
  camera.position.copy(initPos);
  camera.up.copy(initPos.clone().normalize());
  camera.lookAt(latLonToECEF(lat, lon, 0));

  const scene = new THREE.Scene();
  // Sky gradient sphere that follows the camera so it works as an actual sky
  // dome at any scale. The gradient uses the local up direction (ellipsoid
  // normal) so "top" is always overhead regardless of where on Earth we are.
  const skySphere = (() => {
    const geo = new THREE.SphereGeometry(2000, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor:    { value: new THREE.Color(0x4d8fcf) },
        bottomColor: { value: new THREE.Color(0xeaf4fb) },
        upDir:       { value: new THREE.Vector3(0, 0, 1) },
      },
      vertexShader: `varying vec3 vLocal;
        void main(){ vLocal = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying vec3 vLocal; uniform vec3 topColor; uniform vec3 bottomColor; uniform vec3 upDir;
        void main(){ float h = clamp(dot(normalize(vLocal), upDir), -1.0, 1.0);
          gl_FragColor = vec4(mix(bottomColor, topColor, smoothstep(-0.1, 0.6, h)), 1.0); }`,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = -1;
    mesh.frustumCulled = false;
    scene.add(mesh);
    return mesh;
  })();

  // ─── Google 3D Tiles ────────────────────────────────────────────────────
  // IMPORTANT: do NOT pass URL to the constructor. The official pattern uses
  // an empty constructor and lets GoogleCloudAuthPlugin set the URL via its
  // init() hook. Passing URL ahead can race with plugin registration in some
  // versions and skip the auth-pipeline preprocessing.
  const tiles = new TilesRenderer();
  tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: apiKey, autoRefreshToken: true }));
  // Google Maxar tiles use Draco for geometry + KTX2/Basis for textures +
  // EXT_meshopt_compression for vertex/index buffers. Missing any of these
  // decoders leaves the tile mesh as garbage (fishnet pattern of degenerate
  // triangles on a blank ground) even though the GLB parses without error.
  tiles.registerPlugin(new GLTFExtensionsPlugin({
    dracoLoader:    makeDraco(),
    ktxLoader:      makeKtx2(renderer),
    meshoptDecoder: MeshoptDecoder,
  }));
  tiles.registerPlugin(new UnloadTilesPlugin());
  tiles.registerPlugin(new TileCompressionPlugin());

  // Quality / network budget. errorTarget drives screen-space error: lower =
  // more detail (heavier), higher = lighter. Cache + queue sizes are bounded so
  // a long session doesn't saturate memory or the network.
  tiles.errorTarget = calidadToErrorTarget(sQ);
  // Tile budget. Previous bigger sizes (1000/1800) starved the download
  // queue — at full cache the renderer stops requesting new tiles, so
  // stale low-LOD basemap stays in front of the user instead of getting
  // refreshed with Maxar. Smaller cache forces healthy turnover.
  tiles.lruCache.minSize = 600;
  tiles.lruCache.maxSize = 900;
  tiles.downloadQueue.maxJobs = 10;
  tiles.parseQueue.maxJobs = 5;

  tiles.setCamera(camera);
  tiles.setResolutionFromRenderer(camera, renderer);
  scene.add(tiles.group);
  _activeTiles = tiles;

  // ─── PostFX pipeline ────────────────────────────────────────────────────
  // Clone the visual look from the main viewer (SSAO + Bloom + Contrast
  // intensities are stored under the same LS_PREFIX). The pipeline uses
  // the env-google3d's own renderer/scene/camera — we keep coord systems
  // separate so ECEF precision and local-scale precision don't fight.
  //
  // SSAO note: PostFX defaults are tuned for room-scale (kernelRadius
  // ~0.5 m, maxDistance 0.5). At city scale that radius is invisible.
  // We override the SSAO range to suit street/block scale so it actually
  // adds depth to roof/façade junctions without sampling the whole frame.
  const _labSSAO = {
    on:        readLabSetting('ssao_on',        true),
    intensity: readLabSetting('ssao_intensity', 20),
  };
  const _labBloom = {
    on:        readLabSetting('bloom_on',        true),
    intensity: readLabSetting('bloom_intensity', 0.30),
  };
  const _labContrast = readLabSetting('contrast', 0.10);
  const _postfx = new PostFX(renderer, scene, camera, canvas);
  // Re-tune SSAO for urban scale: bigger kernel in world units, deeper
  // sampling range than the room-scale default. The intensity slider from
  // the main UI still drives the relative strength via setSSAO(on, n).
  _postfx.ssao.kernelRadius = 8;     // metres in world space
  _postfx.ssao.minDistance  = 0.0002; // ≈ 4 m at far=20 000
  _postfx.ssao.maxDistance  = 0.02;   // ≈ 400 m
  _postfx.setSSAO(_labSSAO.on, _labSSAO.intensity);
  _postfx.setBloom(_labBloom.on, _labBloom.intensity);
  _postfx.setContrast(_labContrast);
  tiles._postfx = _postfx; // for cleanup on close

  window.__tiles = tiles;
  // Expose THREE so you can poke at the scene from the console (the module
  // import otherwise keeps it scoped to this file).
  window.THREE = THREE;

  // Dynamic attribution — Google's data credits are required by the Maps
  // Platform TOS and change with the tiles in view, so read them from the
  // plugin instead of hardcoding. Falls back to the static text until tiles
  // become visible (getAttributions only reports while visibleTiles > 0).
  const attribEl = panel.querySelector('.g3d-attribution');
  function updateAttribution() {
    const target = [];
    try { tiles.getAttributions(target); } catch {}
    if (!target.length) return;
    attribEl.innerHTML = target.map((a) =>
      a.type === 'image'
        ? `<img src="${escapeAttr(a.value)}" alt="Google" style="height:14px;vertical-align:middle">`
        : escapeAttr(a.value)
    ).join(' · ');
  }

  console.log('[Google 3D] init', {
    rootURL: tiles.rootURL,
    rootLoadingState: tiles.rootLoadingState,
    cameras: tiles.cameras?.length,
    plugins: tiles.plugins?.length,
  });

  // ── Diagnostics: surface load failures + stats so the user can debug
  tiles.addEventListener('load-tile-set', () => {
    console.log('[Google 3D] ✅ load-tile-set fired — root.json cargado');
    console.log('[Google 3D] root tile:', tiles.root || tiles.rootTileSet);
  });
  tiles.addEventListener('load-error', (event) => {
    const status = event.error?.message || event.message || '';
    const url = event.url || '';
    console.error('[Google 3D] ❌ load-error:', { status, url, event });
    if (/403/.test(status)) console.error('[Google 3D] → 403: Map Tiles API no habilitada / restricción de referer no incluye este dominio');
    if (/401/.test(status)) console.error('[Google 3D] → 401: API key inválida');
    if (/429/.test(status)) console.error('[Google 3D] → 429: rate limit / cuota excedida');
  });
  // (Removed: per-tile anisotropy mutation. It was introduced in 89ae45e to
  // sharpen oblique-angle sampling but turned out to interact badly with
  // Three.js's texture binding cache for Maxar tiles, causing some tiles
  // to render without textures ("fishnet" on the ground). Default
  // anisotropy=1 is good enough and matches the v=20260604 behaviour the
  // user wants to restore.)

  // Periodic stats — uses the actual property names from 0.4.7.
  const _statsInterval = setInterval(() => {
    updateAttribution();
    if (!tiles?.stats) return;
    const s = tiles.stats;
    console.log('[Google 3D] stats:', {
      rootLoadingState: tiles.rootLoadingState,
      inCache: s.inCache, parsing: s.parsing, downloading: s.downloading,
      failed: s.failed, inFrustum: s.inFrustum, active: s.active,
      visibleTilesCount: tiles.visibleTiles?.size,
    });
  }, 5000);
  tiles._statsInterval = _statsInterval;

  // OrbitControls — orbit around the building's surface point
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(latLonToECEF(lat, lon, 0));
  // Let the user scroll-zoom right up to the model (3 m) or all the way out
  // to space; previously the 100 m floor blocked street-level inspection.
  controls.minDistance = 3;
  // Match camera.far=20_000; zooming further out would put the ground past
  // the far plane and the user would see nothing while wasting GPU/network.
  // For lot-scale inspection (street level to ~5 km aerial) this is plenty.
  controls.maxDistance = 15_000;
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.screenSpacePanning = false;

  // Camera framing is driven by ground anchoring (tryAnchorGround) once the
  // tiles under the target have loaded — see below.

  // ─── HDRI environment + sun (synced from lab's sun_hour) ────────────────
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  pmrem.compileCubemapShader();
  let _envMap = null;
  let _hdriObjectUrl = null;
  // 'tiles' = baked from the live Maxar 3D Tiles scene; 'hdri' = the
  // bundled HDRI panorama. Tiles is the default once Maxar streams in,
  // because that's the building's *real* visual neighbourhood.
  let _envSource = 'hdri';

  async function loadHDRI() {
    try {
      const url = await getActiveHDRIUrl();
      if (url.startsWith('blob:')) _hdriObjectUrl = url;
      new RGBELoader().load(url, (tex) => {
        const newEnv = pmrem.fromEquirectangular(tex).texture;
        if (_envMap && _envMap !== newEnv) _envMap.dispose();
        _envMap = newEnv;
        if (_envSource === 'hdri') scene.environment = _envMap;
        tex.dispose();
        if (_hdriObjectUrl) { URL.revokeObjectURL(_hdriObjectUrl); _hdriObjectUrl = null; }
      });
    } catch (e) { console.warn('[g3d] HDRI failed:', e.message); }
  }
  if (document.getElementById('g3d-hdri').checked) loadHDRI();
  document.getElementById('g3d-hdri').addEventListener('change', (e) => {
    if (e.target.checked) loadHDRI();
    else if (_envSource === 'hdri') scene.environment = null;
  });
  document.getElementById('g3d-env-rebake').addEventListener('click', () => {
    if (!bakeEnvFromTiles({ force: true })) {
      console.warn('[Google 3D] ✨ rebake omitido — sin anchor o sin tiles visibles aún');
    }
  });

  // ─── Dynamic reflection probe: Maxar tiles → cube map → PMREM ──────────
  // For glass / metal materials on the GLB to reflect the *actual*
  // neighbourhood instead of a generic HDRI, we render the loaded Maxar
  // scene to a cube render target positioned at the building anchor, then
  // pipe it through PMREMGenerator to get a pre-filtered envMap. Re-bake
  // after the first anchor lands and on manual user request.
  //
  // Notes:
  //   • The cube camera near/far must encompass the surrounding city
  //     without including the model itself; we hide modelRoot during the
  //     bake so the building doesn't reflect a static copy of itself.
  //   • The sky sphere stays visible — it's the upper hemisphere of the
  //     captured environment and matches the main render.
  //   • 256² per face is enough for env IBL; bigger looks identical after
  //     PMREM filtering and costs a lot more VRAM.
  const _envCubeRT = new THREE.WebGLCubeRenderTarget(256, {
    generateMipmaps: false,
    type: THREE.HalfFloatType,
  });
  const _envCubeCam = new THREE.CubeCamera(1, 20_000, _envCubeRT);
  let _envCubeTex = null; // PMREM texture cached for disposal
  function bakeEnvFromTiles({ force = false } = {}) {
    if (!_groundAnchor) return false;
    // Wait until Maxar has some real coverage; otherwise the reflection is
    // the basemap dome which makes glass look milky-blue everywhere.
    const vis = tiles.visibleTiles?.size || 0;
    if (!force && vis < 12) return false;
    // Position the cube cam just above the building's base anchor so
    // reflections sample from a realistic vantage (not from underground).
    _envCubeCam.position.copy(_groundAnchor).addScaledVector(_up, 5);
    const modelWasVisible = modelRoot ? modelRoot.visible : false;
    if (modelRoot) modelRoot.visible = false;
    try {
      _envCubeCam.update(renderer, scene);
      const tex = pmrem.fromCubemap(_envCubeRT.texture).texture;
      if (_envCubeTex && _envCubeTex !== tex) _envCubeTex.dispose();
      _envCubeTex = tex;
      _envSource = 'tiles';
      scene.environment = _envCubeTex;
      console.log('[Google 3D] ✨ env-map horneado desde Maxar · visibleTiles=' + vis);
    } catch (e) {
      console.warn('[Google 3D] env-map bake falló:', e.message);
    } finally {
      if (modelRoot) modelRoot.visible = modelWasVisible;
    }
    return true;
  }
  // First auto-bake: small delay after the anchor lands so Maxar has time
  // to refine to high-LOD around the lot. Retries every 4 s for the first
  // 20 s while the cache fills up.
  function scheduleAutoBake() {
    if (tiles._envBakeTimer) return;
    let attempts = 0;
    tiles._envBakeTimer = setInterval(() => {
      attempts++;
      if (bakeEnvFromTiles()) {
        // Re-bake once more after the cache has more tiles, then stop.
        setTimeout(() => bakeEnvFromTiles({ force: true }), 4000);
        clearInterval(tiles._envBakeTimer); tiles._envBakeTimer = null;
      } else if (attempts >= 8) {
        clearInterval(tiles._envBakeTimer); tiles._envBakeTimer = null;
      }
    }, 2500);
  }
  tiles._envCleanup = () => {
    if (_envCubeTex) { try { _envCubeTex.dispose(); } catch {} _envCubeTex = null; }
    if (_envCubeRT)  { try { _envCubeRT.dispose();  } catch {} }
    if (_envMap)     { try { _envMap.dispose();     } catch {} _envMap = null; }
    try { pmrem.dispose(); } catch {}
  };


  const labHour = parseFloat(localStorage.getItem('bizual_lab_sun_hour') || '12');
  const sunParams = getSunParams(labHour);
  const sunDir = getSunDirectionECEF(lat, lon, sunParams.azimut, sunParams.elevation);
  const sunLight = new THREE.DirectionalLight(sunParams.sunColor, Math.max(0.3, sunParams.sunIntensity));
  sunLight.position.copy(sunDir.clone().multiplyScalar(1e7));
  // Shadow mapping disabled for the Google 3D env: the light's shadow camera
  // can't realistically cover a model at ECEF (~6.4e6 m from origin) without
  // either being enormous (precision errors → WebGL "too many errors", broken
  // context) or losing the model entirely. HDRI + direct lighting is enough
  // for the photorealistic tiles. Shadows can be re-added with a per-frame
  // shadow-camera reposition around the anchored model later.
  sunLight.castShadow = false;
  sunLight.shadow.bias = -0.0001;
  sunLight.shadow.normalBias = 0.04;
  sunLight.visible = !sunParams.isNight;
  scene.add(sunLight);
  scene.add(new THREE.AmbientLight(0xc8d8e0, 0.2));

  document.getElementById('g3d-shadows').addEventListener('change', (e) => {
    sunLight.castShadow = e.target.checked;
    if (modelRoot) modelRoot.traverse((c) => { if (c.isMesh) c.castShadow = e.target.checked; });
  });

  // ─── Model load + geo transform ─────────────────────────────────────────
  let modelRoot = null;
  let rotDeg    = sR; // yaw around vertical (world up)
  let pitchDeg  = sP; // tilt around east axis (model tips N/S)
  let rollDeg   = sL; // tilt around north axis (model tips E/O)
  let altOffset = sA;
  let offsetE   = sE;
  let offsetN   = sN;
  let scaleMx   = sS;

  // Local up (ellipsoid normal) at the target, and the ECEF point where the
  // Google terrain actually sits — found by raycasting once tiles load. Until
  // then we fall back to the ellipsoid surface (height 0), which in places like
  // Santiago is hundreds of metres below the real ground, hence the float.
  const _up = new THREE.Vector3();
  WGS84_ELLIPSOID.getEastNorthUpAxes(lat * DEG2RAD, lon * DEG2RAD, new THREE.Vector3(), new THREE.Vector3(), _up);
  let _groundAnchor = null;

  function applyGeoTransform() {
    if (!modelRoot) return;
    const frame = new THREE.Matrix4();
    if (_groundAnchor) {
      // Keep the ENU orientation, but sit on the real terrain + altura offset
      // and shift east/north for precise placement on the lot.
      WGS84_ELLIPSOID.getEastNorthUpFrame(lat * DEG2RAD, lon * DEG2RAD, frame);
      frame.setPosition(_groundAnchor.clone()
        .addScaledVector(_up,    altOffset)
        .addScaledVector(_east,  offsetE)
        .addScaledVector(_north, offsetN));
    } else {
      frame.copy(getLocalFrameMatrix(lat, lon, altOffset));
    }
    // ENU axes after `frame`: local X = east, Y = north, Z = up. So:
    //   yaw    = rotation around Z (world up)
    //   pitch  = rotation around X (east axis) — model tilts N/S
    //   roll   = rotation around Y (north axis) — model tilts E/O
    // Apply scale → roll → pitch → yaw → frame (right-to-left multiplication).
    const rotZ = new THREE.Matrix4().makeRotationZ(rotDeg   * Math.PI / 180);
    const rotX = new THREE.Matrix4().makeRotationX(pitchDeg * Math.PI / 180);
    const rotY = new THREE.Matrix4().makeRotationY(rollDeg  * Math.PI / 180);
    const sM   = new THREE.Matrix4().makeScale(scaleMx, scaleMx, scaleMx);
    modelRoot.matrix.copy(frame).multiply(rotZ).multiply(rotX).multiply(rotY).multiply(sM);
    modelRoot.matrixAutoUpdate = false;
    modelRoot.matrixWorldNeedsUpdate = true;
  }

  // Drop a ray from high above the target straight down onto the loaded Google
  // tiles to find the real ground height, then re-anchor the model and frame
  // the camera on it. Retries until tiles under the target exist.
  const _groundRay = new THREE.Raycaster();
  _groundRay.firstHitOnly = true;
  // East/north axes once — they don't change during the session.
  const _east  = new THREE.Vector3();
  const _north = new THREE.Vector3();
  WGS84_ELLIPSOID.getEastNorthUpAxes(lat * DEG2RAD, lon * DEG2RAD, _east, _north, new THREE.Vector3());

  // Multi-sample raycast helper: 5×5 grid at ±100 m, returns the LOWEST valid
  // hit (= street level, not rooftops) plus stats on the spread. Shared
  // between the initial anchor and the refinement pass that runs as Maxar
  // tiles arrive at higher LOD.
  // Horizontal-distance filter: a hit further than 300 m from the target
  // (measured perpendicular to local up) is geometry from somewhere else
  // (e.g. a Cordillera tile whose bounding volume happened to cover the
  // ray's airspace). Rejecting these stopped the anchor locking at ~5400 m
  // because the raycast was grabbing a far-away mountain mesh.
  const _targetSurface = latLonToECEF(lat, lon, 0);
  const _tmpOffset = new THREE.Vector3();
  function sampleGround() {
    const baseOrigin = latLonToECEF(lat, lon, 2500);
    const ellipsoidR = _targetSurface.length();
    const dir = _up.clone().negate();
    const elevs = [];
    let bestHit = null;
    let bestElev = Infinity;
    let rejectedFar = 0;
    for (const dE of [-100, -50, 0, 50, 100]) {
      for (const dN of [-100, -50, 0, 50, 100]) {
        const origin = baseOrigin.clone().addScaledVector(_east, dE).addScaledVector(_north, dN);
        _groundRay.set(origin, dir);
        _groundRay.far = 12000;
        // Recursive: each Maxar tile is a child scene under tiles.group with
        // its own mesh children. Non-recursive would only hit the group
        // itself (no geometry). Also note that modelRoot is a sibling under
        // scene.add(), not a child of tiles.group, so the building is
        // already excluded from these ray targets.
        const hits = _groundRay.intersectObject(tiles.group, true);
        if (!hits.length) continue;
        const elev = hits[0].point.length() - ellipsoidR;
        if (elev < -500 || elev > 9000) continue;
        // Horizontal distance from target: project the (hit - targetSurface)
        // vector onto the plane perpendicular to local up.
        _tmpOffset.copy(hits[0].point).sub(_targetSurface);
        const vertical = _tmpOffset.dot(_up);
        _tmpOffset.addScaledVector(_up, -vertical);
        if (_tmpOffset.length() > 200) { rejectedFar++; continue; }
        elevs.push(elev);
        if (elev < bestElev) { bestElev = elev; bestHit = hits[0].point.clone(); }
      }
    }
    if (!bestHit) {
      if (rejectedFar > 0) {
        console.log('[Google 3D] ' + rejectedFar + ' hits descartados por distancia horizontal (>300m del target — tile espurio)');
      }
      return null;
    }
    elevs.sort((a, b) => a - b);
    return { hit: bestHit, elev: bestElev, max: elevs[elevs.length - 1], count: elevs.length, rejected: rejectedFar };
  }

  // Just centre the orbit on the anchor. DO NOT tween the camera — that
  // regression (94e62a1) moved the camera to anchor + 60 m east + 40 m up
  // which, when the anchor was non-deterministic raycast that landed wrong,
  // dragged the camera to a place where Maxar tiles never refine. Behaviour
  // restored to v=20260604: camera stays at its initial 800 m-altitude pose
  // and the user picks 🚶 Calle / 🛩 Aérea / scroll-zoom to navigate.
  function frameOnAnchor() {
    if (!_groundAnchor) return;
    controls.target.copy(_groundAnchor.clone().addScaledVector(_up, 15));
  }

  function tryAnchorGround() {
    if (_groundAnchor) return true;

    // ── Fast path: Elevation API gave a definitive ground height. ──
    // We use this whenever it's available because it doesn't depend on
    // which tiles are loaded right now (the raycast path was producing
    // 568, 1071, 5416 m on different sessions for the same address).
    if (_apiElevation != null) {
      _groundAnchor = latLonToECEF(lat, lon, _apiElevation);
      applyGeoTransform();
      if (modelRoot) modelRoot.visible = true;
      frameOnAnchor(); // tween camera close so Maxar refines around the model
      console.log('[Google 3D] ✅ modelo anclado vía Elevation API · elev=' + _apiElevation.toFixed(1) + 'm');
      scheduleAutoBake();
      return true;
    }

    // ── Fallback path: raycast against currently-loaded tiles. ──
    if (!tiles.group || (tiles.visibleTiles?.size || 0) < 10) return false;
    const r = sampleGround();
    if (!r) return false;
    if (Math.abs(r.elev) < 5) {
      console.log('[Google 3D] raycast pegó al basemap (elev≈' + r.elev.toFixed(1) + 'm); esperando Maxar…');
      return false;
    }
    _groundAnchor = r.hit;
    applyGeoTransform();
    if (modelRoot) modelRoot.visible = true;
    frameOnAnchor();
    console.log('[Google 3D] ✅ modelo anclado (raycast fallback)',
                '· suelo (min) ≈ ' + r.elev.toFixed(1) + 'm sobre elipsoide',
                '· techos (max) ≈ ' + r.max.toFixed(1) + 'm',
                '· hits válidos=' + r.count + '/25',
                '· descartados (lejos)=' + r.rejected,
                '· spread=' + (r.max - r.elev).toFixed(1) + 'm');
    scheduleAutoBake();
    return true;
  }

  // Refinement pass: once anchored, keep re-sampling for the next ~30 s.
  // BIDIRECTIONAL — Maxar tiles can land above the initial hit (basemap was
  // the smooth ellipsoid sphere, Maxar adds buildings on top) OR below it
  // (global-terrain dataset smoothed nearby Cordillera into Macul's
  // airspace, real Maxar street is hundreds of metres lower). We just track
  // the latest lowest hit, with safety caps.
  function refineAnchorGround() {
    if (!_groundAnchor) return false;
    const r = sampleGround();
    if (!r || Math.abs(r.elev) < 5) return false;
    const ellipsoidR = _targetSurface.length();
    const currentElev = _groundAnchor.length() - ellipsoidR;
    const delta = r.elev - currentElev;
    if (Math.abs(delta) < 5) return false;     // no meaningful change
    // Cap at 200 m: bigger deltas are the raycast grabbing a far Cordillera
    // tile whose bbox slipped into the rays. The previous 1000 m cap let
    // through a +943 m jump that dragged the orbit target above the camera
    // and Maxar stopped refining around the model.
    if (Math.abs(delta) > 200) {
      console.log('[Google 3D] refinamiento rechazado · delta=' + delta.toFixed(1) + 'm (>200m, probable tile espurio)');
      return false;
    }
    const shift = r.hit.clone().sub(_groundAnchor);
    _groundAnchor = r.hit;
    applyGeoTransform();
    // Pan the orbit target with the model so the camera keeps it framed.
    // Don't move the camera position — staying put gives the tiles renderer
    // a stable viewpoint to keep refining Maxar around the real ground.
    controls.target.add(shift);
    console.log('[Google 3D] anchor refinado: ' + currentElev.toFixed(1) + 'm → ' + r.elev.toFixed(1) +
                'm (Δ=' + (delta >= 0 ? '+' : '') + delta.toFixed(1) + 'm)' +
                ' · spread=' + (r.max - r.elev).toFixed(1) + 'm');
    return true;
  }

  let _anchorTries = 0;
  let _refineTicks = 0;
  // Elevation API returns orthometric (geoid-referenced) height while ECEF
  // tiles live on the WGS84 ellipsoid. Geoid undulation in Chile is ~+30 m,
  // so the API estimate can disagree with the actual Maxar mesh by tens of
  // metres. We let raycast-against-loaded-mesh be the source of truth and
  // keep refining for ~30 s even when the API gave us a starting anchor.
  const _anchorInterval = setInterval(() => {
    if (!_groundAnchor) {
      if (tryAnchorGround()) return;
      _anchorTries++;
      if (_anchorTries % 6 === 0) {
        console.log('[Google 3D] raycast aún sin suelo · visibleTiles=' + (tiles.visibleTiles?.size || 0) +
                    ' · intentos=' + _anchorTries);
      }
      if (_anchorTries > 45) {
        clearInterval(_anchorInterval);
        console.warn('[Google 3D] ⚠️ no se pudo anclar al terreno tras 30s — muestro el modelo en el elipsoide. Bajá 🎯 Calidad para forzar más detalle.');
        if (modelRoot) modelRoot.visible = true;
      }
      return;
    }
    refineAnchorGround();
    if (++_refineTicks >= 45) { // ~30 s of refinement after initial anchor
      clearInterval(_anchorInterval);
      console.log('[Google 3D] refinamiento del anchor concluido');
    }
  }, 700);
  tiles._anchorInterval = _anchorInterval;

  const loader = new GLTFLoader();
  loader.setDRACOLoader(makeDraco());
  loader.setKTX2Loader(makeKtx2(renderer));
  loader.setMeshoptDecoder(MeshoptDecoder);

  // Fetch + sanitize the user GLB before parsing. Same flow as scene.js:
  // some Blender exports leave texture entries with no `source` and no
  // EXT_texture_webp/avif extension, which crashes GLTFLoader with
  // "Cannot read properties of undefined (reading 'uri')" deep in
  // GLTFParser.loadTexture. The plain loader.load() path skips the sanitize
  // step, so the user-reported TypeError on GLTFLoader.js:3222 persisted
  // here even after KTX2/Meshopt decoders were wired up.
  const onLoaded = (gltf) => {
    const model = gltf.scene;
    model.traverse((c) => {
      if (c.isMesh) {
        c.castShadow = true;
        c.receiveShadow = true;
        // Defensive: force standard depth behaviour so the model can't render
        // on top of Maxar tiles that are in front of it (some glTF exporters
        // leave materials with depthTest=false or transparent=true).
        if (c.material) {
          const mats = Array.isArray(c.material) ? c.material : [c.material];
          for (const m of mats) {
            m.depthTest = true;
            m.depthWrite = true;
          }
        }
        c.renderOrder = 0;
      }
    });

    // ── 1) Orientation detection: for a building the tallest bbox extent is
    // the vertical axis. If that's Y, the GLB is Y-up (glTF standard) and we
    // rotate +90° around X so +Y becomes +Z (the ENU frame's "up" here);
    // Z-up stays as-is; X-up rotates -90° around Y.
    let box = new THREE.Box3().setFromObject(model);
    const dims0 = box.getSize(new THREE.Vector3());
    const orient = (dims0.y >= dims0.x && dims0.y >= dims0.z) ? 'Y-up'
                 : (dims0.z >= dims0.x && dims0.z >= dims0.y) ? 'Z-up'
                 : 'X-up';
    if (orient === 'Y-up') model.rotateX(Math.PI / 2);
    else if (orient === 'X-up') model.rotateY(-Math.PI / 2);

    // ── 2) Base normalisation: after the orientation rotation, the model's
    // origin can sit anywhere (UR3D-style exports often put it at the
    // geometric centre, not the floor). Shift the model so its world bbox is
    // centred on (0,0) horizontally and its base lands at z=0. Using sub()
    // instead of set() preserves any pre-existing gltf root translation as a
    // shift instead of overwriting it.
    model.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    model.position.sub(new THREE.Vector3(center.x, center.y, box.min.z));

    // ── 3) Verify the normalisation worked. base.z should be ~0; if it
    // isn't, a future GLB has something we didn't account for (e.g. a
    // mesh with its own matrixAutoUpdate=false), and this log surfaces it.
    model.updateMatrixWorld(true);
    const finalBox = new THREE.Box3().setFromObject(model);
    const finalDims = finalBox.getSize(new THREE.Vector3());

    modelRoot = new THREE.Group();
    modelRoot.add(model);
    // Hidden until the ground anchor lands — avoids showing the model
    // floating at the ellipsoid surface during the first 1-2s.
    modelRoot.visible = !!_groundAnchor;
    scene.add(modelRoot);
    applyGeoTransform();
    window.__g3dModel = { model, box: finalBox, modelRoot };

    console.log('[Google 3D] modelo cargado',
                '· orient=' + orient + (orient !== 'Z-up' ? ' (rotado a Z-up)' : ''),
                '· dims original (x,y,z) =', dims0.x.toFixed(1) + 'm', dims0.y.toFixed(1) + 'm', dims0.z.toFixed(1) + 'm');
    console.log('[Google 3D] modelo normalizado · base en z=' + finalBox.min.z.toFixed(3) + 'm (esperado 0)',
                '· dims finales (x,y,z) =', finalDims.x.toFixed(1) + 'm', finalDims.y.toFixed(1) + 'm', finalDims.z.toFixed(1) + 'm',
                '· visible=' + modelRoot.visible);
  };

  (async () => {
    try {
      const res = await fetch(modelUrl);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      let buf = await res.arrayBuffer();
      buf = sanitizeGLB(buf) || buf;
      const base = modelUrl.substring(0, modelUrl.lastIndexOf('/') + 1);
      loader.parse(buf, base, onLoaded, (err) => {
        console.error('[Google 3D] GLB parse failed:', err);
      });
    } catch (err) {
      console.error('[Google 3D] no se pudo cargar el modelo:', err);
    }
  })();

  // Sliders. `format` overrides the default `value+unit` text in the value
  // span — used by Este/Norte to display "20.5 m E" or "20.5 m O" depending
  // on the sign so the cardinal direction is unambiguous.
  function bindSlider(id, valId, decimals, unit, onChange, format) {
    const inp = document.getElementById(id);
    const out = document.getElementById(valId);
    if (!inp) return;
    inp.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      out.textContent = format ? format(v) : (v.toFixed(decimals) + unit);
      onChange(v);
      applyGeoTransform();
    });
  }
  bindSlider('g3d-rot',   'g3d-rot-val',   0, '°',  (v) => rotDeg = v);
  bindSlider('g3d-pitch', 'g3d-pitch-val', 1, '°',  (v) => pitchDeg = v);
  bindSlider('g3d-roll',  'g3d-roll-val',  1, '°',  (v) => rollDeg = v);
  bindSlider('g3d-alt',   'g3d-alt-val',   1, ' m', (v) => altOffset = v);
  bindSlider('g3d-east',  'g3d-east-val',  1, ' m', (v) => offsetE = v, fmtEW);
  bindSlider('g3d-north', 'g3d-north-val', 1, ' m', (v) => offsetN = v, fmtNS);
  bindSlider('g3d-scale', 'g3d-scale-val', 2, '×',  (v) => scaleMx = v);

  // ─── Shift+click snap: place the building on the clicked tile point ────
  // Geocoders (Places, OSM) often return a street centroid, not the rooftop
  // of the actual lot. The ±300 m sliders cover this in principle but
  // require manual hunting. Shift+click on the photo-textured Maxar terrain
  // gives the operator a single-gesture way to plant the building exactly
  // where they want it.
  //
  //   1. NDC pick → raycast tiles.group recursively (model is a sibling
  //      under scene, so it can't self-intersect).
  //   2. Compute the hit's displacement from the current _groundAnchor.
  //   3. Project that displacement onto local east / north / up axes (the
  //      ENU basis we already computed for the target lat/lon).
  //   4. Write those projections back to offsetE / offsetN / altOffset
  //      AND sync the slider DOM so the user can fine-tune from there.
  const _snapRay = new THREE.Raycaster();
  _snapRay.firstHitOnly = true;
  const _ndc = new THREE.Vector2();
  const _tmpDisp = new THREE.Vector3();
  function syncSliderFromValue(id, valId, value, format) {
    const inp = document.getElementById(id);
    const out = document.getElementById(valId);
    if (!inp || !out) return;
    // Clamp into the slider's own range so the DOM stays consistent even if
    // the snap landed beyond ±300 m (extreme geocoder failure).
    const min = parseFloat(inp.min), max = parseFloat(inp.max);
    const clamped = Math.max(min, Math.min(max, value));
    inp.value = String(clamped);
    out.textContent = format ? format(clamped) : (clamped.toFixed(1) + ' m');
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (!e.shiftKey) return;
    if (!_groundAnchor) {
      console.warn('[Google 3D] Shift+click ignorado — esperá a que ancle el modelo');
      return;
    }
    const rect = canvas.getBoundingClientRect();
    _ndc.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
    _ndc.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
    _snapRay.setFromCamera(_ndc, camera);
    const hits = _snapRay.intersectObject(tiles.group, true);
    if (!hits.length) {
      console.warn('[Google 3D] Shift+click no impactó ningún tile');
      return;
    }
    _tmpDisp.copy(hits[0].point).sub(_groundAnchor);
    const dE = _tmpDisp.dot(_east);
    const dN = _tmpDisp.dot(_north);
    const dU = _tmpDisp.dot(_up);
    offsetE  = dE;
    offsetN  = dN;
    altOffset = dU;
    applyGeoTransform();
    syncSliderFromValue('g3d-east',  'g3d-east-val',  offsetE,  fmtEW);
    syncSliderFromValue('g3d-north', 'g3d-north-val', offsetN,  fmtNS);
    syncSliderFromValue('g3d-alt',   'g3d-alt-val',   altOffset);
    console.log('[Google 3D] 📍 snap a Maxar · ΔE=' + dE.toFixed(1) + 'm · ΔN=' + dN.toFixed(1) +
                'm · ΔU=' + dU.toFixed(1) + 'm');
  });

  let qualityVal = sQ; // 1-10, where 10 = max detail
  const qInp = document.getElementById('g3d-quality');
  const qOut = document.getElementById('g3d-quality-val');
  // Apply initial errorTarget + matching renderer pixel ratio so tile fetches
  // line up with what the GPU will actually rasterise.
  tiles.errorTarget = calidadToErrorTarget(sQ);
  renderer.setPixelRatio(calidadToPixelRatio(sQ));
  function setQuality(calidad) {
    qualityVal = Math.max(1, Math.min(10, calidad));
    qInp.value = String(qualityVal);
    qOut.textContent = qualityVal + '/10';
    tiles.errorTarget = calidadToErrorTarget(qualityVal);
    // Pixel ratio drives both render cost and the screen-space-error budget
    // the tiles renderer uses (setResolutionFromRenderer multiplies by it).
    // Changing it live re-targets which Maxar LODs get fetched on next frame.
    const newDpr = calidadToPixelRatio(qualityVal);
    if (renderer.getPixelRatio() !== newDpr) {
      renderer.setPixelRatio(newDpr);
      const W = Math.max(8, canvas.clientWidth);
      const H = Math.max(8, canvas.clientHeight);
      renderer.setSize(W, H, false);
    }
  }
  qInp.addEventListener('input', (e) => setQuality(parseFloat(e.target.value)));
  // Preset buttons. Photo = max detail (slowest load, sharpest tiles at
  // street level — use before 📷 Capturar). Fast = light for everyday nav.
  document.getElementById('g3d-quality-photo').addEventListener('click', () => {
    setQuality(10);
    console.log('[Google 3D] preset 📸 Calidad máxima: calidad=10 · errorTarget=' + calidadToErrorTarget(10));
  });
  document.getElementById('g3d-quality-fast').addEventListener('click', () => {
    setQuality(4);
    console.log('[Google 3D] preset ⚡ Rápido: calidad=4 · errorTarget=' + calidadToErrorTarget(4));
  });

  document.getElementById('g3d-save').addEventListener('click', () => {
    localStorage.setItem('bizual_g3d_rot',           String(rotDeg));
    localStorage.setItem('bizual_g3d_pitch',         String(pitchDeg));
    localStorage.setItem('bizual_g3d_roll',          String(rollDeg));
    localStorage.setItem('bizual_g3d_alt_v2',        String(altOffset));
    localStorage.setItem('bizual_g3d_offset_east',   String(offsetE));
    localStorage.setItem('bizual_g3d_offset_north',  String(offsetN));
    localStorage.setItem('bizual_g3d_scale',         String(scaleMx));
    localStorage.setItem('bizual_g3d_calidad',       String(qualityVal));
    const btn = document.getElementById('g3d-save');
    btn.textContent = '✅ Guardado';
    setTimeout(() => { btn.textContent = '💾 Guardar ajustes'; }, 1500);
  });

  // ─── Camera view presets ────────────────────────────────────────────────
  // Position camera relative to the (offset-adjusted) model base in ENU
  // axes, looking up at the building. Re-reads the model position each
  // click so it follows wherever the user moved the model with the offset
  // sliders.
  function modelBaseWorld() {
    if (!_groundAnchor) return latLonToECEF(lat, lon, 0);
    return _groundAnchor.clone()
      .addScaledVector(_up,    altOffset)
      .addScaledVector(_east,  offsetE)
      .addScaledVector(_north, offsetN);
  }
  document.getElementById('g3d-view-street').addEventListener('click', () => {
    const base = modelBaseWorld();
    // Stand 35 m south of the building at eye level (1.65 m), looking at
    // the lower third (~9 m up) so the façade fills the frame.
    const eyePos = base.clone()
      .addScaledVector(_north, -35)
      .addScaledVector(_up,    1.65);
    const lookAt = base.clone().addScaledVector(_up, 9);
    controls.target.copy(lookAt);
    animateCameraTo(camera, controls, eyePos, lookAt, 1200);
  });
  document.getElementById('g3d-view-aerial').addEventListener('click', () => {
    const base = modelBaseWorld();
    const eyePos = base.clone()
      .addScaledVector(_east, 150)
      .addScaledVector(_up,   80);
    const lookAt = base.clone().addScaledVector(_up, 15);
    controls.target.copy(lookAt);
    animateCameraTo(camera, controls, eyePos, lookAt, 1200);
  });

  // ─── Street View + 3D model overlay ────────────────────────────────────
  // Renders Google's photographic Street View as the background and our 3D
  // model on a transparent canvas on top, with the model's camera locked to
  // the StreetViewPanorama's position/heading/pitch/zoom. The user gets to
  // walk the real street in panoramic photos and see exactly where the
  // planned building stands in that environment.
  let _svPanorama = null, _svRenderer = null, _svScene = null, _svCamera = null;
  let _svAnimFrame = null, _svModelRoot = null;
  // Local alias for the module-level Maps JS loader so existing call sites
  // don't need apiKey passed through.
  const ensureGoogleMapsJS = () => ensureGoogleMapsJSLoaded(apiKey);
  async function openStreetViewOverlay() {
    if (!modelRoot) { alert('Esperá a que termine de cargar el modelo.'); return; }
    const overlay  = document.getElementById('g3d-svfull');
    const panoDiv  = document.getElementById('g3d-svpano');
    const svCanvas = document.getElementById('g3d-svcanvas');
    overlay.style.display = 'block';
    try {
      await ensureGoogleMapsJS();
    } catch (err) {
      overlay.style.display = 'none';
      alert('Error cargando Maps JavaScript API: ' + err.message);
      return;
    }
    if (!_svPanorama) {
      _svPanorama = new google.maps.StreetViewPanorama(panoDiv, {
        position: { lat, lng: lon },
        pov: { heading: 0, pitch: 0 },
        zoom: 1,
        addressControl: false,
        panControl: false,
        enableCloseButton: false,
        fullscreenControl: false,
        motionTracking: false,
        motionTrackingControl: false,
      });
      _svRenderer = new THREE.WebGLRenderer({
        canvas: svCanvas, alpha: true, antialias: true, preserveDrawingBuffer: true,
      });
      _svRenderer.setPixelRatio(window.devicePixelRatio);
      // Force a fully transparent clear so the Street View panorama shows
      // through every pixel that isn't part of the model.
      _svRenderer.setClearColor(0x000000, 0);
      _svScene = new THREE.Scene();

      // Local-frame design: the three.js camera sits at the scene origin
      // (the Street View "car" position) and the building is translated to
      // its haversine offset (east/up/-north) from there. This avoids any
      // floating-point precision issues that ECEF coords would introduce
      // when the panorama camera moves and removes the need for log-depth.
      //
      // Wrap the GLB clone in a fresh group whose transform we own — we do
      // NOT copy modelRoot.matrix here (that one is an ECEF world matrix
      // and would teleport the clone far away).
      _svModelRoot = new THREE.Group();
      const baseGltf = modelRoot.children[0]; // the GLB root after normalisation
      const clone = baseGltf.clone(true);
      // baseGltf already has the orientation (Y-up→Z-up rotation) and the
      // bbox normalisation baked in via baseGltf.position + scale, so the
      // clone arrives with its base at local z=0 and (x,y) centred on the
      // origin of its parent. Reset its parent transform for the local
      // frame: z-up GLB → in three.js's Y-up convention we'll rotate the
      // whole group so model's "up" lines up with three.js's +Y.
      _svModelRoot.add(clone);
      _svModelRoot.rotation.order = 'YXZ';
      // The GLB was authored with Z-up; three.js camera (rotation YXZ) wants
      // Y-up. Rotate -90° around X to flip Z→Y.
      // We'll bake this in the group's matrix and then add yaw/pitch/roll
      // from the user's sliders inside applySvModelTransform().
      _svScene.add(_svModelRoot);

      _svModelRoot.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) { m.depthTest = true; m.depthWrite = true; }
      });

      // Camera in the local frame: at origin, looking toward -Z (compass
      // north). rotation.order YXZ matches the heading-then-pitch sequence
      // the panorama uses. fov set on first sync.
      _svCamera = new THREE.PerspectiveCamera(90, 1, 0.1, 10_000);
      _svCamera.rotation.order = 'YXZ';
      _svCamera.position.set(0, 0, 0);

      // Match the main scene lighting roughly so the clone doesn't look
      // unlit (the main scene's lights aren't shared between renderers).
      _svScene.add(new THREE.AmbientLight(0xffffff, 0.7));
      const svSun = new THREE.DirectionalLight(0xffffff, 0.9);
      svSun.position.set(50, 80, 30);
      _svScene.add(svSun);

      const sizeSV = () => {
        const w = svCanvas.clientWidth || 1, h = svCanvas.clientHeight || 1;
        _svRenderer.setSize(w, h, false);
        _svCamera.aspect = w / h;
        _svCamera.updateProjectionMatrix();
      };
      new ResizeObserver(sizeSV).observe(svCanvas);
      sizeSV();

      // Strict POV/zoom/position binding. The rAF loop renders every frame,
      // but explicit event listeners give us a single place to log the
      // sync state and let us force an immediate camera update so the model
      // stops "lagging" behind the panorama during fast pan/zoom gestures.
      _svPanorama.addListener('pov_changed', () => syncSvCamera('pov_changed'));
      _svPanorama.addListener('zoom_changed', () => syncSvCamera('zoom_changed'));
      _svPanorama.addListener('position_changed', () => {
        const p = _svPanorama.getPosition();
        if (!p) return;
        const d = haversineMeters(lat, lon, p.lat(), p.lng());
        const b = bearingDeg(p.lat(), p.lng(), lat, lon);
        console.log('[Google 3D · SV] position_changed · ' + p.lat().toFixed(6) + ',' + p.lng().toFixed(6) +
                    ' · edificio a ' + d.toFixed(1) + ' m · azimut ' + b.toFixed(0) + '°');
        syncSvCamera('position_changed');
      });

      svAnimate();
    } else {
      _svPanorama.setVisible(true);
    }
  }

  // Great-circle distance between two lat/lon in metres (Haversine). Used
  // for the diagnostic log on position_changed so the user can confirm the
  // Street View camera is in the right neighbourhood relative to the lot.
  function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6_371_000;
    const φ1 = lat1 * DEG2RAD, φ2 = lat2 * DEG2RAD;
    const Δφ = (lat2 - lat1) * DEG2RAD;
    const Δλ = (lon2 - lon1) * DEG2RAD;
    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  // Initial bearing (azimut) from point 1 to point 2, in degrees clockwise
  // from true north. Matches Street View's heading convention.
  function bearingDeg(lat1, lon1, lat2, lon2) {
    const φ1 = lat1 * DEG2RAD, φ2 = lat2 * DEG2RAD;
    const Δλ = (lon2 - lon1) * DEG2RAD;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return (Math.atan2(y, x) / DEG2RAD + 360) % 360;
  }

  // POV → three.js camera (LOCAL FRAME, camera fixed at origin).
  //   rotation.order = 'YXZ' so Y (heading) runs first, then X (pitch).
  //   pov.heading is compass clockwise from north; three.js rotates
  //     counterclockwise around +Y, so the sign flips.
  //   pov.pitch is positive looking up, matches +X rotation in YXZ order.
  //   fov ≈ 180 / 2^zoom (Street View's documented zoom→fov mapping).
  function syncSvCamera(reason) {
    if (!_svPanorama || !_svCamera) return false;
    const pov = _svPanorama.getPov();
    if (!pov) return false;
    _svCamera.rotation.y = -pov.heading * DEG2RAD;
    _svCamera.rotation.x =  pov.pitch   * DEG2RAD;
    _svCamera.rotation.z = 0;
    const z = _svPanorama.getZoom() || 1;
    const fovDeg = Math.max(20, Math.min(120, 180 / Math.pow(2, z)));
    if (Math.abs(_svCamera.fov - fovDeg) > 0.05) {
      _svCamera.fov = fovDeg;
      _svCamera.updateProjectionMatrix();
    }
    if (reason) {
      console.log('[Google 3D · SV] ' + reason + ' · heading=' + pov.heading.toFixed(1) +
                  '° pitch=' + pov.pitch.toFixed(1) + '° zoom=' + z.toFixed(2) +
                  ' → fov=' + fovDeg.toFixed(1) + '°');
    }
    return true;
  }

  // Place the cloned model in the local SV frame.
  //   Frame: +X = east, +Y = up, -Z = north (matches a camera at origin
  //     looking toward -Z with rotation.y = -heading).
  //   distance + bearing computed via google.maps.geometry.spherical when
  //     available (sub-metre accuracy), with a Haversine fallback so the
  //     overlay doesn't crash if the geometry lib didn't load.
  //   Height: building base elevation - panorama camera height (= panorama
  //     ground + 2.5 m observer offset). Negative dy means the base is
  //     below the observer's eyes (the normal case at street level).
  //   User offsets/rotations from the main panel sliders are layered on
  //     top so the SV view honours manual nudges.
  function applySvModelTransform() {
    if (!_svPanorama || !_svModelRoot || !modelRoot) return;
    const pos = _svPanorama.getPosition();
    if (!pos) return;
    const panoLat = pos.lat(), panoLng = pos.lng();

    let distM, bearingDegFromPano;
    if (window.google?.maps?.geometry?.spherical) {
      const spherical = google.maps.geometry.spherical;
      const a = new google.maps.LatLng(panoLat, panoLng);
      const b = new google.maps.LatLng(lat, lon);
      distM = spherical.computeDistanceBetween(a, b);
      bearingDegFromPano = spherical.computeHeading(a, b); // -180..180 cw from north
    } else {
      distM = haversineMeters(panoLat, panoLng, lat, lon);
      bearingDegFromPano = bearingDeg(panoLat, panoLng, lat, lon);
    }
    const bRad = bearingDegFromPano * DEG2RAD;
    const dxEast  =  distM * Math.sin(bRad);
    const dzMinusN = -distM * Math.cos(bRad); // -north
    const panoGroundElev = (_apiElevation != null)
      ? _apiElevation
      : (_groundAnchor ? (_groundAnchor.length() - _targetSurface.length()) : 0);
    const buildingGroundElev = panoGroundElev; // same ground anchor; user altura slider compensates
    const dyUp = (buildingGroundElev - (panoGroundElev + 2.5)); // camera sits ~2.5 m above ground

    _svModelRoot.position.set(
      dxEast    + offsetE,
      dyUp      + altOffset,
      dzMinusN  - offsetN, // +N is -Z in this frame
    );
    // Z-up GLB clone → Y-up scene: -90° around X baked into the group.
    // Then layer the user's yaw / pitch / roll sliders (which were
    // authored around east/north/up in the main ENU frame and map
    // cleanly to local +Y / +X / +Z here).
    _svModelRoot.rotation.order = 'YXZ';
    _svModelRoot.rotation.x = -Math.PI / 2 + pitchDeg * DEG2RAD;
    _svModelRoot.rotation.y =  rotDeg * DEG2RAD;
    _svModelRoot.rotation.z =  rollDeg * DEG2RAD;
    _svModelRoot.scale.setScalar(scaleMx);
  }
  function svAnimate() {
    _svAnimFrame = requestAnimationFrame(svAnimate);
    if (!_svRenderer || !_svScene || !_svCamera) return;
    if (!syncSvCamera(null)) return;
    applySvModelTransform();
    _svRenderer.render(_svScene, _svCamera);
  }
  function closeStreetViewOverlay() {
    const overlay = document.getElementById('g3d-svfull');
    if (overlay) overlay.style.display = 'none';
    if (_svAnimFrame) { cancelAnimationFrame(_svAnimFrame); _svAnimFrame = null; }
  }
  // Register teardown so closeGoogle3DPanel can stop the SV render loop and
  // dispose its renderer even if the user closes the whole panel while the
  // overlay is open.
  tiles._svCleanup = () => {
    if (_svAnimFrame) { cancelAnimationFrame(_svAnimFrame); _svAnimFrame = null; }
    if (_svRenderer) { try { _svRenderer.dispose(); } catch {} _svRenderer = null; }
    _svPanorama = null; _svScene = null; _svCamera = null; _svModelRoot = null;
  };
  document.getElementById('g3d-view-sv').addEventListener('click', openStreetViewOverlay);
  document.getElementById('g3d-svfull-close').addEventListener('click', closeStreetViewOverlay);

  // Secondary: open Google's Street View in a separate tab (no 3D overlay).
  document.getElementById('g3d-view-sv-tab').addEventListener('click', () => {
    const url = 'https://www.google.com/maps/@?api=1&map_action=pano'
      + '&viewpoint=' + lat + ',' + lon;
    window.open(url, '_blank', 'noopener,noreferrer');
  });

  // ─── Anchor status indicator + manual override ─────────────────────────
  // The anchor (where the model sits vertically) comes from one of:
  //   1. Elevation API (deterministic, ideal).
  //   2. Raycast against loaded tiles (non-deterministic, can land high).
  //   3. Manual override (user-typed metres MSL).
  // Show the source + value in a small badge so when something looks wrong
  // visually, the user can tell at a glance which mode is active and either
  // re-try or override.
  const anchorStatusEl  = document.getElementById('g3d-anchor-status');
  const elevOverrideEl  = document.getElementById('g3d-elev-override');
  let _anchorSource = '⏳';
  function setAnchorStatus(source, elevMeters) {
    _anchorSource = source;
    if (!anchorStatusEl) return;
    const colors = { api: '#7fe091', raycast: '#ffb455', manual: '#7fd0ff', fail: '#ff7a7a', loading: '#bbb' };
    const labels = { api: 'API ✓', raycast: 'raycast ⚠', manual: 'manual ✋', fail: 'sin anchor ❌', loading: '⏳' };
    anchorStatusEl.innerHTML = 'Anchor: <span style="color:' + (colors[source] || '#fff') + '">' + labels[source] + '</span>'
      + (elevMeters != null ? ' · ' + elevMeters.toFixed(1) + ' m' : '');
  }
  setAnchorStatus(_apiElevation != null ? 'api' : 'loading',
                  _apiElevation != null ? _apiElevation : null);

  // Watcher: when _groundAnchor lands via raycast, update the badge.
  // (Polled in the anchor interval rather than via event because the existing
  // anchor functions are closures that don't fire events.)
  const _anchorWatch = setInterval(() => {
    if (!_groundAnchor) return;
    const elev = _groundAnchor.length() - _targetSurface.length();
    if (_anchorSource === 'loading' || _anchorSource === 'fail') {
      setAnchorStatus(_apiElevation != null ? 'api' : 'raycast', elev);
    }
  }, 500);
  tiles._anchorWatch = _anchorWatch;

  // Re-anclar: set an initial anchor from the Elevation API (orthometric
  // estimate) and then run a continuous raycast-snap loop for 2 s. The
  // previous behaviour took a single API value and stopped — but the API
  // returns geoid-referenced height while Maxar tiles use ellipsoid height,
  // so the model would visibly drop or jump. Streaming the raycast across
  // a 2 s window lets the building converge to the actual high-LOD tile
  // surface as Maxar refines around the lot.
  document.getElementById('g3d-reanchor').addEventListener('click', async () => {
    if (tiles._reAnchorTimer) { clearInterval(tiles._reAnchorTimer); tiles._reAnchorTimer = null; }
    setAnchorStatus('loading');
    _groundAnchor = null;
    if (modelRoot) modelRoot.visible = false;

    const newElev = await fetchGroundElevation(lat, lon, apiKey);
    if (newElev != null) {
      _groundAnchor = latLonToECEF(lat, lon, newElev);
      applyGeoTransform();
      if (modelRoot) modelRoot.visible = true;
      frameOnAnchor();
      setAnchorStatus('api', newElev);
      console.log('[Google 3D] 🎯 re-anclado vía Elevation API · elev=' + newElev.toFixed(1) + 'm · refinando contra Maxar…');
    } else {
      setAnchorStatus('raycast');
      console.log('[Google 3D] 🎯 re-anclando vía raycast — esperá unos segundos');
    }

    // 2-second continuous snap loop. Every 250 ms we raycast against the
    // currently-loaded tiles. As Maxar streams in higher LODs the hit
    // converges to the real ground; the existing ±200 m delta cap inside
    // refineAnchorGround() rejects spurious far-tile hits.
    const t0 = performance.now();
    tiles._reAnchorTimer = setInterval(() => {
      if (!_groundAnchor) {
        tryAnchorGround();
      } else {
        refineAnchorGround();
      }
      if (performance.now() - t0 >= 2000) {
        clearInterval(tiles._reAnchorTimer);
        tiles._reAnchorTimer = null;
        const finalElev = _groundAnchor
          ? (_groundAnchor.length() - _targetSurface.length()).toFixed(1)
          : '?';
        console.log('[Google 3D] 🎯 snap continuo terminado · elev final ≈ ' + finalElev + ' m');
      }
    }, 250);
  });

  // Manual elevation override: skip everything automatic and place the model
  // at exactly the elevation the user typed. Useful when both API and raycast
  // produce wrong results for an unusual location.
  document.getElementById('g3d-elev-apply').addEventListener('click', () => {
    const v = parseFloat(elevOverrideEl.value);
    if (!isFinite(v)) { alert('Ingresá una elevación válida en metros.'); return; }
    _groundAnchor = latLonToECEF(lat, lon, v);
    applyGeoTransform();
    if (modelRoot) modelRoot.visible = true;
    frameOnAnchor();
    setAnchorStatus('manual', v);
    console.log('[Google 3D] ✋ anchor manual · elev=' + v.toFixed(1) + 'm');
  });

  // Screenshot of the current 3D view. Saves a PNG with the lat/lon and
  // timestamp in the filename so multiple captures don't overwrite.
  document.getElementById('g3d-capture').addEventListener('click', () => {
    // Force one render so the back buffer matches what's on screen exactly.
    renderer.render(scene, camera);
    canvas.toBlob((blob) => {
      if (!blob) {
        alert('No se pudo capturar la imagen — recargá la página y reintentá.');
        return;
      }
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'bizual-3d-' + lat.toFixed(4) + '_' + lon.toFixed(4) + '-' + stamp + '.png';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      console.log('[Google 3D] 📷 captura descargada:', a.download, '(' + (blob.size/1024).toFixed(0) + ' KB)');
    }, 'image/png');
  });

  // ─── Animation loop ─────────────────────────────────────────────────────
  function animate() {
    _animFrame = requestAnimationFrame(animate);
    // Skip work entirely when the canvas is squished (e.g. the user dragged
    // DevTools so far up that the viewport collapses) — gl.viewport with a
    // ~0 dimension floods the WebGL context with errors and breaks rendering.
    if (canvas.clientWidth < 8 || canvas.clientHeight < 8) return;
    controls.update();
    // Per-frame LOD pipeline for Google Photorealistic 3D Tiles.
    //   setCamera + setResolutionFromRenderer feed the renderer the active
    //     camera matrix and the canvas size in CSS pixels — that's what
    //     drives the screen-space-error calculation (and therefore which
    //     LODs get requested from tile.googleapis.com).
    //   update() walks the tile tree, marks tiles to download/unload, and
    //     applies fade transitions. MUST run every frame, not on an
    //     interval — skipping it freezes the world at the last LOD.
    tiles.setCamera(camera);
    tiles.setResolutionFromRenderer(camera, renderer);
    tiles.update();
    camera.up.copy(camera.position).normalize();
    // Sky dome follows the camera so it's an actual surrounding sky at any
    // distance from the globe; gradient stays aligned to local up.
    skySphere.position.copy(camera.position);
    skySphere.material.uniforms.upDir.value.copy(camera.up);
    // Route every frame through the post-processing composer. RenderPass
    // calls renderer.render(scene, camera) internally so tiles state stays
    // in sync. If PostFX failed to construct for any reason, fall back to
    // direct render so the panel doesn't go black.
    if (_postfx?.composer) _postfx.render();
    else renderer.render(scene, camera);
  }
  animate();

  // Resize observer (panel can be resized when window changes)
  _resizeObs = new ResizeObserver(() => {
    const { W: w, H: h } = fitSize();
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    _postfx?.resize();
  });
  _resizeObs.observe(canvas);

  return {
    setSunHour(hour) {
      const p = getSunParams(hour);
      sunLight.intensity = Math.max(0.3, p.sunIntensity);
      sunLight.color.setHex(p.sunColor);
      sunLight.visible = !p.isNight;
      const d = getSunDirectionECEF(lat, lon, p.azimut, p.elevation);
      sunLight.position.copy(d.multiplyScalar(1e7));
    },
  };
}

function makeDraco() {
  const d = new DRACOLoader();
  d.setDecoderPath(DRACO_DECODER);
  d.setDecoderConfig({ type: 'js' });
  return d;
}

function makeKtx2(renderer) {
  const k = new KTX2Loader();
  k.setTranscoderPath(KTX2_TRANSCODER);
  if (renderer && k.detectSupport) k.detectSupport(renderer);
  return k;
}
