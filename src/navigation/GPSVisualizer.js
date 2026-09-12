import * as THREE from 'three';
import { ROAD_SURFACE_Y } from '../road/RoadMeshBuilder.js';

const RIBBON_Y = ROAD_SURFACE_Y + 0.04;

/**
 * GPSVisualizer — 3D in-world navigation ribbon and holographic waypoint beacon.
 *
 * Renders:
 * 1. 3D glowing GPS ribbon along the calculated route waypoints on the road.
 * 2. 3D holographic destination beacon (light column + pulsing ground rings + hovering marker).
 */
export class GPSVisualizer {
  /**
   * @param {import('../core/Engine.js').Engine} engine
   */
  constructor(engine) {
    this._sceneManager = engine.sceneManager;
    this._group = new THREE.Group();
    this._group.name = 'navigation:visualizer';
    this._group.userData.isExternalOverlay = true;
    this._sceneManager.add(this._group);

    // Route ribbon mesh & material
    this._ribbonMaterial = new THREE.MeshBasicMaterial({
      color: 0x9333ea, // Vibrant GTA waypoint purple
      transparent: true,
      opacity: 0.78,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this._ribbonMesh = null;

    // Destination beacon group
    this._beaconGroup = new THREE.Group();
    this._beaconGroup.name = 'navigation:beacon';
    this._beaconGroup.userData.isExternalOverlay = true;
    this._beaconGroup.visible = false;
    this._group.add(this._beaconGroup);

    this._buildBeaconMeshes();

    this._animTime = 0;
  }

  _buildBeaconMeshes() {
    // 1. Vertical holographic light cylinder
    const cylinderGeo = new THREE.CylinderGeometry(1.2, 1.2, 22, 24, 1, true);
    cylinderGeo.translate(0, 11, 0);
    this._cylinderMat = new THREE.MeshBasicMaterial({
      color: 0xa855f7,
      transparent: true,
      opacity: 0.4,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const cylinderMesh = new THREE.Mesh(cylinderGeo, this._cylinderMat);
    this._beaconGroup.add(cylinderMesh);

    // 2. Concentric pulsing ground rings
    const ringGeo = new THREE.RingGeometry(1.0, 1.6, 32);
    ringGeo.rotateX(-Math.PI / 2);
    this._ringMat = new THREE.MeshBasicMaterial({
      color: 0xd8b4fe,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this._ringMesh = new THREE.Mesh(ringGeo, this._ringMat);
    this._ringMesh.position.y = RIBBON_Y + 0.02;
    this._beaconGroup.add(this._ringMesh);

    // 3. Floating rotating diamond / waypoint crystal
    const crystalGeo = new THREE.OctahedronGeometry(1.2, 0);
    this._crystalMat = new THREE.MeshBasicMaterial({
      color: 0xfacc15, // Golden glowing core
      wireframe: false,
    });
    this._crystalMesh = new THREE.Mesh(crystalGeo, this._crystalMat);
    this._crystalMesh.position.y = 4.5;
    this._beaconGroup.add(this._crystalMesh);

    // Outer wireframe highlight
    const crystalWireGeo = new THREE.OctahedronGeometry(1.35, 0);
    const wireMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      wireframe: true,
    });
    this._wireMesh = new THREE.Mesh(crystalWireGeo, wireMat);
    this._crystalMesh.add(this._wireMesh);
  }

  /**
   * Update 3D route ribbon geometry from array of waypoints {x, y, z}.
   * @param {Array<{ x: number, y?: number, z: number }>} waypoints
   */
  setRoute(waypoints) {
    if (this._ribbonMesh) {
      this._group.remove(this._ribbonMesh);
      this._ribbonMesh.geometry.dispose();
      this._ribbonMesh = null;
    }

    if (!waypoints || waypoints.length < 2) return;

    const width = 1.6; // Lane ribbon width
    const half = width / 2;
    const positions = [];
    const indices = [];

    for (let i = 0; i < waypoints.length; i++) {
      const p = waypoints[i];
      let dir;

      if (i < waypoints.length - 1) {
        const next = waypoints[i + 1];
        dir = new THREE.Vector3(next.x - p.x, 0, next.z - p.z).normalize();
      } else {
        const prev = waypoints[i - 1];
        dir = new THREE.Vector3(p.x - prev.x, 0, p.z - prev.z).normalize();
      }

      if (dir.lengthSq() < 1e-4) dir.set(0, 0, 1);

      // Perpendicular normal vector on X-Z plane
      const nx = -dir.z;
      const nz = dir.x;

      positions.push(
        p.x + nx * half, RIBBON_Y, p.z + nz * half,
        p.x - nx * half, RIBBON_Y, p.z - nz * half
      );

      if (i < waypoints.length - 1) {
        const base = i * 2;
        indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    this._ribbonMesh = new THREE.Mesh(geometry, this._ribbonMaterial);
    this._ribbonMesh.name = 'navigation:ribbon-mesh';
    this._ribbonMesh.userData.isExternalOverlay = true;
    this._group.add(this._ribbonMesh);
  }

  clearRoute() {
    if (this._ribbonMesh) {
      this._group.remove(this._ribbonMesh);
      this._ribbonMesh.geometry.dispose();
      this._ribbonMesh = null;
    }
  }

  /**
   * Set 3D beacon location.
   * @param {{ x: number, z: number }} position
   */
  setCheckpoint(position) {
    if (!position) {
      this.clearCheckpoint();
      return;
    }
    this._beaconGroup.position.set(position.x, 0, position.z);
    this._beaconGroup.visible = true;
  }

  clearCheckpoint() {
    this._beaconGroup.visible = false;
  }

  /**
   * Per-frame animation for beacon and ribbon.
   */
  update(dt = 0.016) {
    this._animTime += dt;

    if (this._beaconGroup.visible) {
      // Rotate crystal
      if (this._crystalMesh) {
        this._crystalMesh.rotation.y += dt * 2.2;
        this._crystalMesh.position.y = 4.5 + Math.sin(this._animTime * 3.0) * 0.4;
      }
      // Pulse ground ring
      if (this._ringMesh) {
        const pulse = 1.0 + Math.sin(this._animTime * 4.0) * 0.25;
        this._ringMesh.scale.set(pulse, pulse, pulse);
        this._ringMat.opacity = 0.5 + Math.sin(this._animTime * 4.0) * 0.35;
      }
      // Light cylinder pulse
      if (this._cylinderMat) {
        this._cylinderMat.opacity = 0.25 + Math.sin(this._animTime * 2.5) * 0.15;
      }
    }

    if (this._ribbonMesh) {
      // Subtle glowing pulse on navigation line
      this._ribbonMaterial.opacity = 0.72 + Math.sin(this._animTime * 4.0) * 0.18;
    }
  }

  dispose() {
    this.clearRoute();
    if (this._beaconGroup) {
      for (const child of this._beaconGroup.children) {
        child.geometry?.dispose();
      }
    }
    this._ribbonMaterial.dispose();
    this._cylinderMat?.dispose();
    this._ringMat?.dispose();
    this._crystalMat?.dispose();
    this._sceneManager.remove(this._group);
  }
}
