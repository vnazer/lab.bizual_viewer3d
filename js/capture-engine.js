// ─── Cinematic Capture & Animation Engine ──────────────────────────────────
// Google Earth Studio-style camera presets (orbit, 90/180 pans, spiral vortex,
// fly-to, aerial reveal, dolly-in, façade pan, top-down→oblique) executed
// directly in our WebGL viewport, with a save/load animation library (portable
// JSON), an endless preview loop for presentations, and a deterministic
// frame-stepper that exports either:
//   • a marketing video — H.264 MP4 via WebCodecs + mp4-muxer (WebM fallback), or
//   • a Gaussian-Splatting dataset — a ZIP of 4K JPEGs + Nerfstudio/COLMAP
//     transforms.json (and/or cameras.json) poses for PlayCanvas.
//
// IMPORTANT — coordinate system: the Google 3D scene lives in ECEF (earth-
// centred), where "up" is the radial direction, NOT the world Y axis. All
// trajectory math therefore runs in the local ENU frame (east/north/up unit
// vectors) around the Shift-Click anchor, so an "orbit" is a real horizontal
// circle on the ground and "altitude" is metres above that ground point.

import * as THREE from 'three';
// Pure trajectory math lives in its own dependency-light module so the AWS
// client viewer can replay the same animations. Re-exported here so existing
// importers (and the AWS app) can pull both from one place.
import { CinematicAnimator, PRESETS } from './cinematic-animator.js?v=20260528a';
export { CinematicAnimator, PRESETS };

const DEG2RAD = Math.PI / 180;
const PRESET_DUR = Object.fromEntries(PRESETS.map((p) => [p.v, p.dur]));

// Video output resolutions (H.264 needs even dimensions; all are 16:9 even).
const VIDEO_RES = {
  '720p':  [1280, 720],
  '1080p': [1920, 1080],
  '1440p': [2560, 1440],
  '4k':    [3840, 2160],
};

// ─── tiny store-only ZIP writer (no deps) ───────────────────────────────────
// JPEGs are already compressed, so store (method 0) keeps the file small while
// staying ~80 lines instead of pulling in a deflate library.
let _crcTable = null;
function crc32(bytes) {
  if (!_crcTable) {
    _crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      _crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = _crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function zipStore(files) {
  // files: [{ name:String, data:Uint8Array }]  →  Blob (application/zip)
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const u16 = (v) => new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF]);
  const u32 = (v) => new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]);
  const push = (arr) => { parts.push(arr); offset += arr.length; };

  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;
    const localOff = offset;
    // Local file header.
    push(u32(0x04034b50)); push(u16(20)); push(u16(0)); push(u16(0));
    push(u16(0)); push(u16(0));                       // mod time / date (0 = 1980)
    push(u32(crc)); push(u32(size)); push(u32(size)); // crc, comp size, uncomp size
    push(u16(name.length)); push(u16(0));             // name len, extra len
    push(name); push(f.data);
    // Central directory record (buffered, written after all locals).
    const c = [];
    const cp = (a) => c.push(a);
    cp(u32(0x02014b50)); cp(u16(20)); cp(u16(20)); cp(u16(0)); cp(u16(0));
    cp(u16(0)); cp(u16(0));
    cp(u32(crc)); cp(u32(size)); cp(u32(size));
    cp(u16(name.length)); cp(u16(0)); cp(u16(0));     // name, extra, comment len
    cp(u16(0)); cp(u16(0)); cp(u32(0));               // disk, int attr, ext attr
    cp(u32(localOff)); cp(name);
    central.push({ bytes: c });
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const rec of central) for (const a of rec.bytes) { push(a); cdSize += a.length; }
  // End of central directory.
  push(u32(0x06054b50)); push(u16(0)); push(u16(0));
  push(u16(files.length)); push(u16(files.length));
  push(u32(cdSize)); push(u32(cdStart)); push(u16(0));

  return new Blob(parts, { type: 'application/zip' });
}

// ─── 2 + 3. Engine: UI, preview loop, deterministic capturer ────────────────
// ctx = {
//   THREE, camera, controls, renderer, scene, canvas, tiles,
//   hudParent,   // element to host the control section (the side panel)
//   panelRoot,   // element to host the blocking modal (the g3d panel root)
//   getFrame,    // () => {anchor,east,north,up,height} | null  (ECEF anchor frame)
//   renderFrame, // () => void : sky follow + composer/renderer render of one frame
//   updateTiles, // () => void : tiles.setCamera/setResolution/update
//   tilesPending,// () => Number : downloading + parsing count (3D Tiles streaming)
//   setNavEnabled,        // (bool) => void
//   beginCaptureResolution(w,h), endCaptureResolution(),  // 4K render + restore
// }
export function mountCaptureEngine(ctx) {
  const { camera, controls, canvas, getFrame, renderFrame, updateTiles, tilesPending,
          setNavEnabled, beginCaptureResolution, endCaptureResolution,
          beginCaptureQuality, endCaptureQuality } = ctx;

  const animator = new CinematicAnimator(getFrame() || {
    anchor: new THREE.Vector3(), east: new THREE.Vector3(1, 0, 0),
    north: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, 1), height: 60,
  });

  const state = {
    previewOn: false, previewStart: 0, previewSecs: 24,
    capturing: false, cancel: false,
  };

  // ── UI: a control section in the side panel + an on-demand blocking modal ──
  const section = document.createElement('details');
  section.className = 'g3d-sec';
  section.open = false;
  section.innerHTML = `
    <summary>🎬 Cine &amp; captura</summary>
    <div class="g3d-sec-body">
      <label title="Estilo de animación de cámara (librería de presets inmobiliarios).">🎞 Animación
        <select id="g3d-cine-preset" class="g3d-cine-select"></select>
      </label>
      <label title="Animaciones guardadas (las que guardes o importes).">📂 Guardadas
        <select id="g3d-cine-saved" class="g3d-cine-select"><option value="">— elegir —</option></select>
      </label>
      <div class="g3d-cine-row">
        <label title="Radio de la órbita en metros. Vacío = automático según el alto del edificio.">📏 Radio<input type="number" id="g3d-cine-radius" min="20" max="3000" step="10" placeholder="auto"></label>
        <label title="Altura de cámara sobre el suelo, en metros. Vacío = automático.">🛗 Alt<input type="number" id="g3d-cine-height" min="5" max="3000" step="10" placeholder="auto"></label>
      </div>
      <div class="g3d-hint">🎯 El centro <b>sigue al edificio</b>: si la dirección no encaja, movelo con E/O · N/S · Altura o ⇧+click y la animación se recentra sola.</div>
      <div class="g3d-check-row">
        <label title="Reproduce la animación en bucle infinito para presentaciones en vivo."><input type="checkbox" id="g3d-cine-preview"> Modo Presentación</label>
        <label title="Segundos por vuelta del bucle.">⏱<input type="number" id="g3d-cine-loopsecs" min="4" max="120" step="1" value="20" style="width:44px"></label>
      </div>
      <div class="g3d-cine-lib">
        <button id="g3d-cine-save" title="Guardar la animación actual con un nombre.">💾 Guardar</button>
        <button id="g3d-cine-del" title="Borrar la animación guardada seleccionada.">🗑</button>
        <button id="g3d-cine-export" title="Exportar las animaciones guardadas como JSON (portable a la app de Bizual en AWS).">⬇ JSON</button>
        <button id="g3d-cine-import" title="Importar animaciones desde un JSON.">⬆ JSON</button>
        <input type="file" id="g3d-cine-importfile" accept="application/json" style="display:none">
      </div>

      <div class="g3d-cine-divider">Exportar</div>
      <label title="Qué generar: un video MP4 para marketing, o un dataset de fotos para Gaussian Splatting.">🎬 Salida
        <select id="g3d-cine-output" class="g3d-cine-select">
          <option value="video" selected>🎬 Video MP4 (marketing)</option>
          <option value="photos">📸 Fotos (dataset Splat)</option>
        </select>
      </label>
      <label id="g3d-cine-reswrap" title="Resolución del video.">🖥 Resolución
        <select id="g3d-cine-res" class="g3d-cine-select">
          <option value="720p">720p</option>
          <option value="1080p" selected>1080p</option>
          <option value="1440p">1440p</option>
          <option value="4k">4K</option>
        </select>
      </label>
      <div class="g3d-cine-row">
        <label title="Duración del clip / la secuencia en segundos.">Duración<input type="number" id="g3d-cine-dur" min="1" max="120" step="1" value="16"></label>
        <label title="Cuadros por segundo.">FPS<input type="number" id="g3d-cine-fps" min="6" max="60" step="1" value="30"></label>
      </div>
      <label id="g3d-cine-formatwrap" title="Formato de poses dentro del ZIP (solo fotos). Nerfstudio/COLMAP es el estándar que ingiere PlayCanvas." style="display:none">📐 Poses
        <select id="g3d-cine-format" class="g3d-cine-select">
          <option value="transforms">Nerfstudio (transforms.json)</option>
          <option value="cameras">Bizual (cameras.json)</option>
          <option value="both" selected>Ambos</option>
        </select>
      </label>
      <div class="g3d-check-row">
        <label title="Fuerza el máximo detalle de tiles SOLO durante la captura (espera a que cada cuadro cargue). Navegá en calidad baja/rápida y aún capturá/grabá en alta."><input type="checkbox" id="g3d-cine-maxq" checked> 🔍 Máxima calidad</label>
      </div>
      <div class="g3d-hint" id="g3d-cine-estimate"></div>
      <button id="g3d-cine-go" class="g3d-cine-go">🎬 Generar Video MP4</button>
    </div>`;
  const saveBtn = ctx.hudParent.querySelector('#g3d-save');
  ctx.hudParent.insertBefore(section, saveBtn || null);

  const $ = (id) => section.querySelector('#' + id);
  const presetSel = $('g3d-cine-preset');
  const savedSel  = $('g3d-cine-saved');
  const radiusInp = $('g3d-cine-radius');
  const heightInp = $('g3d-cine-height');
  const previewChk = $('g3d-cine-preview');
  const loopSecsInp = $('g3d-cine-loopsecs');
  const outputSel = $('g3d-cine-output');
  const resWrap   = $('g3d-cine-reswrap');
  const resSel    = $('g3d-cine-res');
  const durInp = $('g3d-cine-dur');
  const fpsInp = $('g3d-cine-fps');
  const formatWrap = $('g3d-cine-formatwrap');
  const formatSel = $('g3d-cine-format');
  const maxqChk = $('g3d-cine-maxq');
  const estimateEl = $('g3d-cine-estimate');
  const goBtn = $('g3d-cine-go');

  // Populate the animation library dropdown from PRESETS.
  presetSel.innerHTML = PRESETS.map((p) => `<option value="${p.v}">${p.label}</option>`).join('');

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextRAF = () => new Promise((r) => requestAnimationFrame(() => r()));
  const toBlob = (q) => new Promise((res) => canvas.toBlob(res, 'image/jpeg', q));
  const pad4 = (n) => String(n).padStart(4, '0');
  const noAnchor = () => { alert('Primero anclá el edificio (⇧+click sobre el suelo Maxar) para definir el centro de la animación.'); };

  const overrides = () => {
    const r = parseFloat(radiusInp.value), h = parseFloat(heightInp.value);
    const o = {};
    if (Number.isFinite(r)) o.radius = r;
    if (Number.isFinite(h)) o.height = h;
    return o;
  };
  const isVideo = () => outputSel.value === 'video';
  const videoSize = () => VIDEO_RES[resSel.value] || VIDEO_RES['1080p'];
  const totalFrames = () => Math.max(1, Math.round((parseFloat(durInp.value) || 8) * (parseFloat(fpsInp.value) || 30)));

  function refreshEstimate() {
    const n = totalFrames();
    if (isVideo()) {
      const [w, h] = videoSize();
      estimateEl.textContent = `${n} cuadros · MP4 ${w}×${h} · ${durInp.value}s @ ${fpsInp.value}fps`;
    } else {
      estimateEl.textContent = `${n} frames · 4K (3840×2160) · ~${Math.ceil(n * 1.4)} MB aprox.`;
    }
  }
  function syncOutputUI() {
    const v = isVideo();
    resWrap.style.display = v ? '' : 'none';
    formatWrap.style.display = v ? 'none' : '';
    goBtn.textContent = v ? '🎬 Generar Video MP4' : '📸 Generar Secuencia Splat';
    refreshEstimate();
  }
  outputSel.addEventListener('change', syncOutputUI);
  [durInp, fpsInp, resSel].forEach((el) => el.addEventListener('input', refreshEstimate));
  presetSel.addEventListener('change', () => {
    const d = PRESET_DUR[presetSel.value];
    if (d) durInp.value = String(d);
    savedSel.value = '';
    refreshEstimate();
  });
  syncOutputUI();

  // ── Preview (Modo Presentación): endless loop driven by the host rAF ───────
  const stopPreview = () => {
    state.previewOn = false;
    previewChk.checked = false;
    // Hand the view back to OrbitControls looking at the building, so manual
    // navigation resumes from where the preset left off without snapping.
    if (controls) { controls.target.copy(animator.getTarget(0)); controls.update?.(); }
    setNavEnabled(true);
  };
  previewChk.addEventListener('change', () => {
    if (previewChk.checked) {
      const f = getFrame();
      if (!f) { previewChk.checked = false; noAnchor(); return; }
      animator.setFrame(f);
      animator.setPreset(presetSel.value, overrides());
      state.previewSecs = Math.max(4, parseFloat(loopSecsInp.value) || 20);
      state.previewStart = performance.now();
      state.previewOn = true;
      setNavEnabled(false);
    } else {
      stopPreview();
    }
  });
  // Live re-config while presenting.
  [presetSel, radiusInp, heightInp].forEach((el) => el.addEventListener('input', () => {
    if (!state.previewOn) return;
    const f = getFrame(); if (f) animator.setFrame(f);
    animator.setPreset(presetSel.value, overrides());
  }));
  loopSecsInp.addEventListener('input', () => {
    if (!state.previewOn) return;
    const elapsed = (performance.now() - state.previewStart) / 1000;
    const tNow = (elapsed / state.previewSecs) % 1;          // keep phase on speed change
    state.previewSecs = Math.max(4, parseFloat(loopSecsInp.value) || 20);
    state.previewStart = performance.now() - tNow * state.previewSecs * 1000;
  });

  // Called every frame by the host loop. Returns true if it positioned the
  // camera (host then skips controls.update so OrbitControls doesn't fight it).
  function tickPreview(now) {
    if (!state.previewOn) return false;
    // Re-read the frame each tick so the path re-centres live if the user
    // nudges the building (E/O · N/S · Altura · ⇧+click) while presenting.
    const f = getFrame();
    if (f) { animator.setFrame(f); animator.setPreset(presetSel.value, overrides()); }
    const t = ((now - state.previewStart) / 1000 / state.previewSecs) % 1;
    animator.applyToCamera(camera, t);
    return true;
  }

  // ── Modal progress overlay ─────────────────────────────────────────────────
  let modal = null;
  function showModal(title) {
    modal = document.createElement('div');
    modal.className = 'g3d-cine-modal';
    modal.innerHTML = `
      <div class="g3d-cine-card">
        <div class="g3d-cine-title">${escapeHtml(title || 'Generando…')}</div>
        <div class="g3d-cine-frame" id="g3d-cine-frame">Cuadro 0 / 0</div>
        <div class="g3d-cine-track"><div class="g3d-cine-fill" id="g3d-cine-fill"></div></div>
        <div class="g3d-cine-sub" id="g3d-cine-sub">Preparando…</div>
        <button class="g3d-cine-cancel" id="g3d-cine-cancel">Cancelar</button>
      </div>`;
    ctx.panelRoot.appendChild(modal);
    modal.querySelector('#g3d-cine-cancel').addEventListener('click', () => {
      state.cancel = true;
      modal.querySelector('#g3d-cine-sub').textContent = 'Cancelando…';
    });
  }
  function updateModal(i, n, sub) {
    if (!modal) return;
    const pct = n ? Math.round((i / n) * 100) : 0;
    modal.querySelector('#g3d-cine-frame').textContent = `Cuadro ${i} / ${n}`;
    modal.querySelector('#g3d-cine-fill').style.width = pct + '%';
    if (sub != null) modal.querySelector('#g3d-cine-sub').textContent = sub;
  }
  function hideModal() { modal?.remove(); modal = null; }

  // ── Shared deterministic frame-stepper ──────────────────────────────────────
  // Caller configures the animator first. For each frame: force the pose, wait
  // for the 3D Tiles of that view to fully stream in (or time out), render, then
  // hand the freshly-rendered canvas to onFrame(i, t). Restores camera +
  // resolution + quality on exit. Used by both the photo and video exporters.
  const CAP_W = 3840, CAP_H = 2160, JPEG_Q = 0.95;
  const PER_FRAME_TIMEOUT = 9000, SETTLE_FRAMES = 3;
  async function runStepper({ frames, w, h, maxQ, title, label, onFrame }) {
    state.capturing = true;
    state.cancel = false;
    if (state.previewOn) stopPreview();
    setNavEnabled(false);
    showModal(title);
    const saved = {
      pos: camera.position.clone(), up: camera.up.clone(),
      quat: camera.quaternion.clone(), aspect: camera.aspect, fov: camera.fov,
    };
    const perFrameTimeout = maxQ ? 16000 : PER_FRAME_TIMEOUT;
    let aborted = false;
    try {
      beginCaptureResolution(w, h);
      if (maxQ) beginCaptureQuality?.();
      await nextRAF();
      for (let i = 0; i < frames; i++) {
        if (state.cancel) { aborted = true; break; }
        const t = i / frames;       // [0,1) — for a 360° orbit avoids a duplicate 0/360 frame
        animator.applyToCamera(camera, t);
        camera.updateMatrixWorld();
        updateModal(i, frames, label + ' · cargando tiles…');
        const deadline = performance.now() + perFrameTimeout;
        let settled = 0;
        for (;;) {
          updateTiles();
          const pending = tilesPending();
          if (pending <= 0) { if (++settled >= SETTLE_FRAMES) break; } else settled = 0;
          if (performance.now() > deadline) break;
          if (state.cancel) { aborted = true; break; }
          await delay(16);
        }
        if (aborted) break;
        renderFrame();
        await nextRAF();
        await onFrame(i, t, saved.fov);
        updateModal(i + 1, frames, label);
        await delay(0);             // yield so the modal repaints
      }
    } catch (err) {
      console.error('[capture] error', err);
      alert('Error durante la captura: ' + err.message);
    } finally {
      if (maxQ) endCaptureQuality?.();
      endCaptureResolution();
      camera.aspect = saved.aspect; camera.fov = saved.fov; camera.updateProjectionMatrix();
      camera.position.copy(saved.pos); camera.up.copy(saved.up); camera.quaternion.copy(saved.quat);
      setNavEnabled(true);
      state.capturing = false;
    }
    return { aborted, fov: saved.fov };
  }

  // ── Photo dataset (ZIP of 4K JPEGs + poses) ─────────────────────────────────
  async function captureSequence(frames, fps) {
    const frame = getFrame();
    if (!frame) return noAnchor();
    animator.setFrame(frame);
    animator.setPreset(presetSel.value, overrides());
    const captured = [], poses = [];
    const { aborted, fov } = await runStepper({
      frames, w: CAP_W, h: CAP_H, maxQ: !!maxqChk.checked,
      title: '📸 Generando dataset Splat', label: 'Capturando',
      onFrame: async (i, t) => {
        const blob = await toBlob(JPEG_Q);
        const buf = new Uint8Array(await blob.arrayBuffer());
        const name = 'images/frame_' + pad4(i + 1) + '.jpg';
        captured.push({ name, data: buf });
        poses.push(poseRecord(i + 1, name, t, frame));
      },
    });
    if (!captured.length) { hideModal(); return; }
    updateModal(captured.length, frames, 'Empaquetando ZIP…'); await delay(0);
    const tenc = new TextEncoder();
    const fmt = formatSel.value;
    if (fmt === 'transforms' || fmt === 'both')
      captured.push({ name: 'transforms.json', data: tenc.encode(JSON.stringify(buildTransformsJson(CAP_W, CAP_H, fov, poses), null, 2)) });
    if (fmt === 'cameras' || fmt === 'both')
      captured.push({ name: 'cameras.json', data: tenc.encode(JSON.stringify(buildCamerasJson(presetSel.value, fps, captured.length, CAP_W, CAP_H, fov, frame, poses), null, 2)) });
    captured.push({ name: 'README.txt', data: tenc.encode(README) });
    downloadBlob(zipStore(captured), `bizual-splat-${stampNow()}.zip`);
    updateModal(captured.length, frames, aborted ? 'Cancelado — ZIP parcial descargado.' : '✅ ZIP descargado.');
    await delay(1400); hideModal();
  }

  // ── Marketing video (MP4 H.264 via WebCodecs + mp4-muxer) ───────────────────
  async function captureVideo(frames, fps) {
    const frame = getFrame();
    if (!frame) return noAnchor();
    const [w, h] = videoSize();
    if (!('VideoEncoder' in window) || !('VideoFrame' in window))
      return captureVideoFallback(frames, fps, w, h, frame);
    animator.setFrame(frame);
    animator.setPreset(presetSel.value, overrides());
    let Muxer, ArrayBufferTarget;
    try {
      ({ Muxer, ArrayBufferTarget } = await import('https://cdn.jsdelivr.net/npm/mp4-muxer@5/+esm'));
    } catch (e) {
      console.warn('[video] mp4-muxer load failed → WebM fallback', e);
      return captureVideoFallback(frames, fps, w, h, frame);
    }
    const bitrate = pickBitrate(w, h);
    const codec = await chooseH264Codec(w, h, bitrate, fps);
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({ target, video: { codec: 'avc', width: w, height: h }, fastStart: 'in-memory' });
    let encErr = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { encErr = e; console.error('[video] encoder error', e); },
    });
    encoder.configure({ codec, width: w, height: h, bitrate, framerate: fps });
    const usPerFrame = 1e6 / fps;
    const gop = Math.max(1, Math.round(fps * 2));
    const { aborted } = await runStepper({
      frames, w, h, maxQ: !!maxqChk.checked,
      title: '🎬 Codificando video MP4', label: 'Codificando',
      onFrame: async (i) => {
        if (encErr) throw encErr;
        const vf = new VideoFrame(canvas, { timestamp: Math.round(i * usPerFrame), duration: Math.round(usPerFrame) });
        encoder.encode(vf, { keyFrame: i % gop === 0 });
        vf.close();
        while (encoder.encodeQueueSize > 6) await delay(8);   // backpressure
      },
    });
    try {
      updateModal(frames, frames, 'Finalizando MP4…'); await delay(0);
      await encoder.flush();
      muxer.finalize();
      downloadBlob(new Blob([target.buffer], { type: 'video/mp4' }), `bizual-video-${stampNow()}.mp4`);
      updateModal(frames, frames, aborted ? 'Cancelado — MP4 parcial.' : `✅ MP4 ${w}×${h} descargado.`);
    } catch (e) {
      console.error('[video] finalize error', e);
      alert('Error al finalizar el MP4: ' + e.message);
    }
    await delay(1400); hideModal();
  }

  // WebM fallback for browsers without WebCodecs (records the live viewport).
  async function captureVideoFallback(frames, fps, w, h, frame) {
    if (!('MediaRecorder' in window) || !canvas.captureStream) {
      alert('Tu navegador no soporta export de video. Usá Chrome/Edge, o exportá Fotos.'); return;
    }
    alert('Sin WebCodecs: se grabará WebM a la resolución actual del viewport. Para MP4 usá Chrome/Edge.');
    animator.setFrame(frame);
    animator.setPreset(presetSel.value, overrides());
    state.capturing = true; state.cancel = false;
    if (state.previewOn) stopPreview();
    setNavEnabled(false); showModal('🎬 Grabando video (WebM)');
    const saved = { pos: camera.position.clone(), up: camera.up.clone(), quat: camera.quaternion.clone() };
    const maxQ = !!maxqChk.checked; if (maxQ) beginCaptureQuality?.();
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0];
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm';
    const chunks = [];
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: pickBitrate(w, h) });
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    let aborted = false;
    try {
      rec.start();
      const tout = maxQ ? 16000 : 9000;
      for (let i = 0; i < frames; i++) {
        if (state.cancel) { aborted = true; break; }
        animator.applyToCamera(camera, i / frames); camera.updateMatrixWorld();
        const deadline = performance.now() + tout; let settled = 0;
        for (;;) { updateTiles(); const p = tilesPending(); if (p <= 0) { if (++settled >= 3) break; } else settled = 0; if (performance.now() > deadline) break; if (state.cancel) { aborted = true; break; } await delay(16); }
        if (aborted) break;
        renderFrame(); await nextRAF();
        track.requestFrame?.();
        updateModal(i + 1, frames, 'Grabando…');
        await delay(Math.max(8, 1000 / fps));
      }
    } finally {
      rec.stop();
      await new Promise((r) => { rec.onstop = r; });
      if (maxQ) endCaptureQuality?.();
      camera.position.copy(saved.pos); camera.up.copy(saved.up); camera.quaternion.copy(saved.quat);
      setNavEnabled(true); state.capturing = false;
    }
    if (chunks.length) downloadBlob(new Blob(chunks, { type: 'video/webm' }), `bizual-video-${stampNow()}.webm`);
    updateModal(frames, frames, aborted ? 'Cancelado — WebM parcial.' : '✅ WebM descargado.');
    await delay(1400); hideModal();
  }

  // Per-frame pose in the local ENU frame (metres relative to the anchor).
  function poseRecord(idx, name, t, frame) {
    const pos = animator.getPosition(t);
    const tgt = animator.getTarget(t);
    const up = pos.clone().normalize();
    const toENU = (v) => {
      const d = v.clone().sub(frame.anchor);
      return [ +d.dot(frame.east).toFixed(4), +d.dot(frame.north).toFixed(4), +d.dot(frame.up).toFixed(4) ];
    };
    return {
      frame: idx, file: name, t: +t.toFixed(6),
      position: toENU(pos), target: toENU(tgt),
      up: [ +up.dot(frame.east).toFixed(6), +up.dot(frame.north).toFixed(6), +up.dot(frame.up).toFixed(6) ],
    };
  }

  // ── Saved-animations library (localStorage + portable JSON) ─────────────────
  const LS_ANIMS = 'bizual_g3d_animations';
  const loadSaved = () => { try { return JSON.parse(localStorage.getItem(LS_ANIMS) || '[]'); } catch { return []; } };
  const saveSavedList = (list) => localStorage.setItem(LS_ANIMS, JSON.stringify(list));
  const renderSavedOptions = () => {
    const list = loadSaved();
    savedSel.innerHTML = '<option value="">— elegir —</option>' +
      list.map((a, i) => `<option value="${i}">${escapeHtml(a.name)}</option>`).join('');
  };
  const currentConfig = (name) => ({
    name: name || (PRESETS.find((p) => p.v === presetSel.value)?.label || presetSel.value),
    preset: presetSel.value,
    radius: parseFloat(radiusInp.value) || null,
    height: parseFloat(heightInp.value) || null,
    output: outputSel.value, resolution: resSel.value,
    durationSec: parseFloat(durInp.value) || 16, fps: parseFloat(fpsInp.value) || 30,
    posesFormat: formatSel.value,
  });
  const applyConfig = (a) => {
    if (!a) return;
    if (a.preset) presetSel.value = a.preset;
    radiusInp.value = a.radius != null ? a.radius : '';
    heightInp.value = a.height != null ? a.height : '';
    if (a.output) outputSel.value = a.output;
    if (a.resolution) resSel.value = a.resolution;
    if (a.durationSec) durInp.value = a.durationSec;
    if (a.fps) fpsInp.value = a.fps;
    if (a.posesFormat) formatSel.value = a.posesFormat;
    syncOutputUI();
    if (state.previewOn) animator.setPreset(presetSel.value, overrides());
  };
  savedSel.addEventListener('change', () => {
    const idx = parseInt(savedSel.value, 10);
    if (Number.isInteger(idx)) applyConfig(loadSaved()[idx]);
  });
  $('g3d-cine-save').addEventListener('click', () => {
    const name = (prompt('Nombre de la animación:', currentConfig().name) || '').trim();
    if (!name) return;
    const list = loadSaved();
    const cfg = currentConfig(name);
    const ex = list.findIndex((a) => a.name === name);
    if (ex >= 0) list[ex] = cfg; else list.push(cfg);
    saveSavedList(list); renderSavedOptions();
    savedSel.value = String(loadSaved().findIndex((a) => a.name === name));
  });
  $('g3d-cine-del').addEventListener('click', () => {
    const idx = parseInt(savedSel.value, 10);
    if (!Number.isInteger(idx)) return;
    const list = loadSaved(); list.splice(idx, 1); saveSavedList(list); renderSavedOptions();
  });
  $('g3d-cine-export').addEventListener('click', () => {
    const data = { generator: 'Bizual Cinematic Animations', version: 1, animations: loadSaved() };
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `bizual-animaciones-${stampNow()}.json`);
  });
  const importFile = $('g3d-cine-importfile');
  $('g3d-cine-import').addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', async () => {
    const f = importFile.files?.[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const incoming = Array.isArray(data) ? data : (data.animations || []);
      if (!incoming.length) { alert('El JSON no tiene animaciones.'); return; }
      const list = loadSaved();
      for (const a of incoming) {
        if (!a || !a.preset) continue;
        const i = list.findIndex((x) => x.name === a.name);
        if (i >= 0) list[i] = a; else list.push(a);
      }
      saveSavedList(list); renderSavedOptions();
      alert(`Importadas ${incoming.length} animación(es).`);
    } catch (e) { alert('JSON inválido: ' + e.message); }
    importFile.value = '';
  });
  renderSavedOptions();

  // ── Generate button: branch on output type ─────────────────────────────────
  goBtn.addEventListener('click', () => {
    if (state.capturing) return;
    const n = totalFrames();
    const fps = parseFloat(fpsInp.value) || 30;
    const label = PRESETS.find((p) => p.v === presetSel.value)?.label || presetSel.value;
    if (isVideo()) {
      const [w, h] = videoSize();
      if (!confirm(`Generar video MP4 "${label}" → ${w}×${h}, ${durInp.value}s @ ${fps}fps (${n} cuadros).\n\nNo muevas la ventana. Puede tardar varios minutos. ¿Empezar?`)) return;
      captureVideo(n, fps);
    } else {
      if (n > 240 && !confirm(`Vas a capturar ${n} cuadros en 4K (~${Math.ceil(n * 1.4)} MB). Puede tardar varios minutos. ¿Continuar?`)) return;
      if (!confirm(`Generar dataset "${label}" → ${n} cuadros en 4K.\n\nNo muevas la ventana. ¿Empezar?`)) return;
      captureSequence(n, fps);
    }
  });

  return {
    tickPreview,
    isCapturing: () => state.capturing,
    dispose() { state.cancel = true; stopPreview(); hideModal(); section.remove(); },
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────
function buildCamerasJson(preset, fps, count, w, h, fovYDeg, frame, poses) {
  const fovY = fovYDeg * DEG2RAD;
  const fy = 0.5 * h / Math.tan(0.5 * fovY);
  const fx = fy;                                   // square pixels
  const up = frame.anchor.clone().normalize();
  return {
    generator: 'Bizual Cinematic Capture Engine',
    preset, fps, frame_count: count,
    width: w, height: h,
    camera_model: 'PINHOLE',
    fov_y_deg: +fovYDeg.toFixed(4),
    intrinsics: { fl_x: +fx.toFixed(4), fl_y: +fy.toFixed(4), cx: w / 2, cy: h / 2 },
    coordinate_frame: 'ENU local (metres) relative to anchor; +X east, +Y north, +Z up',
    convention: 'Each frame gives camera position, look-at target and up vector in the ENU frame. Build extrinsics as lookAt(position, target, up).',
    anchor_ecef: [ +frame.anchor.x.toFixed(3), +frame.anchor.y.toFixed(3), +frame.anchor.z.toFixed(3) ],
    anchor_up_ecef: [ +up.x.toFixed(6), +up.y.toFixed(6), +up.z.toFixed(6) ],
    frames: poses,
  };
}

// Industry-standard Nerfstudio / COLMAP transforms.json for the PlayCanvas
// Gaussian-Splatting pipeline. Per frame we emit a camera-to-world 4x4 matrix
// in the local ENU frame (metres) around the anchor, in OpenGL convention
// (camera looks down -Z, +Y up, +X right). three.js' camera basis IS OpenGL,
// so building the matrix straight from Matrix4.lookAt() needs NO axis flip —
// applying the COLMAP right-down-forward inversion here would render the path
// upside-down in the trainer. Intrinsics come from the fixed 4K + vertical FOV.
function buildTransformsJson(w, h, fovYDeg, poses) {
  const fovY = fovYDeg * DEG2RAD;
  const fl = 0.5 * h / Math.tan(0.5 * fovY);     // square pixels → fl_x === fl_y
  const r6 = (x) => +x.toFixed(6);
  const eye = new THREE.Vector3(), tgt = new THREE.Vector3(), up = new THREE.Vector3();
  const m = new THREE.Matrix4();
  const frames = poses.map((p) => {
    eye.fromArray(p.position); tgt.fromArray(p.target); up.fromArray(p.up);
    m.identity();
    m.lookAt(eye, tgt, up);    // sets the 3x3 camera basis [right, up, back]
    m.setPosition(eye);        // translation column = camera position (ENU)
    const e = m.elements;      // three stores column-major; emit row-major 4x4
    return {
      file_path: p.file,
      transform_matrix: [
        [r6(e[0]), r6(e[4]), r6(e[8]),  r6(e[12])],
        [r6(e[1]), r6(e[5]), r6(e[9]),  r6(e[13])],
        [r6(e[2]), r6(e[6]), r6(e[10]), r6(e[14])],
        [0, 0, 0, 1],
      ],
    };
  });
  return {
    camera_model: 'PINHOLE',
    w, h,
    fl_x: r6(fl), fl_y: r6(fl),
    cx: w / 2, cy: h / 2,
    k1: 0, k2: 0, p1: 0, p2: 0,           // pinhole: no distortion
    aabb_scale: 16,
    frames,
  };
}

const README =
`Bizual — Cinematic Capture (dataset para Gaussian Splatting)
============================================================
images/frame_XXXX.jpg  — cuadros 4K (3840x2160) en orden de trayectoria.

transforms.json        — formato estándar Nerfstudio / COLMAP. Intrínsecos
                         (camera_model PINHOLE, fl_x, fl_y, cx, cy, w, h) +
                         "frames": [{ file_path, transform_matrix }]. Cada
                         transform_matrix es camera-to-world 4x4 (row-major) en
                         el frame ENU local (metros), convención OpenGL (cámara
                         mira -Z, +Y arriba). Carga directa en PlayCanvas / gsplat
                         o nerfstudio (ns-train). Sin distorsión.

cameras.json           — (opcional) variante Bizual: posición/target/up por
                         cuadro en ENU local + intrínsecos. Útil si preferís
                         reconstruir las extrínsecas con lookAt(pos, target, up).
`;

// Target H.264 bitrate by resolution (Mbps) — generous for crisp marketing.
function pickBitrate(w, h) {
  const px = w * h;
  if (px >= 3840 * 2160 * 0.9) return 55_000_000;
  if (px >= 2560 * 1440 * 0.9) return 28_000_000;
  if (px >= 1920 * 1080 * 0.9) return 16_000_000;
  return 8_000_000;
}

// Pick a supported H.264 codec string for the target resolution. High profile
// at the level that covers the pixel count, falling back to Main/Baseline.
async function chooseH264Codec(w, h, bitrate, fps) {
  const cands = h >= 2160 ? ['avc1.640033', 'avc1.640032', 'avc1.42E033']
              : h >= 1440 ? ['avc1.640032', 'avc1.640028', 'avc1.42E032']
              :             ['avc1.640028', 'avc1.4D4028', 'avc1.42E028'];
  if (typeof VideoEncoder !== 'undefined' && VideoEncoder.isConfigSupported) {
    for (const c of cands) {
      try {
        const s = await VideoEncoder.isConfigSupported({ codec: c, width: w, height: h, bitrate, framerate: fps });
        if (s && s.supported) return c;
      } catch { /* try next */ }
    }
  }
  return cands[0];
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function stampNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
