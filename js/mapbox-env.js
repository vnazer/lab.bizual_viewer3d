// Mapbox GL JS v3 Standard style + Three.js custom layer.
// Full-screen panel with the GLB rendered inside the photorealistic 3D city.
// Reference: https://docs.mapbox.com/mapbox-gl-js/example/add-3d-model/
//
// Token: stored in localStorage[bizual_lab_mapbox_token]. First run prompts.
// Geocoder: OpenStreetMap Nominatim (no API key required).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const MAPBOX_VERSION  = '3.11.0';
const MAPBOX_CSS_URL  = `https://api.mapbox.com/mapbox-gl-js/v${MAPBOX_VERSION}/mapbox-gl.css`;
const MAPBOX_JS_URL   = `https://api.mapbox.com/mapbox-gl-js/v${MAPBOX_VERSION}/mapbox-gl.js`;
const DRACO_DECODER   = 'https://www.gstatic.com/draco/v1/decoders/';
const TOKEN_KEY       = 'bizual_lab_mapbox_token';

const STYLES = {
  standard:  'mapbox://styles/mapbox/standard',
  satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
  streets:   'mapbox://styles/mapbox/streets-v12',
  dark:      'mapbox://styles/mapbox/dark-v11',
};

let _mapboxgl = null;
let _cssInjected = false;

// ─── token + script loading ──────────────────────────────────────────
export function getMapboxToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setMapboxToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t.trim());
  else localStorage.removeItem(TOKEN_KEY);
}

function injectCSS() {
  if (_cssInjected) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = MAPBOX_CSS_URL;
  document.head.appendChild(link);
  _cssInjected = true;
}

async function ensureMapbox() {
  if (_mapboxgl) return _mapboxgl;
  if (window.mapboxgl) { _mapboxgl = window.mapboxgl; return _mapboxgl; }
  injectCSS();
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = MAPBOX_JS_URL;
    s.onload = resolve;
    s.onerror = () => reject(new Error('No se pudo cargar Mapbox GL JS'));
    document.head.appendChild(s);
  });
  _mapboxgl = window.mapboxgl;
  return _mapboxgl;
}

// ─── geocoder (OSM Nominatim) ─────────────────────────────────────────
export async function geocodeAddress(rawAddress) {
  const query = /chile|argentina|uruguay|peru|perú|méxico|mexico|colombia|españa|spain/i.test(rawAddress)
    ? rawAddress
    : rawAddress + ', Chile';
  const url = 'https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(query) + '&format=json&limit=1';
  const res = await fetch(url, { headers: { 'Accept-Language': 'es' } });
  if (!res.ok) throw new Error(`Geocoder HTTP ${res.status}`);
  const data = await res.json();
  if (!data.length) throw new Error('Dirección no encontrada. Probá: Calle 123, Ciudad');
  return {
    lat: parseFloat(data[0].lat),
    lon: parseFloat(data[0].lon),
    display: data[0].display_name,
  };
}

// ─── three.js custom layer ────────────────────────────────────────────
function createModelLayer(lng, lat, glbUrl, initial = {}) {
  let rotDeg  = initial.rotation ?? 0;
  let scaleMx = initial.scale    ?? 1.0;
  let altM    = initial.altitude ?? 0;

  let camera, scene, renderer, model;
  let mapRef = null;

  // Pre-compute Mercator scale at this latitude (constant within ~one city).
  const mercatorOrigin = _mapboxgl.MercatorCoordinate.fromLngLat([lng, lat], 0);
  const metersToMercator = mercatorOrigin.meterInMercatorCoordinateUnits();

  return {
    id: 'bizual-model',
    type: 'custom',
    renderingMode: '3d',

    setRotation(deg) { rotDeg = deg; mapRef?.triggerRepaint(); },
    setScale(s)      { scaleMx = Math.max(0.01, s); mapRef?.triggerRepaint(); },
    setAltitude(m)   { altM = m; mapRef?.triggerRepaint(); },
    getModel()       { return model; },

    onAdd(map, gl) {
      mapRef = map;
      camera = new THREE.Camera();
      scene = new THREE.Scene();

      // 3-light setup matching the official Mapbox example.
      scene.add(new THREE.AmbientLight(0xffffff, 0.7));
      const d1 = new THREE.DirectionalLight(0xfff4e5, 1.1);
      d1.position.set(0, -70, 100).normalize();
      scene.add(d1);
      const d2 = new THREE.DirectionalLight(0xc8d8e0, 0.5);
      d2.position.set(0, 70, 100).normalize();
      scene.add(d2);

      const draco = new DRACOLoader();
      draco.setDecoderPath(DRACO_DECODER);
      draco.setDecoderConfig({ type: 'js' });
      const loader = new GLTFLoader();
      loader.setDRACOLoader(draco);

      loader.load(
        glbUrl,
        (gltf) => {
          model = gltf.scene;

          // Auto-center: base at Y=0, X/Z midpoints at 0.
          const box = new THREE.Box3().setFromObject(model);
          const size = box.getSize(new THREE.Vector3());
          const center = box.getCenter(new THREE.Vector3());
          model.position.set(-center.x, -box.min.y, -center.z);
          model.updateMatrixWorld(true);
          scene.add(model);

          const isLikelyCm = size.y < 5 && size.x < 5 && size.z < 5;
          window.__mapboxModel = { model, box, size, isLikelyCm };
          console.log('[Bizual Entorno] Modelo cargado');
          console.log(`  Dimensiones reales: ${size.x.toFixed(1)}m × ${size.y.toFixed(1)}m × ${size.z.toFixed(1)}m`);
          console.log(`  Factor escala Mercator: ${metersToMercator.toExponential(3)}`);
          if (isLikelyCm) console.warn('  ⚠ Modelo parece estar en cm, no en metros — ajustá la Escala a ~100×');
          mapRef.triggerRepaint();
        },
        undefined,
        (err) => console.warn('[mapbox-env] GLB load failed:', err)
      );

      renderer = new THREE.WebGLRenderer({
        canvas: map.getCanvas(),
        context: gl,
        antialias: true,
      });
      renderer.autoClear = false;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
    },

    render(gl, matrix) {
      if (!model) return;
      const origin = _mapboxgl.MercatorCoordinate.fromLngLat([lng, lat], altM);
      const scale = metersToMercator * scaleMx;

      // Three.js Y-up → Mapbox Z-up, then heading rotation around Y (model space).
      const rotX = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 0, 0), Math.PI / 2);
      const rotY = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(0, 1, 0), rotDeg * Math.PI / 180);
      const xform = new THREE.Matrix4()
        .makeTranslation(origin.x, origin.y, origin.z)
        .scale(new THREE.Vector3(scale, -scale, scale))
        .multiply(rotX)
        .multiply(rotY);

      camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix).multiply(xform);
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

      renderer.resetState();
      renderer.render(scene, camera);
      // No triggerRepaint here — Mapbox repaints on view change; setters
      // trigger explicitly when sliders move.
    },
  };
}

// ─── full-screen panel (open / close) ─────────────────────────────────
let _activePanel = null;
let _activeMap   = null;
let _activeLayer = null;

export async function openEnvPanel(address, modelUrl, opts = {}) {
  if (!address?.trim()) {
    alert('Ingresá una dirección antes de ver el entorno');
    return null;
  }

  let token = getMapboxToken();
  if (!token) {
    token = (prompt('Token público de Mapbox (pk.eyJ1...)\nObtenelo en mapbox.com → Account → Tokens', '') || '').trim();
    if (!token) return null;
    setMapboxToken(token);
  }

  // Geocode first — fail fast if address is bad.
  let coords;
  try {
    coords = await geocodeAddress(address);
  } catch (err) {
    alert('No se encontró la dirección. Probá: "Av. Libertad 123, Viña del Mar"');
    return null;
  }

  await ensureMapbox();
  _mapboxgl.accessToken = token;

  // Persisted slider values (defaults: 0 / 1 / 0)
  const savedRot   = parseFloat(localStorage.getItem('bizual_env_rot')   ?? '0');
  const savedScale = parseFloat(localStorage.getItem('bizual_env_scale') ?? '1');
  const savedAlt   = parseFloat(localStorage.getItem('bizual_env_alt')   ?? '0');

  closeEnvPanel(); // remove any existing

  const panel = document.createElement('div');
  panel.id = 'env-panel';
  panel.innerHTML = `
    <div class="env-header">
      <div class="env-title">
        <span class="env-pin">📍</span>
        <span class="env-address">${escapeHtml(coords.display.split(',').slice(0, 2).join(',').trim())}</span>
      </div>
      <div class="env-style-btns">
        <button class="env-style active" data-style="standard"  title="Edificios 3D fotorealistas">🏙️ 3D</button>
        <button class="env-style"        data-style="satellite" title="Vista satelital">🛰️ Satélite</button>
        <button class="env-style"        data-style="streets"   title="Mapa de calles">🗺️ Calles</button>
        <button class="env-style"        data-style="dark"      title="Modo oscuro">🌙 Noche</button>
      </div>
      <button class="env-close" title="Cerrar (Esc)">✕</button>
    </div>

    <div id="mapbox-container"></div>

    <div class="env-controls">
      <div class="env-slider-group">
        <label>🔄 Rotación edificio</label>
        <input type="range" id="s-rot"   min="0"   max="360" step="1"    value="${savedRot}">
        <span class="env-val" id="v-rot">${savedRot.toFixed(0)}°</span>
      </div>
      <div class="env-slider-group">
        <label>📐 Escala fina <small>(1.0 = real)</small></label>
        <input type="range" id="s-scale" min="0.1" max="3"   step="0.05" value="${savedScale}">
        <span class="env-val" id="v-scale">${savedScale.toFixed(2)}×</span>
      </div>
      <div class="env-slider-group">
        <label>↕️ Altura offset <small>(terreno con pendiente)</small></label>
        <input type="range" id="s-alt"   min="-5"  max="20"  step="0.5"  value="${savedAlt}">
        <span class="env-val" id="v-alt">${savedAlt.toFixed(1)} m</span>
      </div>
      <button class="env-save-btn" id="btn-save-env">💾 Guardar ajustes</button>
      <button class="env-token-btn" id="btn-token-env" title="Cambiar token Mapbox">🔑</button>
    </div>
  `;
  document.body.appendChild(panel);
  _activePanel = panel;

  const map = new _mapboxgl.Map({
    container: 'mapbox-container',
    style: STYLES.standard, // photorealistic 3D city
    center: [coords.lon, coords.lat],
    zoom: 17.5,
    pitch: 60,
    bearing: -20,
    antialias: true,
  });
  _activeMap = map;
  window.__envMap = map;
  window.__envCoord = coords;

  // Marker at the geocoded point.
  new _mapboxgl.Marker({ color: '#0066ff' })
    .setLngLat([coords.lon, coords.lat])
    .addTo(map);

  // Navigation control (rotation + pitch).
  map.addControl(new _mapboxgl.NavigationControl({ visualizePitch: true }), 'top-right');

  // Add custom layer once style finishes loading. Re-runs on style swap.
  function attachLayer() {
    // Configure Standard style (only valid for the "standard" style).
    try {
      map.setConfigProperty('basemap', 'showPlaceLabels', true);
      map.setConfigProperty('basemap', 'showPointOfInterestLabels', false);
      map.setConfigProperty('basemap', 'show3dObjects', true);
    } catch { /* not standard style */ }
    if (map.getLayer('bizual-model')) return; // already there
    _activeLayer = createModelLayer(coords.lon, coords.lat, modelUrl, {
      rotation: parseFloat(panel.querySelector('#s-rot').value),
      scale:    parseFloat(panel.querySelector('#s-scale').value),
      altitude: parseFloat(panel.querySelector('#s-alt').value),
    });
    map.addLayer(_activeLayer);
  }
  map.on('style.load', attachLayer);

  // Sliders → live update layer + persist
  bindSlider(panel, '#s-rot',   '#v-rot',   0, '°',  (v) => { _activeLayer?.setRotation(v); localStorage.setItem('bizual_env_rot',   String(v)); });
  bindSlider(panel, '#s-scale', '#v-scale', 2, '×',  (v) => { _activeLayer?.setScale(v);    localStorage.setItem('bizual_env_scale', String(v)); });
  bindSlider(panel, '#s-alt',   '#v-alt',   1, ' m', (v) => { _activeLayer?.setAltitude(v); localStorage.setItem('bizual_env_alt',   String(v)); });

  // "Guardar ajustes" — explicit feedback (sliders already auto-save).
  panel.querySelector('#btn-save-env')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    btn.textContent = '✅ Guardado';
    setTimeout(() => { btn.textContent = '💾 Guardar ajustes'; }, 1500);
  });

  // Re-prompt token
  panel.querySelector('#btn-token-env')?.addEventListener('click', () => {
    const t = (prompt('Token público de Mapbox', getMapboxToken() || '') || '').trim();
    if (!t) return;
    setMapboxToken(t);
    closeEnvPanel();
    setTimeout(() => openEnvPanel(address, modelUrl, opts), 200);
  });

  // Style switcher
  panel.querySelectorAll('.env-style').forEach((btn) => {
    btn.addEventListener('click', () => {
      panel.querySelectorAll('.env-style').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      _activeLayer = null; // setStyle drops layers; attachLayer recreates on style.load
      map.setStyle(STYLES[btn.dataset.style]);
    });
  });

  // Close button + Esc
  panel.querySelector('.env-close')?.addEventListener('click', closeEnvPanel);
  const escHandler = (e) => { if (e.key === 'Escape') closeEnvPanel(); };
  document.addEventListener('keydown', escHandler);
  panel._escHandler = escHandler;

  return { map, coords };
}

export function closeEnvPanel() {
  if (_activeMap) { try { _activeMap.remove(); } catch {} _activeMap = null; }
  if (_activePanel) {
    if (_activePanel._escHandler) document.removeEventListener('keydown', _activePanel._escHandler);
    _activePanel.remove();
    _activePanel = null;
  }
  _activeLayer = null;
  window.__envMap = null;
  window.__envCoord = null;
}

// Public so console / external code can close it (replaces the global hack).
window.closeEnvPanel = closeEnvPanel;

// ─── helpers ─────────────────────────────────────────────────────────
function bindSlider(root, inputSel, valSel, decimals, unit, onChange) {
  const input = root.querySelector(inputSel);
  const out = root.querySelector(valSel);
  if (!input) return;
  input.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    if (out) out.textContent = v.toFixed(decimals) + unit;
    onChange(v);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
