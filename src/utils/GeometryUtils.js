import * as THREE from 'three';
import { SplineUtils } from '../road/SplineUtils.js';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

const ROAD = ConfigDefaults.road;
const VEHICLE = ConfigDefaults.vehicle;

// Shared vehicle materials
const GLASS_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0x90b8d8,
  roughness: 0.1,
  metalness: 0.85,
  transparent: true,
  opacity: 0.45,
});
const INTERIOR_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0x16181b,
  roughness: 0.85,
  metalness: 0.1,
});
const HEADLIGHT_MAT = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  emissive: 0xd6f4ff,
  emissiveIntensity: 2.6,
  roughness: 0.1,
});
const TAILLIGHT_MAT = new THREE.MeshStandardMaterial({
  color: 0xff0022,
  emissive: 0xff0033,
  emissiveIntensity: 2.8,
  roughness: 0.2,
});
const TIRE_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x151618, roughness: 0.95 });
const RIM_MATERIAL = new THREE.MeshStandardMaterial({ color: 0xc8cdd5, metalness: 0.85, roughness: 0.25 });
const TRIM_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x16181a, roughness: 0.6, metalness: 0.5 });

const BODY_MATERIALS = new Map();
function bodyMaterial(color) {
  if (!BODY_MATERIALS.has(color)) {
    BODY_MATERIALS.set(
      color,
      new THREE.MeshStandardMaterial({
        color,
        roughness: VEHICLE.body.roughness,
        metalness: VEHICLE.body.metalness,
      })
    );
  }
  return BODY_MATERIALS.get(color);
}

function createWheelAssembly(isLeft) {
  const wheelGroup = new THREE.Group();
  const radius = VEHICLE.wheel?.radiusM ?? 0.36;
  const width = VEHICLE.wheel?.widthM ?? 0.28;
  const tireGeom = new THREE.CylinderGeometry(radius, radius, width, 16);
  tireGeom.rotateZ(Math.PI / 2);
  const tire = new THREE.Mesh(tireGeom, TIRE_MATERIAL);
  tire.castShadow = true;
  wheelGroup.add(tire);

  const rimGeom = new THREE.CylinderGeometry(radius * 0.72, radius * 0.72, width + 0.01, 12);
  rimGeom.rotateZ(Math.PI / 2);
  const rim = new THREE.Mesh(rimGeom, RIM_MATERIAL);
  wheelGroup.add(rim);

  return wheelGroup;
}

/**
 * Standard vehicle mesh (faces -Z, origin at chassis center).
 * @param {number} paintColor
 * @returns {THREE.Group}
 */
export function createVehicleMesh(paintColor) {
  const group = new THREE.Group();
  const paintMat = bodyMaterial(paintColor);

  // Lower chassis
  const chassisBase = new THREE.Mesh(new THREE.BoxGeometry(1.68, 0.28, 4.0), paintMat);
  chassisBase.position.set(0, -0.12, 0);
  chassisBase.castShadow = true;
  chassisBase.receiveShadow = true;
  group.add(chassisBase);

  // Cabin
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.48, 0.58, 2.1), GLASS_MATERIAL);
  cabin.position.set(0, 0.42, 0.05);
  cabin.castShadow = true;
  group.add(cabin);

  // Roof
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.06, 1.8), paintMat);
  roof.position.set(0, 0.72, 0.05);
  group.add(roof);

  // Hood
  const hood = new THREE.Mesh(new THREE.BoxGeometry(1.64, 0.22, 1.35), paintMat);
  hood.position.set(0, 0.08, -1.35);
  hood.castShadow = true;
  group.add(hood);

  // Trunk
  const trunk = new THREE.Mesh(new THREE.BoxGeometry(1.64, 0.22, 0.8), paintMat);
  trunk.position.set(0, 0.08, 1.45);
  trunk.castShadow = true;
  group.add(trunk);

  // Headlights
  for (const sx of [-1, 1]) {
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.06), HEADLIGHT_MAT);
    head.position.set(sx * 0.62, 0.08, -2.01);
    group.add(head);

    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.12, 0.06), TAILLIGHT_MAT);
    tail.position.set(sx * 0.62, 0.12, 1.95);
    group.add(tail);
  }

  // Wheels
  const offsetZ = VEHICLE.wheel?.offsetZM ?? VEHICLE.wheel?.frontAxleZ ?? 1.35;
  const trackX = VEHICLE.wheel?.trackM ?? 0.82;
  const wheelZ = [-offsetZ, offsetZ];
  const wheels = [];
  const frontWheels = [];

  for (const z of wheelZ) {
    const isFront = z < 0;
    for (const sx of [-1, 1]) {
      const isLeft = sx < 0;
      const wheelAssembly = createWheelAssembly(isLeft);
      const pivot = new THREE.Group();
      pivot.position.set(sx * trackX, -0.32, z);
      pivot.add(wheelAssembly);
      group.add(pivot);
      wheels.push(wheelAssembly);
      if (isFront) frontWheels.push(pivot);
    }
  }

  group.userData = {
    wheels,
    frontWheels,
  };

  return group;
}

// ---------------------------------------------------------------------------
// Obstruction Mesh Builder (Cones and Barriers)
// ---------------------------------------------------------------------------

const FULL_TEXTURE = createStripedTexture('#ff5500', '#ffffff');
const FULL_MATERIAL = new THREE.MeshStandardMaterial({
  map: FULL_TEXTURE,
  roughness: 0.7,
  metalness: 0.1,
});

const PARTIAL_TEXTURE = createConeTexture('#ff6600', '#ffffff');
const PARTIAL_MATERIAL = new THREE.MeshStandardMaterial({
  map: PARTIAL_TEXTURE,
  roughness: 0.8,
  metalness: 0.05,
});

function createStripedTexture(color1, color2) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color1;
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = color2;
  for (let i = 0; i < 4; i++) {
    ctx.fillRect(0, i * 32, 128, 16);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

function createConeTexture(color1, color2) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color1;
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = color2;
  ctx.fillRect(0, 24, 64, 16);
  return new THREE.CanvasTexture(canvas);
}

export function createObstructionMesh(blocking, laneWidthM = ROAD.laneWidthM) {
  const geometry =
    blocking === 'full'
      ? new THREE.BoxGeometry(laneWidthM * ROAD.barrierLaneWidthFactor, ROAD.barrierHeightM, ROAD.barrierDepthM)
      : new THREE.ConeGeometry(ROAD.coneRadiusM, ROAD.coneHeightM, ROAD.coneSegments);
  const mesh = new THREE.Mesh(geometry, blocking === 'full' ? FULL_MATERIAL : PARTIAL_MATERIAL);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// ---------------------------------------------------------------------------
// Ribbon builder — the flat triangle-strip geometry behind road surfaces
// ---------------------------------------------------------------------------

export function buildRibbonGeometry(
  curve,
  {
    offsetLeftM,
    offsetRightM,
    y = 0,
    spacingM = ROAD.sampleSpacingM,
    minSamples = ROAD.minSamples,
    uvTileM = null,
    tStart = 0,
    tEnd = 1,
  }
) {
  const fullLength = curve.getLength();
  const length = fullLength * Math.abs(tEnd - tStart);
  const samples = Math.max(minSamples, Math.ceil(length / spacingM) + 1);
  const vertexCount = samples * 2;
  const quadCount = samples - 1;

  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = vertexCount > 65535 ? new Uint32Array(quadCount * 6) : new Uint16Array(quadCount * 6);

  for (let i = 0; i < samples; i++) {
    const fraction = samples > 1 ? i / (samples - 1) : 0;
    const t = tStart + fraction * (tEnd - tStart);
    const frame = SplineUtils.computeFrame(curve, t);
    const distance = fraction * length;

    const offL = typeof offsetLeftM === 'function' ? offsetLeftM(t) : offsetLeftM;
    const offR = typeof offsetRightM === 'function' ? offsetRightM(t) : offsetRightM;

    const a = frame.position.clone().addScaledVector(frame.left, offL);
    const b = frame.position.clone().addScaledVector(frame.right, offR);

    positions[i * 6 + 0] = a.x;
    positions[i * 6 + 1] = a.y + y;
    positions[i * 6 + 2] = a.z;
    positions[i * 6 + 3] = b.x;
    positions[i * 6 + 4] = b.y + y;
    positions[i * 6 + 5] = b.z;

    if (uvTileM !== null) {
      uvs[i * 4 + 0] = -offL / uvTileM;
      uvs[i * 4 + 1] = distance / uvTileM;
      uvs[i * 4 + 2] = offR / uvTileM;
      uvs[i * 4 + 3] = distance / uvTileM;
    } else {
      uvs[i * 4 + 0] = 0;
      uvs[i * 4 + 1] = t;
      uvs[i * 4 + 2] = 1;
      uvs[i * 4 + 3] = t;
    }

    if (i < quadCount) {
      const base = i * 2;
      const o = i * 6;
      indices[o] = base;
      indices[o + 1] = base + 1;
      indices[o + 2] = base + 2;
      indices[o + 3] = base + 1;
      indices[o + 4] = base + 3;
      indices[o + 5] = base + 2;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}