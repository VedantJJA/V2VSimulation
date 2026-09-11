import * as THREE from 'three';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

const ENV = ConfigDefaults.environment;

const SKY_VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldPosition;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 topColor;      // zenith
  uniform vec3 horizonColor;  // horizon band
  uniform vec3 bottomColor;   // below-horizon haze (derived, darker)
  uniform float exponent;     // gradient steepness

  varying vec3 vWorldPosition;

  void main() {
    // Altitude of the view direction: +1 = straight up, -1 = straight down.
    vec3 direction = normalize(vWorldPosition - cameraPosition);
    float h = direction.y;

    // Zenith blend.
    float up = pow(clamp(h, 0.0, 1.0), exponent);
    vec3 color = mix(horizonColor, topColor, up);

    // Below the horizon, settle into the darkened haze colour.
    float down = pow(clamp(-h, 0.0, 1.0), exponent);
    color = mix(color, bottomColor, down);

    gl_FragColor = vec4(color, 1.0);

    // Match the rest of the scene: same tone mapping + output color space
    // the renderer applies to lit materials.
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * SkyController — simple gradient sky dome (must stay inside camera.far;
 * see ConfigDefaults.environment.skyDomeRadiusM). Fog is intentionally NOT
 * applied to the dome. UPGRADE PATH: three's Sky addon + PMREM environment.
 */
export class SkyController {
  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) {
    this._sceneManager = engine.sceneManager;
    this._camera = engine.camera;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color(0x4a90d9) },
        horizonColor: { value: new THREE.Color(0xcfe5f2) },
        bottomColor: { value: new THREE.Color(0x2a333f) },
        exponent: { value: 0.7 },
      },
      vertexShader: SKY_VERTEX_SHADER,
      fragmentShader: SKY_FRAGMENT_SHADER,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false, // explicit: the sky must never be fogged
    });

    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(ENV.skyDomeRadiusM, ENV.skyDomeSegments, ENV.skyDomeRings),
      this.material
    );
    this.mesh.name = 'skyDome';
    this.mesh.frustumCulled = false; // always around the camera
    this.mesh.renderOrder = -1; // draw first; everything else layers over it
    this._sceneManager.add(this.mesh);

    // Keep the dome centred on the camera so it can never be exited.
    this._unsubscribeUpdate = engine.addUpdate(() => this.update());
  }

  /** Per-frame: re-centre the dome on the camera. */
  update() {
    this.mesh.position.copy(this._camera.position);
  }

  /** Apply a preset's sky block: { topColor, horizonColor, exponent }. */
  applyPreset({ topColor, horizonColor, exponent }) {
    this.setColors(topColor, horizonColor, exponent);
  }

  /** Set the gradient directly. `exponent` optional (keeps current value). */
  setColors(topColor, horizonColor, exponent) {
    const uniforms = this.material.uniforms;
    uniforms.topColor.value.set(topColor);
    uniforms.horizonColor.value.set(horizonColor);
    if (exponent !== undefined) uniforms.exponent.value = exponent;

    // Below-horizon haze: the horizon colour, deepened.
    uniforms.bottomColor.value
      .copy(uniforms.horizonColor.value)
      .multiplyScalar(1 - ENV.skyHorizonDarken);

    // Fallback flat background — only visible if the dome is ever removed.
    this._sceneManager.setBackground(uniforms.horizonColor.value.clone());
  }

  /** Teardown: unregister the update, remove + free the dome. */
  dispose() {
    this._unsubscribeUpdate();
    this._unsubscribeUpdate = null;
    this._sceneManager.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh = null;
    this.material = null;
    this._sceneManager = null;
    this._camera = null;
  }
}