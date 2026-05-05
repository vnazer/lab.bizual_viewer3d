import * as THREE from 'three';
import {
  createRenderer, createScene, createCamera, createControls,
  getGLTFLoader, loadHDRI, frameObject, countTriangles, enableShadows,
  fetchManifest, loadGLBWithStats, formatBytes,
} from './scene.js?v=20260516';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const panes = $$('.pane').map((el) => ({
  el,
  side: el.dataset.side,
  host: el.querySelector('.canvas-host'),
  select: el.querySelector('.model-select'),
  filesize: el.querySelector('.filesize'),
  loadtime: el.querySelector('.loadtime'),
  tris: el.querySelector('.tris'),
}));

const states = [];

async function setupPane(p) {
  const { renderer, backend } = await createRenderer(p.host);
  const { scene, contactShadows } = createScene();
  const camera = createCamera(p.host);
  const controls = createControls(camera, renderer.domElement);
  const loader = getGLTFLoader(renderer);
  const state = { ...p, renderer, scene, camera, controls, contactShadows, loader, backend, model: null };
  states.push(state);

  function resize() {
    const w = p.host.clientWidth;
    const h = p.host.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  return state;
}

async function loadModel(state, url) {
  if (!url) return;
  try {
    if (state.model) {
      state.scene.remove(state.model);
      disposeObject(state.model);
      state.model = null;
    }
    const { gltf, bytes, ms } = await loadGLBWithStats(state.loader, url);
    const root = gltf.scene || gltf.scenes[0];
    enableShadows(root);
    state.scene.add(root);
    state.model = root;
    frameObject(root, state.camera, state.controls);
    state.filesize.textContent = formatBytes(bytes);
    state.loadtime.textContent = ms.toFixed(0) + ' ms';
    state.tris.textContent = countTriangles(root).toLocaleString();
  } catch (err) {
    console.error('[compare] load failed:', err);
    state.filesize.textContent = 'error';
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

async function populate(models) {
  states.forEach((s, i) => {
    s.select.innerHTML = '';
    if (!models.length) {
      s.select.innerHTML = '<option value="">— sin modelos —</option>';
      return;
    }
    models.forEach((m) => {
      const opt = document.createElement('option');
      const url = typeof m === 'string' ? m : m.url || m.path;
      const label = (typeof m === 'string' ? m : (m.name || m.url || m.path)).split('/').pop();
      opt.value = url;
      opt.textContent = label;
      s.select.appendChild(opt);
    });
    // Default: same model both sides if there's only 1, otherwise A=first, B=second
    const idx = Math.min(i, s.select.options.length - 1);
    s.select.selectedIndex = idx;
    loadModel(s, s.select.value);
  });
}

(async () => {
  for (const p of panes) await setupPane(p);

  await Promise.all(states.map(async (s) => {
    try {
      s.envTex = await loadHDRI(s.renderer);
      if ($('#toggle-hdri').checked) {
        s.scene.environment = s.envTex;
        s.scene.background = s.envTex;
      }
    } catch (e) { console.warn('[compare] HDRI failed:', e); }
  }));

  const models = await fetchManifest();
  populate(models);

  states.forEach((s) => {
    s.select.addEventListener('change', (e) => loadModel(s, e.target.value));
  });

  // Camera sync
  let syncing = false;
  function syncCameras(source) {
    if (!$('#sync-cameras').checked || syncing) return;
    syncing = true;
    states.forEach((s) => {
      if (s === source) return;
      s.camera.position.copy(source.camera.position);
      s.camera.quaternion.copy(source.camera.quaternion);
      s.controls.target.copy(source.controls.target);
      s.controls.update();
    });
    syncing = false;
  }
  states.forEach((s) => s.controls.addEventListener('change', () => syncCameras(s)));

  $('#toggle-hdri').addEventListener('change', (e) => {
    states.forEach((s) => {
      s.scene.environment = e.target.checked ? s.envTex : null;
      s.scene.background = e.target.checked ? s.envTex : null;
    });
  });
  $('#toggle-shadows').addEventListener('change', (e) => {
    states.forEach((s) => { s.contactShadows.visible = e.target.checked; });
  });

  // FPS
  let frames = 0;
  let lastT = performance.now();
  function tick() {
    states.forEach((s) => {
      s.controls.update();
      if (typeof s.renderer.renderAsync === 'function') s.renderer.renderAsync(s.scene, s.camera);
      else s.renderer.render(s.scene, s.camera);
    });
    frames++;
    const now = performance.now();
    if (now - lastT >= 500) {
      $('#fps').textContent = ((frames / (now - lastT)) * 1000).toFixed(0);
      frames = 0;
      lastT = now;
    }
  }
  states[0].renderer.setAnimationLoop(tick);
})();
