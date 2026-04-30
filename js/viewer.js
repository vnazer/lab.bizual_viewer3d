import * as THREE from 'three';
import {
  createRenderer, createScene, createCamera, createControls,
  getGLTFLoader, loadHDRI, setCustomHDRI, frameObject, countTriangles, enableShadows,
  fetchManifest, loadGLBWithStats, formatBytes,
} from './scene.js?v=20260430';

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

// Load HDRI
loadHDRI(renderer).then((env) => {
  envTex = env;
  if ($('toggle-hdri').checked) {
    scene.environment = env;
    scene.background = env;
  }
}).catch((err) => console.warn('[lab] HDRI failed:', err));

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
    const { gltf, bytes, ms } = await loadGLBWithStats(loader, url);
    const root = gltf.scene || gltf.scenes[0];
    enableShadows(root);
    scene.add(root);
    currentModel = root;
    window.__currentModel = root;
    frameObject(root, camera, controls);

    $('filesize').textContent = formatBytes(bytes);
    $('loadtime').textContent = ms.toFixed(0) + ' ms';
    $('tris').textContent = countTriangles(root).toLocaleString();
  } catch (err) {
    console.error('[lab] load failed:', err);
    alert('Error cargando modelo: ' + err.message);
  } finally {
    showLoading(false);
  }
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
const MAX_UPLOAD_MB = 50;
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
