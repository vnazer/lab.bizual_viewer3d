// ─── CinematicAnimator ──────────────────────────────────────────────────────
// Portable, dependency-light camera-trajectory engine. The ONLY dependency is
// three.js — no DOM, no renderer, no tiles, no capture. It computes camera
// position + look-at target over a normalised timeline t ∈ [0,1] for a library
// of real-estate presets (orbit, 90/180 pans, spiral vortex, fly-to, aerial
// reveal, dolly-in, façade pan, top-down→oblique).
//
// It is deliberately split out of capture-engine.js so the SAME math can drive:
//   • the lab viewer (preview loop + headless capture), and
//   • the Bizual client viewer on AWS (replay a saved animation),
// from one source of truth.
//
// ── Coordinate frame contract ───────────────────────────────────────────────
// All math runs in a LOCAL ENU frame around a ground anchor, so an "orbit" is a
// real horizontal circle and "altitude" is metres above that point. The host
// builds the frame (in whatever world space its scene uses — ECEF here) and
// passes it in:
//   frame = {
//     anchor: THREE.Vector3,   // building base point in world space
//     east:   THREE.Vector3,   // unit east  axis at the anchor
//     north:  THREE.Vector3,   // unit north axis at the anchor
//     up:     THREE.Vector3,   // unit up    axis at the anchor (radial in ECEF)
//     height: Number,          // building height in metres (for auto radius/alt)
//   }
// A local offset (e, n, u) metres maps to world: anchor + east·e + north·n + up·u.
//
// ── AWS replay usage ────────────────────────────────────────────────────────
//   import { CinematicAnimator } from './cinematic-animator.js';
//   const anim = new CinematicAnimator(frame);
//   anim.applyAnimationConfig(savedConfig);          // { preset, radius, height }
//   // in the render loop, looping every config.durationSec seconds:
//   const t = ((now - start) / 1000 / cfg.durationSec) % 1;
//   anim.applyToCamera(camera, t);                   // sets position/up/lookAt
// `frame` can be refreshed any time with anim.setFrame(frame) (e.g. if the
// building moves); presets and overrides are re-derived from the building size.

import * as THREE from 'three';

const DEG2RAD = Math.PI / 180;
const smoothstep = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };

// Built-in animation library. `dur` is a sensible default duration (s) the HUD
// auto-fills when the preset is picked. `v` is the stable id stored in configs.
export const PRESETS = [
  { v: 'orbit',   label: '🛰 Órbita 360°',            dur: 16 },
  { v: 'pan90',   label: '↔ Paneo 90°',               dur: 5  },
  { v: 'pan180',  label: '↔ Paneo 180°',              dur: 8  },
  { v: 'spiral',  label: '🌀 Espiral (vórtice)',       dur: 18 },
  { v: 'flyto',   label: '🎯 Zoom In + Órbita',        dur: 12 },
  { v: 'reveal',  label: '🏙 Reveal aéreo',            dur: 14 },
  { v: 'dolly',   label: '🎥 Acercamiento (dolly-in)', dur: 8  },
  { v: 'facade',  label: '🏢 Fachada (paneo frontal)', dur: 9  },
  { v: 'topdown', label: '🛸 Top-down → oblicua',      dur: 12 },
];

// Pure math over t ∈ [0,1] — identical in preview, headless capture and replay.
export class CinematicAnimator {
  constructor(frame) { this.setFrame(frame); this.preset = 'orbit'; this.params = this.defaultsFor('orbit'); }

  // frame = { anchor:Vec3, east:Vec3, north:Vec3, up:Vec3, height:Number(m) }
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
    const base = { radius: R, height: H, targetHeight: tH, startDeg: 0, arcDeg: 360 };
    switch (type) {
      case 'pan90':  return { ...base, arcDeg: 90 };
      case 'pan180': return { ...base, arcDeg: 180 };
      case 'spiral': return {
        radiusOuter: Math.max(R * 2.6, 800), radiusInner: Math.max(R * 0.7, 180),
        heightStart: Math.max(H * 2.4, 600), heightEnd: H,
        targetHeight: tH, startDeg: 0, arcDeg: 900,   // ~2.5 turns
      };
      case 'flyto': return {
        radius: R, height: H, targetHeight: tH, startDeg: 0, arcDeg: 306,
        flyDist: Math.max(R * 4, 1500), flyHeight: Math.max(H * 3, 700),
        flyBearingDeg: 205, hook: 0.45,
      };
      case 'reveal': return {       // aerial reveal: descend + sweep
        radiusFar: Math.max(R * 2.2, 700), radiusNear: R,
        heightHigh: Math.max(H * 3, 650), heightLow: H,
        targetHeight: tH, startDeg: 0, arcDeg: 220,
      };
      case 'dolly': return {        // straight push-in from a bearing
        radiusFar: Math.max(R * 3, 900), radiusNear: Math.max(R * 0.45, 55),
        height: H, targetHeight: tH, startDeg: 200, arcDeg: 0,
      };
      case 'facade': return {       // frontal lateral pan (short arc)
        radius: Math.max(R * 0.95, 90), height: THREE.MathUtils.clamp(bh * 0.6, 20, 220),
        targetHeight: THREE.MathUtils.clamp(bh * 0.5, 10, 160), startDeg: 0, arcDeg: 70,
      };
      case 'topdown': return {      // nadir → oblique, descending + rotating
        radiusStart: Math.max(R * 0.4, 40), radiusEnd: R,
        heightStart: Math.max(H * 4, 900), heightEnd: H,
        targetHeight: tH, startDeg: 0, arcDeg: 130,
      };
      default: return base;         // orbit (arcDeg 360)
    }
  }

  // Apply preset + optional overrides (radius/height come from the HUD/config).
  setPreset(type, overrides = {}) {
    this.preset = type;
    const b = this.defaultsFor(type);
    const r = overrides.radius, h = overrides.height;
    if (Number.isFinite(r)) {        // scale every radius field off the one knob
      b.radius = r;
      b.radiusOuter = r * 2.6; b.radiusInner = Math.max(r * 0.6, 90);
      b.radiusFar = r * 2.4;   b.radiusNear = Math.max(r * 0.45, 45);
      b.radiusStart = Math.max(r * 0.4, 30); b.radiusEnd = r;
    }
    if (Number.isFinite(h)) {
      b.height = h;
      b.heightStart = h * 2.4; b.heightEnd = h;
      b.heightHigh = h * 3;    b.heightLow = h;
    }
    for (const k of Object.keys(overrides)) {
      if (k === 'radius' || k === 'height') continue;
      const v = overrides[k];
      if (v != null && !Number.isNaN(v)) b[k] = v;
    }
    this.params = b;
    return this;
  }

  // Configure from a saved-animation config object (the portable JSON shape):
  //   { preset, radius?, height?, ... }  — extra fields (durationSec/fps/output)
  // are playback/UI concerns and ignored here.
  applyAnimationConfig(config = {}) {
    return this.setPreset(config.preset || 'orbit', {
      radius: config.radius != null ? config.radius : undefined,
      height: config.height != null ? config.height : undefined,
    });
  }

  // anchor + east·e + north·n + up·u  →  a world point.
  _local(e, n, u) {
    return this.anchor.clone()
      .addScaledVector(this.east, e)
      .addScaledVector(this.north, n)
      .addScaledVector(this.up, u);
  }

  getTarget(/* t */) { return this._local(0, 0, this.params.targetHeight ?? 20); }

  // Polar track {R, az(deg), H} shared by every preset except flyto's approach.
  _polar(t) {
    const p = this.params;
    const sm = smoothstep(t);
    switch (this.preset) {
      case 'spiral': {
        // Geometric (exponential) radius → constant shrink ratio per turn = a
        // true logarithmic vortex rather than a flat ramp.
        const ratio = Math.max(1e-3, p.radiusInner / p.radiusOuter);
        return { R: p.radiusOuter * Math.pow(ratio, t), az: p.startDeg + p.arcDeg * t,
                 H: p.heightStart + (p.heightEnd - p.heightStart) * sm };
      }
      case 'reveal':
        return { R: p.radiusFar + (p.radiusNear - p.radiusFar) * sm, az: p.startDeg + p.arcDeg * t,
                 H: p.heightHigh + (p.heightLow - p.heightHigh) * sm };
      case 'dolly':
        return { R: p.radiusFar + (p.radiusNear - p.radiusFar) * sm, az: p.startDeg, H: p.height };
      case 'facade':
        return { R: p.radius, az: p.startDeg - p.arcDeg / 2 + p.arcDeg * t, H: p.height };
      case 'topdown':
        return { R: p.radiusStart + (p.radiusEnd - p.radiusStart) * sm, az: p.startDeg + p.arcDeg * t,
                 H: p.heightStart + (p.heightEnd - p.heightStart) * sm };
      default: // orbit, pan90, pan180
        return { R: p.radius, az: p.startDeg + (p.arcDeg ?? 360) * t, H: p.height };
    }
  }

  getPosition(t) {
    const p = this.params;
    // flyto: a straight eased approach from a far point that lands exactly on
    // the orbit's entry pose (no positional snap), then orbits.
    if (this.preset === 'flyto') {
      const hook = p.hook;
      const entryAz = p.startDeg * DEG2RAD;
      const entry = this._local(p.radius * Math.sin(entryAz), p.radius * Math.cos(entryAz), p.height);
      if (t <= hook) {
        const bz = p.flyBearingDeg * DEG2RAD;
        const start = this._local(p.flyDist * Math.sin(bz), p.flyDist * Math.cos(bz), p.flyHeight);
        return start.lerp(entry, smoothstep(t / hook));
      }
      const tt = (t - hook) / (1 - hook);
      const az = (p.startDeg + p.arcDeg * tt) * DEG2RAD;
      return this._local(p.radius * Math.sin(az), p.radius * Math.cos(az), p.height);
    }
    const { R, az, H } = this._polar(t);
    const a = az * DEG2RAD;
    return this._local(R * Math.sin(a), R * Math.cos(a), H);
  }

  // Drive a three camera at normalised time t. ENU "up" is radial in ECEF.
  applyToCamera(camera, t) {
    const pos = this.getPosition(t);
    camera.position.copy(pos);
    camera.up.copy(pos).normalize();
    camera.lookAt(this.getTarget(t));
  }
}
