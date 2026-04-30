// Shared scene factory used by viewer.js and compare.js
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

const HDRI_URL = 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/kloofendal_48d_partly_cloudy_puresky_2k.hdr';
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

  // Sun (key light)
  const sun = new THREE.DirectionalLight(0xffffff, 2.5);
  sun.position.set(5, 8, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -5;
  sun.shadow.camera.right = 5;
  sun.shadow.camera.top = 5;
  sun.shadow.camera.bottom = -5;
  sun.shadow.camera.near = 0.1;
  sun.shadow.camera.far = 30;
  sun.shadow.bias = -0.0005;
  sun.shadow.radius = 4; // soft shadow PCF
  scene.add(sun);

  // Soft fill
  const hemi = new THREE.HemisphereLight(0xb1d6ff, 0x222222, 0.4);
  scene.add(hemi);

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

  return { scene, sun, hemi, contactShadows };
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

let _envTexture = null;
let _envPromise = null;
export function loadHDRI(renderer) {
  if (_envTexture) return Promise.resolve(_envTexture);
  if (_envPromise) return _envPromise;
  _envPromise = new Promise((resolve, reject) => {
    new RGBELoader().load(
      HDRI_URL,
      (tex) => {
        const pmrem = new THREE.PMREMGenerator(renderer);
        pmrem.compileEquirectangularShader();
        const env = pmrem.fromEquirectangular(tex).texture;
        tex.dispose();
        pmrem.dispose();
        _envTexture = env;
        resolve(env);
      },
      undefined,
      (err) => { _envPromise = null; reject(err); }
    );
  });
  return _envPromise;
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
  const arrayBuffer = await blob.arrayBuffer();

  return new Promise((resolve, reject) => {
    // GLTFLoader.parse needs a base path for relative .bin/textures inside .gltf;
    // for .glb everything is embedded so '' is fine.
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
