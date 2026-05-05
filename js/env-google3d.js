// Google Photorealistic 3D Tiles + GLB del edificio.
// Library: https://github.com/NASA-AMMOS/3DTilesRendererJS (loaded via esm.sh)
// API key: stored in localStorage[bizual_google_maps_key]; first run prompts.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader }    from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader }   from 'three/addons/loaders/DRACOLoader.js';
import { RGBELoader }    from 'three/addons/loaders/RGBELoader.js';

import { TilesRenderer } from '3d-tiles-renderer';
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

// ─── ECEF math ────────────────────────────────────────────────────────────
const EARTH_RADIUS = 6_371_000;

function latLonToECEF(lat, lon, altitudeM = 0) {
  const R = EARTH_RADIUS + altitudeM;
  const φ = lat * Math.PI / 180;
  const λ = lon * Math.PI / 180;
  return new THREE.Vector3(
    R * Math.cos(φ) * Math.cos(λ),
    R * Math.cos(φ) * Math.sin(λ),
    R * Math.sin(φ)
  );
}

// Transform that places "local Y-up" coordinates at lat/lon + altitude in ECEF.
function getLocalFrameMatrix(lat, lon, altitudeM = 0) {
  const φ = lat * Math.PI / 180;
  const λ = lon * Math.PI / 180;
  const R = EARTH_RADIUS + altitudeM;

  const pos = new THREE.Vector3(
    R * Math.cos(φ) * Math.cos(λ),
    R * Math.cos(φ) * Math.sin(λ),
    R * Math.sin(φ)
  );
  const up = pos.clone().normalize();
  const east = new THREE.Vector3(-Math.sin(λ), Math.cos(λ), 0).normalize();
  const north = new THREE.Vector3().crossVectors(up, east).normalize();
  east.crossVectors(north, up);

  return new THREE.Matrix4().set(
    east.x,  north.x,  up.x,  pos.x,
    east.y,  north.y,  up.y,  pos.y,
    east.z,  north.z,  up.z,  pos.z,
    0, 0, 0, 1
  );
}

function getSunDirectionECEF(lat, lon, azimutDeg, elevDeg) {
  const φ = lat * Math.PI / 180;
  const λ = lon * Math.PI / 180;
  const az = azimutDeg * Math.PI / 180;
  const el = elevDeg * Math.PI / 180;
  const lx = Math.cos(el) * Math.sin(az);
  const ly = Math.cos(el) * Math.cos(az);
  const lz = Math.sin(el);
  const up = new THREE.Vector3(Math.cos(φ) * Math.cos(λ), Math.cos(φ) * Math.sin(λ), Math.sin(φ));
  const east = new THREE.Vector3(-Math.sin(λ), Math.cos(λ), 0).normalize();
  const north = new THREE.Vector3().crossVectors(up, east).normalize();
  east.crossVectors(north, up);
  return new THREE.Vector3()
    .addScaledVector(east, lx)
    .addScaledVector(north, ly)
    .addScaledVector(up, lz)
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

// ─── Main panel ───────────────────────────────────────────────────────────
export async function openGoogle3DPanel(coords, modelUrl) {
  const { lat, lon, display } = coords;
  const apiKey = getGoogleApiKey();
  if (!apiKey) { openApiKeyDialog(coords, modelUrl); return; }

  closeGoogle3DPanel();

  const panel = document.createElement('div');
  panel.id = 'g3d-panel';
  const sR = parseFloat(localStorage.getItem('bizual_g3d_rot')   || 0);
  const sA = parseFloat(localStorage.getItem('bizual_g3d_alt')   || 0);
  const sS = parseFloat(localStorage.getItem('bizual_g3d_scale') || 1);
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
        <label>↕️ Altura
          <input type="range" id="g3d-alt"   min="-10" max="30"  step="0.5"  value="${sA}">
          <span id="g3d-alt-val">${sA} m</span>
        </label>
        <label>📐 Escala
          <input type="range" id="g3d-scale" min="0.1" max="3"   step="0.05" value="${sS}">
          <span id="g3d-scale-val">${sS}×</span>
        </label>
      </div>
      <div class="g3d-quality">
        <label><input type="checkbox" id="g3d-hdri" checked> HDRI</label>
        <label><input type="checkbox" id="g3d-shadows" checked> Sombras</label>
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
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
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
  const initPos = latLonToECEF(lat, lon, 500);
  camera.position.copy(initPos);
  camera.up.copy(initPos.clone().normalize());
  camera.lookAt(latLonToECEF(lat, lon, 0));

  const scene = new THREE.Scene();
  // Soft sky skybox (cielo a horizonte gradient) — less jarring than a flat
  // blue while tiles stream in. Sphere is bigger than camera.far far enough
  // to never get clipped.
  {
    const skyGeo = new THREE.SphereGeometry(5e6, 32, 16);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: { topColor: { value: new THREE.Color(0x4d8fcf) }, bottomColor: { value: new THREE.Color(0xeaf4fb) } },
      vertexShader: `varying vec3 vWorld; void main(){ vWorld = (modelMatrix * vec4(position,1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying vec3 vWorld; uniform vec3 topColor; uniform vec3 bottomColor; void main(){ float h = clamp(normalize(vWorld).z, -1.0, 1.0); vec3 c = mix(bottomColor, topColor, smoothstep(-0.1, 0.6, h)); gl_FragColor = vec4(c, 1.0); }`,
    });
    scene.add(new THREE.Mesh(skyGeo, skyMat));
    scene.background = null;
  }

  // ─── Google 3D Tiles ────────────────────────────────────────────────────
  const tiles = new TilesRenderer(GOOGLE_TILES_URL);
  tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: apiKey }));
  tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: makeDraco() }));
  tiles.registerPlugin(new UnloadTilesPlugin());
  tiles.registerPlugin(new TileCompressionPlugin());
  tiles.setCamera(camera);
  tiles.setResolutionFromRenderer(camera, renderer);
  scene.add(tiles.group);
  _activeTiles = tiles;
  window.__tiles = tiles;

  // ── Diagnostics: surface load failures + stats so the user can debug
  tiles.addEventListener('load-tile-set', () => {
    console.log('[Google 3D] ✅ Tileset cargado');
  });
  tiles.addEventListener('load-error', (event) => {
    const msg = event.message || event.error?.message || JSON.stringify(event);
    console.error('[Google 3D] ❌ Error cargando tile:', msg);
    if (/403/.test(msg)) console.error('[Google 3D] → 403: Map Tiles API no está habilitada en esta key');
    if (/401/.test(msg)) console.error('[Google 3D] → 401: API key inválida');
    if (/429/.test(msg)) console.error('[Google 3D] → 429: rate limit / cuota excedida');
  });

  // Periodic stats — helps diagnose "stuck on blue sky" cases.
  const _statsInterval = setInterval(() => {
    if (!tiles?.stats) return;
    const s = tiles.stats;
    console.log('[Google 3D] stats:', {
      loading: s.loading, failed: s.failed,
      inFrustum: s.inFrustum, active: s.active, downloading: s.downloading,
    });
    if (s.failed > 0 && s.active === 0) {
      console.warn('[Google 3D] All tile loads failed — verificá la API key + Map Tiles API habilitada');
    }
  }, 5000);
  // Stop the interval when panel closes — store on the tiles handle.
  tiles._statsInterval = _statsInterval;

  // OrbitControls — orbit around the building's surface point
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(latLonToECEF(lat, lon, 0));
  controls.minDistance = 100;
  controls.maxDistance = 5_000_000;
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.screenSpacePanning = false;

  // Smooth zoom-in to ~400m above the target
  setTimeout(() => {
    animateCameraTo(camera, controls, latLonToECEF(lat, lon, 400), latLonToECEF(lat, lon, 0), 2000);
  }, 400);

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
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.camera.near = 1;
  sunLight.shadow.camera.far = 1e8;
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

  function applyGeoTransform() {
    if (!modelRoot) return;
    const frame = getLocalFrameMatrix(lat, lon, altOffset);
    const rotY = new THREE.Matrix4().makeRotationY(rotDeg * Math.PI / 180);
    const sM = new THREE.Matrix4().makeScale(scaleMx, scaleMx, scaleMx);
    modelRoot.matrix.copy(frame).multiply(rotY).multiply(sM);
    modelRoot.matrixAutoUpdate = false;
    modelRoot.matrixWorldNeedsUpdate = true;
  }

  const loader = new GLTFLoader();
  loader.setDRACOLoader(makeDraco());
  loader.load(modelUrl, (gltf) => {
    const model = gltf.scene;
    model.traverse((c) => {
      if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; }
    });
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    model.position.set(-center.x, -box.min.y, -center.z);
    modelRoot = new THREE.Group();
    modelRoot.add(model);
    scene.add(modelRoot);
    applyGeoTransform();
    window.__g3dModel = { model, box, modelRoot };
    console.log('[Google 3D] modelo cargado, dimensiones:', box.getSize(new THREE.Vector3()));
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

  document.getElementById('g3d-save').addEventListener('click', () => {
    localStorage.setItem('bizual_g3d_rot',   String(rotDeg));
    localStorage.setItem('bizual_g3d_alt',   String(altOffset));
    localStorage.setItem('bizual_g3d_scale', String(scaleMx));
    const btn = document.getElementById('g3d-save');
    btn.textContent = '✅ Guardado';
    setTimeout(() => { btn.textContent = '💾 Guardar ajustes'; }, 1500);
  });

  // ─── Animation loop ─────────────────────────────────────────────────────
  function animate() {
    _animFrame = requestAnimationFrame(animate);
    controls.update();
    tiles.setCamera(camera);
    tiles.setResolutionFromRenderer(camera, renderer);
    tiles.update();
    camera.up.copy(camera.position).normalize();
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
