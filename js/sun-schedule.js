// Hour-of-day → sun parameters. Calibrated for Chile (~lat -33°, equinoccio).
// Shared by the lab viewer and the Mapbox env panel so both stay in sync.

import * as THREE from 'three';

// [hour, azimut°, elev°, sunIntensity, envIntensity, sunColorHex]
export const SUN_SCHEDULE = [
  [ 0,    0,  -35, 0.00, 0.04, '#111133'],
  [ 5,   68,   -8, 0.00, 0.07, '#221133'],
  [ 6,   80,    3, 0.50, 0.25, '#ff7722'],
  [ 7,   95,   16, 0.85, 0.50, '#ffaa55'],
  [ 8,  112,   30, 1.05, 0.72, '#ffd080'],
  [ 9,  130,   43, 1.20, 0.88, '#fff0c0'],
  [10,  150,   53, 1.30, 0.97, '#ffffff'],
  [11,  167,   59, 1.30, 1.05, '#ffffff'],
  [12,  180,   62, 1.25, 1.10, '#ffffff'],
  [13,  193,   59, 1.25, 1.05, '#ffffff'],
  [14,  212,   53, 1.20, 0.97, '#fff8ee'],
  [15,  230,   43, 1.10, 0.88, '#ffe8c0'],
  [16,  248,   30, 0.95, 0.72, '#ffcc80'],
  [17,  264,   16, 0.75, 0.50, '#ff9944'],
  [18,  278,    3, 0.45, 0.25, '#ff5511'],
  [19,  288,   -8, 0.00, 0.08, '#221133'],
  [20,  300,  -20, 0.00, 0.05, '#111133'],
  [24,  360,  -35, 0.00, 0.04, '#111133'],
];

function _expandHex(h) {
  h = h.replace('#', '');
  return h.length === 3 ? `${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}` : h;
}
export function lerpHexColor(hex1, hex2, t) {
  const a = _expandHex(hex1), b = _expandHex(hex2);
  const r1 = parseInt(a.slice(0, 2), 16), g1 = parseInt(a.slice(2, 4), 16), b1 = parseInt(a.slice(4, 6), 16);
  const r2 = parseInt(b.slice(0, 2), 16), g2 = parseInt(b.slice(2, 4), 16), b2_ = parseInt(b.slice(4, 6), 16);
  return ((Math.round(r1 + (r2 - r1) * t) << 16) | (Math.round(g1 + (g2 - g1) * t) << 8) | Math.round(b1 + (b2_ - b1) * t));
}

export function getSunParams(hour) {
  const h = ((hour % 24) + 24) % 24;
  let lo = SUN_SCHEDULE[0];
  let hi = SUN_SCHEDULE[SUN_SCHEDULE.length - 1];
  for (let i = 0; i < SUN_SCHEDULE.length - 1; i++) {
    if (SUN_SCHEDULE[i][0] <= h && h < SUN_SCHEDULE[i + 1][0]) {
      lo = SUN_SCHEDULE[i]; hi = SUN_SCHEDULE[i + 1]; break;
    }
  }
  const span = hi[0] - lo[0];
  const t = span === 0 ? 0 : (h - lo[0]) / span;
  const lerp = (a, b) => a + (b - a) * t;
  const elevation = lerp(lo[2], hi[2]);
  return {
    azimut:       lerp(lo[1], hi[1]),
    elevation,
    sunIntensity: Math.max(0, lerp(lo[3], hi[3])),
    envIntensity: lerp(lo[4], hi[4]),
    sunColor:     lerpHexColor(lo[5], hi[5], t),
    isNight:      elevation <= 0,
    isGoldenHour: (h >= 5.5 && h <= 7.5) || (h >= 17 && h <= 19),
  };
}

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
