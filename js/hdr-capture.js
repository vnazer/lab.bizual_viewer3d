// ─── HDR environment capture (equirectangular .hdr / .exr) ──────────────────
// Captures a 360° equirectangular environment map from the Google 3D Tiles
// scene at the building's location, to reuse as an IBL / reflection / background
// env map in the production micro-site viewer.
//
// ⚠️ IMPORTANT — dynamic range: Google's photorealistic tiles are LDR (8-bit).
// A raw cubemap capture therefore yields a .hdr with no real dynamic range
// (great for reflections/background, useless for physically-correct lighting).
// For pro quality use the HYBRID mode: it composites the captured real tiles
// with a synthetic HDR procedural sky + a bright directional sun (radiance ≫1),
// so the resulting .hdr has genuine dynamic range for image-based lighting.
//
// Convention of the output equirect (documented for downstream consumers):
//   • 2:1, top row = zenith, bottom row = nadir, centre column faces NORTH,
//     azimuth increases toward EAST. Built in the local ENU frame around the
//     anchor, so it's correct despite the scene being in ECEF (up = radial).
// Output is a standard Radiance .hdr (RGBE, RLE) that three's RGBELoader loads
// unmodified, or an .exr via three's EXRExporter.

import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// ─── float → RGBE (Radiance) encoder ────────────────────────────────────────
function frexp(value) {
  if (value === 0 || !isFinite(value)) return [value, 0];
  const abs = Math.abs(value);
  let e = Math.max(-1023, Math.floor(Math.log2(abs)) + 1);
  let m = value / Math.pow(2, e);
  while (Math.abs(m) >= 1) { m *= 0.5; e++; }     // normalise mantissa to [0.5,1)
  while (Math.abs(m) < 0.5) { m *= 2; e--; }
  return [m, e];
}

// Write one float RGB triple as 4 RGBE bytes into out[o..o+3].
function floatToRGBE(r, g, b, out, o) {
  const v = Math.max(r, g, b, 0);
  if (v < 1e-32) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; return; }
  const [m, e] = frexp(v);
  const scale = (m * 256.0) / v;                  // canonical Radiance float→rgbe
  out[o]     = Math.min(255, Math.max(0, Math.floor(r * scale)));
  out[o + 1] = Math.min(255, Math.max(0, Math.floor(g * scale)));
  out[o + 2] = Math.min(255, Math.max(0, Math.floor(b * scale)));
  out[o + 3] = Math.min(255, Math.max(0, e + 128));
}

// Adaptive RLE of one RGBE component across a scanline (standard Radiance).
function rleComponent(data, width, push) {
  let cur = 0;
  while (cur < width) {
    // Find the start of the next run of ≥4 identical bytes (bounds the literal).
    let runStart = cur;
    while (runStart < width) {
      let run = 1;
      while (runStart + run < width && run < 127 && data[runStart + run] === data[runStart]) run++;
      if (run >= 4) break;
      runStart += run;
    }
    // Emit the literal block [cur, runStart) in ≤128-byte chunks.
    while (cur < runStart) {
      const lit = Math.min(128, runStart - cur);
      push(lit);                                    // count 1..128 (high bit clear)
      for (let k = 0; k < lit; k++) push(data[cur + k]);
      cur += lit;
    }
    // Emit the run at runStart, if any.
    if (runStart < width) {
      let run = 1;
      while (runStart + run < width && run < 127 && data[runStart + run] === data[runStart]) run++;
      push(128 + run);                              // count with high bit set
      push(data[runStart]);
      cur = runStart + run;
    }
  }
}

// Encode RGBA float pixels (WebGL bottom-up rows) → Radiance .hdr byte array.
export function encodeHDR(floatRGBA, width, height) {
  const header = `#?RADIANCE\n# Made by Bizual lab viewer\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`;
  const bytes = [];
  const enc = new TextEncoder();
  enc.encode(header).forEach((b) => bytes.push(b));
  const comp = [new Uint8Array(width), new Uint8Array(width), new Uint8Array(width), new Uint8Array(width)];
  const rgbe = new Uint8Array(4);
  const push = (b) => bytes.push(b & 0xff);
  for (let y = 0; y < height; y++) {
    const srcY = height - 1 - y;                    // flip: WebGL reads bottom→top, .hdr is top→bottom
    for (let x = 0; x < width; x++) {
      const i = (srcY * width + x) * 4;
      floatToRGBE(floatRGBA[i], floatRGBA[i + 1], floatRGBA[i + 2], rgbe, 0);
      comp[0][x] = rgbe[0]; comp[1][x] = rgbe[1]; comp[2][x] = rgbe[2]; comp[3][x] = rgbe[3];
    }
    // New-format scanline header + 4 RLE components.
    push(2); push(2); push((width >> 8) & 0xff); push(width & 0xff);
    for (let c = 0; c < 4; c++) rleComponent(comp[c], width, push);
  }
  return new Uint8Array(bytes);
}

// IEEE half (uint16) → float, for reading HalfFloat render targets.
function halfToFloat(h) {
  const s = (h & 0x8000) >> 15, e = (h & 0x7c00) >> 10, f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : (s ? -Infinity : Infinity);
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

function readRTFloat(renderer, rt, W, H) {
  if (rt.texture.type === THREE.FloatType) {
    const buf = new Float32Array(W * H * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
    return buf;
  }
  const half = new Uint16Array(W * H * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, half);
  const buf = new Float32Array(W * H * 4);
  for (let i = 0; i < buf.length; i++) buf[i] = halfToFloat(half[i]);
  return buf;
}

// ─── shaders ─────────────────────────────────────────────────────────────────
const EQUIRECT_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const EQUIRECT_FRAG = `
  precision highp float;
  uniform samplerCube envMap; uniform vec3 uEast, uNorth, uUp;
  varying vec2 vUv;
  #define PI 3.141592653589793
  void main(){
    // u → azimuth (0.5 = north, increasing toward east); v → polar (1 = zenith).
    float phi   = (vUv.x - 0.5) * 2.0 * PI;
    float theta = (1.0 - vUv.y) * PI;
    float st = sin(theta), ct = cos(theta);
    vec3 dir = normalize(uUp * ct + uNorth * (st * cos(phi)) + uEast * (st * sin(phi)));
    gl_FragColor = textureCube(envMap, dir);
  }`;

const SKY_VERT = `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SKY_FRAG = `
  precision highp float;
  varying vec3 vDir;
  uniform vec3 uUp, uSunDir, uSunColor; uniform float uSunInt, uDay;
  void main(){
    vec3 d = normalize(vDir);
    float h = clamp(dot(d, uUp), -1.0, 1.0);
    float up01 = clamp(h * 0.5 + 0.5, 0.0, 1.0);
    vec3 zenith  = vec3(0.20, 0.38, 0.78);
    vec3 horizon = vec3(0.72, 0.80, 0.95);
    vec3 sky = mix(horizon, zenith, pow(up01, 0.45)) * (1.6 + 2.4 * uDay);
    sky = mix(vec3(0.05, 0.05, 0.06), sky, smoothstep(-0.15, 0.05, h));  // dim ground
    float c = dot(d, uSunDir);
    float disk = smoothstep(0.99965, 0.99986, c);    // ~1.3° sun disk
    float glow = pow(max(c, 0.0), 350.0);
    vec3 col = sky + uSunColor * (disk * uSunInt + glow * uSunInt * 0.06);
    gl_FragColor = vec4(max(col, 0.0), 1.0);
  }`;

function makeHdrSky(point, up, sun) {
  const geo = new THREE.SphereGeometry(16000, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false, toneMapped: false,
    uniforms: {
      uUp:      { value: up.clone().normalize() },
      uSunDir:  { value: sun.dir.clone().normalize() },
      uSunColor:{ value: new THREE.Color(sun.color || 0xffffff) },
      uSunInt:  { value: sun.isNight ? 0.0 : (sun.sunIntensity != null ? sun.sunIntensity : 90.0) },
      uDay:     { value: sun.isNight ? 0.0 : 1.0 },
    },
    vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(point);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;   // background: draw first; opaque tiles overwrite it (sky writes no depth)
  return { mesh, dispose() { geo.dispose(); mat.dispose(); } };
}

// ─── tile streaming: force HD around the capture point in all directions ─────
async function waitTilesHD(tiles, cubeCam, faceRes, timeoutMs, onPending, isCancelled) {
  const cams = cubeCam.children.slice();           // 6 face cameras (±X±Y±Z)
  const registered = [];
  try {
    for (const c of cams) { tiles.setCamera(c); tiles.setResolution?.(c, faceRes, faceRes); registered.push(c); }
  } catch { /* multi-camera unsupported — fall back to the main camera's LOD */ }
  const deadline = performance.now() + timeoutMs;
  let settled = 0, partial = false;
  for (;;) {
    if (isCancelled()) break;
    try { tiles.update(); } catch {}
    const pend = (tiles.stats?.downloading || 0) + (tiles.stats?.parsing || 0);
    onPending(pend);
    if (pend <= 0) { if (++settled >= 4) break; } else settled = 0;
    if (performance.now() > deadline) { partial = true; break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  for (const c of registered) { try { tiles.deleteCamera(c); } catch {} }
  return { partial };
}

async function encodeEXR(renderer, rt) {
  try {
    const { EXRExporter } = await import('three/addons/exporters/EXRExporter.js');
    const exporter = new EXRExporter();
    let res = exporter.parse(renderer, rt, { type: THREE.HalfFloatType });
    if (res && typeof res.then === 'function') res = await res;
    return new Blob([res], { type: 'image/x-exr' });
  } catch (e) {
    console.warn('[hdr] EXR export failed → falling back to .hdr', e);
    return null;
  }
}

// ─── core capture pipeline ───────────────────────────────────────────────────
// Returns { blob, ext, W, H, partial }. Restores ALL state + disposes temporaries
// in the finally block (no leaks), even on error / context loss.
async function captureEnvironmentHDR(opts) {
  const {
    renderer, scene, tiles, point, east, north, up, faceRes, includeSky, sun,
    format, modelRoot, skySphere, getErrorTarget, setErrorTarget, minErrorTarget,
    onProgress, isCancelled,
  } = opts;

  const prevTone = renderer.toneMapping;
  const prevErr = getErrorTarget();
  const prevModelVis = modelRoot ? modelRoot.visible : null;
  const prevSky = skySphere
    ? { pos: skySphere.position.clone(), up: skySphere.material.uniforms.upDir.value.clone(), visible: skySphere.visible }
    : null;

  let tempSky = null, cubeRT = null, cubeCam = null, equirectRT = null, fsQuad = null, mat = null;
  try {
    if (modelRoot) modelRoot.visible = false;        // keep the building out of its own env map
    // Replace the camera-following gradient sky with a stable sky pinned at the
    // capture point — the main render loop keeps moving skySphere during the
    // async tile wait, which would clobber a capture-time reposition. Hybrid =
    // bright HDR sun (real dynamic range); otherwise a plain dim gradient
    // (pseudo-HDR, per the LDR-tiles limitation documented at the top).
    if (skySphere) skySphere.visible = false;
    tempSky = makeHdrSky(point, up, { dir: sun.dir, color: sun.color, isNight: sun.isNight, sunIntensity: includeSky ? 90 : 0 });
    scene.add(tempSky.mesh);

    // 1) Force max-detail tiles around the point and wait for them to stream in.
    onProgress('Cargando tiles HD…', 0.05);
    setErrorTarget(minErrorTarget);
    cubeRT = new THREE.WebGLCubeRenderTarget(faceRes, { type: THREE.HalfFloatType });
    cubeRT.texture.colorSpace = THREE.LinearSRGBColorSpace;
    cubeRT.texture.minFilter = THREE.LinearFilter;
    cubeRT.texture.magFilter = THREE.LinearFilter;
    cubeRT.texture.generateMipmaps = false;
    cubeCam = new THREE.CubeCamera(1, 1e6, cubeRT);   // far covers distant terrain (log depth)
    cubeCam.position.copy(point);
    cubeCam.updateMatrixWorld(true);
    const { partial } = await waitTilesHD(
      tiles, cubeCam, faceRes, 30000,
      (pend) => onProgress(`Cargando tiles HD… (${pend} pendientes)`, 0.05 + 0.3 * (pend > 0 ? 0.5 : 1)),
      isCancelled,
    );
    if (isCancelled()) return null;

    // 2) Render the cubemap in LINEAR space (tone mapping off → preserve HDR).
    onProgress('Renderizando cubemap…', 0.45);
    renderer.toneMapping = THREE.NoToneMapping;
    cubeCam.update(renderer, scene);
    renderer.toneMapping = prevTone;   // restore now; the equirect pass is a raw shader (no tonemap)

    // 3) Project the cube to a 2:1 equirect float render target.
    onProgress('Proyectando equirectangular…', 0.6);
    const W = faceRes * 2, H = faceRes;
    const floatRenderable = renderer.extensions.has('EXT_color_buffer_float');
    equirectRT = new THREE.WebGLRenderTarget(W, H, {
      type: floatRenderable ? THREE.FloatType : THREE.HalfFloatType,   // FloatType fallback → HalfFloat
      colorSpace: THREE.LinearSRGBColorSpace,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      generateMipmaps: false, depthBuffer: false, stencilBuffer: false,
    });
    mat = new THREE.ShaderMaterial({
      vertexShader: EQUIRECT_VERT, fragmentShader: EQUIRECT_FRAG, depthTest: false, depthWrite: false,
      uniforms: { envMap: { value: cubeRT.texture }, uEast: { value: east.clone() }, uNorth: { value: north.clone() }, uUp: { value: up.clone() } },
    });
    fsQuad = new FullScreenQuad(mat);
    renderer.setRenderTarget(equirectRT);
    fsQuad.render(renderer);
    renderer.setRenderTarget(null);

    // 4) Read float pixels + encode.
    onProgress('Codificando ' + (format === 'exr' ? 'EXR' : 'HDR') + '…', 0.8);
    let blob = null, ext = format;
    if (format === 'exr') blob = await encodeEXR(renderer, equirectRT);
    if (!blob) {
      const floatData = readRTFloat(renderer, equirectRT, W, H);
      blob = new Blob([encodeHDR(floatData, W, H)], { type: 'image/vnd.radiance' });
      ext = 'hdr';
    }
    return { blob, ext, W, H, partial };
  } finally {
    renderer.setRenderTarget(null);
    renderer.toneMapping = prevTone;
    setErrorTarget(prevErr);
    if (modelRoot && prevModelVis !== null) modelRoot.visible = prevModelVis;
    if (skySphere && prevSky) {
      skySphere.position.copy(prevSky.pos);
      skySphere.material.uniforms.upDir.value.copy(prevSky.up);
      skySphere.visible = prevSky.visible;
    }
    if (tempSky) { scene.remove(tempSky.mesh); tempSky.dispose(); }
    if (fsQuad) fsQuad.dispose();
    if (mat) mat.dispose();
    if (cubeRT) cubeRT.dispose();
    if (equirectRT) equirectRT.dispose();
  }
}

// ─── UI ──────────────────────────────────────────────────────────────────────
function slugify(s) {
  return (s || 'entorno').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')      // strip accents
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'entorno';
}
function dateStamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 6000);
}

// ctx: { renderer, scene, tiles, panelRoot, buttonId,
//        getCaptureBase()->Vec3, getFrame()->{east,north,up}, getBuildingHeight()->m,
//        getModelRoot()->Object3D|null, getSkySphere()->Mesh|null,
//        getSun(hour)->{dir,color,isNight}, getErrorTarget(), setErrorTarget(v),
//        minErrorTarget, initialHour, addrText }
export function mountHdrCapture(ctx) {
  const btn = document.getElementById(ctx.buttonId);
  if (!btn) return { dispose() {} };

  let modal = null, busy = false, cancelled = false;
  const close = () => { modal?.remove(); modal = null; };

  function openModal() {
    if (busy) return;
    const bh = Math.max(3, ctx.getBuildingHeight());
    const defH = Math.max(1.5, Math.round(bh / 2));
    modal = document.createElement('div');
    modal.className = 'g3d-cine-modal';
    modal.innerHTML = `
      <div class="g3d-cine-card g3d-hdr-card">
        <div class="g3d-cine-title">📸 Capturar HDR del entorno</div>
        <div class="g3d-hdr-form">
          <label title="Mayor resolución = más detalle, más tiempo de captura y archivo más pesado.">Resolución
            <select id="g3d-hdr-res" class="g3d-cine-select">
              <option value="1024">1024 (rápido)</option>
              <option value="2048" selected>2048 (recomendado)</option>
              <option value="4096">4096 (puede fallar en GPU limitada)</option>
            </select>
          </label>
          <label title="Altura del punto de captura sobre la base del edificio.">Altura captura
            <input type="range" id="g3d-hdr-height" min="1.5" max="${Math.round(bh)}" step="0.5" value="${defH}">
            <span id="g3d-hdr-height-val">${defH} m</span>
          </label>
          <label title="Hora del día para posicionar el sol del cielo procedural.">🕐 Hora
            <input type="range" id="g3d-hdr-hour" min="0" max="24" step="0.5" value="${(ctx.initialHour ?? 12).toFixed(1)}">
            <span id="g3d-hdr-hour-val"></span>
          </label>
          <label title="Formato del archivo. .hdr (Radiance RGBE) es el estándar para environment maps.">Formato
            <select id="g3d-hdr-format" class="g3d-cine-select">
              <option value="hdr" selected>.hdr (Radiance)</option>
              <option value="exr">.exr (OpenEXR)</option>
            </select>
          </label>
          <label class="g3d-hdr-check" title="Los tiles de Google son LDR (8-bit): sin esto el .hdr no tiene rango dinámico real y solo sirve para reflejos/fondo. Con el cielo procedural HDR + sol, el mapa ilumina físicamente (sol con valores ≫1).">
            <input type="checkbox" id="g3d-hdr-sky" checked> Incluir cielo procedural con sol (recomendado)
          </label>
          <div class="g3d-hint" id="g3d-hdr-note"></div>
        </div>
        <div class="g3d-hdr-progress" id="g3d-hdr-progress" style="display:none">
          <div class="g3d-cine-sub" id="g3d-hdr-stage">Preparando…</div>
          <div class="g3d-cine-track"><div class="g3d-cine-fill" id="g3d-hdr-fill"></div></div>
        </div>
        <div class="g3d-hdr-btns">
          <button class="g3d-cine-cancel" id="g3d-hdr-cancel">Cerrar</button>
          <button class="g3d-cine-go" id="g3d-hdr-go">Generar y descargar</button>
        </div>
      </div>`;
    ctx.panelRoot.appendChild(modal);

    const $ = (id) => modal.querySelector('#' + id);
    const resSel = $('g3d-hdr-res'), hInp = $('g3d-hdr-height'), hVal = $('g3d-hdr-height-val');
    const hourInp = $('g3d-hdr-hour'), hourVal = $('g3d-hdr-hour-val');
    const fmtSel = $('g3d-hdr-format'), skyChk = $('g3d-hdr-sky'), noteEl = $('g3d-hdr-note');
    const fmtHour = (v) => { const t = (Math.round(v * 60) % 1440 + 1440) % 1440; return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); };
    const refreshNote = () => {
      const r = parseInt(resSel.value, 10);
      noteEl.innerHTML = `Equirect <b>${r * 2}×${r}</b>. ${r >= 4096 ? '⚠️ 4096 puede fallar por memoria en GPUs limitadas — si falla, usá 2048.' : ''}`;
    };
    hInp.addEventListener('input', () => { hVal.textContent = hInp.value + ' m'; });
    hourInp.addEventListener('input', () => { hourVal.textContent = fmtHour(parseFloat(hourInp.value)); });
    resSel.addEventListener('change', refreshNote);
    hourVal.textContent = fmtHour(parseFloat(hourInp.value));
    refreshNote();

    $('g3d-hdr-cancel').addEventListener('click', () => { if (busy) { cancelled = true; } else close(); });
    $('g3d-hdr-go').addEventListener('click', () => run({
      faceRes: parseInt(resSel.value, 10),
      captureHeight: parseFloat(hInp.value),
      hour: parseFloat(hourInp.value),
      format: fmtSel.value,
      includeSky: skyChk.checked,
    }, { resSel, hInp, hourInp, fmtSel, skyChk, goBtn: $('g3d-hdr-go') }));
  }

  async function run(o, els) {
    if (busy) return;
    busy = true; cancelled = false;
    const form = modal.querySelector('.g3d-hdr-form');
    const prog = modal.querySelector('#g3d-hdr-progress');
    const stage = modal.querySelector('#g3d-hdr-stage');
    const fill = modal.querySelector('#g3d-hdr-fill');
    form.style.display = 'none'; prog.style.display = '';
    els.goBtn.disabled = true; els.goBtn.textContent = 'Generando…';
    const onProgress = (txt, pct) => { stage.textContent = txt; fill.style.width = Math.round((pct || 0) * 100) + '%'; };
    const t0 = performance.now();
    try {
      const base = ctx.getCaptureBase();
      const { east, north, up } = ctx.getFrame();
      const point = base.clone().addScaledVector(up, o.captureHeight);
      const sun = ctx.getSun(o.hour);
      const result = await captureEnvironmentHDR({
        renderer: ctx.renderer, scene: ctx.scene, tiles: ctx.tiles,
        point, east, north, up, faceRes: o.faceRes, includeSky: o.includeSky, sun,
        format: o.format, modelRoot: ctx.getModelRoot(), skySphere: ctx.getSkySphere(),
        getErrorTarget: ctx.getErrorTarget, setErrorTarget: ctx.setErrorTarget, minErrorTarget: ctx.minErrorTarget,
        onProgress, isCancelled: () => cancelled,
      });
      if (cancelled || !result) { onProgress('Cancelado.', 0); }
      else {
        const secs = ((performance.now() - t0) / 1000).toFixed(1);
        const mb = (result.blob.size / 1048576).toFixed(1);
        const name = `entorno_${slugify(ctx.addrText)}_${dateStamp()}.${result.ext}`;
        download(result.blob, name);
        onProgress(`✅ ${name} · ${result.W}×${result.H} · ${mb} MB · ${secs}s`, 1);
        if (result.partial) {
          const warn = document.createElement('div');
          warn.className = 'g3d-hint';
          warn.style.color = '#ffcf8a';
          warn.textContent = '⚠️ Captura con tiles parciales — algunas zonas pueden verse en baja resolución.';
          prog.appendChild(warn);
        }
      }
    } catch (e) {
      console.error('[hdr] capture failed', e);
      const lost = ctx.renderer.getContext()?.isContextLost?.();
      onProgress(lost ? '❌ Se perdió el contexto WebGL. Recargá la página y reintentá.' : ('❌ Error: ' + (e.message || e)), 0);
    } finally {
      busy = false;
      els.goBtn.disabled = false; els.goBtn.textContent = 'Generar de nuevo';
      modal.querySelector('#g3d-hdr-cancel').textContent = 'Cerrar';
      form.style.display = '';   // let the operator tweak + retry
    }
  }

  btn.addEventListener('click', openModal);
  return { dispose() { cancelled = true; close(); } };
}
