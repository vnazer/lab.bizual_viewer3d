import * as THREE from 'three';
import {
  createRenderer, createScene, createCamera, createControls,
  getGLTFLoader, loadHDRI, setCustomHDRI, frameObject, countTriangles, enableShadows,
  fetchManifest, loadGLBWithStats, formatBytes,
  HDRI_PRESETS, DEFAULT_HDRI_ID,
  applyAnisotropy, getMaterialsInfo, getExtensions, calculateVRAM,
  isolateMaterial, setWireframe,
} from './scene.js?v=20260504';

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
  aces:     THREE.ACESFilmicToneMapping,
  neutral:  THREE.NeutralToneMapping ?? THREE.ACESFilmicToneMapping,
  cineon:   THREE.CineonToneMapping,
  reinhard: THREE.ReinhardToneMapping,
  linear:   THREE.LinearToneMapping,
};

const host = document.getElementById('canvas-wrap');
const $ = (id) => document.getElementById(id);

const { renderer, backend } = await createRenderer(host);
// Expose ASAP — before any DOM access that could throw and abort module init.
window.__renderer = renderer;
const tagEl = $('renderer-tag');
if (tagEl) tagEl.textContent = backend.toUpperCase();

const { scene, sun, hemi, contactShadows } = createScene();
window.__scene = scene;
window.__sunLight = sun;
window.__ambientLight = hemi;

const camera = createCamera(host);
const controls = createControls(camera, renderer.domElement);
const loader = getGLTFLoader(renderer);
window.__camera = camera;
window.__controls = controls;
console.log('[lab] globals ready:', { renderer: !!window.__renderer, scene: !!window.__scene, sun: !!window.__sunLight, ambient: !!window.__ambientLight });

let envTex = null;
let currentModel = null;
let currentGLTF = null;
let currentMaterials = [];
let isolatedUuid = null;

// Apply persisted tone mapping + exposure BEFORE first render so we don't flash defaults.
const persistedTonemap = ls.get('tonemap', 'aces');
const persistedExposure = ls.get('exposure', 1.0);
const persistedEnvIntensity = ls.get('envIntensity', 1.0);
const persistedHdriId = ls.get('hdri', DEFAULT_HDRI_ID);
renderer.toneMapping = TONEMAP_BY_ID[persistedTonemap] ?? THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = persistedExposure;
scene.environmentIntensity = persistedEnvIntensity;
window.__envIntensity = persistedEnvIntensity;

// Show max anisotropy capability up front.
const maxAniso = renderer.capabilities?.getMaxAnisotropy?.() ?? 1;
const anisoEl = $('aniso-max');
if (anisoEl) anisoEl.textContent = `${maxAniso}×`;

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

applyHDRIPreset(hdriSelect ? hdriSelect.value : DEFAULT_HDRI_ID);

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
  const DEFAULT_MODEL = 'Edificio_01_vacio_sinplanters.glb';
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
    applyAnisotropy(root, renderer);
    scene.add(root);
    currentModel = root;
    currentGLTF = gltf;
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
  const usedHtml = used
    .map((e) => `<div class="ext-item${requiredSet.has(e) ? ' required' : ''}">${escapeHtml(e)}${requiredSet.has(e) ? ' <small>(required)</small>' : ''}</div>`)
    .join('');
  container.innerHTML = `
    <div class="group">
      <div class="group-title">Used (${used.length})</div>
      ${usedHtml}
    </div>
    ${required.length ? `<div class="group"><div class="group-title">Required (${required.length})</div>${required.map((e) => `<div class="ext-item required">${escapeHtml(e)}</div>`).join('')}</div>` : ''}
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

// Custom HDRI upload
$('btn-hdri').addEventListener('click', () => $('hdri-input').click());
$('hdri-input').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  $('hdri-name').textContent = `Cargando ${file.name}…`;
  try {
    envTex = await setCustomHDRI(file, renderer);
    if ($('toggle-hdri').checked) {
      scene.environment = envTex;
      scene.background = envTex;
    }
    $('hdri-name').textContent = `✓ ${file.name}`;
  } catch (err) {
    console.error('[hdri] failed:', err);
    $('hdri-name').textContent = `✗ Error: ${err.message || err}`;
  } finally {
    e.target.value = '';
  }
});

// Resize
function resize() {
  const w = host.clientWidth;
  const h = host.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
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

function animate() {
  controls.update();
  // WebGPURenderer exposes renderAsync; WebGLRenderer uses render
  if (typeof renderer.renderAsync === 'function') {
    renderer.renderAsync(scene, camera);
  } else {
    renderer.render(scene, camera);
  }
  updateFPS();
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

// Atajo de teclado: Shift+T para resetear el token
window.addEventListener('keydown', (e) => {
  if (e.shiftKey && e.key === 'T' && !e.ctrlKey && !e.metaKey) {
    if (confirm('¿Resetear el token de upload guardado?')) {
      clearToken();
      alert('Token borrado. Se va a pedir la próxima vez que subas algo.');
    }
  }
});
