import * as THREE from 'three';

const SOBEL_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SOBEL_FRAGMENT = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2 texelSize;
  varying vec2 vUv;

  float luminance(vec2 uv) {
    vec3 c = texture2D(tDiffuse, uv).rgb;
    return dot(c, vec3(0.299, 0.587, 0.114));
  }

  void main() {
    // 3x3 Sobel on luminance → gradient magnitude.
    float tl = luminance(vUv + vec2(-texelSize.x,  texelSize.y));
    float tc = luminance(vUv + vec2(0.0,           texelSize.y));
    float tr = luminance(vUv + vec2( texelSize.x,  texelSize.y));
    float ml = luminance(vUv + vec2(-texelSize.x,  0.0));
    float mr = luminance(vUv + vec2( texelSize.x,  0.0));
    float bl = luminance(vUv + vec2(-texelSize.x, -texelSize.y));
    float bc = luminance(vUv + vec2(0.0,          -texelSize.y));
    float br = luminance(vUv + vec2( texelSize.x, -texelSize.y));

    float gx = (tl + 2.0 * ml + bl) - (tr + 2.0 * mr + br);
    float gy = (tl + 2.0 * tc + tr) - (bl + 2.0 * bc + br);
    float edge = clamp(length(vec2(gx, gy)), 0.0, 1.0);
    gl_FragColor = vec4(vec3(edge), 1.0);
  }
`;

/**
 * FrontCameraSensor — a real forward-facing camera on the ego.
 *
 * Pipeline per frame (only while enabled; OFF by default, ego-only):
 *   1. update(): render the scene from a PerspectiveCamera mounted at the
 *      front bumper into a WebGLRenderTarget (shadow maps are reused, not
 *      recomputed, for this pass).
 *   2. A fullscreen Sobel pass reads that target into a second target —
 *      the "edge image", purely for visualization.
 *   3. addPostRender callback (runs AFTER the main render, via the Engine's
 *      new post-render hook): draws the edge image as a picture-in-picture
 *      square in the bottom-right corner of the canvas using
 *      scissor/viewport, restoring renderer state afterwards.
 *
 * The camera feed naturally includes the debug ray lines when the ray
 * visualizer is on — the sensor "sees" its own sensing overlay.
 */
export class FrontCameraSensor {
  /**
   * @param {import('../core/Engine.js').Engine} engine
   * @param {object} options
   * @param {import('../vehicles/Vehicle.js').Vehicle} options.vehicle
   * @param {number} [options.resolution] square render-target size, default 256
   * @param {number} [options.fovDeg] default 70
   * @param {boolean} [options.enabled] default false
   */
  constructor(engine, { vehicle, resolution = 256, fovDeg = 70, enabled = false } = {}) {
    if (!vehicle) throw new TypeError('FrontCameraSensor: vehicle is required');
    this._engine = engine;
    this._renderer = engine.renderer;
    this._scene = engine.scene;
    this._vehicle = vehicle;
    this._resolution = resolution;
    this._enabled = !!enabled;

    this.camera = new THREE.PerspectiveCamera(fovDeg, 1, 0.5, 300);
    this._colorTarget = new THREE.WebGLRenderTarget(resolution, resolution);
    this._edgeTarget = new THREE.WebGLRenderTarget(resolution, resolution, {
      depthBuffer: false,
    });

    // Sobel pass: colorTarget → edgeTarget.
    this._sobelMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this._colorTarget.texture },
        texelSize: { value: new THREE.Vector2(1 / resolution, 1 / resolution) },
      },
      vertexShader: SOBEL_VERTEX,
      fragmentShader: SOBEL_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._sobelMaterial);
    quad.frustumCulled = false;
    this._passScene = new THREE.Scene();
    this._passScene.add(quad);

    // PiP quad: edgeTarget → screen corner.
    this._pipMaterial = new THREE.MeshBasicMaterial({ map: this._edgeTarget.texture });
    this._pipMaterial.toneMapped = false;
    this._pipMaterial.depthTest = false;
    this._pipMaterial.depthWrite = false;
    const pipQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._pipMaterial);
    pipQuad.frustumCulled = false;
    this._pipScene = new THREE.Scene();
    this._pipScene.add(pipQuad);

    this._ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._size = new THREE.Vector2();

    this._unsubscribePostRender = engine.addPostRender(() => this._drawPip());
  }

  get enabled() {
    return this._enabled;
  }

  setEnabled(enabled) {
    this._enabled = !!enabled;
    if (this._enabled) {
      // Shadow maps may not exist yet this frame — render them once so the
      // first sensor frame isn't pitch black.
      this._renderer.shadowMap.needsUpdate = true;
    }
  }

  /** Render the sensor frame + edge pass. No-op while disabled. */
  update(dt) {
    if (!this._enabled) return;

    const state = this._vehicle.motionModel.getState();
    const heading = state.headingRad;
    const forwardX = Math.sin(heading);
    const forwardZ = -Math.cos(heading);
    const eyeX = state.position.x + forwardX * 1.9;
    const eyeZ = state.position.z + forwardZ * 1.9;
    const eyeY = state.position.y + 0.4;

    this.camera.position.set(eyeX, eyeY, eyeZ);
    this.camera.lookAt(eyeX + forwardX * 30, eyeY - 1.2, eyeZ + forwardZ * 30);

    const renderer = this._renderer;
    const shadowAutoUpdate = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false; // reuse existing shadow maps
    renderer.setRenderTarget(this._colorTarget);
    renderer.render(this._scene, this.camera);
    renderer.setRenderTarget(this._edgeTarget);
    renderer.render(this._passScene, this._ortho);
    renderer.setRenderTarget(null);
    renderer.shadowMap.autoUpdate = shadowAutoUpdate;
  }

  /** Picture-in-picture overlay — runs after the main render pass. */
  _drawPip() {
    if (!this._enabled) return;
    const renderer = this._renderer;
    renderer.getSize(this._size);
    const margin = 16;
    const x = Math.max(0, this._size.x - this._resolution - margin);
    const y = margin;

    const previousAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setScissorTest(true);
    renderer.setScissor(x, y, this._resolution, this._resolution);
    renderer.setViewport(x, y, this._resolution, this._resolution);
    renderer.render(this._pipScene, this._ortho);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, this._size.x, this._size.y);
    renderer.autoClear = previousAutoClear;
  }

  dispose() {
    if (this._unsubscribePostRender) {
      this._unsubscribePostRender();
      this._unsubscribePostRender = null;
    }
    this._colorTarget?.dispose();
    this._edgeTarget?.dispose();
    this._sobelMaterial?.dispose();
    this._pipMaterial?.dispose();
    for (const scene of [this._passScene, this._pipScene]) {
      if (!scene) continue;
      for (const child of scene.children) {
        child.geometry?.dispose();
      }
    }
    this._passScene = null;
    this._pipScene = null;
  }
}