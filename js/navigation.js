// First-person navigation + BVH-accelerated collision detection.
// Drop-in for the lab viewer: vanilla three.js, no React.

import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

// three-mesh-bvh patches THREE.BufferGeometry with computeBoundsTree etc.
// Loaded via importmap (see index.html). If it fails to load at runtime, we
// fall back to plain Raycaster which is still fine for typical apartment GLBs.
let _bvhLib = null;
try {
  _bvhLib = await import('three-mesh-bvh');
  THREE.BufferGeometry.prototype.computeBoundsTree = _bvhLib.computeBoundsTree;
  THREE.BufferGeometry.prototype.disposeBoundsTree = _bvhLib.disposeBoundsTree;
  THREE.Mesh.prototype.raycast = _bvhLib.acceleratedRaycast;
  console.log('[lab] three-mesh-bvh loaded');
} catch (err) {
  console.warn('[lab] three-mesh-bvh unavailable, falling back to default raycaster:', err.message);
}

export const BVH_AVAILABLE = !!_bvhLib;

// Build BVH bounds tree on every mesh in a subtree. Idempotent — re-running
// disposes the old tree first.
export function setupBVH(root) {
  if (!_bvhLib) return { meshes: 0, available: false };
  let meshes = 0;
  root.traverse((o) => {
    if (o.isMesh && o.geometry) {
      try {
        if (o.geometry.boundsTree) o.geometry.disposeBoundsTree();
        o.geometry.computeBoundsTree();
        meshes++;
      } catch (e) {
        // Geometry might be non-indexed or have weird attrs — skip silently.
      }
    }
  });
  return { meshes, available: true };
}

export function disposeBVH(root) {
  if (!_bvhLib) return;
  root.traverse((o) => {
    if (o.isMesh && o.geometry?.boundsTree) o.geometry.disposeBoundsTree();
  });
}

// ────────────────────────────────────────────────────────────────────
// FirstPersonController
//
// Usage:
//   const fps = new FirstPersonController(camera, domElement, scene);
//   fps.setCollisionRoot(model);
//   fps.enable();      // pointer-lock + start receiving input
//   // in your render loop:
//   fps.update(delta);
//   fps.disable();     // restore mouse cursor
//
// Keys: WASD = move, Space = up, Ctrl = down, Shift = run.
// ────────────────────────────────────────────────────────────────────
const KEYS = {
  forward:  ['KeyW', 'ArrowUp'],
  backward: ['KeyS', 'ArrowDown'],
  left:     ['KeyA', 'ArrowLeft'],
  right:    ['KeyD', 'ArrowRight'],
  up:       ['Space'],
  down:     ['ControlLeft', 'ControlRight'],
  run:      ['ShiftLeft', 'ShiftRight'],
};

function keyAction(code) {
  for (const [action, codes] of Object.entries(KEYS)) {
    if (codes.includes(code)) return action;
  }
  return null;
}

export class FirstPersonController {
  constructor(camera, domElement) {
    this.camera = camera;
    this.domElement = domElement;
    this.controls = new PointerLockControls(camera, domElement);
    this.speed = 2.0;          // m/s walking
    this.runMultiplier = 2.0;  // shift
    this.eyeHeight = 1.65;     // meters from y=0
    this.collisionPadding = 0.35; // min distance to walls
    this.gravity = false;
    this.collisionRoot = null;

    this._enabled = false;
    this._state = { forward: false, backward: false, left: false, right: false, up: false, down: false, run: false };
    this._raycaster = new THREE.Raycaster();
    this._raycaster.firstHitOnly = true; // honored by three-mesh-bvh
    this._tmpDir = new THREE.Vector3();
    this._tmpForward = new THREE.Vector3();
    this._tmpRight = new THREE.Vector3();
    this._tmpMove = new THREE.Vector3();
    this._tmpDown = new THREE.Vector3(0, -1, 0);

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onLockChange = this._onLockChange.bind(this);

    this.controls.addEventListener('lock', this._onLockChange);
    this.controls.addEventListener('unlock', this._onLockChange);
  }

  setCollisionRoot(root) { this.collisionRoot = root; }
  setSpeed(s) { this.speed = s; }
  setEyeHeight(h) { this.eyeHeight = h; }
  setGravity(on) { this.gravity = !!on; }

  /** Move camera to a sensible "interior start" pose: bbox center at eyeHeight,
   *  facing into the model. Then optionally lock the pointer. */
  enterModel(model, { lockPointer = true } = {}) {
    if (!model) return;
    const box = new THREE.Box3().setFromObject(model);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    this.camera.position.set(center.x, this.eyeHeight, center.z);
    this.camera.lookAt(center.x, this.eyeHeight, center.z - 1);
    if (lockPointer) {
      // PointerLock requires a user gesture; the click that triggered this
      // counts. If lock fails it logs and we just skip silently.
      try { this.controls.lock(); } catch (e) { /* noop */ }
    }
  }

  enable() {
    if (this._enabled) return;
    this._enabled = true;
    document.addEventListener('keydown', this._onKeyDown);
    document.addEventListener('keyup', this._onKeyUp);
  }

  disable() {
    if (!this._enabled) return;
    this._enabled = false;
    document.removeEventListener('keydown', this._onKeyDown);
    document.removeEventListener('keyup', this._onKeyUp);
    this._resetState();
    if (this.controls.isLocked) this.controls.unlock();
  }

  dispose() {
    this.disable();
    this.controls.removeEventListener('lock', this._onLockChange);
    this.controls.removeEventListener('unlock', this._onLockChange);
    this.controls.dispose();
  }

  _resetState() {
    for (const k of Object.keys(this._state)) this._state[k] = false;
  }

  _onLockChange() {
    if (!this.controls.isLocked) this._resetState();
  }

  // We deliberately accept input even when pointer is NOT locked — that way
  // someone can hold W to peek through walls without committing to a lock.
  // Comment out the lock check if you want stricter behavior.
  _shouldHandleKey(ev) {
    if (!this._enabled) return false;
    const tag = (ev.target?.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;
    return true;
  }

  _onKeyDown(ev) {
    if (!this._shouldHandleKey(ev)) return;
    const action = keyAction(ev.code);
    if (action) {
      this._state[action] = true;
      // prevent page scroll on Space / Arrow keys
      if (ev.code === 'Space' || ev.code.startsWith('Arrow')) ev.preventDefault();
    }
  }

  _onKeyUp(ev) {
    if (!this._shouldHandleKey(ev)) return;
    const action = keyAction(ev.code);
    if (action) this._state[action] = false;
  }

  /** Compute the desired displacement for this frame and apply with collision. */
  update(delta) {
    if (!this._enabled) return;
    const s = this._state;
    let strafeX = 0;
    let strafeZ = 0;
    let liftY = 0;
    if (s.forward)  strafeZ -= 1;
    if (s.backward) strafeZ += 1;
    if (s.left)     strafeX -= 1;
    if (s.right)    strafeX += 1;
    if (s.up)       liftY += 1;
    if (s.down)     liftY -= 1;

    const moving = strafeX !== 0 || strafeZ !== 0 || liftY !== 0;
    if (!moving && !this.gravity) return;

    const speed = this.speed * (s.run ? this.runMultiplier : 1) * delta;

    // Build forward (XZ-plane) and right vectors from current camera heading.
    this.camera.getWorldDirection(this._tmpForward);
    this._tmpForward.y = 0;
    if (this._tmpForward.lengthSq() < 1e-6) this._tmpForward.set(0, 0, -1);
    this._tmpForward.normalize();
    this._tmpRight.crossVectors(this._tmpForward, this.camera.up).normalize();

    // Compose horizontal movement vector in world space.
    this._tmpMove.set(0, 0, 0);
    this._tmpMove.addScaledVector(this._tmpForward, -strafeZ);
    this._tmpMove.addScaledVector(this._tmpRight, strafeX);
    if (this._tmpMove.lengthSq() > 0) this._tmpMove.normalize().multiplyScalar(speed);

    // Apply with horizontal collision (ray from current pos along desired XZ).
    if (this.collisionRoot && this._tmpMove.lengthSq() > 1e-8) {
      const hit = this._castDir(this._tmpMove);
      if (hit && hit.distance < this.collisionPadding + this._tmpMove.length()) {
        // Slide-along-walls: project movement onto plane defined by hit normal.
        if (hit.face) {
          const normal = hit.face.normal.clone()
            .transformDirection(hit.object.matrixWorld)
            .normalize();
          const dot = this._tmpMove.dot(normal);
          // Remove the component into the wall, keep the parallel one.
          this._tmpMove.addScaledVector(normal, -dot);
          // Re-test: if still colliding, zero it out.
          const slideHit = this._castDir(this._tmpMove);
          if (slideHit && slideHit.distance < this.collisionPadding) {
            this._tmpMove.set(0, 0, 0);
          }
        } else {
          this._tmpMove.set(0, 0, 0);
        }
      }
    }
    this.camera.position.add(this._tmpMove);

    // Vertical movement (Space / Ctrl). No collision check — useful for floors.
    if (liftY !== 0) this.camera.position.y += liftY * speed;

    // Optional gravity: drop until just above ground hit by downward ray.
    if (this.gravity && this.collisionRoot) {
      this._raycaster.set(this.camera.position, this._tmpDown);
      this._raycaster.far = 50;
      const hits = this._raycaster.intersectObject(this.collisionRoot, true);
      if (hits.length) {
        const targetY = hits[0].point.y + this.eyeHeight;
        // Soft snap so it doesn't pop hard.
        this.camera.position.y = THREE.MathUtils.lerp(this.camera.position.y, targetY, 0.2);
      }
    }
  }

  _castDir(moveVec) {
    if (!this.collisionRoot) return null;
    const dir = this._tmpDir.copy(moveVec).normalize();
    this._raycaster.set(this.camera.position, dir);
    this._raycaster.far = this.collisionPadding + moveVec.length() + 0.05;
    const hits = this._raycaster.intersectObject(this.collisionRoot, true);
    return hits[0] || null;
  }
}
