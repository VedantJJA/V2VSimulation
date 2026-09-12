import * as THREE from 'three';

/**
 * Calculates smooth continuous analog RGB color based on distance.
 *  <= 3.5m: Critical Red (#ef4444)
 *  3.5m - 8m: Warning Orange (#f97316)
 *  8m - 16m: Caution Amber/Yellow (#eab308)
 *  16m - 28m: Approaching Lime Green (#84cc16)
 *  > 28m: Distant Emerald / Cyan (#10b981)
 */
function getAnalogDistanceColor(distanceM, maxRangeM, hasHit = true) {
  if (!hasHit || distanceM == null || distanceM >= maxRangeM) {
    return { r: 0.06, g: 0.72, b: 0.51 }; // Emerald Green
  }
  const d = Math.max(0, distanceM);
  if (d <= 3.5) {
    // 0 to 3.5m: Critical Red
    const u = d / 3.5;
    return { r: 1.0, g: u * 0.2, b: 0.1 };
  } else if (d <= 8.0) {
    // 3.5 to 8m: Red to Orange
    const u = (d - 3.5) / 4.5;
    return { r: 1.0, g: 0.2 + u * 0.35, b: 0.05 };
  } else if (d <= 16.0) {
    // 8 to 16m: Orange to Amber Yellow
    const u = (d - 8.0) / 8.0;
    return { r: 1.0 - u * 0.1, g: 0.55 + u * 0.35, b: 0.05 };
  } else if (d <= 28.0) {
    // 16 to 28m: Yellow to Lime Green
    const u = (d - 16.0) / 12.0;
    return { r: 0.9 - u * 0.45, g: 0.9 + u * 0.05, b: 0.05 + u * 0.1 };
  } else {
    // 28 to maxRange: Lime to Emerald/Cyan
    const u = Math.min(1, (d - 28.0) / Math.max(1, maxRangeM - 28.0));
    return { r: 0.45 - u * 0.39, g: 0.95 - u * 0.23, b: 0.15 + u * 0.36 };
  }
}

/**
 * SensorVisualizer — proximity rays with smooth analog distance gradients.
 *
 * Renders proximity rays with continuous analog color transitions based on
 * real measured obstacle distance, plus 3D contact point markers.
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

    this.group = new THREE.Group();
    this.group.name = 'sensors:proximity-group';
    this.group.userData.isExternalOverlay = true;

    const rayCount = sensorArray.raySegments.length;
    this._rayCount = rayCount;
    this._positions = new Float32Array(rayCount * 2 * 3);
    this._colors = new Float32Array(rayCount * 2 * 3);

    // 1. Line Segments with analog vertex colors
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this._positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(this._colors, 3));

    this._lineSegments = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.92 })
    );
    this._lineSegments.name = 'sensors:proximity-rays';
    this._lineSegments.userData.isExternalOverlay = true;
    this._lineSegments.frustumCulled = false;
    this.group.add(this._lineSegments);

    // 2. 3D contact points for obstacles
    this._hitPositions = new Float32Array(rayCount * 3);
    this._hitColors = new Float32Array(rayCount * 3);
    const hitGeo = new THREE.BufferGeometry();
    hitGeo.setAttribute('position', new THREE.BufferAttribute(this._hitPositions, 3));
    hitGeo.setAttribute('color', new THREE.BufferAttribute(this._hitColors, 3));

    this._hitPoints = new THREE.Points(
      hitGeo,
      new THREE.PointsMaterial({
        vertexColors: true,
        size: 8.0,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.95,
      })
    );
    this._hitPoints.name = 'sensors:proximity-hit-points';
    this._hitPoints.userData.isExternalOverlay = true;
    this._hitPoints.frustumCulled = false;
    this.group.add(this._hitPoints);

    this.group.visible = this._enabled;
    engine.sceneManager.add(this.group);
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
    this.group.visible = this._enabled;
  }

  /** Refresh vertices/colors from the array's latest analog distance cast. */
  update() {
    if (!this._enabled) return;
    const segments = this._sensorArray.raySegments;
    const maxRange = this._sensorArray.maxRangeM;

    let o = 0;
    let c = 0;
    let hp = 0;
    let hc = 0;

    for (const segment of segments) {
      const origin = segment.origin;
      const hit = segment.hit;
      const dist = hit ? hit.distanceM : maxRange;
      const endX = hit ? hit.point.x : origin.x + segment.direction.x * maxRange;
      const endY = hit ? hit.point.y : origin.y;
      const endZ = hit ? hit.point.z : origin.z + segment.direction.z * maxRange;

      this._positions[o++] = origin.x;
      this._positions[o++] = origin.y;
      this._positions[o++] = origin.z;
      this._positions[o++] = endX;
      this._positions[o++] = endY;
      this._positions[o++] = endZ;

      // Analog distance color at ray termination
      const analogColor = getAnalogDistanceColor(dist, maxRange, !!hit);

      // Ray origin: light blue technical emitter
      this._colors[c++] = 0.22;
      this._colors[c++] = 0.74;
      this._colors[c++] = 0.98;

      // Ray tip: analog distance color
      this._colors[c++] = analogColor.r;
      this._colors[c++] = analogColor.g;
      this._colors[c++] = analogColor.b;

      // Contact point marker
      if (hit) {
        this._hitPositions[hp++] = hit.point.x;
        this._hitPositions[hp++] = hit.point.y + 0.1;
        this._hitPositions[hp++] = hit.point.z;

        this._hitColors[hc++] = analogColor.r;
        this._hitColors[hc++] = analogColor.g;
        this._hitColors[hc++] = analogColor.b;
      } else {
        this._hitPositions[hp++] = 0;
        this._hitPositions[hp++] = -999;
        this._hitPositions[hp++] = 0;

        this._hitColors[hc++] = 0;
        this._hitColors[hc++] = 0;
        this._hitColors[hc++] = 0;
      }
    }

    this._lineSegments.geometry.attributes.position.needsUpdate = true;
    this._lineSegments.geometry.attributes.color.needsUpdate = true;
    this._hitPoints.geometry.attributes.position.needsUpdate = true;
    this._hitPoints.geometry.attributes.color.needsUpdate = true;
  }

  dispose() {
    this.group.parent?.remove(this.group);
    this._lineSegments.geometry.dispose();
    this._lineSegments.material.dispose();
    this._hitPoints.geometry.dispose();
    this._hitPoints.material.dispose();
    this._lineSegments = null;
    this._hitPoints = null;
    this._sensorArray = null;
  }
}