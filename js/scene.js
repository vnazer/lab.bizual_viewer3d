// Shared scene factory used by viewer.js and compare.js
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { sanitizeGLB } from './sanitize.js?v=20260515';

// ────────────────────────────────────────────────────────────────────
// HDRI presets — Poly Haven 2K, CC0. Servidos localmente desde /hdri/.
// ────────────────────────────────────────────────────────────────────
export const HDRI_PRESETS = {
  street:    { label: 'Wide Street (prod default)',  file: './hdri/wide_street_01_2k.hdr' },
  kloofendal:{ label: 'Kloofendal Late Afternoon',   file: './hdri/kloofendal_2k.hdr' },
  studio:    { label: 'Studio neutro',               file: './hdri/studio_small_03_2k.hdr' },
  sunset:    { label: 'Venice Sunset',               file: './hdri/venice_sunset_2k.hdr' },
  indoor:    { label: 'Warehouse interior',          file: './hdri/empty_warehouse_01_2k.hdr' },
  overcast:  { label: 'Overcast Soil',               file: './hdri/overcast_soil_2k.hdr' },
};
export const DEFAULT_HDRI_ID = 'street';
const HDRI_URL = HDRI_PRESETS[DEFAULT_HDRI_ID].file;

const DRACO_DECODER = 'https://www.gstatic.com/draco/v1/decoders/';
const KTX2_TRANSCODER = 'https://unpkg.com/three@0.184.0/examples/jsm/libs/basis/';

// WebGPU is opt-in via ?webgpu=1 to avoid stability issues across browsers.
// r184 ships WebGPURenderer in the `three.webgpu.module.js` build but it
// requires a different import map, so we keep the default visor on WebGL2
// (battle-tested) and expose a query-string flag to test WebGPU.
export async function createRenderer(canvasHost) {
  const wantWebGPU = new URLSearchParams(location.search).get('webgpu') === '1';
  let renderer;
  let backend = 'webgl2';

  if (wantWebGPU && navigator.gpu) {
    try {
      // Lazy-load the webgpu build only when requested
      const mod = await import('https://unpkg.com/three@0.184.0/build/three.webgpu.module.js');
      renderer = new mod.WebGPURenderer({ antialias: true, alpha: true });
      await renderer.init();
      backend = 'webgpu';
    } catch (err) {
      console.warn('[lab] WebGPU init failed, falling back to WebGL2:', err.message);
      renderer = null;
    }
  }

  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(canvasHost.clientWidth, canvasHost.clientHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  if (renderer.shadowMap) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }

  canvasHost.appendChild(renderer.domElement);
  return { renderer, backend };
}

export function createScene() {
  const scene = new THREE.Scene();
  scene.background = null; // transparent until HDRI applies

  // Sun (key light): warm white, sized for both unit-scale and building scenes.
  const sun = new THREE.DirectionalLight(0xfff4e5, 1.5);
  setSunDirection(sun, 45, 55, 30); // azimut 45° · elevation 55°
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  // Frustum widened to cover building-size models (~25-30 m bbox).
  sun.shadow.camera.left = -25;
  sun.shadow.camera.right = 25;
  sun.shadow.camera.top = 25;
  sun.shadow.camera.bottom = -25;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 100;
  // normalBias displaces samples along the surface normal — kills shimmer on
  // near-flat geometry (grass plane, sidewalks) without losing balcony shadows.
  // Pair it with a tiny bias so steep-angle surfaces still resolve cleanly.
  sun.shadow.normalBias = 0.04;
  sun.shadow.bias = -0.0001;
  sun.shadow.radius = 4; // soft shadow PCF
  scene.add(sun);

  // Hemisphere fill (sky/ground rim).
  const hemi = new THREE.HemisphereLight(0xb1d6ff, 0x222222, 0.4);
  scene.add(hemi);

  // Cool ambient — keeps shadows from going to pure black.
  const ambient = new THREE.AmbientLight(0xc8d8e0, 0.15);
  scene.add(ambient);

  // Contact shadow plane: invisible plane that just receives shadows.
  // (The drei-style ContactShadows is not part of stock three addons.)
  const contactShadows = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 20),
    new THREE.ShadowMaterial({ opacity: 0.45, transparent: true })
  );
  contactShadows.rotation.x = -Math.PI / 2;
  contactShadows.position.y = 0;
  contactShadows.receiveShadow = true;
  scene.add(contactShadows);

  return { scene, sun, hemi, ambient, contactShadows };
}

// Convert (azimut°, elevation°) into a sun world-position on a sphere of `radius`.
export function setSunDirection(sun, azDeg, elDeg, radius = 30) {
  const az = THREE.MathUtils.degToRad(azDeg);
  const el = THREE.MathUtils.degToRad(elDeg);
  sun.position.set(
    radius * Math.cos(el) * Math.cos(az),
    radius * Math.sin(el),
    radius * Math.cos(el) * Math.sin(az)
  );
  if (sun.target) {
    sun.target.position.set(0, 0, 0);
    sun.target.updateMatrixWorld?.();
  }
}

export function createCamera(host) {
  const camera = new THREE.PerspectiveCamera(45, host.clientWidth / host.clientHeight, 0.01, 1000);
  camera.position.set(2.5, 1.8, 3.5);
  return camera;
}

export function createControls(camera, dom) {
  const controls = new OrbitControls(camera, dom);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 0.05;
  controls.maxDistance = 200;
  controls.target.set(0, 0.5, 0);
  return controls;
}

let _gltfLoader = null;
export function getGLTFLoader(renderer) {
  if (_gltfLoader) return _gltfLoader;

  const draco = new DRACOLoader();
  draco.setDecoderPath(DRACO_DECODER);
  draco.setDecoderConfig({ type: 'js' });

  const ktx2 = new KTX2Loader();
  ktx2.setTranscoderPath(KTX2_TRANSCODER);
  if (renderer && ktx2.detectSupport) ktx2.detectSupport(renderer);

  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);
  loader.setKTX2Loader(ktx2);
  loader.setMeshoptDecoder(MeshoptDecoder);
  _gltfLoader = loader;
  return loader;
}

// PMREM env maps are tied to the GL context of the renderer that built them.
// We cache RGBE textures by URL (renderer-agnostic) and PMREM-baked envs per
// (renderer, url) tuple so switching presets doesn't re-decode the .hdr.
const _rgbeByUrl = new Map();          // url -> Promise<DataTexture>
const _envByRendererUrl = new WeakMap(); // renderer -> Map<url, envTexture>

function loadRGBE(url) {
  if (_rgbeByUrl.has(url)) return _rgbeByUrl.get(url);
  const p = new Promise((resolve, reject) => {
    new RGBELoader().load(
      url,
      (tex) => resolve(tex),
      undefined,
      (err) => { _rgbeByUrl.delete(url); reject(err); }
    );
  });
  _rgbeByUrl.set(url, p);
  return p;
}

function pmremFor(renderer, url, rgbeTex) {
  let perRenderer = _envByRendererUrl.get(renderer);
  if (!perRenderer) {
    perRenderer = new Map();
    _envByRendererUrl.set(renderer, perRenderer);
  }
  if (perRenderer.has(url)) return perRenderer.get(url);
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const env = pmrem.fromEquirectangular(rgbeTex).texture;
  pmrem.dispose();
  perRenderer.set(url, env);
  return env;
}

// Load HDRI by preset id or explicit URL. Returns PMREM-baked env texture.
// Backwards compatible: loadHDRI(renderer) → uses default preset.
export function loadHDRI(renderer, idOrUrl) {
  let url;
  if (!idOrUrl) url = HDRI_URL;
  else if (HDRI_PRESETS[idOrUrl]) url = HDRI_PRESETS[idOrUrl].file;
  else url = idOrUrl;
  return loadRGBE(url).then((tex) => pmremFor(renderer, url, tex));
}

// Load a user-supplied .hdr (File or URL). Caches under a synthetic url so it
// survives subsequent loadHDRI calls without re-decoding.
// Accepts a File, ArrayBuffer (for persisted HDRIs from IndexedDB), or URL string.
// When ArrayBuffer is passed, supply a `cacheName` so we can key the cache.
export function setCustomHDRI(input, renderer, cacheName) {
  return new Promise((resolve, reject) => {
    const isString = typeof input === 'string';
    const isArrayBuffer = !isString && input instanceof ArrayBuffer;
    const isFile = !isString && !isArrayBuffer;
    let objectUrl;
    let cacheKey;
    if (isString) {
      objectUrl = input;
      cacheKey = input;
    } else if (isArrayBuffer) {
      const blob = new Blob([input], { type: 'application/octet-stream' });
      objectUrl = URL.createObjectURL(blob);
      cacheKey = `custom://buffer-${cacheName || input.byteLength}`;
    } else {
      objectUrl = URL.createObjectURL(input);
      cacheKey = `custom://${input.name}-${input.size}-${input.lastModified}`;
    }
    const needsRevoke = !isString;
    new RGBELoader().load(
      objectUrl,
      (tex) => {
        if (needsRevoke) URL.revokeObjectURL(objectUrl);
        _rgbeByUrl.set(cacheKey, Promise.resolve(tex));
        resolve(pmremFor(renderer, cacheKey, tex));
      },
      undefined,
      (err) => { if (needsRevoke) URL.revokeObjectURL(objectUrl); reject(err); }
    );
  });
}

// Frame model in view, return stats.
export function frameObject(object, camera, controls) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return null;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  // Re-center on ground (model bottom at y=0)
  object.position.sub(center);
  object.position.y += size.y / 2;

  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = camera.fov * (Math.PI / 180);
  const dist = Math.abs(maxDim / Math.tan(fov / 2)) * 1.2;
  camera.position.set(dist * 0.7, dist * 0.5 + size.y * 0.3, dist);
  camera.near = Math.max(0.001, maxDim / 1000);
  camera.far = dist * 100;
  camera.updateProjectionMatrix();
  controls.target.set(0, size.y / 2, 0);
  controls.update();

  return { size, maxDim };
}

// Count triangles in a loaded scene.
export function countTriangles(root) {
  let tris = 0;
  root.traverse((o) => {
    if (o.isMesh && o.geometry) {
      const idx = o.geometry.index;
      if (idx) tris += idx.count / 3;
      else if (o.geometry.attributes.position) tris += o.geometry.attributes.position.count / 3;
    }
  });
  return Math.round(tris);
}

// Enable shadows on every mesh.
export function enableShadows(root) {
  root.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
}

export async function fetchManifest() {
  // Try PHP endpoint first (Hostinger), fall back to manifest.json.
  const tries = ['./models.php', './models/manifest.json'];
  for (const url of tries) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) continue;
      const ct = res.headers.get('content-type') || '';
      // If PHP isn't executed, the server returns the raw <?php source as text/html.
      if (!ct.includes('json') && url.endsWith('.php')) continue;
      const data = await res.json();
      if (Array.isArray(data) && data.length) return data;
      if (Array.isArray(data?.models) && data.models.length) return data.models;
    } catch (e) { /* try next */ }
  }
  return [];
}

// Fetch the GLB as a blob to know exact byte size, then load via GLTFLoader.parse.
export async function loadGLBWithStats(loader, url) {
  const t0 = performance.now();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const bytes = blob.size;
  let arrayBuffer = await blob.arrayBuffer();

  // Some Blender exports leave texture entries with no `source` and no
  // EXT_texture_webp/avif extension, which crashes GLTFLoader with a
  // "cannot read 'uri' of undefined" deep in loadTexture. Patch on the fly.
  arrayBuffer = sanitizeGLB(arrayBuffer) || arrayBuffer;

  return new Promise((resolve, reject) => {
    const base = url.substring(0, url.lastIndexOf('/') + 1);
    loader.parse(arrayBuffer, base, (gltf) => {
      const ms = performance.now() - t0;
      resolve({ gltf, bytes, ms });
    }, reject);
  });
}


export function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(2) + ' MB';
}

// ────────────────────────────────────────────────────────────────────
// Pro-mode helpers: anisotropy, material introspection, extensions, VRAM.
// ────────────────────────────────────────────────────────────────────

// Apply max anisotropy to every texture slot of every material in the tree.
// Eliminates granulado en ángulo oblicuo. Idempotent.
const TEX_SLOTS = [
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap',
  'aoMap', 'specularMap', 'specularIntensityMap', 'specularColorMap',
  'transmissionMap', 'thicknessMap', 'sheenColorMap', 'sheenRoughnessMap',
  'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap',
  'anisotropyMap', 'iridescenceMap', 'iridescenceThicknessMap',
];

// Apply anisotropy. If `value` is omitted, uses the renderer's max capability.
// Pass an explicit value (1, 4, 8, 16, ...) to compare quality/perf tradeoffs.
// Capped to renderer.capabilities.getMaxAnisotropy() so we never exceed HW.
export function applyAnisotropy(root, renderer, value) {
  const cap = renderer?.capabilities?.getMaxAnisotropy?.() ?? 1;
  const target = Math.max(1, Math.min(cap, value == null ? cap : value));
  let applied = 0;
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach((m) => {
      TEX_SLOTS.forEach((slot) => {
        const tex = m[slot];
        if (tex && typeof tex === 'object' && tex.anisotropy !== undefined && tex.anisotropy !== target) {
          tex.anisotropy = target;
          tex.needsUpdate = true;
          applied++;
        }
      });
    });
  });
  return { max: cap, applied: target, slotsTouched: applied };
}

// Extract material info for the inspector panel.
export function getMaterialsInfo(root) {
  const materials = new Map();
  root.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach((mat) => {
      let info = materials.get(mat.uuid);
      if (!info) {
        info = {
          uuid: mat.uuid,
          name: mat.name || '(unnamed)',
          type: mat.type,
          alphaMode: mat.transparent ? 'BLEND' : (mat.alphaTest > 0 ? 'MASK' : 'OPAQUE'),
          baseColor: mat.color ? mat.color.toArray() : null,
          opacity: mat.opacity,
          roughness: mat.roughness,
          metalness: mat.metalness,
          emissive: mat.emissive ? mat.emissive.toArray() : null,
          emissiveIntensity: mat.emissiveIntensity,
          // KHR extensions exposed by three.js
          transmission: mat.transmission ?? null,
          ior: mat.ior ?? null,
          thickness: mat.thickness ?? null,
          attenuationDistance: mat.attenuationDistance ?? null,
          specularIntensity: mat.specularIntensity ?? null,
          anisotropy: mat.anisotropy ?? null,
          iridescence: mat.iridescence ?? null,
          clearcoat: mat.clearcoat ?? null,
          sheen: mat.sheen ?? null,
          textures: TEX_SLOTS.filter((s) => mat[s] && mat[s].isTexture),
          instances: 0,
          meshUuids: [],
          ref: mat,
        };
        materials.set(mat.uuid, info);
      }
      info.instances++;
      info.meshUuids.push(child.uuid);
    });
  });
  return Array.from(materials.values());
}

// Read declared glTF extensions from the GLTFLoader result.
export function getExtensions(gltf) {
  const json = gltf?.parser?.json || {};
  return {
    used: Array.isArray(json.extensionsUsed) ? json.extensionsUsed.slice() : [],
    required: Array.isArray(json.extensionsRequired) ? json.extensionsRequired.slice() : [],
  };
}

// Estimate GPU VRAM consumed by textures in the scene.
// Formula: w * h * bytesPerPixel * (1 + 1/3 mipmaps).
export function calculateVRAM(root) {
  let bytes = 0;
  const seen = new Set();
  root.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach((mat) => {
      TEX_SLOTS.forEach((slot) => {
        const tex = mat[slot];
        if (!tex || !tex.image || seen.has(tex.uuid)) return;
        seen.add(tex.uuid);
        const w = tex.image.width || 0;
        const h = tex.image.height || 0;
        // Assume RGBA8 (4 bytes/pixel) — close enough for a "what's in VRAM" estimate.
        bytes += w * h * 4 * 1.333;
      });
    });
  });
  return { bytes: Math.round(bytes), count: seen.size };
}

// Compute the perceptual albedo of a model. We return BOTH the mean and the
// p75 (75th percentile) so callers can pick the right metric for their use:
//
//   • mean: representative of the whole material set (good for "is this dark?")
//   • p75:  ignores the darkest quartile (floors, trims, dark furniture) →
//          much better proxy for the dominant *façade/wall* color when
//          deciding sun intensity. Default for auto-calibration.
//
// Each material's contribution is weighted by the number of mesh instances
// using it, so a model with one big white wall + many tiny dark trims still
// reads as "white" rather than averaging toward gray.
export function analyzeModelAlbedo(root) {
  // material uuid -> { lum, instances }
  const byMat = new Map();
  let opaque = 0;
  let transparent = 0;
  root.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach((m) => {
      if (m.transparent || (m.transmission != null && m.transmission > 0)) {
        transparent++;
        return; // skip glass / volume materials — they distort the avg
      }
      if (!m.color) return;
      let entry = byMat.get(m.uuid);
      if (!entry) {
        const r = m.color.r, g = m.color.g, b = m.color.b;
        entry = { lum: 0.299 * r + 0.587 * g + 0.114 * b, instances: 0 };
        byMat.set(m.uuid, entry);
        opaque++;
      }
      entry.instances++;
    });
  });
  // Weighted samples (each material contributes `instances` copies of its lum).
  const samples = [];
  byMat.forEach((e) => {
    for (let i = 0; i < e.instances; i++) samples.push(e.lum);
  });
  if (samples.length === 0) {
    return { albedo: 0.5, albedoMean: 0.5, albedoP75: 0.5, opaqueMaterials: 0, transparentMaterials: transparent };
  }
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  // p75: take element at index 0.75 * (n-1) — represents the dominant lighter half.
  const p75 = samples[Math.floor(0.75 * (samples.length - 1))];
  return {
    albedo: p75,           // legacy field — auto-calibration now uses p75
    albedoMean: mean,
    albedoP75: p75,
    opaqueMaterials: opaque,
    transparentMaterials: transparent,
  };
}

// Toggle visibility so only meshes using `materialUuid` show. Returns prev state.
export function isolateMaterial(root, materialUuid) {
  const prevState = new Map();
  root.traverse((child) => {
    if (!child.isMesh) return;
    prevState.set(child.uuid, child.visible);
    if (!materialUuid) {
      child.visible = true;
      return;
    }
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    child.visible = mats.some((m) => m.uuid === materialUuid);
  });
  return prevState;
}

// Toggle wireframe on a single material (or all if uuid is falsy).
export function setWireframe(root, materialUuid, on) {
  root.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach((m) => {
      if (!materialUuid || m.uuid === materialUuid) m.wireframe = !!on;
    });
  });
}
