// ─── Cinematic Capture & Animation Engine ──────────────────────────────────
// Google Earth Studio-style camera presets (Orbit / Spiral / Fly-to+Orbit)
// executed directly in our WebGL viewport, plus a deterministic frame-stepper
// that captures a frame-per-pose dataset of the unbuilt building inside the
// photorealistic 3D Tiles environment. Output is a single ZIP (4K JPEGs +
// cameras.json poses) ready for the PlayCanvas / Gaussian-Splatting pipeline.
//
// IMPORTANT — coordinate system: the Google 3D scene lives in ECEF (earth-
// centred), where "up" is the radial direction, NOT the world Y axis. All
// trajectory math therefore runs in the local ENU frame (east/north/up unit
// vectors) around the Shift-Click anchor, so an "orbit" is a real horizontal
// circle on the ground and "altitude" is metres above that ground point.

import * as THREE from 'three';

const DEG2RAD = Math.PI / 180;
const smoothstep = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };

// ─── 1. Mathematical trajectory presets ─────────────────────────────────────
// Pure math over a normalised timeline t ∈ [0,1]. No DOM, no three scene — just
// position/target tracks, so it's identical in preview and headless capture.
export class CinematicAnimator {
  constructor(frame) { this.setFrame(frame); this.preset = 'orbit'; this.params = this.defaultsFor('orbit'); }

  // frame = { anchor:Vec3(ECEF), east:Vec3, north:Vec3, up:Vec3, height:Number(m) }
  setFrame(frame) {
    this.anchor = frame.anchor.clone();
    this.east   = frame.east.clone();
    this.north  = frame.north.clone();
    this.up     = frame.up.clone();
    this.bh     = Math.max(8, frame.height || 60);   // building height (m)
  }

  defaultsFor(type) {
    const bh = this.bh;
    const R  = THREE.MathUtils.clamp(bh * 2.6, 120, 600);   // orbit radius
    const H  = THREE.MathUtils.clamp(bh * 1.10, 50, 500);   // orbit altitude
    const tH = THREE.MathUtils.clamp(bh * 0.45, 8, 140);    // look-at height
    if (type === 'spiral') return {
      radiusOuter: Math.max(R * 2.6, 800), radiusInner: Math.max(R * 0.7, 180),
      heightStart: Math.max(H * 2.4, 600), heightEnd: H,
      targetHeight: tH, startDeg: 0, turns: 2.5,
    };
    if (type === 'flyto') return {
      radius: R, height: H, targetHeight: tH, startDeg: 0, turns: 0.85,
      flyDist: Math.max(R * 4, 1500), flyHeight: Math.max(H * 3, 700),
      flyBearingDeg: 205, hook: 0.45,
    };
    return { radius: R, height: H, targetHeight: tH, startDeg: 0, turns: 1 }; // orbit
  }

  // Apply preset + optional user overrides (radius/height come from the HUD).
  setPreset(type, overrides = {}) {
    this.preset = type;
    const base = this.defaultsFor(type);
    for (const k of Object.keys(overrides)) {
      if (overrides[k] == null || Number.isNaN(overrides[k])) continue;
      // Map the two generic HUD knobs onto each preset's matching fields.
      if (k === 'radius') { base.radius = overrides[k]; base.radiusOuter = overrides[k] * 2.6; base.radiusInner = Math.max(overrides[k] * 0.6, 120); }
      else if (k === 'height') { base.height = overrides[k]; base.heightStart = overrides[k] * 2.4; base.heightEnd = overrides[k]; }
      else base[k] = overrides[k];
    }
    this.params = base;
  }

  // anchor + east·e + north·n + up·u  →  an ECEF point.
  _local(e, n, u) {
    return this.anchor.clone()
      .addScaledVector(this.east, e)
      .addScaledVector(this.north, n)
      .addScaledVector(this.up, u);
  }

  getTarget(/* t */) { return this._local(0, 0, this.params.targetHeight ?? 20); }

  getPosition(t) {
    const p = this.params;

    if (this.preset === 'orbit') {
      const az = (p.startDeg + 360 * p.turns * t) * DEG2RAD;
      return this._local(p.radius * Math.sin(az), p.radius * Math.cos(az), p.height);
    }

    if (this.preset === 'spiral') {
      // Geometric (exponential) radius interpolation → a constant shrink ratio
      // per turn, i.e. a true logarithmic vortex rather than a flat ramp.
      const ratio = Math.max(1e-3, p.radiusInner / p.radiusOuter);
      const R = p.radiusOuter * Math.pow(ratio, t);
      const az = (p.startDeg + 360 * p.turns * t) * DEG2RAD;
      const H = p.heightStart + (p.heightEnd - p.heightStart) * smoothstep(t);
      return this._local(R * Math.sin(az), R * Math.cos(az), H);
    }

    // flyto: a straight eased approach from a far point into the orbit's entry
    // pose, then a seamless hand-off into the orbit loop. The approach lands on
    // the exact orbit-entry position (no positional snap); smoothstep eases the
    // approach so the camera arrives gently before the orbit takes over.
    const hook = p.hook;
    const entryAz = p.startDeg * DEG2RAD;
    const entry = this._local(p.radius * Math.sin(entryAz), p.radius * Math.cos(entryAz), p.height);
    if (t <= hook) {
      const bz = p.flyBearingDeg * DEG2RAD;
      const start = this._local(p.flyDist * Math.sin(bz), p.flyDist * Math.cos(bz), p.flyHeight);
      return start.lerp(entry, smoothstep(t / hook));
    }
    const tt = (t - hook) / (1 - hook);
    const az = (p.startDeg + 360 * p.turns * tt) * DEG2RAD;
    return this._local(p.radius * Math.sin(az), p.radius * Math.cos(az), p.height);
  }

  // Drive a three camera at normalised time t. ECEF "up" is radial.
  applyToCamera(camera, t) {
    const pos = this.getPosition(t);
    camera.position.copy(pos);
    camera.up.copy(pos).normalize();
    camera.lookAt(this.getTarget(t));
  }
}

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
          setNavEnabled, beginCaptureResolution, endCaptureResolution } = ctx;

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
  section.open = true;
  section.innerHTML = `
    <summary>🎬 Cine &amp; captura Splat</summary>
    <div class="g3d-sec-body">
      <label title="Preset de trayectoria de cámara.">🎞 Preset
        <select id="g3d-cine-preset" class="g3d-cine-select">
          <option value="orbit">🛰 Órbita 360°</option>
          <option value="spiral">🌀 Espiral (vórtice)</option>
          <option value="flyto">🎯 Zoom In + Órbita</option>
        </select>
      </label>
      <label title="Radio de la órbita en metros. Vacío = automático según el alto del edificio.">📏 Radio
        <input type="number" id="g3d-cine-radius" min="20" max="3000" step="10" placeholder="auto">
        <span class="g3d-cine-unit">m</span>
      </label>
      <label title="Altura de cámara sobre el suelo, en metros. Vacío = automático.">🛗 Altura
        <input type="number" id="g3d-cine-height" min="5" max="3000" step="10" placeholder="auto">
        <span class="g3d-cine-unit">m</span>
      </label>
      <div class="g3d-check-row">
        <label title="Reproduce el preset en bucle infinito para presentaciones en vivo."><input type="checkbox" id="g3d-cine-preview"> Modo Presentación</label>
        <label title="Segundos por vuelta del bucle de presentación.">⏱<input type="number" id="g3d-cine-loopsecs" min="4" max="120" step="1" value="24" style="width:46px"></label>
      </div>
      <div class="g3d-cine-row">
        <label title="Duración de la secuencia a capturar, en segundos.">Duración<input type="number" id="g3d-cine-dur" min="1" max="120" step="1" value="8"></label>
        <label title="Cuadros por segundo del dataset.">FPS<input type="number" id="g3d-cine-fps" min="6" max="60" step="1" value="24"></label>
      </div>
      <div class="g3d-hint" id="g3d-cine-estimate">192 frames · 4K (3840×2160)</div>
      <button id="g3d-cine-go" class="g3d-cine-go">🎬 Generar Secuencia Splat</button>
      <div class="g3d-hint">Captura cuadro-a-cuadro esperando a que cada vista de los tiles de Maxar termine de cargar. Salida: un ZIP con los JPG 4K + <b>cameras.json</b> (poses) para Gaussian Splatting.</div>
    </div>`;
  const saveBtn = ctx.hudParent.querySelector('#g3d-save');
  ctx.hudParent.insertBefore(section, saveBtn || null);

  const $ = (id) => section.querySelector('#' + id);
  const presetSel = $('g3d-cine-preset');
  const radiusInp = $('g3d-cine-radius');
  const heightInp = $('g3d-cine-height');
  const previewChk = $('g3d-cine-preview');
  const loopSecsInp = $('g3d-cine-loopsecs');
  const durInp = $('g3d-cine-dur');
  const fpsInp = $('g3d-cine-fps');
  const estimateEl = $('g3d-cine-estimate');
  const goBtn = $('g3d-cine-go');

  const overrides = () => {
    const r = parseFloat(radiusInp.value), h = parseFloat(heightInp.value);
    const o = {};
    if (Number.isFinite(r)) o.radius = r;
    if (Number.isFinite(h)) o.height = h;
    return o;
  };
  const totalFrames = () => Math.max(1, Math.round((parseFloat(durInp.value) || 8) * (parseFloat(fpsInp.value) || 24)));
  const refreshEstimate = () => {
    const n = totalFrames();
    estimateEl.textContent = `${n} frames · 4K (3840×2160) · ~${Math.ceil(n * 1.4)} MB aprox.`;
  };
  [durInp, fpsInp].forEach((el) => el.addEventListener('input', refreshEstimate));
  refreshEstimate();

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
      if (!f) { previewChk.checked = false; alert('Primero anclá el edificio (⇧+click sobre el suelo Maxar) para definir el centro de la órbita.'); return; }
      animator.setFrame(f);
      animator.setPreset(presetSel.value, overrides());
      state.previewSecs = Math.max(4, parseFloat(loopSecsInp.value) || 24);
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
    state.previewSecs = Math.max(4, parseFloat(loopSecsInp.value) || 24);
    state.previewStart = performance.now() - tNow * state.previewSecs * 1000;
  });

  // Called every frame by the host loop. Returns true if it positioned the
  // camera (host then skips controls.update so OrbitControls doesn't fight it).
  function tickPreview(now) {
    if (!state.previewOn) return false;
    const t = ((now - state.previewStart) / 1000 / state.previewSecs) % 1;
    animator.applyToCamera(camera, t);
    return true;
  }

  // ── Modal progress overlay ─────────────────────────────────────────────────
  let modal = null;
  function showModal() {
    modal = document.createElement('div');
    modal.className = 'g3d-cine-modal';
    modal.innerHTML = `
      <div class="g3d-cine-card">
        <div class="g3d-cine-title">🎬 Generando secuencia Splat</div>
        <div class="g3d-cine-frame" id="g3d-cine-frame">Frame 0 / 0</div>
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
    modal.querySelector('#g3d-cine-frame').textContent = `Frame ${i} / ${n}`;
    modal.querySelector('#g3d-cine-fill').style.width = pct + '%';
    if (sub != null) modal.querySelector('#g3d-cine-sub').textContent = sub;
  }
  function hideModal() { modal?.remove(); modal = null; }

  // ── Deterministic frame-stepper ────────────────────────────────────────────
  const CAP_W = 3840, CAP_H = 2160;            // 4K
  const JPEG_Q = 0.95;
  const PER_FRAME_TIMEOUT = 9000;              // ms; never hang on a stuck tile
  const SETTLE_FRAMES = 3;                     // consecutive "0 pending" before grab
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextRAF = () => new Promise((r) => requestAnimationFrame(() => r()));
  const toBlob = (q) => new Promise((res) => canvas.toBlob(res, 'image/jpeg', q));

  async function captureSequence(presetType, frames, fps) {
    const frame = getFrame();
    if (!frame) { alert('Primero anclá el edificio (⇧+click sobre el suelo Maxar) para definir el centro de la cámara.'); return; }

    state.capturing = true;
    state.cancel = false;
    if (state.previewOn) stopPreview();
    setNavEnabled(false);
    showModal();

    animator.setFrame(frame);
    animator.setPreset(presetType, overrides());

    // Save camera/aspect to restore the live view afterwards.
    const saved = {
      pos: camera.position.clone(), up: camera.up.clone(),
      quat: camera.quaternion.clone(), aspect: camera.aspect, fov: camera.fov,
    };

    const captured = [];            // { name, data:Uint8Array }
    const poses = [];               // per-frame camera record (ENU-local)
    let aborted = false;

    try {
      beginCaptureResolution(CAP_W, CAP_H);
      await nextRAF();

      for (let i = 0; i < frames; i++) {
        if (state.cancel) { aborted = true; break; }
        const t = i / frames;       // [0,1) — for orbit this avoids a duplicate 0/360 frame
        animator.applyToCamera(camera, t);
        camera.updateMatrixWorld();

        // Stream the 3D Tiles for THIS exact view to completion (or timeout).
        updateModal(i, frames, 'Cargando tiles de Maxar para el cuadro…');
        const deadline = performance.now() + PER_FRAME_TIMEOUT;
        let settled = 0;
        for (;;) {
          updateTiles();
          const pending = tilesPending();
          if (pending <= 0) { if (++settled >= SETTLE_FRAMES) break; }
          else settled = 0;
          if (performance.now() > deadline) break;
          if (state.cancel) { aborted = true; break; }
          await delay(16);
        }
        if (aborted) break;

        // Render + read back the pixel buffer (preserveDrawingBuffer is on).
        renderFrame();
        await nextRAF();
        const blob = await toBlob(JPEG_Q);
        const buf = new Uint8Array(await blob.arrayBuffer());
        const name = 'images/frame_' + String(i + 1).padStart(4, '0') + '.jpg';
        captured.push({ name, data: buf });
        poses.push(poseRecord(i + 1, name, t, frame));

        updateModal(i + 1, frames, `Capturado · ${(buf.length / 1024 | 0)} KB`);
        await delay(0);             // yield so the modal repaints
      }
    } catch (err) {
      console.error('[capture] error', err);
      alert('Error durante la captura: ' + err.message);
    } finally {
      endCaptureResolution();
      // Restore the live camera so the viewport doesn't jump.
      camera.aspect = saved.aspect; camera.fov = saved.fov; camera.updateProjectionMatrix();
      camera.position.copy(saved.pos); camera.up.copy(saved.up); camera.quaternion.copy(saved.quat);
      setNavEnabled(true);
      state.capturing = false;
    }

    if (captured.length === 0) { hideModal(); return; }

    updateModal(captured.length, frames, 'Empaquetando ZIP…');
    await delay(0);
    const stamp = stampNow();
    const meta = buildCamerasJson(presetType, fps, captured.length, CAP_W, CAP_H, camera.fov, frame, poses);
    captured.push({ name: 'cameras.json', data: new TextEncoder().encode(JSON.stringify(meta, null, 2)) });
    captured.push({ name: 'README.txt', data: new TextEncoder().encode(README) });
    const zip = zipStore(captured);
    downloadBlob(zip, `bizual-splat-${stamp}.zip`);
    updateModal(captured.length, frames, aborted ? 'Cancelado — ZIP parcial descargado.' : '✅ Listo — ZIP descargado.');
    await delay(1400);
    hideModal();
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

  goBtn.addEventListener('click', () => {
    if (state.capturing) return;
    const n = totalFrames();
    const fps = parseFloat(fpsInp.value) || 24;
    if (n > 240 && !confirm(`Vas a capturar ${n} cuadros en 4K. Eso puede usar bastante memoria (~${Math.ceil(n * 1.4)} MB) y tardar varios minutos. ¿Continuar?`)) return;
    if (!confirm(`Generar secuencia "${presetSel.options[presetSel.selectedIndex].text}" → ${n} cuadros @ ${fps} fps en 4K.\n\nNo muevas la ventana durante el proceso. ¿Empezar?`)) return;
    captureSequence(presetSel.value, n, fps);
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

const README =
`Bizual — Cinematic Capture (dataset para Gaussian Splatting)
============================================================
images/frame_XXXX.jpg  — cuadros 4K en orden de trayectoria.
cameras.json           — poses por cuadro (posición, target, up) en el frame
                         ENU local (metros) relativo al anchor del edificio,
                         más los intrínsecos de cámara (pinhole).

Para PlayCanvas / gsplat: construí las extrínsecas con lookAt(position, target,
up) por cuadro. Los intrínsecos (fl_x, fl_y, cx, cy, width, height) están en
cameras.json. Pixeles cuadrados, sin distorsión.
`;

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
