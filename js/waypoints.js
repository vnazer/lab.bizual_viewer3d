// Waypoint-based navigation (T14 Unidad + T15 Edificio).
// - Detects model type from bbox.
// - Computes default waypoints from bbox.
// - Smooth lerp to a waypoint via CameraController (factor 0.06 ≈ 1.2s).
// - Editor: capture custom waypoints, persist per-file in localStorage,
//   export/import JSON in the exact format the SaaS admin panel expects.

import * as THREE from 'three';

// ────────────────────────────────────────────────────────────────────
// Model type detection
// ────────────────────────────────────────────────────────────────────
export function detectModelType(model) {
  if (!model) return 'unidad';
  const bbox = new THREE.Box3().setFromObject(model);
  if (bbox.isEmpty()) return 'unidad';
  const size = bbox.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim > 20) return 'edificio';
  if (maxDim < 15) return 'unidad';
  return 'mixto';
}

export function getBBoxFrame(model) {
  const bbox = new THREE.Box3().setFromObject(model);
  const c = bbox.getCenter(new THREE.Vector3());
  const size = bbox.getSize(new THREE.Vector3());
  const d = Math.max(size.x, size.y, size.z) * 1.5;
  return { center: c, size, d, bbox };
}

// ────────────────────────────────────────────────────────────────────
// Building waypoints (T15) — exactly as in the spec.
// ────────────────────────────────────────────────────────────────────
export function computeBuildingWaypoints(model) {
  const { center: c, d } = getBBoxFrame(model);
  return [
    { id: 'frente',   label: 'Frente',     icono: '🏢',
      position: [c.x,             c.y + d * 0.3,  c.z + d],     target: [c.x, c.y, c.z] },
    { id: 'izq',      label: 'Izquierda',  icono: '⬅️',
      position: [c.x - d,         c.y + d * 0.3,  c.z],         target: [c.x, c.y, c.z] },
    { id: 'der',      label: 'Derecha',    icono: '➡️',
      position: [c.x + d,         c.y + d * 0.3,  c.z],         target: [c.x, c.y, c.z] },
    { id: 'trasera',  label: 'Trasera',    icono: '🔙',
      position: [c.x,             c.y + d * 0.3,  c.z - d],     target: [c.x, c.y, c.z] },
    { id: 'cenital',  label: 'Cenital',    icono: '⬆️',
      position: [c.x,             c.y + d * 1.4,  c.z + 0.1],   target: [c.x, c.y, c.z] },
    { id: 'iso',      label: 'Isométrica', icono: '📐',
      position: [c.x + d * 0.7,   c.y + d * 0.5,  c.z + d * 0.7], target: [c.x, c.y, c.z] },
  ];
}

// ────────────────────────────────────────────────────────────────────
// Unit waypoints (T14). Fallback when no custom waypoints saved.
// ────────────────────────────────────────────────────────────────────
export function computeUnitWaypointsFallback(model) {
  const { center: c, d } = getBBoxFrame(model);
  return [
    { id: 'iso',     label: 'Vista general', icono: '📐',
      position: [c.x + d * 0.7, c.y + d * 0.3,  c.z + d * 0.7], target: [c.x, c.y, c.z] },
    { id: 'frente',  label: 'Frente',        icono: '🏠',
      position: [c.x,           c.y + d * 0.2,  c.z + d],       target: [c.x, c.y, c.z] },
    { id: 'cenital', label: 'Cenital',       icono: '⬆️',
      position: [c.x,           c.y + d * 1.3,  c.z + 0.1],     target: [c.x, c.y, c.z] },
  ];
}

// "Save as ___" slots that the editor offers — different per model kind.
export const UNIT_WAYPOINT_SLOTS = [
  { id: 'entrada',    label: 'Entrada',    icono: '🚪' },
  { id: 'living',     label: 'Living',     icono: '🛋️' },
  { id: 'cocina',     label: 'Cocina',     icono: '🍳' },
  { id: 'dormitorio', label: 'Dormitorio', icono: '🛏️' },
  { id: 'bano',       label: 'Baño',       icono: '🚿' },
  { id: 'terraza',    label: 'Terraza',    icono: '🌿' },
  { id: 'cenital',    label: 'Cenital',    icono: '⬆️' },
];

export const EDIFICIO_WAYPOINT_SLOTS = [
  { id: 'hall_acceso',   label: 'Hall Acceso',    icono: '🚪' },
  { id: 'lobby',         label: 'Lobby',          icono: '🏛️' },
  { id: 'quincho',       label: 'Quincho',        icono: '🍖' },
  { id: 'piscina',       label: 'Área Piscina',   icono: '🏊' },
  { id: 'terraza_comun', label: 'Terraza Común',  icono: '🌇' },
  { id: 'jardin',        label: 'Jardín',         icono: '🌿' },
  { id: 'vista_general', label: 'Vista General',  icono: '🏢' },
  { id: 'vista_aerea',   label: 'Vista Aérea',    icono: '⬆️' },
];

export function getWaypointSlots(modelType) {
  return modelType === 'edificio' ? EDIFICIO_WAYPOINT_SLOTS : UNIT_WAYPOINT_SLOTS;
}

// Infer model type from a GLB filename (used when the override is "auto" and
// we want a quick guess without computing a bbox).
export function guessModelTypeFromFilename(filename) {
  if (!filename) return 'unidad';
  const f = String(filename).toLowerCase();
  if (/(exterior|edificio|general|completo|fachada)/.test(f)) return 'edificio';
  if (/(tipologia|unidad|interior|dpto|departamento)/.test(f)) return 'unidad';
  return 'unidad';
}

// ────────────────────────────────────────────────────────────────────
// CameraController — smooth lerp to a (position, target) pair.
// Factor 0.06 per frame ≈ 1.2 seconds to arrive at 60fps.
// ────────────────────────────────────────────────────────────────────
const _ARRIVE_EPS = 0.04;
const _STABLE_FRAMES_NEEDED = 90; // ~1.5s stable before declaring arrived.

export class CameraController {
  constructor(camera, controls) {
    this.camera = camera;
    this.controls = controls;
    this.lerpFactor = 0.06;
    this._target = null;       // { pos: Vector3, look: Vector3 }
    this._stableFrames = 0;
    this._onArrive = null;
  }

  flyTo(positionArr, targetArr, onArrive = null) {
    this._target = {
      pos: new THREE.Vector3().fromArray(positionArr),
      look: new THREE.Vector3().fromArray(targetArr),
    };
    this._stableFrames = 0;
    this._onArrive = onArrive;
  }

  cancel() {
    this._target = null;
    this._stableFrames = 0;
    this._onArrive = null;
  }

  isFlying() { return this._target !== null; }

  /** Returns true if the camera is currently being driven by the controller. */
  update() {
    if (!this._target) return false;
    const t = this._target;
    this.camera.position.lerp(t.pos, this.lerpFactor);
    this.controls.target.lerp(t.look, this.lerpFactor);
    this.camera.lookAt(this.controls.target);

    const dPos = this.camera.position.distanceTo(t.pos);
    const dLook = this.controls.target.distanceTo(t.look);
    if (dPos < _ARRIVE_EPS && dLook < _ARRIVE_EPS) {
      this._stableFrames++;
      if (this._stableFrames >= _STABLE_FRAMES_NEEDED) {
        // Snap to exact position and release control back to OrbitControls.
        this.camera.position.copy(t.pos);
        this.controls.target.copy(t.look);
        const cb = this._onArrive;
        this._target = null;
        this._stableFrames = 0;
        this._onArrive = null;
        cb && cb();
        return false;
      }
    } else {
      this._stableFrames = 0;
    }
    return true;
  }
}

// Discrete orbit rotation for arrow buttons (±0.1 rad steps).
export function rotateOrbit(camera, controls, deltaAzimuth, deltaPolar) {
  const offset = new THREE.Vector3().subVectors(camera.position, controls.target);
  const sph = new THREE.Spherical().setFromVector3(offset);
  sph.theta -= deltaAzimuth;       // negate so "left arrow" feels left
  sph.phi -= deltaPolar;
  sph.phi = Math.max(0.05, Math.min(Math.PI - 0.05, sph.phi));
  offset.setFromSpherical(sph);
  camera.position.copy(controls.target).add(offset);
  camera.lookAt(controls.target);
  controls.update();
}

// Snapshot of current pose (for "Save as ___" in the editor).
export function snapshotPose(camera, controls) {
  return {
    position: camera.position.toArray().map((v) => +v.toFixed(3)),
    target:   controls.target.toArray().map((v) => +v.toFixed(3)),
  };
}

// ────────────────────────────────────────────────────────────────────
// Per-file waypoint storage. Key = djb2 hash of filename to keep it short.
// ────────────────────────────────────────────────────────────────────
const LS_PREFIX = 'bizual_lab_waypoints_';

function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

export function fileKey(urlOrName) {
  if (!urlOrName) return 'unknown';
  const last = urlOrName.split('/').pop().split('?')[0];
  return djb2(last);
}

// Segmented storage key: edificio waypoints share one bucket across files,
// while tipologia waypoints stay per-file (each unit has its own POIs).
export function storageKeyFor(modelType, urlOrName) {
  if (modelType === 'edificio') return LS_PREFIX + 'edificio';
  return LS_PREFIX + 'tipologia_' + fileKey(urlOrName);
}

// Legacy (per-file only). Kept for backwards compatibility — viewer.js now
// prefers loadWaypoints(modelType, url) below.
export function loadWaypointsForFile(urlOrName) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + fileKey(urlOrName));
    if (!raw) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data?.waypoints) ? data.waypoints : [];
  } catch { return []; }
}

export function saveWaypointsForFile(urlOrName, waypoints) {
  try {
    localStorage.setItem(LS_PREFIX + fileKey(urlOrName), JSON.stringify({ waypoints }));
  } catch {}
}

export function clearWaypointsForFile(urlOrName) {
  localStorage.removeItem(LS_PREFIX + fileKey(urlOrName));
}

// Segmented storage:
//   • edificio   → one shared bucket per project (most labs have a single bldg)
//   • tipologia  → per-file bucket (each unit has its own POIs)
export function loadWaypoints(modelType, urlOrName) {
  // Migrate from legacy per-file key if the segmented one is empty.
  const key = storageKeyFor(modelType, urlOrName);
  try {
    let raw = localStorage.getItem(key);
    if (!raw && modelType !== 'edificio') {
      // Try legacy
      raw = localStorage.getItem(LS_PREFIX + fileKey(urlOrName));
      if (raw) localStorage.setItem(key, raw); // promote to new key
    }
    if (!raw) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data?.waypoints) ? data.waypoints : [];
  } catch { return []; }
}

export function saveWaypoints(modelType, urlOrName, waypoints) {
  try {
    localStorage.setItem(storageKeyFor(modelType, urlOrName), JSON.stringify({ waypoints }));
  } catch {}
}

export function clearWaypoints(modelType, urlOrName) {
  localStorage.removeItem(storageKeyFor(modelType, urlOrName));
}

// JSON format matches what `tipologias.waypoints_json` stores in the SaaS DB.
export function formatWaypointJSON(waypoints) {
  return JSON.stringify({ waypoints }, null, 2);
}

// Strict parser: only accepts the canonical {waypoints:[{id, position[3], target[3]}]} shape.
export function parseWaypointJSON(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : data?.waypoints;
  if (!Array.isArray(list)) throw new Error('Formato inválido: falta el array "waypoints"');
  list.forEach((w, i) => {
    if (!w.id || !Array.isArray(w.position) || !Array.isArray(w.target)) {
      throw new Error(`Waypoint #${i} inválido (necesita id, position[3], target[3])`);
    }
  });
  return list;
}

// Convert a position-like value to a [x,y,z] array. Accepts:
//   • [x, y, z]   → returned as-is
//   • {x, y, z}   → converted (legacy export from older SaaS)
//   • null/undef  → null
function _toVec3(v) {
  if (Array.isArray(v) && v.length >= 3) return [Number(v[0]), Number(v[1]), Number(v[2])];
  if (v && typeof v === 'object' && 'x' in v && 'y' in v && 'z' in v) {
    return [Number(v.x), Number(v.y), Number(v.z)];
  }
  return null;
}

// Flexible normalizer: accepts many shapes and converts to the canonical form.
//   1. [...]                 → array of waypoints directly
//   2. { waypoints: [...] }  → editor export (canonical)
//   3. { rooms:     [...] }  → spec interior format with .camera
//   4. { views:     [...] }  → spec exterior format with .camera
//
// Each item must end up with: { id, label?, icono?, position[3], target[3] }.
// Items may use { position, target } at top level OR nested in .camera.
// position/target may be arrays [x,y,z] OR objects {x,y,z}.
export function normalizeImportedWaypoints(raw) {
  let list;
  if (Array.isArray(raw)) list = raw;
  else if (Array.isArray(raw?.waypoints)) list = raw.waypoints;
  else if (Array.isArray(raw?.rooms)) list = raw.rooms;
  else if (Array.isArray(raw?.views)) list = raw.views;
  else throw new Error('Formato JSON no reconocido (esperaba array, .waypoints, .rooms o .views)');

  const out = list.map((w, i) => {
    const cam = w.camera || w;
    const position = _toVec3(w.position) || _toVec3(cam.position);
    const target   = _toVec3(w.target)   || _toVec3(cam.target);
    if (!position) throw new Error(`Waypoint #${i + 1}: falta camera.position (acepta [x,y,z] o {x,y,z})`);
    if (!target)   throw new Error(`Waypoint #${i + 1}: falta camera.target (acepta [x,y,z] o {x,y,z})`);
    if (!w.id && !w.label) throw new Error(`Waypoint #${i + 1}: falta id o label`);
    return {
      id: w.id || (w.label || `wp_${i}`).toLowerCase().replace(/\s+/g, '_'),
      label: w.label || w.id || `Punto ${i + 1}`,
      icono: w.icono || w.icon || '📍',
      position,
      target,
      duration: Number(w.duration_ms || w.duration) || undefined,
    };
  });
  return out;
}
