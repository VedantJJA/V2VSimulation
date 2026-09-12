import * as THREE from 'three';

const LOS_COLOR = new THREE.Color(0x35d07f); // green: line of sight
const NLOS_COLOR = new THREE.Color(0xff4a4a); // red: NLOS but received
const BLOCKED_COLOR = new THREE.Color(0x5d6875); // dim: dropped (rays mode only)
const LINK_HEIGHT_M = 2.2; // flat overlay height, above the cars

/**
 * V2VVisualizer — ego-centric debug overlay (Phase 10-E).
 *
 * Links mode ('V2V links' toggle): one line per RECEIVED neighbor — green
 * LOS, red NLOS-but-received; dropped links draw nothing (their absence in
 * the overlay IS the visualization of a blocked link).
 *
 * Rays mode ('LOS rays + wall hits' toggle): draws ALL candidate links
 * (received colored, dropped dim gray) and places red markers at the
 * building-intersection points along the ego's propagation rays.
 *
 * Data source: ego.v2vLinks — { id, distanceM, received, los, pdr, bsm,
 * hits } — attached by V2VManager each tick. Buffers are pre-sized and
 * updated in place (drawRange / instance count).
 */
export class V2VVisualizer {
    /**
     * @param {import('../core/Engine.js').Engine} engine
     * @param {object} options
     * @param {import('../vehicles/Vehicle.js').Vehicle} options.ego
     * @param {number} [options.maxLinks]
     */
    constructor(engine, { ego, maxLinks = 64 } = {}) {
        if (!ego) throw new TypeError('V2VVisualizer: ego is required');
        this._ego = ego;
        this._maxLinks = maxLinks;
        this._enabled = false;
        this._showRays = false;

        this._positions = new Float32Array(maxLinks * 2 * 3);
        this._colors = new Float32Array(maxLinks * 2 * 3);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(this._positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(this._colors, 3));
        geometry.setDrawRange(0, 0);

        this._lineSegments = new THREE.LineSegments(
            geometry,
            new THREE.LineBasicMaterial({
                vertexColors: true,
                transparent: true,
                opacity: 0.85,
                depthTest: false,
                depthWrite: false,
            })
        );
        this._lineSegments.name = 'v2v:links';
        this._lineSegments.userData.isExternalOverlay = true;
        this._lineSegments.frustumCulled = false;
        this._lineSegments.visible = false;
        engine.sceneManager.add(this._lineSegments);

        this._hitMarkers = new THREE.InstancedMesh(
            new THREE.SphereGeometry(0.55, 10, 8),
            new THREE.MeshBasicMaterial({ color: 0xff4a4a, depthTest: false, depthWrite: false }),
            maxLinks * 4
        );
        this._hitMarkers.name = 'v2v:wall-hits';
        this._hitMarkers.userData.isExternalOverlay = true;
        this._hitMarkers.frustumCulled = false;
        this._hitMarkers.visible = false;
        this._hitMarkers.count = 0;
        engine.sceneManager.add(this._hitMarkers);
    }

    get enabled() {
        return this._enabled;
    }

    setEnabled(enabled) {
        this._enabled = !!enabled;
        this._lineSegments.visible = this._enabled || this._showRays;
    }

    /** Rays debug mode: all candidates + building-hit markers. */
    setShowRays(showRays) {
        this._showRays = !!showRays;
        this._lineSegments.visible = this._enabled || this._showRays;
    }

    /** Refresh from the ego's latest v2vLinks. */
    update() {
        if (!this._enabled && !this._showRays) return;
        const links = this._ego.v2vLinks ?? [];
        const own = this._ego.motionModel.getState().position;

        let lineCount = 0;
        let markerCount = 0;
        const matrix = new THREE.Matrix4();

        for (const link of links) {
            if (lineCount >= this._maxLinks) break;
            if (!link.received && !this._showRays) continue; // links mode: no line when blocked
            const bsm = link.bsm;
            if (!bsm?.position) continue;

            const color = link.received ? (link.los ? LOS_COLOR : NLOS_COLOR) : BLOCKED_COLOR;
            const o = lineCount * 6;
            const c = lineCount * 6;
            this._positions[o] = own.x;
            this._positions[o + 1] = LINK_HEIGHT_M;
            this._positions[o + 2] = own.z;
            this._positions[o + 3] = bsm.position.x;
            this._positions[o + 4] = LINK_HEIGHT_M;
            this._positions[o + 5] = bsm.position.z;
            for (let v = 0; v < 2; v++) {
                this._colors[c + v * 3] = color.r;
                this._colors[c + v * 3 + 1] = color.g;
                this._colors[c + v * 3 + 2] = color.b;
            }
            lineCount += 1;

            if (this._showRays && link.hits) {
                for (const point of link.hits) {
                    if (markerCount >= this._maxLinks * 4) break;
                    matrix.setPosition(point.x, point.y + 0.4, point.z);
                    this._hitMarkers.setMatrixAt(markerCount++, matrix);
                }
            }
        }

        const geometry = this._lineSegments.geometry;
        geometry.setDrawRange(0, lineCount * 2);
        geometry.attributes.position.needsUpdate = true;
        geometry.attributes.color.needsUpdate = true;

        this._hitMarkers.count = this._showRays ? markerCount : 0;
        this._hitMarkers.visible = this._showRays && markerCount > 0;
        if (this._hitMarkers.visible) this._hitMarkers.instanceMatrix.needsUpdate = true;
    }

    dispose() {
        for (const object of [this._lineSegments, this._hitMarkers]) {
            object.parent?.remove(object);
            object.geometry.dispose();
            object.material.dispose();
        }
        this._lineSegments = null;
        this._hitMarkers = null;
        this._ego = null;
    }
}