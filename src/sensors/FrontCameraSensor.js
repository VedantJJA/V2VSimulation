import * as THREE from 'three';
import { clamp } from '../utils/MathUtils.js';

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

    this.laneReadings = {
      detected: false,
      lateralOffsetM: 0,
      headingErrorRad: 0,
      distToLeftEdgeM: 3.5,
      distToRightEdgeM: 3.5,
      distToCurbAheadM: 50.0,
      isNearRoadEdge: false,
      isOnRoad: true,
    };
    this._pixelBuffer = new Uint8Array(resolution * resolution * 4);
    this._laneScanTimer = 0;

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

  getLaneReadings() {
    return this.laneReadings;
  }

  /** Render the sensor frame + edge pass and compute camera-feed lane centering. */
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

    // Temporarily hide externally drawn overlays so the front camera only sees real world scenery
    const hiddenObjects = [];
    this._scene.traverse((obj) => {
      if (
        obj.visible &&
        (obj.userData?.isExternalOverlay ||
          (obj.name &&
            (obj.name.startsWith('sensors:') ||
              obj.name.startsWith('lane-guide:') ||
              obj.name.startsWith('laneGuide') ||
              obj.name.startsWith('navigation:') ||
              obj.name.startsWith('v2v:') ||
              obj.name.startsWith('editor:') ||
              obj.name.startsWith('gizmo:') ||
              obj.name.startsWith('spawn-preview:') ||
              obj.name.startsWith('debug:'))))
      ) {
        obj.visible = false;
        hiddenObjects.push(obj);
      }
    });

    renderer.setRenderTarget(this._colorTarget);
    renderer.render(this._scene, this.camera);
    renderer.setRenderTarget(this._edgeTarget);
    renderer.render(this._passScene, this._ortho);

    // Restore visibility of externally drawn overlays for main viewport
    for (const obj of hiddenObjects) {
      obj.visible = true;
    }

    // Compute Camera-based Lane Centering from the edge target at 20 Hz
    this._laneScanTimer += dt;
    if (this._laneScanTimer >= 0.05) {
      this._laneScanTimer = 0;
      this._detectLanesFromEdgeFeed(renderer);
    }

    renderer.setRenderTarget(null);
    renderer.shadowMap.autoUpdate = shadowAutoUpdate;
  }

  /**
   * Scan horizontal rows in the bottom half of the edge image to detect lane boundaries
   * and compute visual cross-track error and heading offset.
   */
  _detectLanesFromEdgeFeed(renderer) {
    const W = this._resolution;
    const H = this._resolution;
    try {
      renderer.readRenderTargetPixels(this._edgeTarget, 0, 0, W, H, this._pixelBuffer);
    } catch {
      return;
    }

    // Sample two horizontal rows: near road row (y ~ 20%) and far road row (y ~ 35%)
    const scanRow = (rowY) => {
      const y = Math.floor(rowY * H);
      const rowOffset = y * W * 4;
      const midX = Math.floor(W / 2);

      let leftX = -1;
      let rightX = -1;

      // Scan left from center
      for (let x = midX - 4; x >= 6; x--) {
        const val = this._pixelBuffer[rowOffset + x * 4]; // R channel of Sobel edge
        if (val > 80) {
          leftX = x;
          break;
        }
      }

      // Scan right from center
      for (let x = midX + 4; x <= W - 6; x++) {
        const val = this._pixelBuffer[rowOffset + x * 4];
        if (val > 80) {
          rightX = x;
          break;
        }
      }

      return { leftX, rightX, midX };
    };

    const near = scanRow(0.20);
    const far = scanRow(0.35);

    // Transverse curb detection directly in front of bumper (for U-turns and road boundary awareness)
    let distToCurbAheadM = 50.0;
    const midX = Math.floor(W / 2);
    // Scan vertical strip in front of bumper: y from 0.08 (~0.8m) to 0.40 (~7.0m)
    for (let y = Math.floor(0.08 * H); y <= Math.floor(0.40 * H); y++) {
      let edgeCount = 0;
      const rowOffset = y * W * 4;
      for (let x = midX - 16; x <= midX + 16; x++) {
        if (this._pixelBuffer[rowOffset + x * 4] > 80) {
          edgeCount++;
        }
      }
      // If a horizontal edge spans across the bumper center, it's a curb or road boundary ahead!
      if (edgeCount >= 8) {
        const rowNorm = y / H;
        distToCurbAheadM = 0.8 + (rowNorm / 0.35) * 5.0;
        break;
      }
    }

    let lateralOffsetM = 0;
    let headingErrorRad = 0;
    let detected = false;
    let metersPerPx = 3.7 / (W * 0.45);

    if (near.leftX !== -1 && near.rightX !== -1) {
      const laneWidthPx = Math.max(20, near.rightX - near.leftX);
      const visualCenterPx = (near.leftX + near.rightX) / 2;
      const offsetPx = visualCenterPx - near.midX;

      // Standard lane is ~3.7m wide
      metersPerPx = 3.7 / laneWidthPx;
      lateralOffsetM = offsetPx * metersPerPx;
      detected = true;

      if (far.leftX !== -1 && far.rightX !== -1) {
        const farCenterPx = (far.leftX + far.rightX) / 2;
        const deltaX = (farCenterPx - visualCenterPx) * metersPerPx;
        const deltaY = 6.0; // distance ahead between near and far scan bands in meters
        headingErrorRad = Math.atan2(deltaX, deltaY);
      }
    } else if (near.leftX !== -1) {
      const estWidthPx = W * 0.45;
      const visualCenterPx = near.leftX + estWidthPx / 2;
      metersPerPx = 3.7 / estWidthPx;
      lateralOffsetM = (visualCenterPx - near.midX) * metersPerPx;
      detected = true;
    } else if (near.rightX !== -1) {
      const estWidthPx = W * 0.45;
      const visualCenterPx = near.rightX - estWidthPx / 2;
      metersPerPx = 3.7 / estWidthPx;
      lateralOffsetM = (visualCenterPx - near.midX) * metersPerPx;
      detected = true;
    }

    const distToLeftEdgeM = near.leftX !== -1 ? Math.max(0.1, (near.midX - near.leftX) * metersPerPx) : 4.0;
    const distToRightEdgeM = near.rightX !== -1 ? Math.max(0.1, (near.rightX - near.midX) * metersPerPx) : 4.0;
    const isNearRoadEdge = distToLeftEdgeM < 1.3 || distToRightEdgeM < 1.3 || distToCurbAheadM < 2.0;
    const isOnRoad = distToLeftEdgeM > 0.3 && distToRightEdgeM > 0.3 && distToCurbAheadM > 0.9;

    this.laneReadings = {
      detected,
      lateralOffsetM: clamp(lateralOffsetM, -3.5, 3.5),
      headingErrorRad: clamp(headingErrorRad, -0.6, 0.6),
      distToLeftEdgeM,
      distToRightEdgeM,
      distToCurbAheadM,
      isNearRoadEdge,
      isOnRoad,
    };
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