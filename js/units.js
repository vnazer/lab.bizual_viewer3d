// Unit-level navigation: HTML2D labels floating over the building model +
// dblclick raycaster that finds an "Unidad_NN" mesh and triggers a click handler.
//
// Config is fetched lazily from ./models/unidades.json. Schema:
// [
//   {
//     "numero": "602",
//     "tipologia": "tipologia_602_med_v6.glb",
//     "tipologia_url": "./models/tipologia_602_med_v6.glb",
//     "waypoints_url": "./models/tipologia_602_waypoints.json",
//     "world_position": { "x": 4.2, "y": 18.5, "z": 1.1 }
//   }
// ]
//
// Missing fields gracefully degrade: no world_position → no label; no
// tipologia_url → click logs a warning instead of loading.

import * as THREE from 'three';

let _config = [];
let _container = null;
let _mode = 'orbit';      // 'orbit' or anything else suppresses labels
let _onClick = null;      // (unidad) => void
let _camera = null;
let _renderer = null;
let _scene = null;
let _ready = false;

const _projected = new THREE.Vector3();

export async function initUnitLabels({ camera, renderer, scene, configUrl = './models/unidades.json' }) {
  _camera = camera;
  _renderer = renderer;
  _scene = scene;
  _container = document.getElementById('labels-container');
  if (!_container) {
    _container = document.createElement('div');
    _container.id = 'labels-container';
    document.body.appendChild(_container);
  }
  try {
    const res = await fetch(configUrl, { cache: 'no-store' });
    if (!res.ok) {
      console.log(`[units] no config at ${configUrl} (${res.status}) — labels disabled`);
      return false;
    }
    const data = await res.json();
    _config = Array.isArray(data) ? data : (Array.isArray(data?.unidades) ? data.unidades : []);
    if (!_config.length) {
      console.log('[units] config loaded but empty');
      return false;
    }
    buildLabels();
    _ready = true;
    console.log(`[units] ${_config.length} labels ready`);
    return true;
  } catch (err) {
    console.warn('[units] config fetch failed:', err.message);
    return false;
  }
}

function buildLabels() {
  if (!_container) return;
  _container.innerHTML = '';
  _config.forEach((u) => {
    const el = document.createElement('div');
    el.className = 'unidad-label';
    el.textContent = u.numero;
    el.title = `Unidad ${u.numero}${u.tipologia ? ' · ' + u.tipologia : ''} · click para entrar`;
    el.dataset.unidadId = u.numero;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      _onClick?.(u);
    });
    _container.appendChild(el);
    u._element = el;
  });
}

export function registerUnitClickHandler(fn) { _onClick = fn; }

export function setUnitMode(mode) {
  _mode = mode;
  if (_mode !== 'orbit') {
    _config.forEach((u) => { if (u._element) u._element.style.display = 'none'; });
  }
}

export function updateUnitLabels() {
  if (!_ready || _mode !== 'orbit' || !_camera || !_renderer) return;
  const rect = _renderer.domElement.getBoundingClientRect();
  for (const u of _config) {
    if (!u._element || !u.world_position) continue;
    const wp = u.world_position;
    _projected.set(wp.x, wp.y, wp.z).project(_camera);
    if (_projected.z > 1 || _projected.z < -1) {
      u._element.style.display = 'none';
      continue;
    }
    const x = (_projected.x + 1) / 2 * rect.width + rect.left;
    const y = (1 - _projected.y) / 2 * rect.height + rect.top;
    u._element.style.display = 'block';
    u._element.style.left = `${x}px`;
    u._element.style.top  = `${y}px`;
  }
}

// Dblclick raycaster: find first mesh whose name matches /unidad[_\s-]?(\d+)/i
// (also walks the parent chain), then fire the click handler with that config.
export function setupDblclickEntry({ scene, camera, renderer }) {
  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true; // honored by three-mesh-bvh
  const mouse = new THREE.Vector2();
  renderer.domElement.addEventListener('dblclick', (e) => {
    if (_mode !== 'orbit') return;
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObjects(scene.children, true);
    if (!hits.length) return;
    let obj = hits[0].object;
    let unitNum = null;
    while (obj && obj !== scene) {
      const m = obj.name?.match(/[Uu]nidad[_\s-]?(\d+)/);
      if (m) { unitNum = m[1]; break; }
      obj = obj.parent;
    }
    if (!unitNum) {
      console.log('[units] dblclick on mesh without "Unidad_NN" naming:', hits[0].object.name);
      return;
    }
    const cfg = _config.find((u) => u.numero === unitNum || u.numero === Number(unitNum));
    if (!cfg) {
      console.log(`[units] dblclick → Unidad ${unitNum} (no config in unidades.json)`);
      return;
    }
    _onClick?.(cfg);
  });
}
