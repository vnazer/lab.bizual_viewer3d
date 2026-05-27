// Google Photorealistic 3D Tiles + GLB del edificio.
// Library: https://github.com/NASA-AMMOS/3DTilesRendererJS (bundled in /libs/3dtiles/)
// API key: stored in localStorage[bizual_google_maps_key]; first run prompts.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader }    from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader }   from 'three/addons/loaders/DRACOLoader.js';
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

const GOOGLE_TILES_URL = 'https://tile.googleapis.com/v1/3dtiles/root.json';
const DRACO_DECODER    = 'https://www.gstatic.com/draco/v1/decoders/';

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
    if (_activeTiles._statsInterval) clearInterval(_activeTiles._statsInterval);
    if (_activeTiles._anchorInterval) clearInterval(_activeTiles._anchorInterval);
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
  const { lat, lon, display } = coords;
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

  closeGoogle3DPanel();

  const panel = document.createElement('div');
  panel.id = 'g3d-panel';
  const sR = parseFloat(localStorage.getItem('bizual_g3d_rot')   || 0);
  // bizual_g3d_alt_v2 = ALTURA SOBRE EL SUELO (post ground-anchor). The old
  // bizual_g3d_alt key was metres above the WGS84 ellipsoid and is now
  // semantically wrong — ignore it so users don't inherit a stale +16 m offset.
  const sA = parseFloat(localStorage.getItem('bizual_g3d_alt_v2') || 0);
  const sS = parseFloat(localStorage.getItem('bizual_g3d_scale') || 1);
  const sQ = parseFloat(localStorage.getItem('bizual_g3d_quality') || 14);
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
    <div class="g3d-bottom">
      <div class="g3d-sliders">
        <label>🔄 Rot
          <input type="range" id="g3d-rot"   min="0"   max="360" step="1"    value="${sR}">
          <span id="g3d-rot-val">${sR}°</span>
        </label>
        <label title="Metros sobre el suelo real (Maxar). Negativo = hundir el modelo">↕️ Altura
          <input type="range" id="g3d-alt"   min="-30" max="60"  step="0.5"  value="${sA}">
          <span id="g3d-alt-val">${sA} m</span>
        </label>
        <label>📐 Escala
          <input type="range" id="g3d-scale" min="0.1" max="3"   step="0.05" value="${sS}">
          <span id="g3d-scale-val">${sS}×</span>
        </label>
        <label title="errorTarget: menor = más detalle (más pesado), mayor = más liviano">🎯 Calidad
          <input type="range" id="g3d-quality" min="8" max="24" step="1" value="${sQ}">
          <span id="g3d-quality-val">${sQ}</span>
        </label>
      </div>
      <div class="g3d-quality">
        <label><input type="checkbox" id="g3d-hdri" checked> HDRI</label>
        <label title="Sombras del sol desactivadas por defecto en este entorno — el shadow camera no escala bien a coordenadas ECEF"><input type="checkbox" id="g3d-shadows"> Sombras</label>
        <button id="g3d-save">💾 Guardar ajustes</button>
      </div>
    </div>
    <div class="g3d-attribution">© Google · Imagery ©2025 Maxar Technologies</div>
  `;
  document.body.appendChild(panel);

  document.getElementById('btn-close-g3d').addEventListener('click', closeGoogle3DPanel);
  document.getElementById('btn-change-key').addEventListener('click', () => {
    const k = (prompt('Google Maps API key:', getGoogleApiKey()) || '').trim();
    if (k) { saveGoogleApiKey(k); closeGoogle3DPanel(); openGoogle3DPanel(coords, modelUrl); }
  });
  const escHandler = (e) => { if (e.key === 'Escape') closeGoogle3DPanel(); };
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
  });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.toneMapping = THREE.AgXToneMapping ?? THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  _activeRenderer = renderer;

  function fitSize() {
    const W = canvas.clientWidth || window.innerWidth;
    const H = canvas.clientHeight || (window.innerHeight - 110);
    renderer.setSize(W, H, false);
    return { W, H };
  }
  const { W, H } = fitSize();

  const camera = new THREE.PerspectiveCamera(60, W / H, 1, 160_000_000);
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
  tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: makeDraco() }));
  tiles.registerPlugin(new UnloadTilesPlugin());
  tiles.registerPlugin(new TileCompressionPlugin());

  // Quality / network budget. errorTarget drives screen-space error: lower =
  // more detail (heavier), higher = lighter. Cache + queue sizes are bounded so
  // a long session doesn't saturate memory or the network.
  tiles.errorTarget = sQ;
  tiles.lruCache.minSize = 600;
  tiles.lruCache.maxSize = 900;
  tiles.downloadQueue.maxJobs = 10;
  tiles.parseQueue.maxJobs = 5;

  tiles.setCamera(camera);
  tiles.setResolutionFromRenderer(camera, renderer);
  scene.add(tiles.group);
  _activeTiles = tiles;
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
  tiles.addEventListener('load-content', (e) => {
    console.log('[Google 3D] tile content loaded:', e?.tile?.content?.uri || e);
  });

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
  controls.minDistance = 100;
  controls.maxDistance = 5_000_000;
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.screenSpacePanning = false;

  // Camera framing is driven by ground anchoring (tryAnchorGround) once the
  // tiles under the target have loaded — see below.

  // ─── HDRI environment + sun (synced from lab's sun_hour) ────────────────
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  let _envMap = null;
  let _hdriObjectUrl = null;

  async function loadHDRI() {
    try {
      const url = await getActiveHDRIUrl();
      if (url.startsWith('blob:')) _hdriObjectUrl = url;
      new RGBELoader().load(url, (tex) => {
        _envMap = pmrem.fromEquirectangular(tex).texture;
        scene.environment = _envMap;
        tex.dispose();
        if (_hdriObjectUrl) { URL.revokeObjectURL(_hdriObjectUrl); _hdriObjectUrl = null; }
      });
    } catch (e) { console.warn('[g3d] HDRI failed:', e.message); }
  }
  if (document.getElementById('g3d-hdri').checked) loadHDRI();
  document.getElementById('g3d-hdri').addEventListener('change', (e) => {
    if (e.target.checked) loadHDRI();
    else scene.environment = null;
  });

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
  let rotDeg    = sR;
  let altOffset = sA;
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
      // Keep the ENU orientation, but sit on the real terrain + altura offset.
      WGS84_ELLIPSOID.getEastNorthUpFrame(lat * DEG2RAD, lon * DEG2RAD, frame);
      frame.setPosition(_groundAnchor.clone().addScaledVector(_up, altOffset));
    } else {
      frame.copy(getLocalFrameMatrix(lat, lon, altOffset));
    }
    const rotY = new THREE.Matrix4().makeRotationY(rotDeg * Math.PI / 180);
    const sM = new THREE.Matrix4().makeScale(scaleMx, scaleMx, scaleMx);
    modelRoot.matrix.copy(frame).multiply(rotY).multiply(sM);
    modelRoot.matrixAutoUpdate = false;
    modelRoot.matrixWorldNeedsUpdate = true;
  }

  // Drop a ray from high above the target straight down onto the loaded Google
  // tiles to find the real ground height, then re-anchor the model and frame
  // the camera on it. Retries until tiles under the target exist.
  const _groundRay = new THREE.Raycaster();
  _groundRay.firstHitOnly = true;
  function tryAnchorGround() {
    if (_groundAnchor) return true;
    const visible = tiles.visibleTiles?.size || 0;
    if (!tiles.group || visible < 10) return false;

    // East/north axes around the target so we can fan rays in a small grid.
    const east  = new THREE.Vector3();
    const north = new THREE.Vector3();
    WGS84_ELLIPSOID.getEastNorthUpAxes(lat * DEG2RAD, lon * DEG2RAD, east, north, new THREE.Vector3());

    // Multi-sample raycast: 5×5 grid at ±100 m. Dense Maxar tiles in an urban
    // block mean a tight grid (±30 m) lands every ray on a rooftop — the
    // "lowest" still ended up 100 m above the street. Widening to ±100 m
    // covers across the surrounding streets so at least a few rays should hit
    // asphalt.
    const baseOrigin = latLonToECEF(lat, lon, 15000);
    const ellipsoidR = latLonToECEF(lat, lon, 0).length();
    const dir = _up.clone().negate();
    const allElevs = [];
    let bestHit = null;
    let bestElev = Infinity;
    const offsets = [-100, -50, 0, 50, 100];
    for (const dE of offsets) {
      for (const dN of offsets) {
        const origin = baseOrigin.clone().addScaledVector(east, dE).addScaledVector(north, dN);
        _groundRay.set(origin, dir);
        _groundRay.far = 25000;
        const hits = _groundRay.intersectObject(tiles.group, false);
        if (!hits.length) continue;
        const elev = hits[0].point.length() - ellipsoidR;
        if (elev < -500 || elev > 9000) continue;
        allElevs.push(elev);
        if (elev < bestElev) { bestElev = elev; bestHit = hits[0].point.clone(); }
      }
    }
    if (!bestHit) return false;
    if (Math.abs(bestElev) < 5) {
      console.log('[Google 3D] raycast pegó al basemap (elev≈' + bestElev.toFixed(1) + 'm); esperando Maxar…');
      return false;
    }

    _groundAnchor = bestHit;
    applyGeoTransform();
    if (modelRoot) modelRoot.visible = true;
    controls.target.copy(_groundAnchor);
    animateCameraTo(
      camera, controls,
      _groundAnchor.clone().addScaledVector(_up, 220),
      _groundAnchor, 1400
    );
    const sorted = allElevs.slice().sort((a, b) => a - b);
    console.log('[Google 3D] ✅ modelo anclado',
                '· suelo (min) ≈ ' + bestElev.toFixed(1) + 'm sobre elipsoide',
                '· techos (max) ≈ ' + sorted[sorted.length-1].toFixed(1) + 'm',
                '· hits válidos=' + allElevs.length + '/25',
                '· spread=' + (sorted[sorted.length-1] - sorted[0]).toFixed(1) + 'm');
    return true;
  }
  let _anchorTries = 0;
  const _anchorInterval = setInterval(() => {
    if (tryAnchorGround()) { clearInterval(_anchorInterval); return; }
    _anchorTries++;
    if (_anchorTries % 6 === 0) {
      console.log('[Google 3D] raycast aún sin suelo · visibleTiles=' + (tiles.visibleTiles?.size || 0) +
                  ' · intentos=' + _anchorTries);
    }
    if (_anchorTries > 45) {
      clearInterval(_anchorInterval);
      console.warn('[Google 3D] ⚠️ no se pudo anclar al terreno tras 30s — muestro el modelo en el elipsoide (puede flotar). Bajá 🎯 Calidad para forzar más detalle.');
      if (modelRoot) modelRoot.visible = true;
    }
  }, 700);
  tiles._anchorInterval = _anchorInterval;

  const loader = new GLTFLoader();
  loader.setDRACOLoader(makeDraco());
  loader.load(modelUrl, (gltf) => {
    const model = gltf.scene;
    model.traverse((c) => {
      if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; }
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
  });

  // Sliders
  function bindSlider(id, valId, decimals, unit, onChange) {
    const inp = document.getElementById(id);
    const out = document.getElementById(valId);
    if (!inp) return;
    inp.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      out.textContent = v.toFixed(decimals) + unit;
      onChange(v);
      applyGeoTransform();
    });
  }
  bindSlider('g3d-rot',   'g3d-rot-val',   0, '°',  (v) => rotDeg = v);
  bindSlider('g3d-alt',   'g3d-alt-val',   1, ' m', (v) => altOffset = v);
  bindSlider('g3d-scale', 'g3d-scale-val', 2, '×',  (v) => scaleMx = v);

  let qualityVal = sQ;
  const qInp = document.getElementById('g3d-quality');
  const qOut = document.getElementById('g3d-quality-val');
  qInp.addEventListener('input', (e) => {
    qualityVal = parseFloat(e.target.value);
    qOut.textContent = String(qualityVal);
    tiles.errorTarget = qualityVal;
  });

  document.getElementById('g3d-save').addEventListener('click', () => {
    localStorage.setItem('bizual_g3d_rot',      String(rotDeg));
    localStorage.setItem('bizual_g3d_alt_v2',   String(altOffset));
    localStorage.setItem('bizual_g3d_scale',    String(scaleMx));
    localStorage.setItem('bizual_g3d_quality',  String(qualityVal));
    const btn = document.getElementById('g3d-save');
    btn.textContent = '✅ Guardado';
    setTimeout(() => { btn.textContent = '💾 Guardar ajustes'; }, 1500);
  });

  // ─── Animation loop ─────────────────────────────────────────────────────
  function animate() {
    _animFrame = requestAnimationFrame(animate);
    // Skip work entirely when the canvas is squished (e.g. the user dragged
    // DevTools so far up that the viewport collapses) — gl.viewport with a
    // ~0 dimension floods the WebGL context with errors and breaks rendering.
    if (canvas.clientWidth < 8 || canvas.clientHeight < 8) return;
    controls.update();
    tiles.setCamera(camera);
    tiles.setResolutionFromRenderer(camera, renderer);
    tiles.update();
    camera.up.copy(camera.position).normalize();
    // Sky dome follows the camera so it's an actual surrounding sky at any
    // distance from the globe; gradient stays aligned to local up.
    skySphere.position.copy(camera.position);
    skySphere.material.uniforms.upDir.value.copy(camera.up);
    renderer.render(scene, camera);
  }
  animate();

  // Resize observer (panel can be resized when window changes)
  _resizeObs = new ResizeObserver(() => {
    const { W: w, H: h } = fitSize();
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
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
