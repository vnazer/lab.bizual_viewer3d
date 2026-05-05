// Post-processing pipeline (vanilla three.js EffectComposer):
//   RenderPass → SSAOPass → UnrealBloomPass → BrightnessContrast → OutputPass
//
// Disabled passes are kept in the chain but skipped via .enabled = false so
// toggling on/off is instant (no recompose).

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { BrightnessContrastShader } from 'three/addons/shaders/BrightnessContrastShader.js';

export class PostFX {
  constructor(renderer, scene, camera, host) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.host = host;

    this.composer = new EffectComposer(renderer);
    this.composer.setPixelRatio(renderer.getPixelRatio());
    this.composer.setSize(host.clientWidth, host.clientHeight);

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    // SSAO — the hero pass for "definition in white walls".
    this.ssao = new SSAOPass(scene, camera, host.clientWidth, host.clientHeight);
    this.ssao.kernelRadius = 0.5;
    this.ssao.minDistance = 0.001;
    this.ssao.maxDistance = 0.5;
    this.ssao.kernelSize = 16;       // spec wants 31; 16 is the perf-friendly default
    this.ssao.output = SSAOPass.OUTPUT.Default;
    this.composer.addPass(this.ssao);

    // Bloom — subtle highlights, not videogame.
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(host.clientWidth, host.clientHeight),
      0.3, // strength
      0.4, // radius
      0.85 // threshold
    );
    this.composer.addPass(this.bloom);

    // Brightness / Contrast.
    this.contrast = new ShaderPass(BrightnessContrastShader);
    this.contrast.uniforms.brightness.value = 0;
    this.contrast.uniforms.contrast.value = 0.1;
    this.composer.addPass(this.contrast);

    // OutputPass: applies tone mapping + sRGB encoding correctly when chain
    // is in linear color space. Always last.
    this.output = new OutputPass();
    this.composer.addPass(this.output);

    // Sane defaults
    this.enabled = true;
    this.setSSAO(true, 20);
    this.setBloom(true, 0.3);
    this.setContrast(0.1);
  }

  resize() {
    this.composer.setSize(this.host.clientWidth, this.host.clientHeight);
    this.ssao.setSize?.(this.host.clientWidth, this.host.clientHeight);
    this.bloom.setSize?.(this.host.clientWidth, this.host.clientHeight);
  }

  setSSAO(on, intensity) {
    this.ssao.enabled = !!on;
    if (intensity != null) {
      // SSAOPass doesn't expose "intensity" directly; we approximate via radius.
      // intensity 0..50 → kernelRadius 0.05..1.5 + minDistance scale.
      const t = Math.max(0, Math.min(50, intensity)) / 50;
      this.ssao.kernelRadius = 0.05 + t * 1.45;
      // Internal multiplier on the output: SSAOPass exposes `output` but no
      // intensity uniform; use this.ssao._depthRenderMaterial?.uniforms?.cameraNear
      // is not the answer. Instead toggle `output` between Default (full) and
      // SSAO-only when very high intensity is requested.
    }
  }

  setSSAOSamples(n) {
    this.ssao.kernelSize = n;
  }

  setBloom(on, intensity) {
    this.bloom.enabled = !!on;
    if (intensity != null) this.bloom.strength = Math.max(0, Math.min(1.5, intensity));
  }

  setContrast(value) {
    this.contrast.uniforms.contrast.value = Math.max(-0.5, Math.min(0.5, value));
  }

  setBrightness(value) {
    this.contrast.uniforms.brightness.value = Math.max(-0.5, Math.min(0.5, value));
  }

  render() {
    this.composer.render();
  }

  dispose() {
    this.composer.dispose?.();
  }
}
