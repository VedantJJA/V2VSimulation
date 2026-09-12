import * as THREE from 'three';
import { createVehicleMesh } from '../utils/GeometryUtils.js';

function lerpAngle(from, to, t) {
  let diff = (to - from) % (Math.PI * 2);
  if (diff < -Math.PI) diff += Math.PI * 2;
  if (diff > Math.PI) diff -= Math.PI * 2;
  return from + diff * t;
}

/** Create an overhead billboard name badge canvas texture for remote players. */
function createNameplateTexture(name, colorHex) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');

  // Background rounded pill
  ctx.fillStyle = 'rgba(16, 20, 28, 0.88)';
  ctx.beginPath();
  ctx.roundRect(30, 24, 452, 80, 40);
  ctx.fill();

  // Glowing border with driver color
  const colorStr = typeof colorHex === 'number' ? `#${colorHex.toString(16).padStart(6, '0')}` : (colorHex || '#4ac9ff');
  ctx.strokeStyle = colorStr;
  ctx.lineWidth = 6;
  ctx.stroke();

  // Small online indicator dot
  ctx.fillStyle = '#10b981';
  ctx.beginPath();
  ctx.arc(75, 64, 12, 0, Math.PI * 2);
  ctx.fill();

  // Driver Name text
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 38px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(name.slice(0, 16), 105, 65);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * RemoteVehicle — Represents another human player's vehicle in the 3D scene.
 * Uses high-fidelity interpolation, wheel animation, dynamic brake lights,
 * and an overhead 3D name badge.
 */
export class RemoteVehicle {
  constructor({ id, name = 'Remote Driver', paintColor = 0x3f6d8c, sceneManager = null, initialSlot = 0 } = {}) {
    this.id = id;
    this.name = name;
    this.paintColor = paintColor;
    this._sceneManager = sceneManager;
    this.isRemote = true;
    this.isEgo = false;

    // 3D Vehicle Mesh
    this.mesh = createVehicleMesh(paintColor);
    this.mesh.name = `remote_vehicle:${id}`;

    // Target state received from network packets
    this.targetPosition = new THREE.Vector3(0, 0.72, 0);
    this.targetHeading = 0;
    this.targetSpeed = 0;
    this.targetSteering = 0;
    this.targetBrake = 0;

    // Current interpolated state
    this.currentPosition = new THREE.Vector3(0, 0.72, 0);
    this.currentHeading = 0;
    this.speedMps = 0;
    this.steeringRad = 0;

    // Overhead 3D Nameplate Sprite
    this._nameTexture = createNameplateTexture(name, paintColor);
    const spriteMaterial = new THREE.SpriteMaterial({
      map: this._nameTexture,
      transparent: true,
      depthTest: true,
    });
    this.nameSprite = new THREE.Sprite(spriteMaterial);
    this.nameSprite.scale.set(3.6, 0.9, 1);
    this.nameSprite.position.set(0, 2.3, 0);
    this.mesh.add(this.nameSprite);

    if (sceneManager) {
      sceneManager.add(this.mesh);
    }
  }

  /** Update target state from network message */
  setNetworkState(state) {
    if (!state) return;
    if (state.x != null && state.z != null) {
      this.targetPosition.set(state.x, state.y ?? 0.72, state.z);
    }
    if (state.headingRad != null) {
      this.targetHeading = state.headingRad;
    }
    if (state.speedMps != null) {
      this.targetSpeed = state.speedMps;
    }
    if (state.steeringRad != null) {
      this.targetSteering = state.steeringRad;
    }
    if (state.brake != null) {
      this.targetBrake = state.brake;
    }
  }

  /** Update name and paint color */
  updateProfile(name, color) {
    if (name && name !== this.name) {
      this.name = name;
      if (this._nameTexture) this._nameTexture.dispose();
      this._nameTexture = createNameplateTexture(this.name, this.paintColor);
      this.nameSprite.material.map = this._nameTexture;
      this.nameSprite.material.needsUpdate = true;
    }
    if (color != null && color !== this.paintColor) {
      this.paintColor = color;
      // Update body material
      if (this.mesh.userData?.bodyMesh) {
        this.mesh.userData.bodyMesh.material.color.set(color);
      }
    }
  }

  /**
   * Run every frame for silky-smooth dead-reckoning and interpolation.
   * @param {number} dt delta time in seconds
   */
  update(dt = 0.016) {
    if (!this.mesh) return;

    // Interpolation factor (~18/s responsiveness)
    const factor = Math.min(1.0, dt * 18);

    this.currentPosition.lerp(this.targetPosition, factor);
    this.currentHeading = lerpAngle(this.currentHeading, this.targetHeading, factor);
    this.speedMps = THREE.MathUtils.lerp(this.speedMps, this.targetSpeed, factor);
    this.steeringRad = THREE.MathUtils.lerp(this.steeringRad, this.targetSteering, factor);

    this.mesh.position.copy(this.currentPosition);
    this.mesh.rotation.y = -this.currentHeading;

    // Front wheels steering
    if (this.mesh.userData?.frontWheels) {
      for (const w of this.mesh.userData.frontWheels) {
        w.rotation.y = -this.steeringRad;
      }
    }

    // Wheel rolling rotation
    if (this.mesh.userData?.wheels && dt > 0) {
      const rollDelta = (this.speedMps * dt) / 0.36;
      for (const w of this.mesh.userData.wheels) {
        w.rotation.x -= rollDelta;
      }
    }

    // Brake lights illumination
    if (this.mesh.userData?.tailLights) {
      const isBraking = this.targetBrake > 0.08;
      const intensity = isBraking ? 4.5 : 1.2;
      for (const light of this.mesh.userData.tailLights) {
        if (light.material) {
          light.material.emissiveIntensity = intensity;
        }
      }
    }
  }

  get headingRad() {
    return this.currentHeading;
  }

  dispose() {
    if (this._nameTexture) this._nameTexture.dispose();
    if (this.nameSprite?.material) this.nameSprite.material.dispose();
    if (this._sceneManager && this.mesh) {
      this._sceneManager.remove(this.mesh);
    }
    this.mesh = null;
    this._sceneManager = null;
  }
}
