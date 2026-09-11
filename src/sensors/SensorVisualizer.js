import * as THREE from 'three';

const CLEAR_COLOR = new THREE.Color(0x35d07f); // green: no hit within range
const HIT_COLOR = new THREE.Color(0xff4a4a); // red: shortened to the hit point

/**
 * SensorVisualizer — proximity rays as world-space line segments.
 *
 * One LineSegments with per-vertex colors: a ray that finds nothing draws
 * green at full maxRange; a ray that hits draws red, shortened to the hit
 * point. Buffers are pre-sized for the array's ray count and updated in
 * place each frame. Toggleable (off by default); the toggle lives in the
 * ControlPanel's Sensors folder.
 */
export class SensorVisualizer {
  /**
   * @param {import('../core/Engine.js').Engine} engine
   * @param {object} options
   * @param {import('./ProximitySensorArray.js').ProximitySensorArray} options.sensorArray
   * @param {boolean} [options.enabled] default false
   */
  constructor(engine, { sensorArray, enabled = false } = {}) {
    if (!sensorArray) throw new TypeError('SensorVisualizer: sensorArray is required');
    this._sensorArray = sensorArray;
    this._enabled = !!enabled;

    const rayCount = sensorArray.raySegments.length;
    this._positions = new Float32Array(rayCount * 2 * 3);
    this._colors = new Float32Array(rayCount * 2 * 3);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this._positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(this._colors, 3));

    this._lineSegments = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 })
    );
    this._lineSegments.name = 'sensors:proximity-rays';
    this._lineSegments.frustumCulled = false;
    this._lineSegments.visible = this._enabled;
    engine.sceneManager.add(this._lineSegments);
  }

  get enabled() {
    return this._enabled;
  }

  get visible() {
    return this._enabled;
  }

  set visible(value) {
    this.setEnabled(value);
  }

  setEnabled(enabled) {
    this._enabled = !!enabled;
    this._lineSegments.visible = this._enabled;
  }

  /** Refresh vertices/colors from the array's latest cast. */
  update() {
    if (!this._enabled) return;
    const segments = this._sensorArray.raySegments;
    const maxRange = this._sensorArray.maxRangeM;

    let o = 0;
    let c = 0;
    for (const segment of segments) {
      const origin = segment.origin;
      const hit = segment.hit;
      const endX = hit ? hit.point.x : origin.x + segment.direction.x * maxRange;
      const endY = hit ? hit.point.y : origin.y;
      const endZ = hit ? hit.point.z : origin.z + segment.direction.z * maxRange;

      this._positions[o++] = origin.x;
      this._positions[o++] = origin.y;
      this._positions[o++] = origin.z;
      this._positions[o++] = endX;
      this._positions[o++] = endY;
      this._positions[o++] = endZ;

      const color = hit ? HIT_COLOR : CLEAR_COLOR;
      for (let v = 0; v < 2; v++) {
        this._colors[c++] = color.r;
        this._colors[c++] = color.g;
        this._colors[c++] = color.b;
      }
    }

    this._lineSegments.geometry.attributes.position.needsUpdate = true;
    this._lineSegments.geometry.attributes.color.needsUpdate = true;
  }

  dispose() {
    this._lineSegments.parent?.remove(this._lineSegments);
    this._lineSegments.geometry.dispose();
    this._lineSegments.material.dispose();
    this._lineSegments = null;
    this._sensorArray = null;
  }
}