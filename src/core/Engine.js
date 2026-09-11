import * as THREE from 'three';
import { SceneManager } from './SceneManager.js';
import { EventBus } from './EventBus.js';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

const CORE = ConfigDefaults.core;

/**
 * Engine — the application's runtime core.
 *
 * Owns: the WebGL renderer, the SceneManager (which owns the THREE.Scene),
 * the shared PerspectiveCamera, the THREE.Clock, the requestAnimationFrame
 * loop, and the global EventBus.
 *
 * Frame order: update callbacks (registration order — physics → vehicles →
 * camera rig → sensors) → main render → post-render callbacks (overlays,
 * e.g. the front camera's picture-in-picture).
 *
 * Camera control: CameraRig (simulation) / MapEditor's orbit controls
 * (editor).
 *
 * Extension points:
 * - `addUpdate(cb)` — per-frame logic, before the render.
 * - `addPostRender(cb)` — after the render (overlays, readbacks).
 * - `bus` — pub/sub for cross-module events.
 * - `sceneManager` — add/remove scene objects.
 */
export class Engine {
  constructor({
    container = document.body,
    fov = CORE.cameraFovDeg,
    near = CORE.cameraNearM,
    far = CORE.cameraFarM,
  } = {}) {
    // ---- Core services -------------------------------------------------------
    this.clock = new THREE.Clock();
    this.bus = new EventBus();

    // ---- Renderer --------------------------------------------------------------
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, CORE.maxPixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = CORE.toneMappingExposure;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    // ---- Scene -------------------------------------------------------------------
    this.sceneManager = new SceneManager();
    this.scene = this.sceneManager.scene;

    // ---- Camera --------------------------------------------------------------------
    // Neutral default vantage — main.js repositions before a rig attaches.
    this.camera = new THREE.PerspectiveCamera(
      fov,
      window.innerWidth / Math.max(1, window.innerHeight),
      near,
      far
    );
    this.camera.position.set(28, 22, 28);

    // ---- Loop bookkeeping ----------------------------------------------------------
    this._updateCallbacks = new Set();
    this._postRenderCallbacks = new Set();
    this._rafId = null;
    this._running = false;
    this._tick = this._tick.bind(this);
    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);
  }

  /**
   * Register a per-frame callback. `callback` receives the clamped delta time
   * in seconds. Returns an unsubscribe function. Execution order equals
   * registration order — systems that depend on others' per-frame output
   * (e.g. the camera rig after vehicles) must register later.
   */
  addUpdate(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Engine.addUpdate: callback must be a function');
    }
    this._updateCallbacks.add(callback);
    return () => this._updateCallbacks.delete(callback);
  }

  /**
   * Register a post-render callback, executed AFTER the main render pass
   * each frame (same clamped dt). For overlay draws (scissor/viewport PiPs,
   * readbacks) that must not be cleared by the main render. Returns an
   * unsubscribe function.
   */
  addPostRender(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Engine.addPostRender: callback must be a function');
    }
    this._postRenderCallbacks.add(callback);
    return () => this._postRenderCallbacks.delete(callback);
  }

  /** Start the render loop (idempotent). */
  start() {
    if (this._running) return;
    this._running = true;
    this._rafId = requestAnimationFrame(this._tick);
  }

  /** Stop the render loop (idempotent). */
  stop() {
    if (!this._running) return;
    this._running = false;
    cancelAnimationFrame(this._rafId);
    this._rafId = null;
  }

  _tick() {
    this._rafId = requestAnimationFrame(this._tick);

    // Clamp large deltas (background tabs, paused debugger) so fixed-timestep
    // physics never receives a runaway step.
    const dt = Math.min(this.clock.getDelta(), CORE.maxFrameDeltaSec);

    // Copy the sets so callbacks may (un)register themselves mid-frame.
    for (const callback of [...this._updateCallbacks]) {
      callback(dt);
    }

    this.renderer.render(this.scene, this.camera);

    for (const callback of [...this._postRenderCallbacks]) {
      callback(dt);
    }
  }

  _onResize() {
    const width = window.innerWidth;
    const height = Math.max(1, window.innerHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  /** Full teardown: loop, listeners, scene resources, WebGL context. */
  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    this._updateCallbacks.clear();
    this._postRenderCallbacks.clear();
    this.sceneManager.dispose();
    this.bus.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}