import * as THREE from 'three';
import {
  createRenderer, createScene, createCamera, createControls,
  getGLTFLoader, loadHDRI, setCustomHDRI, frameObject, countTriangles, enableShadows,
  fetchManifest, loadGLBWithStats, formatBytes,
  HDRI_PRESETS, DEFAULT_HDRI_ID, setSunDirection,
  applyAnisotropy, getMaterialsInfo, getExtensions, calculateVRAM,
  analyzeModelAlbedo,
  isolateMaterial, setWireframe,
} from './scene.js?v=20260519';
import { PostFX } from './postfx.js?v=20260519';
import { saveCustomHDRI, loadCustomHDRI, clearCustomHDRI, getCustomHDRIName, hasCustomHDRI } from './hdri-store.js?v=20260519';
import { FirstPersonController, setupBVH, disposeBVH, BVH_AVAILABLE } from './navigation.js?v=20260519';
import {
  detectModelType, computeBuildingWaypoints, computeUnitWaypointsFallback,
  CameraController, rotateOrbit, snapshotPose,
  loadWaypoints, saveWaypoints, clearWaypoints,
  formatWaypointJSON, parseWaypointJSON, normalizeImportedWaypoints,
  getWaypointSlots, guessModelTypeFromFilename,
  UNIT_WAYPOINT_SLOTS, EDIFICIO_WAYPOINT_SLOTS,
} from './waypoints.js?v=20260519';
import { initUnitLabels, updateUnitLabels, setUnitMode, registerUnitClickHandler, setupDblclickEntry } from './units.js?v=20260519';

// localStorage prefix for all persisted lab preferences.
const LS_PREFIX = 'bizual_lab_';
const ls = {
  get: (k, fallback) => {
    try { const v = localStorage.getItem(LS_PREFIX + k); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set: (k, v) => { try { localStorage.setItem(LS_PREFIX + k, JSON.stringify(v)); } catch {} },
};

const TONEMAP_BY_ID = {
  agx:      THREE.AgXToneMapping ?? THREE.ACESFilmicToneMapping,
  aces:     THREE.ACESFilmicToneMapping,
  neutral:  THREE.NeutralToneMapping ?? THREE.ACESFilmicToneMapping,
  cineon:   THREE.CineonToneMapping,
  reinhard: THREE.ReinhardToneMapping,
  linear:   THREE.LinearToneMapping,
};
const HAS_AGX = !!THREE.AgXToneMapping;
const DEFAULT_TONEMAP = HAS_AGX ? 'agx' : 'aces';

const host = document.getElementById('canvas-wrap');
const $ = (id) => document.getElementById(id);

const { renderer, backend } = await createRenderer(host);
// Expose ASAP — before any DOM access that could throw and abort module init.
window.__renderer = renderer;
const tagEl = $('renderer-tag');
if (tagEl) tagEl.textContent = backend.toUpperCase();

const { scene, sun, hemi, ambient, contactShadows } = createScene();
window.__scene = scene;
window.__sunLight = sun;
window.__ambientLight = ambient ?? hemi;
window.__hemiLight = hemi;

const camera = createCamera(host);
const controls = createControls(camera, renderer.domElement);
const loader = getGLTFLoader(renderer);
window.__camera = camera;
window.__controls = controls;
console.log('[lab] globals ready:', { renderer: !!window.__renderer, scene: !!window.__scene, sun: !!window.__sunLight, ambient: !!window.__ambientLight });

// "Linterna" parentada a la cámara para iluminar cuartos interiores cerrados
// (baños, dormitorios sin ventana) donde ni el sol ni el HDRI llegan dentro.
// Solo se enciende en modo FPS — en orbit/exterior queda apagada para no
// alterar el look con HDRI + sun. La cámara tiene que estar en el grafo de
// la scene para que los hijos rendericen, por eso scene.add(camera).
scene.add(camera);
const fpHeadlamp = new THREE.PointLight(0xfff1d6, 0.0, 8.0, 1.8);
fpHeadlamp.position.set(0, -0.1, -0.15); // levemente al frente y debajo de los ojos
fpHeadlamp.castShadow = false; // sin sombras para no impactar perf en FPS
fpHeadlamp.visible = false;
camera.add(fpHeadlamp);
window.__fpHeadlamp = fpHeadlamp;

// Pause autoRotate + cancel any in-flight lerp the moment the user drags.
controls.addEventListener('start', () => {
  if (typeof setAutoRotate === 'function') setAutoRotate(false);
  // (cameraCtrl may not exist yet at this point — guard below)
  if (typeof cameraCtrl !== 'undefined' && cameraCtrl.isFlying()) cameraCtrl.cancel();
  // Clear "active" highlight from view buttons.
  document.querySelectorAll('.view-grid button.active').forEach((b) => b.classList.remove('active'));
  if (typeof activeWaypointId !== 'undefined') activeWaypointId = null;
});

// First-person controller (lazy-enabled when user switches mode).
const fpsController = new FirstPersonController(camera, renderer.domElement);
window.__fps = fpsController;

const persistedNavMode = ls.get('navMode', 'orbit');
const persistedNavSpeed = ls.get('navSpeed', 2.0);
const persistedEyeHeight = ls.get('navEyeHeight', 1.65);
const persistedGravity = ls.get('navGravity', false);
fpsController.setSpeed(persistedNavSpeed);
fpsController.setEyeHeight(persistedEyeHeight);
fpsController.setGravity(persistedGravity);

// Camera pose snapshot — restore when switching back to orbit.
let _orbitSnapshot = null;
function snapshotOrbit() {
  _orbitSnapshot = {
    pos: camera.position.clone(),
    target: controls.target.clone(),
    quat: camera.quaternion.clone(),
  };
}
function restoreOrbit() {
  if (!_orbitSnapshot) return;
  camera.position.copy(_orbitSnapshot.pos);
  camera.quaternion.copy(_orbitSnapshot.quat);
  controls.target.copy(_orbitSnapshot.target);
  controls.update();
}

let navMode = 'orbit';
function setNavMode(mode, { fromUser = true } = {}) {
  if (mode === navMode) return;
  if (mode === 'fps') {
    snapshotOrbit();
    controls.enabled = false;
    fpsController.setCollisionRoot(currentModel);
    fpsController.enable();
    document.body.classList.add('nav-fps');
    $('fps-crosshair')?.classList.remove('hidden');
    // Encender linterna para evitar que baños/cuartos cerrados queden negros
    // (el sol y el HDRI no penetran paredes; sin esto el FPS es injugable).
    fpHeadlamp.intensity = 2.5;
    fpHeadlamp.visible = true;
  } else {
    fpsController.disable();
    document.body.classList.remove('nav-fps');
    $('fps-crosshair')?.classList.add('hidden');
    controls.enabled = true;
    if (fromUser) restoreOrbit();
    // Apagar linterna al volver a exterior — el look orbital usa HDRI+sun puros.
    fpHeadlamp.visible = false;
    fpHeadlamp.intensity = 0;
  }
  navMode = mode;
  ls.set('navMode', mode);
  setUnitMode(mode);
  // Sync floating-controls mode icon (defined later, may not exist yet).
  try { if (typeof syncFloatingModeIcon === 'function') syncFloatingModeIcon(); } catch {}
  // Sync UI radios
  document.querySelectorAll('.nav-mode').forEach((el) => {
    el.classList.toggle('active', el.dataset.mode === mode);
    const input = el.querySelector('input');
    if (input) input.checked = (input.value === mode);
  });
  const badge = $('nav-mode-badge');
  if (badge) badge.textContent = mode === 'fps' ? 'Interior' : 'Exterior';
}
window.__setNavMode = setNavMode;

// ────────────────────────────────────────────────────────────────────
// Waypoint navigation (T14 unidad / T15 edificio)
// ────────────────────────────────────────────────────────────────────
const cameraCtrl = new CameraController(camera, controls);
window.__cameraCtrl = cameraCtrl;

// Unit labels + dblclick-to-enter (lazy: needs ./models/unidades.json)
initUnitLabels({ camera, renderer, scene }).then((ok) => {
  if (ok) setupDblclickEntry({ scene, camera, renderer });
});

// When a label or dblclick selects a unit: load its tipologia GLB.
registerUnitClickHandler((unidad) => {
  const url = unidad.tipologia_url || (unidad.tipologia ? `./models/${unidad.tipologia}` : null);
  if (!url) {
    console.log(`[units] Unidad ${unidad.numero} sin tipologia_url`);
    return;
  }
  // Prefer the model dropdown so all tracking (waypoints, materials, etc.)
  // refreshes consistently.
  const sel = $('model-select');
  if (sel) {
    const found = Array.from(sel.options).find((o) => o.value === url || o.value.endsWith('/' + url) || o.textContent === url.split('/').pop());
    if (found) {
      sel.value = found.value;
      loadModel(found.value);
      return;
    }
  }
  loadModel(url);
});

let modelTypeOverride = ls.get('modelType', 'auto'); // 'auto' | 'edificio' | 'unidad' | 'mixto'
let activeModelType = 'unidad'; // resolved type currently in use
let buildingWaypoints = [];
let unitWaypoints = [];
let activeWaypointId = null;
let isAutoRotating = false;
let currentModelUrl = null;

function resolveModelType(model) {
  if (modelTypeOverride && modelTypeOverride !== 'auto') return modelTypeOverride;
  // Filename hint first (cheap, often unambiguous), bbox detection as fallback.
  const nameGuess = guessModelTypeFromFilename(currentModelUrl);
  const bboxGuess = detectModelType(model);
  // If the bbox says "mixto" but the filename clearly says edificio/unidad, trust the filename.
  if (bboxGuess === 'mixto') return nameGuess;
  return bboxGuess;
}

function refreshWaypoints() {
  if (!currentModel) return;
  activeModelType = resolveModelType(currentModel);
  // Custom saved waypoints take priority over the bbox fallback for both kinds.
  const savedBuilding = loadWaypoints('edificio', currentModelUrl);
  const savedUnit     = loadWaypoints('unidad',   currentModelUrl);
  buildingWaypoints = savedBuilding.length ? savedBuilding : computeBuildingWaypoints(currentModel);
  unitWaypoints     = savedUnit.length     ? savedUnit     : computeUnitWaypointsFallback(currentModel);

  const badge = $('model-type-badge');
  if (badge) badge.textContent = activeModelType.charAt(0).toUpperCase() + activeModelType.slice(1);

  const showBuild = activeModelType === 'edificio' || activeModelType === 'mixto';
  const showUnit  = activeModelType === 'unidad'   || activeModelType === 'mixto';
  $('views-edificio').style.display = showBuild ? '' : 'none';
  $('views-unidad').style.display   = showUnit  ? '' : 'none';

  renderViewGrid('views-edificio-grid', buildingWaypoints, (w) => goToWaypoint(w));
  renderViewGrid('views-unidad-grid',   unitWaypoints,     (w) => goToWaypoint(w));
  renderSavedWaypoints();

  // Apply default per type.
  if (showBuild && navMode === 'orbit') {
    const isoBuild = buildingWaypoints.find((w) => w.id === 'iso');
    if (isoBuild) goToWaypoint(isoBuild);
    setAutoRotate(true);
  } else if (showUnit && navMode === 'orbit') {
    const isoUnit = unitWaypoints.find((w) => w.id === 'iso') || unitWaypoints[0];
    if (isoUnit) goToWaypoint(isoUnit);
    setAutoRotate(false);
  }
}

// True when a position falls inside the model's axis-aligned bbox — used
// to flag waypoints whose camera lands "inside" the model (interior view).
function _isInsideModelBBox(pos) {
  if (!currentModel) return false;
  const box = new THREE.Box3().setFromObject(currentModel);
  if (box.isEmpty()) return false;
  return pos[0] > box.min.x && pos[0] < box.max.x &&
         pos[1] > box.min.y && pos[1] < box.max.y &&
         pos[2] > box.min.z && pos[2] < box.max.z;
}

function renderViewGrid(elId, waypoints, onClick) {
  const el = $(elId);
  if (!el) return;
  el.innerHTML = '';
  waypoints.forEach((w) => {
    const btn = document.createElement('button');
    btn.dataset.wpId = w.id;
    const inside = _isInsideModelBBox(w.position);
    const insideMark = inside ? '<span class="wp-inside" title="Vista interior — la cámara entra al modelo">→Interior</span>' : '';
    btn.innerHTML = `<span class="wp-label">${w.icono || '•'} ${escapeHtml(w.label)}</span>${insideMark}`;
    btn.title = inside ? `${w.label} · click para ver desde adentro` : w.label;
    if (activeWaypointId === w.id) btn.classList.add('active');
    btn.addEventListener('click', () => onClick(w));
    el.appendChild(btn);
  });
}

function goToWaypoint(w) {
  if (!w) return;
  // Playback es orbit-based. Si estamos en interior (FPS), salir antes de volar:
  // de lo contrario el FirstPersonController sigue corriendo y pelea con el lerp
  // del CameraController (jitter, clamp Y, rotación que no llega al target).
  if (navMode === 'fps') setNavMode('orbit', { fromUser: false });
  setAutoRotate(false);
  activeWaypointId = w.id;
  cameraCtrl.flyTo(w.position, w.target, () => { /* arrived */ });
  // Highlight active
  document.querySelectorAll('.view-grid button').forEach((b) => {
    b.classList.toggle('active', b.dataset.wpId === w.id);
  });
}

function setAutoRotate(on) {
  isAutoRotating = !!on;
  controls.autoRotate = isAutoRotating;
  controls.autoRotateSpeed = 1.0; // ~ π/30 rad/s ≈ 0.1 rad/s, ≈ 60s/vuelta
  const btn = $('btn-autorotate');
  if (btn) {
    btn.classList.toggle('active', isAutoRotating);
    btn.textContent = isAutoRotating ? '⏸ Pausar auto-rotate' : '▶ Auto-rotate';
  }
}

// Editor scope = which model kind the editor is currently saving slots for.
// edificio scope shares one bucket; unidad scope is per-file.
function editorScope() {
  // If the resolved type is "mixto", the editor follows the dropdown override
  // when it's set to a concrete kind; otherwise default to unidad (interiors).
  if (modelTypeOverride === 'edificio') return 'edificio';
  if (modelTypeOverride === 'unidad')   return 'unidad';
  return activeModelType === 'edificio' ? 'edificio' : 'unidad';
}

function renderSavedWaypoints() {
  const container = $('wp-saved-list');
  if (!container) return;
  const scope = editorScope();
  const saved = loadWaypoints(scope, currentModelUrl);
  const scopeBadge = $('wp-scope-badge');
  if (scopeBadge) {
    scopeBadge.textContent = scope === 'edificio' ? 'Edificio (compartido)' : 'Unidad (este archivo)';
  }
  if (!saved.length) {
    container.innerHTML = '<em class="hint">Ninguno todavía.</em>';
    return;
  }
  container.innerHTML = '';
  saved.forEach((w) => {
    const row = document.createElement('div');
    row.className = 'wp-row';
    row.innerHTML = `
      <span class="name">${escapeHtml(w.icono || '•')} ${escapeHtml(w.label || w.id)}</span>
      <button data-act="go">↗ Ir</button>
      <button data-act="del">×</button>
    `;
    row.querySelector('[data-act="go"]').addEventListener('click', () => goToWaypoint(w));
    row.querySelector('[data-act="del"]').addEventListener('click', () => {
      const next = saved.filter((x) => x.id !== w.id);
      saveWaypoints(scope, currentModelUrl, next);
      refreshWaypoints();
    });
    container.appendChild(row);
  });
}

let envTex = null;
let currentModel = null;
let currentGLTF = null;
let currentMaterials = [];
let isolatedUuid = null;

// Apply persisted tone mapping + exposure BEFORE first render so we don't flash defaults.
const persistedTonemap = ls.get('tonemap', DEFAULT_TONEMAP);
const persistedExposure = ls.get('exposure', 1.15);       // bumped default
const persistedEnvIntensity = ls.get('envIntensity', 1.20); // bumped default
const persistedHdriId = ls.get('hdri', DEFAULT_HDRI_ID);
renderer.toneMapping = TONEMAP_BY_ID[persistedTonemap] ?? THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = persistedExposure;
scene.environmentIntensity = persistedEnvIntensity;
window.__envIntensity = persistedEnvIntensity;

// ────────────────────────────────────────────────────────────────────
// Post-processing pipeline (only on WebGL2; WebGPU path skips composer).
// ────────────────────────────────────────────────────────────────────
let postfx = null;
const isWebGL2 = backend === 'webgl2';
if (isWebGL2) {
  try {
    postfx = new PostFX(renderer, scene, camera, host);
    window.__postfx = postfx;
  } catch (err) {
    console.warn('[lab] PostFX init failed, rendering without post-processing:', err);
    postfx = null;
  }
}

// Visual state (preset + post-fx + sun) — persisted.
const persistedVisualPreset  = ls.get('visual_preset',  'estandar');
const persistedSSAOOn        = ls.get('ssao_on',        true);
const persistedSSAOIntensity = ls.get('ssao_intensity', 20);
const persistedBloomOn       = ls.get('bloom_on',       true);
const persistedBloomIntensity= ls.get('bloom_intensity', 0.30);
const persistedContrast      = ls.get('contrast',       0.10);
const persistedSunOn         = ls.get('sun_on',         true);
const persistedSunIntensity  = ls.get('sun_intensity',  1.5);
const persistedSunAzimut     = ls.get('sun_azimut',     45);
const persistedSunElevation  = ls.get('sun_elevation',  55);

// Apply sun state immediately
sun.visible = persistedSunOn;
sun.intensity = persistedSunIntensity;
setSunDirection(sun, persistedSunAzimut, persistedSunElevation, 30);

// Apply post-fx state immediately
if (postfx) {
  postfx.setSSAO(persistedSSAOOn, persistedSSAOIntensity);
  postfx.setBloom(persistedBloomOn, persistedBloomIntensity);
  postfx.setContrast(persistedContrast);
}

window.__visualState = {
  preset: persistedVisualPreset,
  ssao: { on: persistedSSAOOn, intensity: persistedSSAOIntensity },
  bloom: { on: persistedBloomOn, intensity: persistedBloomIntensity },
  contrast: persistedContrast,
  sun: { on: persistedSunOn, intensity: persistedSunIntensity, azimut: persistedSunAzimut, elevation: persistedSunElevation },
};

// Anisotropy: 4 pill buttons (1× / 4× / 8× / 16×). Default 8×, capped at GPU max.
const maxAniso = renderer.capabilities?.getMaxAnisotropy?.() ?? 1;
// Migrate previous key 'aniso' → 'anisotropy'. Default 8× (was 16×).
const _legacy = ls.get('aniso', null);
let anisoValue = ls.get('anisotropy', _legacy != null ? _legacy : 8);
anisoValue = Math.min(maxAniso, Math.max(1, anisoValue));

const anisoEl = $('aniso-max');
const anisoCapHint = $('aniso-cap-hint');

function updateAnisoLabels() {
  // Stats line: "8× (sel) / 16× (gpu max)"
  if (anisoEl) anisoEl.textContent = `${anisoValue}× (sel) / ${maxAniso}× (gpu)`;
  // Hint under the pills: only show when something interesting is happening.
  if (anisoCapHint) {
    if (anisoValue < maxAniso) anisoCapHint.textContent = `Seleccionado ${anisoValue}× · GPU soporta hasta ${maxAniso}×`;
    else if (anisoValue === maxAniso) anisoCapHint.textContent = `${maxAniso}× = máximo de la GPU`;
    else anisoCapHint.textContent = '';
  }
}

function syncAnisoPills() {
  document.querySelectorAll('#aniso-pills .pill').forEach((btn) => {
    const v = parseInt(btn.dataset.aniso, 10);
    btn.classList.toggle('active', v === anisoValue);
    // Disable pills above GPU max so the user sees the hardware ceiling.
    if (v > maxAniso) {
      btn.disabled = true;
      btn.title = `No soportado — GPU máx ${maxAniso}×`;
    } else {
      btn.disabled = false;
      btn.title = `${v}× anisotropic filtering`;
    }
  });
}

document.querySelectorAll('#aniso-pills .pill').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    const requested = parseInt(btn.dataset.aniso, 10);
    anisoValue = Math.min(maxAniso, Math.max(1, requested));
    ls.set('anisotropy', anisoValue);
    if (currentModel) {
      const r = applyAnisotropy(currentModel, renderer, anisoValue);
      // Re-run VRAM calc so the operator can see the (lack of) change in real time.
      const vram = calculateVRAM(currentModel);
      $('tex-count').textContent = vram.count.toString();
      $('vram').textContent = formatBytes(vram.bytes);
      console.log(`[lab] anisotropy → ${r.applied}× (${r.slotsTouched} texture slots updated)`);
    }
    syncAnisoPills();
    updateAnisoLabels();
  });
});

syncAnisoPills();
updateAnisoLabels();

// Populate HDRI preset dropdown from scene.js export.
const hdriSelect = $('hdri-preset');
if (hdriSelect) {
  Object.entries(HDRI_PRESETS).forEach(([id, p]) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = p.label;
    hdriSelect.appendChild(opt);
  });
  hdriSelect.value = HDRI_PRESETS[persistedHdriId] ? persistedHdriId : DEFAULT_HDRI_ID;
}

// Apply tone mapping select + exposure slider initial UI state.
const tonemapSel = $('tonemap-select');
if (tonemapSel) tonemapSel.value = persistedTonemap;
const expoSlider = $('exposure');
const expoOut = $('exposure-val');
if (expoSlider) { expoSlider.value = persistedExposure; if (expoOut) expoOut.textContent = persistedExposure.toFixed(2); }
const envSlider = $('env-intensity');
const envOut = $('env-intensity-val');
if (envSlider) { envSlider.value = persistedEnvIntensity; if (envOut) envOut.textContent = persistedEnvIntensity.toFixed(2); }

async function applyHDRIPreset(id) {
  try {
    $('hdri-name').textContent = `Cargando ${HDRI_PRESETS[id]?.label || id}…`;
    const env = await loadHDRI(renderer, id);
    envTex = env;
    if ($('toggle-hdri').checked) {
      scene.environment = env;
      scene.background = env;
    }
    $('hdri-name').textContent = `✓ ${HDRI_PRESETS[id]?.label || id}`;
    ls.set('hdri', id);
  } catch (err) {
    console.warn('[lab] HDRI preset failed:', err);
    $('hdri-name').textContent = `✗ ${err.message || err}`;
  }
}

// Async HDRI bootstrap: prefer the user's persisted custom HDRI from IndexedDB,
// fall back to selected preset.
async function bootstrapHDRI() {
  if (hasCustomHDRI()) {
    try {
      const record = await loadCustomHDRI();
      if (record?.data) {
        const env = await setCustomHDRI(record.data, renderer, record.name || 'custom');
        envTex = env;
        if ($('toggle-hdri').checked) {
          scene.environment = env;
          scene.background = env;
        }
        updateCustomHDRIBadge(record.name || 'custom HDRI');
        return;
      }
    } catch (err) {
      console.warn('[lab] could not restore persisted HDRI, falling back:', err);
    }
  }
  applyHDRIPreset(hdriSelect ? hdriSelect.value : DEFAULT_HDRI_ID);
}

function updateCustomHDRIBadge(name) {
  const wrap = $('custom-hdri-status');
  if (!wrap) return;
  if (name) {
    wrap.style.display = '';
    wrap.querySelector('.custom-hdri-name').textContent = name;
  } else {
    wrap.style.display = 'none';
  }
}

bootstrapHDRI();

// Populate model dropdown
async function populateModels() {
  const select = $('model-select');
  const models = await fetchManifest();
  select.innerHTML = '';
  if (!models.length) {
    select.innerHTML = '<option value="">(no hay GLBs en /models/)</option>';
    // Fall back to a procedural cube so the viewer is never empty
    addProceduralCube();
    return;
  }
  models.forEach((m) => {
    const opt = document.createElement('option');
    const url = typeof m === 'string' ? m : m.url || m.path;
    const label = typeof m === 'string'
      ? m.split('/').pop()
      : (m.name || m.url || m.path).split('/').pop();
    opt.value = url;
    opt.textContent = label;
    select.appendChild(opt);
  });
  const DEFAULT_MODEL = 'Edificio_01_exterior_med_v6.glb';
  const preferred = Array.from(select.options).find(
    (o) => o.textContent === DEFAULT_MODEL || o.value.endsWith('/' + DEFAULT_MODEL)
  );
  select.value = preferred ? preferred.value : select.options[0].value;
  loadModel(select.value);
}

function addProceduralCube() {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshStandardMaterial({ color: 0x6688aa, metalness: 0.3, roughness: 0.4 });
  const cube = new THREE.Mesh(geo, mat);
  cube.castShadow = cube.receiveShadow = true;
  scene.add(cube);
  currentModel = cube;
  frameObject(cube, camera, controls);
  $('filesize').textContent = '— (procedural)';
  $('loadtime').textContent = '0 ms';
  $('tris').textContent = '12';
}

async function loadModel(url) {
  if (!url) return;
  showLoading(true);
  try {
    if (currentModel) {
      disposeBVH(currentModel);
      scene.remove(currentModel);
      disposeObject(currentModel);
      currentModel = null;
    }
    isolatedUuid = null;
    const isolateRow = $('isolate-row');
    if (isolateRow) isolateRow.style.display = 'none';

    const { gltf, bytes, ms } = await loadGLBWithStats(loader, url);
    const root = gltf.scene || gltf.scenes[0];
    enableShadows(root);
    applyAnisotropy(root, renderer, anisoValue);
    const bvh = setupBVH(root);
    scene.add(root);
    currentModel = root;
    currentGLTF = gltf;
    fpsController.setCollisionRoot(root);
    if (bvh.available) console.log(`[lab] BVH built for ${bvh.meshes} meshes`);
    currentModelUrl = url;
    refreshWaypoints();
    window.__currentModel = root;
    window.__currentGLTF = gltf;
    frameObject(root, camera, controls);

    // Stats
    $('filesize').textContent = formatBytes(bytes);
    $('loadtime').textContent = ms.toFixed(0) + ' ms';
    $('tris').textContent = countTriangles(root).toLocaleString();
    const vram = calculateVRAM(root);
    $('tex-count').textContent = vram.count.toString();
    $('vram').textContent = formatBytes(vram.bytes);

    // Materials inspector
    currentMaterials = getMaterialsInfo(root);
    window.__materials = currentMaterials;
    renderMaterialsList();

    // Extensions panel
    renderExtensions(getExtensions(gltf));

    // Re-apply wireframe global if it was on.
    if ($('toggle-wireframe-all')?.checked) setWireframe(root, null, true);
  } catch (err) {
    console.error('[lab] load failed:', err);
    alert('Error cargando modelo: ' + err.message);
  } finally {
    showLoading(false);
  }
}

// ────────────────────────────────────────────────────────────────────
// Material Inspector rendering
// ────────────────────────────────────────────────────────────────────
function renderMaterialsList() {
  const container = $('materials-list');
  const countBadge = $('mat-count');
  if (!container) return;
  if (countBadge) countBadge.textContent = currentMaterials.length.toString();
  container.innerHTML = '';
  currentMaterials.forEach((info) => {
    const item = document.createElement('div');
    item.className = 'material-item';
    item.dataset.uuid = info.uuid;
    if (isolatedUuid === info.uuid) item.classList.add('isolated');

    const swatch = info.baseColor
      ? `<span class="color-swatch" style="background:rgb(${Math.round(info.baseColor[0]*255)},${Math.round(info.baseColor[1]*255)},${Math.round(info.baseColor[2]*255)})"></span>`
      : '';

    const exts = [];
    if (info.transmission != null) exts.push(`KHR_materials_transmission (${info.transmission.toFixed(2)})`);
    if (info.ior != null && info.ior !== 1.5) exts.push(`KHR_materials_ior (${info.ior.toFixed(2)})`);
    if (info.thickness != null && info.thickness > 0) exts.push(`KHR_materials_volume (thickness ${info.thickness.toFixed(2)})`);
    if (info.specularIntensity != null && info.specularIntensity !== 1.0) exts.push(`KHR_materials_specular (${info.specularIntensity.toFixed(2)})`);
    if (info.anisotropy != null && info.anisotropy > 0) exts.push(`KHR_materials_anisotropy (${info.anisotropy.toFixed(2)})`);
    if (info.iridescence != null && info.iridescence > 0) exts.push(`KHR_materials_iridescence (${info.iridescence.toFixed(2)})`);
    if (info.clearcoat != null && info.clearcoat > 0) exts.push(`KHR_materials_clearcoat (${info.clearcoat.toFixed(2)})`);
    if (info.sheen != null && info.sheen > 0) exts.push(`KHR_materials_sheen (${info.sheen.toFixed(2)})`);

    const extHtml = exts.map((e) => `<div class="ext">✓ ${e}</div>`).join('');
    const baseColorHex = info.baseColor
      ? '#' + info.baseColor.slice(0, 3).map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')
      : '—';

    item.innerHTML = `
      <div class="material-head">
        <span>${swatch}</span>
        <span class="name">${escapeHtml(info.name)}</span>
        <span class="count">×${info.instances}</span>
      </div>
      <div class="material-body">
        <div class="kv"><span class="k">type</span><span class="v">${info.type}</span></div>
        <div class="kv"><span class="k">alphaMode</span><span class="v">${info.alphaMode}</span></div>
        <div class="kv"><span class="k">baseColor</span><span class="v">${baseColorHex}</span></div>
        ${info.opacity != null && info.opacity < 1 ? `<div class="kv"><span class="k">opacity</span><span class="v">${info.opacity.toFixed(2)}</span></div>` : ''}
        ${info.roughness != null ? `<div class="kv"><span class="k">roughness</span><span class="v">${info.roughness.toFixed(3)}</span></div>` : ''}
        ${info.metalness != null ? `<div class="kv"><span class="k">metalness</span><span class="v">${info.metalness.toFixed(3)}</span></div>` : ''}
        ${info.emissiveIntensity > 0 ? `<div class="kv"><span class="k">emissive</span><span class="v">${info.emissiveIntensity.toFixed(2)}</span></div>` : ''}
        ${info.textures.length ? `<div class="kv"><span class="k">textures</span><span class="v">${info.textures.length} (${info.textures.join(', ')})</span></div>` : ''}
        ${extHtml}
        <div class="material-actions">
          <button data-action="isolate">${isolatedUuid === info.uuid ? '✓ Aislado' : 'Aislar'}</button>
          <button data-action="wireframe">${info.ref?.wireframe ? '✓ Wire' : 'Wire'}</button>
        </div>
      </div>
    `;

    item.querySelector('.material-head').addEventListener('click', () => {
      item.classList.toggle('expanded');
    });

    item.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const action = btn.dataset.action;
        if (action === 'isolate') {
          if (isolatedUuid === info.uuid) {
            isolatedUuid = null;
            isolateMaterial(currentModel, null);
          } else {
            isolatedUuid = info.uuid;
            isolateMaterial(currentModel, info.uuid);
          }
          const isolateRow = $('isolate-row');
          if (isolateRow) isolateRow.style.display = isolatedUuid ? 'flex' : 'none';
          renderMaterialsList();
        } else if (action === 'wireframe') {
          const newVal = !info.ref.wireframe;
          setWireframe(currentModel, info.uuid, newVal);
          renderMaterialsList();
        }
      });
    });

    container.appendChild(item);
  });
}

// Extensions natively supported by THREE.GLTFLoader in r184. These get a ✓
// even when declared as `extensionsRequired` because three.js will apply them.
const NATIVELY_SUPPORTED_EXTENSIONS = new Set([
  'KHR_draco_mesh_compression',
  'KHR_lights_punctual',
  'KHR_materials_anisotropy',
  'KHR_materials_clearcoat',
  'KHR_materials_dispersion',
  'KHR_materials_emissive_strength',
  'KHR_materials_ior',
  'KHR_materials_iridescence',
  'KHR_materials_pbrSpecularGlossiness',
  'KHR_materials_sheen',
  'KHR_materials_specular',
  'KHR_materials_transmission',
  'KHR_materials_unlit',
  'KHR_materials_volume',
  'KHR_mesh_quantization',
  'KHR_texture_basisu',
  'KHR_texture_transform',
  'KHR_xmp_json_ld',
  'EXT_meshopt_compression',
  'EXT_texture_webp',
  'EXT_texture_avif',
]);

function renderExtensions({ used, required }) {
  const container = $('extensions-list');
  const badge = $('ext-count');
  if (!container) return;
  const total = used.length;
  if (badge) badge.textContent = total.toString();
  if (!total && !required.length) {
    container.innerHTML = '<em class="hint">No hay extensiones declaradas.</em>';
    return;
  }
  const requiredSet = new Set(required);
  // ext-item with class:
  //   .supported   → green ✓ (three.js applies it)
  //   .required    → orange ! (declared required AND not natively supported)
  //   (default)    → blue ✓ used but not required
  const renderItem = (e) => {
    const supported = NATIVELY_SUPPORTED_EXTENSIONS.has(e);
    const isRequired = requiredSet.has(e);
    const cls = supported ? 'supported' : (isRequired ? 'required' : '');
    const tag = isRequired
      ? (supported ? '<small>(required · soportado)</small>' : '<small>(required · NO soportado)</small>')
      : '';
    return `<div class="ext-item ${cls}">${escapeHtml(e)} ${tag}</div>`;
  };
  const usedHtml = used.map(renderItem).join('');
  // Items required-but-not-in-used (rare but possible)
  const orphanRequired = required.filter((e) => !used.includes(e));
  container.innerHTML = `
    <div class="group">
      <div class="group-title">Used (${used.length})</div>
      ${usedHtml}
    </div>
    ${orphanRequired.length ? `<div class="group"><div class="group-title">Required only (${orphanRequired.length})</div>${orphanRequired.map(renderItem).join('')}</div>` : ''}
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function disposeObject(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => {
        for (const k in m) if (m[k]?.isTexture) m[k].dispose();
        m.dispose();
      });
    }
  });
}

function showLoading(on) {
  $('loading').classList.toggle('hidden', !on);
}

// HUD wiring
$('model-select').addEventListener('change', (e) => loadModel(e.target.value));
$('load-external').addEventListener('click', () => {
  const v = $('external-url').value.trim();
  if (v) loadModel(v);
});
$('toggle-hdri').addEventListener('change', (e) => {
  if (e.target.checked && envTex) {
    scene.environment = envTex;
    scene.background = envTex;
  } else {
    scene.environment = null;
    scene.background = null;
  }
});
$('toggle-shadows').addEventListener('change', (e) => {
  contactShadows.visible = e.target.checked;
});
$('toggle-rotate').addEventListener('change', (e) => {
  controls.autoRotate = e.target.checked;
  controls.autoRotateSpeed = 1.2;
});

// HDRI preset dropdown
if (hdriSelect) {
  hdriSelect.addEventListener('change', (e) => applyHDRIPreset(e.target.value));
}

// Tone mapping dropdown
if (tonemapSel) {
  tonemapSel.addEventListener('change', (e) => {
    const id = e.target.value;
    renderer.toneMapping = TONEMAP_BY_ID[id] ?? THREE.ACESFilmicToneMapping;
    // Tone mapping change requires materials to recompile their shaders.
    if (currentModel) {
      currentModel.traverse((o) => {
        if (o.isMesh && o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach((m) => { m.needsUpdate = true; });
        }
      });
    }
    ls.set('tonemap', id);
  });
}

// Exposure slider
if (expoSlider) {
  expoSlider.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    renderer.toneMappingExposure = v;
    if (expoOut) expoOut.textContent = v.toFixed(2);
    ls.set('exposure', v);
  });
}

// Env intensity slider
if (envSlider) {
  envSlider.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    scene.environmentIntensity = v;
    window.__envIntensity = v;
    if (envOut) envOut.textContent = v.toFixed(2);
    ls.set('envIntensity', v);
  });
}

// ────────────────────────────────────────────────────────────────────
// Sun controls (intensity / azimut / elevation / on-off)
// ────────────────────────────────────────────────────────────────────
const sunOnEl     = $('sun-on');
const sunIntEl    = $('sun-intensity');
const sunIntOut   = $('sun-intensity-val');
const sunAzEl     = $('sun-azimut');
const sunAzOut    = $('sun-azimut-val');
const sunElEl     = $('sun-elevation');
const sunElOut    = $('sun-elevation-val');

function syncSunUI() {
  const v = window.__visualState.sun;
  if (sunOnEl)   sunOnEl.checked = v.on;
  if (sunIntEl)  { sunIntEl.value = v.intensity;  if (sunIntOut) sunIntOut.textContent = v.intensity.toFixed(2); }
  if (sunAzEl)   { sunAzEl.value  = v.azimut;     if (sunAzOut)  sunAzOut.textContent  = `${v.azimut|0}°`; }
  if (sunElEl)   { sunElEl.value  = v.elevation;  if (sunElOut)  sunElOut.textContent  = `${v.elevation|0}°`; }
}
syncSunUI();

function applySun() {
  const v = window.__visualState.sun;
  sun.visible = v.on;
  sun.intensity = v.intensity;
  setSunDirection(sun, v.azimut, v.elevation, 30);
}

if (sunOnEl) {
  sunOnEl.addEventListener('change', (e) => {
    window.__visualState.sun.on = e.target.checked;
    ls.set('sun_on', e.target.checked);
    applySun();
  });
}
if (sunIntEl) {
  sunIntEl.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    window.__visualState.sun.intensity = v;
    ls.set('sun_intensity', v);
    if (sunIntOut) sunIntOut.textContent = v.toFixed(2);
    applySun();
  });
}
if (sunAzEl) {
  sunAzEl.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    window.__visualState.sun.azimut = v;
    ls.set('sun_azimut', v);
    if (sunAzOut) sunAzOut.textContent = `${v|0}°`;
    applySun();
  });
}
if (sunElEl) {
  sunElEl.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    window.__visualState.sun.elevation = v;
    ls.set('sun_elevation', v);
    if (sunElOut) sunElOut.textContent = `${v|0}°`;
    applySun();
  });
}

// ────────────────────────────────────────────────────────────────────
// Hour-of-day → sun simulation (Chile / hemisferio sur, ~lat -33°, equinoccio).
// One-way binding: hour drives sun. Manual sliders coexist (clear hour mode
// when touched), so the UI stays consistent.
// ────────────────────────────────────────────────────────────────────
// [hour, azimut°, elev°, sunIntensity, envIntensity, sunColorHex]
const SUN_SCHEDULE = [
  [ 0,    0,  -35, 0.00, 0.04, '#111133'],
  [ 5,   68,   -8, 0.00, 0.07, '#221133'],
  [ 6,   80,    3, 0.50, 0.25, '#ff7722'],
  [ 7,   95,   16, 0.85, 0.50, '#ffaa55'],
  [ 8,  112,   30, 1.05, 0.72, '#ffd080'],
  [ 9,  130,   43, 1.20, 0.88, '#fff0c0'],
  [10,  150,   53, 1.30, 0.97, '#ffffff'],
  [11,  167,   59, 1.30, 1.05, '#ffffff'],
  [12,  180,   62, 1.25, 1.10, '#ffffff'],
  [13,  193,   59, 1.25, 1.05, '#ffffff'],
  [14,  212,   53, 1.20, 0.97, '#fff8ee'],
  [15,  230,   43, 1.10, 0.88, '#ffe8c0'],
  [16,  248,   30, 0.95, 0.72, '#ffcc80'],
  [17,  264,   16, 0.75, 0.50, '#ff9944'],
  [18,  278,    3, 0.45, 0.25, '#ff5511'],
  [19,  288,   -8, 0.00, 0.08, '#221133'],
  [20,  300,  -20, 0.00, 0.05, '#111133'],
  [24,  360,  -35, 0.00, 0.04, '#111133'],
];

function _expandHex(h) {
  h = h.replace('#', '');
  return h.length === 3 ? `${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}` : h;
}
function _lerpHexColor(hex1, hex2, t) {
  const a = _expandHex(hex1), b = _expandHex(hex2);
  const r1 = parseInt(a.slice(0, 2), 16), g1 = parseInt(a.slice(2, 4), 16), b1 = parseInt(a.slice(4, 6), 16);
  const r2 = parseInt(b.slice(0, 2), 16), g2 = parseInt(b.slice(2, 4), 16), b2_ = parseInt(b.slice(4, 6), 16);
  return ((Math.round(r1 + (r2 - r1) * t) << 16) | (Math.round(g1 + (g2 - g1) * t) << 8) | Math.round(b1 + (b2_ - b1) * t));
}

function getSunParams(hour) {
  const h = ((hour % 24) + 24) % 24;
  let lo = SUN_SCHEDULE[0];
  let hi = SUN_SCHEDULE[SUN_SCHEDULE.length - 1];
  for (let i = 0; i < SUN_SCHEDULE.length - 1; i++) {
    if (SUN_SCHEDULE[i][0] <= h && h < SUN_SCHEDULE[i + 1][0]) {
      lo = SUN_SCHEDULE[i]; hi = SUN_SCHEDULE[i + 1]; break;
    }
  }
  const span = hi[0] - lo[0];
  const t = span === 0 ? 0 : (h - lo[0]) / span;
  const lerp = (a, b) => a + (b - a) * t;
  const elevation = lerp(lo[2], hi[2]);
  return {
    azimut:       lerp(lo[1], hi[1]),
    elevation,
    sunIntensity: Math.max(0, lerp(lo[3], hi[3])),
    envIntensity: lerp(lo[4], hi[4]),
    sunColor:     _lerpHexColor(lo[5], hi[5], t),
    isNight:      elevation <= 0,
    isGoldenHour: (h >= 5.5 && h <= 7.5) || (h >= 17 && h <= 19),
  };
}

function _setSliderQuiet(el, valueText, value) {
  if (!el) return;
  if (value !== undefined) el.value = value;
  // Also update the linked <output> if it's the next sibling-ish.
  const out = el.parentElement?.querySelector('output');
  if (out && valueText !== undefined) out.textContent = valueText;
}

function applySunHour(hour) {
  const p = getSunParams(hour);

  // Sun direction + intensity + color + visibility
  const v = window.__visualState?.sun;
  if (v) {
    v.azimut = p.azimut;
    v.elevation = p.elevation;
    v.intensity = p.sunIntensity;
    v.on = !p.isNight;
  }
  setSunDirection(sun, p.azimut, p.elevation, 30);
  sun.intensity = p.sunIntensity;
  sun.color.setHex(p.sunColor);
  sun.visible = !p.isNight;

  // HDRI environment intensity follows the sky brightness curve.
  scene.environmentIntensity = p.envIntensity;
  window.__envIntensity = p.envIntensity;

  // Ambient color shifts with time of day (cool at night, warm at golden hour).
  if (ambient) {
    if (p.isNight) {
      ambient.color.setHex(0x223355); ambient.intensity = 0.08;
    } else if (p.isGoldenHour) {
      ambient.color.setHex(0xff8833); ambient.intensity = 0.12;
    } else {
      ambient.color.setHex(0xc8d8e0); ambient.intensity = 0.15;
    }
  }

  // Mirror the per-component sliders WITHOUT firing input events.
  _setSliderQuiet(sunOnEl,    undefined, undefined);
  if (sunOnEl)   sunOnEl.checked = !p.isNight;
  _setSliderQuiet(sunIntEl,   p.sunIntensity.toFixed(2), p.sunIntensity);
  _setSliderQuiet(sunAzEl,    `${p.azimut|0}°`,           p.azimut);
  _setSliderQuiet(sunElEl,    `${p.elevation|0}°`,        p.elevation);
  _setSliderQuiet(envSlider,  p.envIntensity.toFixed(2),  p.envIntensity);

  ls.set('sun_hour', hour);
  ls.set('sun_hour_active', true);

  // If any env panel is open, push the same hour to its sun.
  // Defined later in the file — guard for hoist order.
  try { if (typeof _envHandle    !== 'undefined') _envHandle?.setSunHour?.(hour); } catch {}
  try { if (typeof _envHandleG3d !== 'undefined') _envHandleG3d?.setSunHour?.(hour); } catch {}
}

function updateSunHourDisplay(hour) {
  const display = $('sun-hour-display');
  if (!display) return;
  const h = Math.floor(hour);
  const m = Math.round((hour % 1) * 60);
  display.textContent = `${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// Hour slider events
const hourSlider = $('sun-hour-slider');
if (hourSlider) {
  const initialHour = ls.get('sun_hour', 12);
  hourSlider.value = initialHour;
  updateSunHourDisplay(initialHour);
  // Apply only if user has been using hour mode (otherwise respect their manual sliders).
  if (ls.get('sun_hour_active', false)) applySunHour(initialHour);
  hourSlider.addEventListener('input', (e) => {
    if (sunAnimFrame) toggleSunAnimation(); // stop anim if user grabs the slider
    const h = parseFloat(e.target.value);
    updateSunHourDisplay(h);
    applySunHour(h);
  });
}

// When the user manually moves az/el/int sliders, exit hour mode so refresh
// won't override their manual settings.
[sunIntEl, sunAzEl, sunElEl].forEach((el) => {
  el?.addEventListener('input', () => ls.set('sun_hour_active', false));
});

// Animation loop: full day in ~19 s (1 hour every 800 ms).
let sunAnimFrame = null;
let sunAnimHour = 5;

function toggleSunAnimation() {
  const btn = $('sun-animate-btn');
  if (sunAnimFrame) {
    cancelAnimationFrame(sunAnimFrame);
    sunAnimFrame = null;
    if (btn) { btn.textContent = '▶ Animar día'; btn.classList.remove('playing'); }
    return;
  }
  if (!btn || !hourSlider) return;
  const HOURS_PER_MS = 1 / 800;
  let lastT = null;
  btn.textContent = '⏸ Pausar';
  btn.classList.add('playing');
  sunAnimHour = parseFloat(hourSlider.value) || 5;
  function tick(ts) {
    if (lastT === null) lastT = ts;
    const dt = ts - lastT;
    lastT = ts;
    sunAnimHour = (sunAnimHour + dt * HOURS_PER_MS) % 24;
    hourSlider.value = sunAnimHour;
    updateSunHourDisplay(sunAnimHour);
    applySunHour(sunAnimHour);
    sunAnimFrame = requestAnimationFrame(tick);
  }
  sunAnimFrame = requestAnimationFrame(tick);
}
$('sun-animate-btn')?.addEventListener('click', toggleSunAnimation);

// ────────────────────────────────────────────────────────────────────
// VISUAL panel: presets + SSAO + Bloom + Contrast
// ────────────────────────────────────────────────────────────────────
const ssaoOnEl    = $('ssao-on');
const ssaoIntEl   = $('ssao-intensity');
const ssaoIntOut  = $('ssao-intensity-val');
const bloomOnEl   = $('bloom-on');
const bloomIntEl  = $('bloom-intensity');
const bloomIntOut = $('bloom-intensity-val');
const contrastEl  = $('contrast');
const contrastOut = $('contrast-val');

function syncVisualUI() {
  const v = window.__visualState;
  if (ssaoOnEl)   ssaoOnEl.checked  = v.ssao.on;
  if (ssaoIntEl)  { ssaoIntEl.value = v.ssao.intensity;  if (ssaoIntOut) ssaoIntOut.textContent = String(v.ssao.intensity|0); }
  if (bloomOnEl)  bloomOnEl.checked = v.bloom.on;
  if (bloomIntEl) { bloomIntEl.value = v.bloom.intensity; if (bloomIntOut) bloomIntOut.textContent = v.bloom.intensity.toFixed(2); }
  if (contrastEl) { contrastEl.value = v.contrast; if (contrastOut) contrastOut.textContent = v.contrast.toFixed(2); }
  document.querySelectorAll('#visual-presets .pill').forEach((b) => {
    b.classList.toggle('active', b.dataset.preset === v.preset);
  });
}
syncVisualUI();

function applyVisual() {
  const v = window.__visualState;
  if (postfx) {
    postfx.setSSAO(v.ssao.on, v.ssao.intensity);
    postfx.setBloom(v.bloom.on, v.bloom.intensity);
    postfx.setContrast(v.contrast);
  }
}

if (ssaoOnEl) {
  ssaoOnEl.addEventListener('change', (e) => {
    window.__visualState.ssao.on = e.target.checked;
    ls.set('ssao_on', e.target.checked);
    applyVisual();
  });
}
if (ssaoIntEl) {
  ssaoIntEl.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    window.__visualState.ssao.intensity = v;
    ls.set('ssao_intensity', v);
    if (ssaoIntOut) ssaoIntOut.textContent = String(v|0);
    applyVisual();
  });
}
if (bloomOnEl) {
  bloomOnEl.addEventListener('change', (e) => {
    window.__visualState.bloom.on = e.target.checked;
    ls.set('bloom_on', e.target.checked);
    applyVisual();
  });
}
if (bloomIntEl) {
  bloomIntEl.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    window.__visualState.bloom.intensity = v;
    ls.set('bloom_intensity', v);
    if (bloomIntOut) bloomIntOut.textContent = v.toFixed(2);
    applyVisual();
  });
}
if (contrastEl) {
  contrastEl.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    window.__visualState.contrast = v;
    ls.set('contrast', v);
    if (contrastOut) contrastOut.textContent = v.toFixed(2);
    applyVisual();
  });
}

// Visual presets — apply combinations all at once, sync everything.
const VISUAL_PRESETS = {
  plano: {
    ssao:  { on: false, intensity: 0 },
    bloom: { on: false, intensity: 0 },
    contrast: 0.0,
    exposure: 1.00,
    envIntensity: 0.75,
    sun: { on: true, intensity: 1.5, azimut: 45, elevation: 55 },
    tonemap: 'aces',
  },
  estandar: {
    ssao:  { on: true, intensity: 20 },
    bloom: { on: true, intensity: 0.30 },
    contrast: 0.10,
    exposure: 1.15,
    envIntensity: 1.20,
    sun: { on: true, intensity: 1.5, azimut: 45, elevation: 55 },
    tonemap: DEFAULT_TONEMAP,
  },
  cinematic: {
    ssao:  { on: true, intensity: 35 },
    bloom: { on: true, intensity: 0.50 },
    contrast: 0.20,
    exposure: 1.25,
    envIntensity: 1.40,
    sun: { on: true, intensity: 2.0, azimut: 45, elevation: 55 },
    tonemap: HAS_AGX ? 'agx' : 'aces',
  },
};

function applyPreset(id) {
  const p = VISUAL_PRESETS[id];
  if (!p) return;
  const v = window.__visualState;
  v.preset = id;
  v.ssao = { ...p.ssao };
  v.bloom = { ...p.bloom };
  v.contrast = p.contrast;
  v.sun = { ...p.sun };
  // Apply the iluminación-side values too.
  renderer.toneMappingExposure = p.exposure;
  scene.environmentIntensity = p.envIntensity;
  window.__envIntensity = p.envIntensity;
  renderer.toneMapping = TONEMAP_BY_ID[p.tonemap] ?? THREE.ACESFilmicToneMapping;
  // Persist everything individually.
  ls.set('visual_preset', id);
  ls.set('ssao_on', v.ssao.on);
  ls.set('ssao_intensity', v.ssao.intensity);
  ls.set('bloom_on', v.bloom.on);
  ls.set('bloom_intensity', v.bloom.intensity);
  ls.set('contrast', v.contrast);
  ls.set('exposure', p.exposure);
  ls.set('envIntensity', p.envIntensity);
  ls.set('tonemap', p.tonemap);
  ls.set('sun_on', v.sun.on);
  ls.set('sun_intensity', v.sun.intensity);
  ls.set('sun_azimut', v.sun.azimut);
  ls.set('sun_elevation', v.sun.elevation);
  // Sync exposure/env sliders + tonemap select.
  if (expoSlider) { expoSlider.value = p.exposure; if (expoOut) expoOut.textContent = p.exposure.toFixed(2); }
  if (envSlider)  { envSlider.value  = p.envIntensity; if (envOut) envOut.textContent  = p.envIntensity.toFixed(2); }
  if (tonemapSel) tonemapSel.value = p.tonemap;
  // Materials need needsUpdate=true after tone-mapping change.
  if (currentModel) {
    currentModel.traverse((o) => {
      if (o.isMesh && o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => { m.needsUpdate = true; });
      }
    });
  }
  applySun();
  applyVisual();
  syncSunUI();
  syncVisualUI();
}

document.querySelectorAll('#visual-presets .pill').forEach((btn) => {
  btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
});

// ────────────────────────────────────────────────────────────────────
// Auto-calibrate: analyze model albedo + active HDRI → set sliders to a
// "no-mistakes" baseline. Not a final look, just a smart starting point.
// ────────────────────────────────────────────────────────────────────

// HDRI light direction + scene-type lookup. Eyeballed from the actual .hdr
// files in /hdri/. `kind: 'exterior'` means the HDRI already provides strong
// directional outdoor light (sun, sky), so the directional sun should NOT
// stack on top — Auto caps its intensity at 1.0 to avoid burning façades.
const HDRI_INFO = {
  street:     { azimut: 200, elevation: 35, kind: 'exterior' }, // late afternoon, sun west-ish
  kloofendal: { azimut: 240, elevation: 45, kind: 'exterior' }, // late afternoon, sun behind/right
  studio:     { azimut: 135, elevation: 55, kind: 'studio'   }, // even softboxes
  sunset:     { azimut: 270, elevation: 12, kind: 'exterior' }, // sun very low, west
  indoor:     { azimut: 90,  elevation: 75, kind: 'interior' }, // skylight from above
  overcast:   { azimut: 135, elevation: 70, kind: 'exterior' }, // diffuse, near-zenith
};

function detectHDRIInfo() {
  const id = ls.get('hdri', DEFAULT_HDRI_ID);
  return HDRI_INFO[id] || { azimut: 135, elevation: 50, kind: 'unknown' };
}

// 4-tier sun intensity curve (more granular than the previous 2-tier).
// Same intent: brighter scenes get less sun (no façade burn), darker scenes
// more (volume definition).
function computeAutoSunIntensity(albedo) {
  if (albedo > 0.75) return 0.85;
  if (albedo > 0.55) return 1.10;
  if (albedo < 0.35) return 1.40;
  return 1.20;
}

function computeAutoExposure(albedo) {
  if (albedo > 0.75) return 0.95; // mostly white → don't blow highlights
  if (albedo < 0.35) return 1.30; // dark model → boost
  return 1.10;
}

function computeAutoBloom(albedo) {
  if (albedo > 0.75) return 0.08; // white already feels bright, keep bloom subtle
  if (albedo < 0.35) return 0.25;
  return 0.15;
}

function flashAutoBtn() {
  const btn = $('btn-auto-calibrate');
  if (!btn) return;
  btn.classList.add('flash');
  setTimeout(() => btn.classList.remove('flash'), 700);
}

function showAutoHint(text) {
  const el = $('auto-hint');
  if (!el) return;
  el.textContent = text;
  el.style.display = '';
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => { el.style.display = 'none'; }, 3500);
}

function autoCalibrate() {
  if (!currentModel) {
    showAutoHint('No hay modelo cargado todavía.');
    return;
  }
  const t0 = performance.now();
  // Use p75 (75th percentile) instead of mean — ignores the darkest 25% of
  // materials (floors, trims, dark furniture) so a mostly-white façade reads
  // as white even with a few gray tile patches dragging the mean down.
  const albedoStats = analyzeModelAlbedo(currentModel);
  const { albedoP75, albedoMean, opaqueMaterials, transparentMaterials } = albedoStats;
  const albedo = albedoP75;
  const hdri = detectHDRIInfo();
  const lightDir = { azimut: hdri.azimut, elevation: hdri.elevation };
  const tone = HAS_AGX ? 'agx' : 'aces';

  const exposure = computeAutoExposure(albedo);
  const envIntensity = albedo > 0.75 ? 0.90 : 1.10;
  // Sun intensity baseline by albedo; capped at 1.0 when the HDRI is exterior
  // (it already contributes strong directional sun light → don't stack).
  let sunIntensity = computeAutoSunIntensity(albedo);
  // Exterior HDRI already provides strong directional sun light → cap so we
  // don't stack and burn façades.
  if (hdri.kind === 'exterior') sunIntensity = Math.min(sunIntensity, 1.0);
  const bloomIntensity = computeAutoBloom(albedo);
  const contrast = albedo > 0.75 ? 0.15 : 0.10;
  const ssaoIntensity = 22;

  // Apply renderer-side
  renderer.toneMapping = TONEMAP_BY_ID[tone];
  renderer.toneMappingExposure = exposure;
  scene.environmentIntensity = envIntensity;
  window.__envIntensity = envIntensity;
  // Force material recompile for tone-mapping change.
  currentModel.traverse((o) => {
    if (o.isMesh && o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => { m.needsUpdate = true; });
    }
  });

  // Update visual state + persist
  const v = window.__visualState;
  v.sun = { on: true, intensity: sunIntensity, azimut: lightDir.azimut, elevation: lightDir.elevation };
  v.ssao = { on: true, intensity: ssaoIntensity };
  v.bloom = { on: true, intensity: bloomIntensity };
  v.contrast = contrast;
  ls.set('exposure', exposure);
  ls.set('envIntensity', envIntensity);
  ls.set('tonemap', tone);
  ls.set('sun_on', true);
  ls.set('sun_intensity', sunIntensity);
  ls.set('sun_azimut', lightDir.azimut);
  ls.set('sun_elevation', lightDir.elevation);
  ls.set('ssao_on', true);
  ls.set('ssao_intensity', ssaoIntensity);
  ls.set('bloom_on', true);
  ls.set('bloom_intensity', bloomIntensity);
  ls.set('contrast', contrast);

  // Apply scene-side
  applySun();
  applyVisual();
  syncSunUI();
  syncVisualUI();
  // Sync the iluminación sliders/select too
  if (expoSlider) { expoSlider.value = exposure; if (expoOut) expoOut.textContent = exposure.toFixed(2); }
  if (envSlider)  { envSlider.value  = envIntensity; if (envOut) envOut.textContent  = envIntensity.toFixed(2); }
  if (tonemapSel) tonemapSel.value = tone;

  // Respect hour mode: if the user has been driving the sun via the hour slider,
  // apply the current hour LAST so its sun position/color override the heuristic.
  if (ls.get('sun_hour_active', false)) {
    const hour = ls.get('sun_hour', 12);
    if (hourSlider) hourSlider.value = hour;
    updateSunHourDisplay(hour);
    applySunHour(hour);
  }

  const ms = (performance.now() - t0).toFixed(0);
  const tone_label = albedo > 0.75 ? 'blanco' : albedo < 0.35 ? 'oscuro' : 'mixto';
  const cappedNote = (hdri.kind === 'exterior' && (albedoP75 < 0.75)) ? ' (sol cap exterior)' : '';
  flashAutoBtn();
  showAutoHint(
    `Auto: p75 ${(albedoP75 * 100).toFixed(0)}% (${tone_label}, μ ${(albedoMean * 100).toFixed(0)}%) · ` +
    `${opaqueMaterials} mats opacos${transparentMaterials ? ' + ' + transparentMaterials + ' transp' : ''} · ` +
    `HDRI ${hdri.kind}${cappedNote} · sol ${lightDir.azimut|0}°/${lightDir.elevation|0}° int ${sunIntensity.toFixed(1)} · ${ms}ms`
  );
  console.log('[lab] auto-calibrate', {
    albedoP75, albedoMean, hdriKind: hdri.kind, lightDir,
    exposure, envIntensity, sunIntensity, bloomIntensity, contrast, ms,
  });
}

window.__autoCalibrate = autoCalibrate;

$('btn-auto-calibrate')?.addEventListener('click', autoCalibrate);

// Wireframe global toggle
const wireAll = $('toggle-wireframe-all');
if (wireAll) {
  wireAll.addEventListener('change', (e) => {
    if (currentModel) setWireframe(currentModel, null, e.target.checked);
    renderMaterialsList();
  });
}

// Restore isolation
const isolateClearBtn = $('btn-isolate-clear');
if (isolateClearBtn) {
  isolateClearBtn.addEventListener('click', () => {
    isolatedUuid = null;
    if (currentModel) isolateMaterial(currentModel, null);
    const row = $('isolate-row');
    if (row) row.style.display = 'none';
    renderMaterialsList();
  });
}

// ────────────────────────────────────────────────────────────────────
// Navigation panel wiring (Exterior / Interior toggle, FPS controls)
// ────────────────────────────────────────────────────────────────────
document.querySelectorAll('input[name="nav-mode"]').forEach((input) => {
  input.addEventListener('change', (e) => {
    if (e.target.checked) setNavMode(e.target.value);
  });
});

const navSpeedInput = $('nav-speed');
const navSpeedOut = $('nav-speed-val');
if (navSpeedInput) {
  navSpeedInput.value = persistedNavSpeed;
  if (navSpeedOut) navSpeedOut.textContent = persistedNavSpeed.toFixed(1);
  navSpeedInput.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    fpsController.setSpeed(v);
    if (navSpeedOut) navSpeedOut.textContent = v.toFixed(1);
    ls.set('navSpeed', v);
  });
}

const eyeHeightInput = $('nav-eye-height');
const eyeHeightOut = $('nav-eye-height-val');
if (eyeHeightInput) {
  eyeHeightInput.value = persistedEyeHeight;
  if (eyeHeightOut) eyeHeightOut.textContent = persistedEyeHeight.toFixed(2);
  eyeHeightInput.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    fpsController.setEyeHeight(v);
    if (eyeHeightOut) eyeHeightOut.textContent = v.toFixed(2);
    ls.set('navEyeHeight', v);
  });
}

const navGravity = $('nav-gravity');
if (navGravity) {
  navGravity.checked = persistedGravity;
  navGravity.addEventListener('change', (e) => {
    fpsController.setGravity(e.target.checked);
    ls.set('navGravity', e.target.checked);
  });
}

const enterBtn = $('btn-enter-model');
if (enterBtn) {
  enterBtn.addEventListener('click', () => {
    if (!currentModel) return;
    setNavMode('fps', { fromUser: false });
    // Defer one tick so the FPS controller is fully enabled before lock+pose.
    requestAnimationFrame(() => fpsController.enterModel(currentModel, { lockPointer: true }));
  });
}

// Keyboard shortcuts: E = exterior, I = interior. Don't fire from inputs.
window.addEventListener('keydown', (e) => {
  const tag = (e.target?.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'e' || e.key === 'E') setNavMode('orbit');
  else if (e.key === 'i' || e.key === 'I') setNavMode('fps');
});

// Apply persisted nav mode AFTER first model loads so collision root is set.
// (We can't be in FPS without a model, so guard inside loadModel completion.)
const _origPopulate = populateModels;
async function populateModelsAndApplyNav() {
  await _origPopulate();
  if (persistedNavMode === 'fps' && currentModel) {
    setNavMode('fps', { fromUser: false });
  }
}
// Note: populateModels is already invoked above. We don't re-run it here;
// instead, we apply persisted FPS mode lazily once model is in place.
// Hook into loadModel completion via a one-shot watcher:
let _navInitialized = false;
const _checkNavInit = () => {
  if (_navInitialized || !currentModel) return;
  _navInitialized = true;
  if (persistedNavMode === 'fps') setNavMode('fps', { fromUser: false });
};
const _origAnimate = animate;
// Lightweight: poll once per second until model exists.
const _navPoll = setInterval(() => {
  if (currentModel) { _checkNavInit(); clearInterval(_navPoll); }
}, 250);

// ────────────────────────────────────────────────────────────────────
// Vistas / Waypoints panel wiring (T14 + T15 + Editor)
// ────────────────────────────────────────────────────────────────────

// Model type override
const modelTypeSelect = $('model-type-select');
if (modelTypeSelect) {
  modelTypeSelect.value = modelTypeOverride;
  modelTypeSelect.addEventListener('change', (e) => {
    modelTypeOverride = e.target.value;
    ls.set('modelType', modelTypeOverride);
    if (currentModel) refreshWaypoints();
    // Re-render editor slots — they're scope-dependent (edificio vs unidad).
    if (typeof renderEditorSlots === 'function') renderEditorSlots();
  });
}

// Arrow pad — discrete 0.1 rad rotation per click
const ARROW_STEP = 0.1;
document.querySelectorAll('.arrow-pad button[data-arrow]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (cameraCtrl.isFlying()) cameraCtrl.cancel();
    setAutoRotate(false);
    const a = btn.dataset.arrow;
    if (a === 'up')        rotateOrbit(camera, controls, 0, -ARROW_STEP);
    else if (a === 'down') rotateOrbit(camera, controls, 0,  ARROW_STEP);
    else if (a === 'left') rotateOrbit(camera, controls, -ARROW_STEP, 0);
    else if (a === 'right')rotateOrbit(camera, controls,  ARROW_STEP, 0);
    else if (a === 'reset' && currentModel) {
      const iso = (activeModelType === 'edificio' ? buildingWaypoints : unitWaypoints)
        .find((w) => w.id === 'iso');
      if (iso) goToWaypoint(iso);
    }
  });
});

// AutoRotate toggle
$('btn-autorotate')?.addEventListener('click', () => setAutoRotate(!isAutoRotating));

// Reset buttons (per-section)
$('btn-reset-edificio')?.addEventListener('click', () => {
  if (!currentModel) return;
  const iso = buildingWaypoints.find((w) => w.id === 'iso');
  if (iso) goToWaypoint(iso);
  setAutoRotate(true);
});
$('btn-reset-unidad')?.addEventListener('click', () => {
  if (!currentModel) return;
  const iso = unitWaypoints.find((w) => w.id === 'iso') || unitWaypoints[0];
  if (iso) goToWaypoint(iso);
});

// Keyboard: 1–6 = waypoint, R = reset, Space = pause/play autoRotate
window.addEventListener('keydown', (e) => {
  const tag = (e.target?.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (navMode !== 'orbit' || !currentModel) return;
  const list = activeModelType === 'edificio' ? buildingWaypoints : unitWaypoints;
  if (e.key >= '1' && e.key <= '9') {
    const idx = parseInt(e.key, 10) - 1;
    if (list[idx]) goToWaypoint(list[idx]);
  } else if (e.key === 'r' || e.key === 'R') {
    const iso = list.find((w) => w.id === 'iso') || list[0];
    if (iso) goToWaypoint(iso);
  } else if (e.code === 'Space' && activeModelType === 'edificio') {
    e.preventDefault();
    setAutoRotate(!isAutoRotating);
  }
});

// ── Waypoint editor ──────────────────────────────────────────────
const wpEditMode = $('wp-edit-mode');
const wpSaveSlots = $('wp-save-slots');

function renderEditorSlots() {
  if (!wpSaveSlots) return;
  wpSaveSlots.innerHTML = '';
  if (!wpEditMode?.checked) return;
  const scope = editorScope();
  const slots = getWaypointSlots(scope);
  slots.forEach((slot) => {
    const btn = document.createElement('button');
    btn.textContent = `💾 ${slot.icono} ${slot.label}`;
    btn.title = `Guardar pose actual como ${slot.label}`;
    btn.addEventListener('click', () => {
      if (!currentModelUrl) return;
      // En FPS (interior), controls.target está congelado en el último pivot
      // orbit, así que snapshotPose graba un target inservible. Derivar el
      // target real desde la dirección de la cámara FP (1m hacia adelante).
      let pose;
      if (navMode === 'fps') {
        const _dir = new THREE.Vector3();
        camera.getWorldDirection(_dir);
        const _look = camera.position.clone().add(_dir);
        pose = {
          position: camera.position.toArray().map((v) => +v.toFixed(3)),
          target:   _look.toArray().map((v) => +v.toFixed(3)),
        };
      } else {
        pose = snapshotPose(camera, controls);
      }
      const saved = loadWaypoints(scope, currentModelUrl);
      const next = saved.filter((w) => w.id !== slot.id);
      next.push({ id: slot.id, label: slot.label, icono: slot.icono, ...pose });
      saveWaypoints(scope, currentModelUrl, next);
      refreshWaypoints();
    });
    wpSaveSlots.appendChild(btn);
  });
}

if (wpEditMode) {
  wpEditMode.addEventListener('change', renderEditorSlots);
}

$('wp-copy-json')?.addEventListener('click', async () => {
  const scope = editorScope();
  const saved = loadWaypoints(scope, currentModelUrl);
  if (!saved.length) {
    alert(`No hay waypoints guardados para ${scope === 'edificio' ? 'el edificio' : 'este archivo'}.`);
    return;
  }
  const json = formatWaypointJSON(saved);
  try {
    await navigator.clipboard.writeText(json);
    const btn = $('wp-copy-json');
    const old = btn.textContent;
    btn.textContent = '✓ Copiado';
    setTimeout(() => { btn.textContent = old; }, 1500);
  } catch (err) {
    prompt('Copiá manualmente el JSON:', json);
  }
});

$('wp-clear-all')?.addEventListener('click', () => {
  const scope = editorScope();
  const target = scope === 'edificio' ? 'del edificio' : 'de este archivo';
  if (!confirm(`¿Borrar todos los waypoints guardados ${target}?`)) return;
  clearWaypoints(scope, currentModelUrl);
  refreshWaypoints();
});

// Import button → opens the rich modal (file/paste/drop + preview + normalize).
$('wp-import')?.addEventListener('click', () => openImportModal());

// Custom HDRI upload (also persists to IndexedDB so it survives reloads)
$('btn-hdri').addEventListener('click', () => $('hdri-input').click());
$('hdri-input').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  $('hdri-name').textContent = `Cargando ${file.name}…`;
  try {
    // Read once into ArrayBuffer so we can both render AND persist.
    const arrayBuffer = await file.arrayBuffer();
    envTex = await setCustomHDRI(arrayBuffer, renderer, file.name);
    if ($('toggle-hdri').checked) {
      scene.environment = envTex;
      scene.background = envTex;
    }
    $('hdri-name').textContent = `✓ ${file.name}`;
    try {
      await saveCustomHDRI(arrayBuffer, file.name);
      updateCustomHDRIBadge(file.name);
    } catch (persistErr) {
      console.warn('[lab] HDRI applied but could not persist:', persistErr);
    }
  } catch (err) {
    console.error('[hdri] failed:', err);
    $('hdri-name').textContent = `✗ Error: ${err.message || err}`;
  } finally {
    e.target.value = '';
  }
});

// Clear custom HDRI → revert to currently-selected preset
$('btn-hdri-clear')?.addEventListener('click', async () => {
  await clearCustomHDRI();
  updateCustomHDRIBadge(null);
  applyHDRIPreset(hdriSelect ? hdriSelect.value : DEFAULT_HDRI_ID);
});

// Resize
function resize() {
  const w = host.clientWidth;
  const h = host.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (postfx) postfx.resize();
}
window.addEventListener('resize', resize);
resize();

// FPS counter
let frames = 0;
let lastFpsT = performance.now();
function updateFPS() {
  frames++;
  const now = performance.now();
  if (now - lastFpsT >= 500) {
    const fps = (frames / (now - lastFpsT)) * 1000;
    $('fps').textContent = fps.toFixed(0);
    $('drawcalls').textContent = renderer.info?.render?.calls ?? '—';
    frames = 0;
    lastFpsT = now;
  }
}

let _lastFrameT = performance.now();
function animate() {
  const now = performance.now();
  const delta = Math.min(0.1, (now - _lastFrameT) / 1000); // clamp big jumps (tab switch)
  _lastFrameT = now;
  if (navMode === 'fps') {
    fpsController.update(delta);
  } else {
    if (cameraCtrl.isFlying()) {
      controls.enabled = false;
      cameraCtrl.update();
    } else {
      controls.enabled = true;
      controls.update();
    }
  }
  // Composer when post-fx active (any of SSAO/Bloom/Contrast); otherwise direct render.
  // WebGPURenderer takes the renderAsync path and skips composer entirely.
  if (typeof renderer.renderAsync === 'function') {
    renderer.renderAsync(scene, camera);
  } else if (postfx && postfxActive()) {
    postfx.render();
  } else {
    renderer.render(scene, camera);
  }
  updateUnitLabels();
  updateFPS();
}

function postfxActive() {
  if (!postfx) return false;
  const v = window.__visualState;
  if (!v) return true; // pre-init: default to composer (cheap)
  // Composer always runs SSAO/Bloom/Contrast passes; if all disabled and contrast=0
  // we'd want to bypass to save GPU. With contrast slider != 0 (default 0.10),
  // composer is needed. Plano preset sets contrast=0 + SSAO/Bloom off → bypass.
  return v.ssao.on || v.bloom.on || Math.abs(v.contrast) > 0.001;
}
renderer.setAnimationLoop(animate);

populateModels();

// ────────────────────────────────────────────────────────────────────
// Upload: drag-drop + file picker, autenticado por token en localStorage.
// ────────────────────────────────────────────────────────────────────
const TOKEN_KEY = 'lab_upload_token';
const MAX_UPLOAD_MB = 100;
const ALLOWED_UPLOAD_EXT = ['glb', 'gltf', 'ktx2', 'bin'];

function getToken() {
  let t = localStorage.getItem(TOKEN_KEY);
  if (!t) {
    t = prompt(
      'Token de upload (se pide solo la primera vez, queda guardado en este navegador):'
    );
    if (t) localStorage.setItem(TOKEN_KEY, t.trim());
  }
  return t;
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

function showProgress(name) {
  const el = $('upload-progress');
  el.classList.remove('hidden');
  el.querySelector('.up-name').textContent = name;
  el.querySelector('.up-fill').style.width = '0%';
  const pct = el.querySelector('.up-pct');
  pct.textContent = '0%';
  pct.classList.remove('error', 'ok');
}
function setProgress(p) {
  const el = $('upload-progress');
  el.querySelector('.up-fill').style.width = p + '%';
  el.querySelector('.up-pct').textContent = p.toFixed(0) + '%';
}
function setProgressError(msg) {
  const el = $('upload-progress');
  const pct = el.querySelector('.up-pct');
  pct.textContent = '✗ ' + msg;
  pct.classList.add('error');
  setTimeout(() => el.classList.add('hidden'), 6000);
}
function setProgressOk(name) {
  const el = $('upload-progress');
  const pct = el.querySelector('.up-pct');
  pct.textContent = '✓ subido: ' + name;
  pct.classList.add('ok');
  setTimeout(() => el.classList.add('hidden'), 2000);
}

async function uploadFile(file) {
  // Client-side validations (feedback instantáneo, no esperamos al server)
  const ext = file.name.split('.').pop().toLowerCase();
  if (!ALLOWED_UPLOAD_EXT.includes(ext)) {
    showProgress(file.name);
    setProgressError(`Extensión .${ext} no permitida. Solo ${ALLOWED_UPLOAD_EXT.map(e => '.'+e).join(', ')}.`);
    return;
  }

  const sizeMb = file.size / 1024 / 1024;
  if (sizeMb > MAX_UPLOAD_MB) {
    showProgress(file.name);
    setProgressError(
      `${sizeMb.toFixed(1)} MB excede el límite de ${MAX_UPLOAD_MB} MB. ` +
      `Aplicá Draco/KTX2/decimación antes.`
    );
    return;
  }

  const token = getToken();
  if (!token) return;

  showProgress(file.name);

  const fd = new FormData();
  fd.append('file', file);

  try {
    const result = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', './upload.php');
      xhr.setRequestHeader('X-Upload-Token', token);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setProgress((e.loaded / e.total) * 100);
      };
      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300 && data.ok) resolve(data);
          else reject(new Error(data.error || ('HTTP ' + xhr.status)));
        } catch (e) {
          reject(new Error('Respuesta inválida del servidor'));
        }
      };
      xhr.onerror = () => {
        console.error('[upload] xhr error', { status: xhr.status, statusText: xhr.statusText, responseText: xhr.responseText });
        reject(new Error(`Error de red (status ${xhr.status || '0'}). Mirá la consola.`));
      };
      xhr.ontimeout = () => reject(new Error('Timeout subiendo archivo'));
      xhr.timeout = 120000;
      xhr.send(fd);
    });

    setProgressOk(result.name);

    // Refrescar dropdown y cargar el modelo recién subido
    await populateModels();
    const select = $('model-select');
    for (const opt of select.options) {
      if (opt.value === result.url) {
        select.value = result.url;
        loadModel(result.url);
        break;
      }
    }
  } catch (err) {
    console.error('[upload] failed:', err);
    if (/token|401|inválido/i.test(err.message)) {
      clearToken();
      setProgressError('Token inválido — se borró. Intentá de nuevo.');
    } else {
      setProgressError(err.message);
    }
  }
}

async function uploadFiles(files) {
  for (const f of files) {
    await uploadFile(f);
  }
}

// File picker
const btnUpload = $('btn-upload');
const fileInput = $('file-input');
console.log('[lab] upload init — btn:', !!btnUpload, 'input:', !!fileInput);

if (btnUpload) {
  btnUpload.addEventListener('click', () => {
    console.log('[lab] btn-upload clicked → triggering file picker');
    fileInput.click();
  });
}
if (fileInput) {
  fileInput.addEventListener('change', (e) => {
    console.log('[lab] file-input change, files:', e.target.files.length);
    if (e.target.files.length) uploadFiles(e.target.files);
    e.target.value = ''; // reset
  });
}

// Drag-drop sobre toda la página — sin filtrar tipos, validamos al drop
let dragCounter = 0;
const overlay = $('drop-overlay');

window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  if (overlay) overlay.classList.remove('hidden');
});
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    if (overlay) overlay.classList.add('hidden');
  }
});
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  // Necesario para que el drop funcione
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  console.log('[lab] drop event, files:', e.dataTransfer?.files?.length || 0);
  dragCounter = 0;
  if (overlay) overlay.classList.add('hidden');
  const files = e.dataTransfer?.files;
  if (files && files.length) uploadFiles(files);
});

// ────────────────────────────────────────────────────────────────────
// Model manager (delete) — abre modal con lista de GLBs en /models/ y
// permite borrarlos en lote vía delete.php. Mismo token que upload.
// ────────────────────────────────────────────────────────────────────
const btnManageModels = $('btn-manage-models');
const modalModels = $('modal-models');
const mmList = $('mm-list');
const mmStatus = $('mm-status');
const mmDeleteBtn = $('mm-delete-selected');
const mmFilter = $('mm-filter');

function mmSetStatus(text, kind = '') {
  if (!mmStatus) return;
  mmStatus.textContent = text || '';
  mmStatus.className = 'mm-status' + (kind ? ' ' + kind : '');
  mmStatus.classList.toggle('hidden', !text);
}

function mmUpdateDeleteBtn() {
  if (!mmDeleteBtn) return;
  const n = mmList.querySelectorAll('input[type="checkbox"]:checked').length;
  mmDeleteBtn.disabled = n === 0;
  mmDeleteBtn.textContent = n > 0 ? `Eliminar ${n} archivo${n > 1 ? 's' : ''}` : 'Eliminar seleccionados';
}

async function mmRefresh() {
  if (!mmList) return;
  mmList.innerHTML = '<em>Cargando…</em>';
  mmSetStatus('');
  let models;
  try {
    models = await fetchManifest();
  } catch (err) {
    mmList.innerHTML = '<em>Error cargando lista</em>';
    return;
  }
  if (!models.length) {
    mmList.innerHTML = '<em>No hay archivos en /models/</em>';
    mmUpdateDeleteBtn();
    return;
  }
  // Ordenar por nombre asc para gestión más cómoda
  models.sort((a, b) => (a.name || a.url || '').localeCompare(b.name || b.url || ''));
  mmList.innerHTML = '';
  models.forEach((m) => {
    const name = m.name || (m.url || '').split('/').pop();
    const size = typeof m.size === 'number' ? formatBytes(m.size) : '';
    const inUse = currentModelUrl && (currentModelUrl === m.url || currentModelUrl.endsWith('/' + name));
    const row = document.createElement('label');
    row.className = 'mm-row' + (inUse ? ' in-use' : '');
    row.innerHTML = `
      <input type="checkbox" data-name="${name}" ${inUse ? 'disabled' : ''}>
      <span class="mm-name" title="${name}">${name}</span>
      ${inUse ? '<span class="mm-badge">EN USO</span>' : ''}
      <span class="mm-size">${size}</span>
    `;
    mmList.appendChild(row);
  });
  mmFilter && (mmFilter.value = '');
  mmUpdateDeleteBtn();
}

function mmOpen() {
  if (!modalModels) return;
  $('modal-overlay')?.classList.remove('hidden');
  modalModels.classList.remove('hidden');
  mmRefresh();
}
function mmClose() {
  modalModels?.classList.add('hidden');
  // Si no quedan modales abiertos, ocultar overlay
  const anyOpen = document.querySelectorAll('#modal-overlay .modal:not(.hidden)').length;
  if (!anyOpen) $('modal-overlay')?.classList.add('hidden');
}

btnManageModels?.addEventListener('click', mmOpen);
modalModels?.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', mmClose));
mmList?.addEventListener('change', mmUpdateDeleteBtn);

$('mm-select-all')?.addEventListener('click', () => {
  mmList.querySelectorAll('input[type="checkbox"]:not(:disabled)').forEach((cb) => {
    // Solo marcar los visibles (si hay filtro activo)
    if (cb.closest('.mm-row').style.display !== 'none') cb.checked = true;
  });
  mmUpdateDeleteBtn();
});
$('mm-select-none')?.addEventListener('click', () => {
  mmList.querySelectorAll('input[type="checkbox"]').forEach((cb) => (cb.checked = false));
  mmUpdateDeleteBtn();
});

mmFilter?.addEventListener('input', () => {
  const q = mmFilter.value.trim().toLowerCase();
  mmList.querySelectorAll('.mm-row').forEach((row) => {
    const name = row.querySelector('.mm-name')?.textContent.toLowerCase() || '';
    row.style.display = !q || name.includes(q) ? '' : 'none';
  });
});

mmDeleteBtn?.addEventListener('click', async () => {
  const checked = Array.from(mmList.querySelectorAll('input[type="checkbox"]:checked'));
  const files = checked.map((cb) => cb.dataset.name).filter(Boolean);
  if (!files.length) return;

  if (!confirm(`¿Eliminar ${files.length} archivo${files.length > 1 ? 's' : ''} de /models/?\n\nEsta acción NO se puede deshacer.`)) return;

  const token = getToken();
  if (!token) return;

  mmDeleteBtn.disabled = true;
  mmSetStatus('Eliminando…');

  try {
    const res = await fetch('./delete.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Upload-Token': token },
      body: JSON.stringify({ files }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 401) {
        clearToken();
        mmSetStatus('Token inválido — se borró. Reintentá.', 'err');
      } else {
        mmSetStatus(data.error || `HTTP ${res.status}`, 'err');
      }
      mmDeleteBtn.disabled = false;
      return;
    }
    const okN = (data.deleted || []).length;
    const failN = (data.failed || []).length;
    let msg = `✓ ${okN} eliminado${okN === 1 ? '' : 's'}`;
    if (failN) msg += ` · ${failN} con error`;
    mmSetStatus(msg, failN ? 'err' : 'ok');
    if (failN) console.warn('[delete] fallaron:', data.failed);
    // Refrescar lista del modal y dropdown principal
    await mmRefresh();
    await populateModels();
  } catch (err) {
    console.error('[delete] error', err);
    mmSetStatus('Error de red: ' + err.message, 'err');
    mmDeleteBtn.disabled = false;
  }
});

// ────────────────────────────────────────────────────────────────────
// Floating viewport controls (bottom-right stack)
// ────────────────────────────────────────────────────────────────────
function zoomViewport(deltaUnits) {
  if (cameraCtrl.isFlying()) cameraCtrl.cancel();
  if (navMode === 'fps') return; // no zoom in fps mode (you walk instead)
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  camera.position.addScaledVector(dir, deltaUnits);
  controls.update();
}

function resetCamera() {
  if (!currentModel) return;
  // Use the iso waypoint of the current model type as the reset target.
  const list = activeModelType === 'edificio' ? buildingWaypoints : unitWaypoints;
  const iso = list.find((w) => w.id === 'iso') || list.find((w) => w.id === 'vista_general') || list[0];
  if (iso) goToWaypoint(iso);
  else frameObject(currentModel, camera, controls);
}

function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
  else document.exitFullscreen?.();
}

function toggleNavMode() {
  setNavMode(navMode === 'orbit' ? 'fps' : 'orbit');
}

function syncFloatingModeIcon() {
  const btn = $('btn-cam-mode');
  if (btn) btn.textContent = navMode === 'fps' ? '🚶' : '🌐';
}

$('btn-cam-reset')?.addEventListener('click', resetCamera);
$('btn-cam-zoomin')?.addEventListener('click', () => zoomViewport(currentModel ? Math.max(1, _zoomStep()) : 1));
$('btn-cam-zoomout')?.addEventListener('click', () => zoomViewport(currentModel ? -Math.max(1, _zoomStep()) : -1));
$('btn-cam-fullscreen')?.addEventListener('click', toggleFullscreen);
$('btn-cam-mode')?.addEventListener('click', () => { toggleNavMode(); syncFloatingModeIcon(); });

// Step size scaled by model bbox so + / − feel right for both unit and building.
function _zoomStep() {
  if (!currentModel) return 1;
  const box = new THREE.Box3().setFromObject(currentModel);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  return Math.max(0.5, maxDim * 0.1); // ~10% of bbox per click
}

// Keyboard shortcuts (don't fire from inputs; respect existing E/I/R/Space handlers).
window.addEventListener('keydown', (e) => {
  const tag = (e.target?.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '+' || e.key === '=') { zoomViewport(_zoomStep()); }
  else if (e.key === '-' || e.key === '_') { zoomViewport(-_zoomStep()); }
  else if (e.key === 'f' || e.key === 'F') { toggleFullscreen(); }
  else if (e.key === 'Tab') { e.preventDefault(); toggleNavMode(); syncFloatingModeIcon(); }
});

syncFloatingModeIcon();

// Atajo de teclado: Shift+T para resetear el token
window.addEventListener('keydown', (e) => {
  if (e.shiftKey && e.key === 'T' && !e.ctrlKey && !e.metaKey) {
    if (confirm('¿Resetear el token de upload guardado?')) {
      clearToken();
      alert('Token borrado. Se va a pedir la próxima vez que subas algo.');
    }
  }
});

// ────────────────────────────────────────────────────────────────────
// Modals: import waypoints + map embed
// ────────────────────────────────────────────────────────────────────
const modalOverlay = $('modal-overlay');
const modalImport  = $('modal-import');
const modalMap     = $('modal-map');

function openModal(which) {
  if (!modalOverlay) return;
  modalOverlay.classList.remove('hidden');
  [modalImport, modalMap].forEach((m) => m?.classList.add('hidden'));
  which.classList.remove('hidden');
}
function closeModal() {
  modalOverlay?.classList.add('hidden');
  // Reset import modal state
  const text = $('import-json-text'); if (text) text.value = '';
  const preview = $('import-preview'); if (preview) preview.classList.add('hidden');
  const errorBox = $('import-error'); if (errorBox) errorBox.classList.add('hidden');
  const confirmBtn = $('import-confirm'); if (confirmBtn) confirmBtn.disabled = true;
  pendingImportList = null;
  // Stop iframe load
  const iframe = $('map-iframe'); if (iframe) iframe.src = '';
}

modalOverlay?.addEventListener('click', (e) => {
  // Close when clicking overlay (not the modal box).
  if (e.target === modalOverlay) closeModal();
});
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modalOverlay?.classList.contains('hidden')) closeModal();
});

// ── Import waypoints modal ─────────────────────────────────────────
let pendingImportList = null;

function openImportModal() {
  openModal(modalImport);
  $('import-json-text')?.focus();
}

function previewImportText(text) {
  const preview = $('import-preview');
  const errorBox = $('import-error');
  const confirmBtn = $('import-confirm');
  preview?.classList.add('hidden');
  errorBox?.classList.add('hidden');
  if (confirmBtn) confirmBtn.disabled = true;
  pendingImportList = null;
  if (!text || !text.trim()) return;
  let parsed;
  try { parsed = JSON.parse(text); }
  catch {
    if (errorBox) { errorBox.textContent = 'JSON inválido — revisá la sintaxis.'; errorBox.classList.remove('hidden'); }
    return;
  }
  let list;
  try { list = normalizeImportedWaypoints(parsed); }
  catch (err) {
    if (errorBox) { errorBox.textContent = err.message; errorBox.classList.remove('hidden'); }
    return;
  }
  pendingImportList = list;
  if (preview) {
    const labels = list.slice(0, 6).map((w) => `${w.icono || '•'} ${w.label}`).join(', ');
    const more = list.length > 6 ? ` <em>(+${list.length - 6} más)</em>` : '';
    preview.innerHTML = `
      <div class="preview-title">📋 Detectados ${list.length} waypoint${list.length === 1 ? '' : 's'}</div>
      <div class="preview-list">${labels}${more}</div>
    `;
    preview.classList.remove('hidden');
  }
  if (confirmBtn) confirmBtn.disabled = false;
}

$('import-json-text')?.addEventListener('input', (e) => previewImportText(e.target.value));

$('import-json-file')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  $('import-json-text').value = text;
  previewImportText(text);
  e.target.value = '';
});

// Drag-drop directly onto the import modal.
modalImport?.addEventListener('dragover', (e) => { e.preventDefault(); modalImport.classList.add('drag-over'); });
modalImport?.addEventListener('dragleave', (e) => { if (e.target === modalImport) modalImport.classList.remove('drag-over'); });
modalImport?.addEventListener('drop', async (e) => {
  e.preventDefault();
  modalImport.classList.remove('drag-over');
  const file = e.dataTransfer?.files?.[0];
  if (!file || !file.name.toLowerCase().endsWith('.json')) return;
  const text = await file.text();
  $('import-json-text').value = text;
  previewImportText(text);
});

$('import-confirm')?.addEventListener('click', () => {
  if (!pendingImportList) return;
  const scope = editorScope();
  saveWaypoints(scope, currentModelUrl, pendingImportList);
  refreshWaypoints();
  closeModal();
});

// ── Project address + Map embed modal ───────────────────────────────
const addressInput = $('project-address');
if (addressInput) {
  addressInput.value = ls.get('proyecto_direccion', '');
  addressInput.addEventListener('change', (e) => ls.set('proyecto_direccion', e.target.value.trim()));
  addressInput.addEventListener('blur',   (e) => ls.set('proyecto_direccion', e.target.value.trim()));

  // Google Places Autocomplete — exact lat/lng for the 3D viewer instead of
  // geocoding free text. Only if a key is already stored (set it once via the
  // Google 3D dialog, then reload). Plain field + OSM fallback otherwise.
  const _gkey = localStorage.getItem('bizual_google_maps_key') || '';
  if (_gkey) {
    import('./places-autocomplete.js?v=20260528h')
      .then(({ initAddressAutocomplete }) =>
        initAddressAutocomplete(addressInput, _gkey, (coords) => {
          ls.set('proyecto_direccion', coords.display);
        }))
      .catch((err) => console.warn('[places] autocomplete no disponible (se usará OSM):', err.message));
  }
}

const MAP_MODE_BUILDERS = {
  satelite:   (a) => `https://maps.google.com/maps?q=${a}&t=k&z=19&output=embed`,
  mapa:       (a) => `https://maps.google.com/maps?q=${a}&z=18&output=embed`,
  streetview: (a) => `https://maps.google.com/maps?q=${a}&layer=c&cbll=&cbp=11,0,0,0,0&z=18&output=embed`,
};

function loadMapMode(mode) {
  const addr = (addressInput?.value || '').trim();
  if (!addr) return;
  const iframe = $('map-iframe');
  if (!iframe) return;
  iframe.src = MAP_MODE_BUILDERS[mode](encodeURIComponent(addr));
  document.querySelectorAll('.map-modes .pill').forEach((b) => {
    b.classList.toggle('active', b.dataset.mapMode === mode);
  });
}

$('btn-show-map')?.addEventListener('click', () => {
  const addr = (addressInput?.value || '').trim();
  if (!addr) {
    addressInput?.focus();
    addressInput?.classList.add('input-error');
    setTimeout(() => addressInput?.classList.remove('input-error'), 1200);
    return;
  }
  $('map-address').textContent = addr;
  openModal(modalMap);
  loadMapMode('satelite');
});

document.querySelectorAll('.map-modes .pill[data-map-mode]').forEach((btn) => {
  btn.addEventListener('click', () => loadMapMode(btn.dataset.mapMode));
});

// ── Mapbox real-environment full-screen panel ──────────────────────
// All UI lives in mapbox-env.js (it's a self-contained #env-panel that
// renders over the viewer). viewer.js only fires the open call.
let _envHandle = null;
window.__envHandleAccess = () => _envHandle;

function _modelForEnv() {
  if (!currentModelUrl) return null;
  return /tipologia/i.test(currentModelUrl)
    ? currentModelUrl.replace(/tipologia[^/]*\.glb/i, 'Edificio_01_exterior_med_v6.glb')
    : currentModelUrl;
}

$('btn-show-mapbox')?.addEventListener('click', async () => {
  const addr = (addressInput?.value || '').trim();
  if (!addr) { addressInput?.focus(); return; }
  if (!currentModelUrl) {
    alert('Cargá un GLB primero — el modelo se va a posicionar en el entorno real.');
    return;
  }
  try {
    const mod = await import('./mapbox-env.js?v=20260519');
    _envHandle = await mod.openEnvPanel(addr, _modelForEnv());
  } catch (err) {
    console.error('[mapbox-env] open failed:', err);
    alert('Error abriendo entorno: ' + err.message);
  }
});

// Google Photorealistic 3D Tiles
let _envHandleG3d = null;
$('btn-show-g3d')?.addEventListener('click', async () => {
  const addr = (addressInput?.value || '').trim();
  if (!addr) { addressInput?.focus(); return; }
  if (!currentModelUrl) {
    alert('Cargá un GLB primero — el modelo se va a posicionar en el entorno real.');
    return;
  }
  try {
    // Prefer the exact coords from a Places pick; fall back to OSM geocoding.
    const pa = await import('./places-autocomplete.js?v=20260528h');
    let coords = pa.resolvePickedCoords(addr);
    if (!coords) {
      const mb = await import('./mapbox-env.js?v=20260519');
      coords = await mb.geocodeAddress(addr);
    }
    const g3d = await import('./env-google3d.js?v=20260528u');
    _envHandleG3d = await g3d.openGoogle3DPanel(coords, _modelForEnv());
  } catch (err) {
    console.error('[g3d] open failed:', err);
    alert('Error abriendo Google 3D: ' + err.message);
  }
});
