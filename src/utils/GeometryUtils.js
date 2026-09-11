import * as THREE from 'three';
import { SplineUtils } from '../road/SplineUtils.js';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

const ROAD = ConfigDefaults.road;
const VEHICLE = ConfigDefaults.vehicle;

// ---------------------------------------------------------------------------
// Vehicle fallback mesh (shared by Vehicle, AssetLoader's fallback, and the
// editor's spawn previews). One geometry/material set for ALL instances;
// body materials are cached per paint color. Mesh faces −Z; origin = the
// chassis center; wheel bottoms sit at local −0.67.
// ---------------------------------------------------------------------------
const BODY_GEOMETRY = new THREE.BoxGeometry(VEHICLE.body.widthM, VEHICLE.body.heightM, VEHICLE.body.lengthM);
const CABIN_GEOMETRY = new THREE.BoxGeometry(VEHICLE.cabin.widthM, VEHICLE.cabin.heightM, VEHICLE.cabin.lengthM);
const WHEEL_GEOMETRY = new THREE.CylinderGeometry(VEHICLE.wheel.radiusM, VEHICLE.wheel.radiusM, VEHICLE.wheel.widthM, 14);
WHEEL_GEOMETRY.rotateZ(Math.PI / 2); // roll axis → local X
const CABIN_MATERIAL = new THREE.MeshStandardMaterial({
    color: VEHICLE.cabin.colorHex,
    roughness: VEHICLE.cabin.roughness,
    metalness: VEHICLE.cabin.metalness,
});
const WHEEL_MATERIAL = new THREE.MeshStandardMaterial({ color: VEHICLE.wheel.colorHex, roughness: 0.9 });
const BODY_MATERIALS = new Map();

function bodyMaterial(color) {
    if (!BODY_MATERIALS.has(color)) {
        BODY_MATERIALS.set(
            color,
            new THREE.MeshStandardMaterial({ color, roughness: VEHICLE.body.roughness, metalness: VEHICLE.body.metalness })
        );
    }
    return BODY_MATERIALS.get(color);
}

/**
 * Build the fallback car mesh (faces −Z; origin = chassis center).
 * @param {number} paintColor
 * @returns {THREE.Group}
 */
export function createVehicleMesh(paintColor) {
    const group = new THREE.Group();

    const body = new THREE.Mesh(BODY_GEOMETRY, bodyMaterial(paintColor));
    body.position.set(0, VEHICLE.body.offsetY, 0);
    body.castShadow = true;
    body.receiveShadow = true;

    const cabin = new THREE.Mesh(CABIN_GEOMETRY, CABIN_MATERIAL);
    cabin.position.set(0, VEHICLE.cabin.offsetY, VEHICLE.cabin.offsetZ); // toward the rear (+Z)
    cabin.castShadow = true;

    for (const x of [VEHICLE.wheel.trackM, -VEHICLE.wheel.trackM]) {
        for (const z of [VEHICLE.wheel.offsetZM, -VEHICLE.wheel.offsetZM]) {
            const wheel = new THREE.Mesh(WHEEL_GEOMETRY, WHEEL_MATERIAL);
            wheel.position.set(x, VEHICLE.wheel.offsetY, z);
            wheel.castShadow = true;
            group.add(wheel);
        }
    }

    group.add(body, cabin);
    return group;
}

// ---------------------------------------------------------------------------
// Obstruction proxy meshes (moved out of road/RoadObstruction.js).
// ---------------------------------------------------------------------------
const PARTIAL_MATERIAL = new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.7 });
const FULL_MATERIAL = new THREE.MeshStandardMaterial({ color: 0xb23b2e, roughness: 0.8 });

/**
 * Proxy mesh for a lane obstruction: a traffic cone ('partial') or a
 * lane-spanning barrier ('full'). Per-instance geometry (barrier width
 * scales with laneWidthM); materials are shared.
 * @returns {THREE.Mesh} (geometry.parameters.height is used by RoadObstruction)
 */
export function createObstructionMesh({ blocking, laneWidthM }) {
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
// Ribbon builder (moved out of road/SplineUtils.js) — the flat triangle-strip
// geometry behind road surfaces, edge lines, and centerlines.
// ---------------------------------------------------------------------------

/**
 * Flat ribbon (triangle strip) between two lateral offsets: from
 * pos + left·offsetLeftM to pos + right·offsetRightM, raised by `y`, sampled
 * along the curve (arc-length parameterised).
 *
 * uvTileM: when set, UVs are in tile units (lateral meters / tile,
 * distance / tile) for a RepeatWrapping texture; otherwise normalized.
 */
export function buildRibbonGeometry(
    curve,
    {
        offsetLeftM,
        offsetRightM,
        y = 0,
        spacingM = ROAD.sampleSpacingM,
        minSamples = ROAD.minSamples,
        uvTileM = null,
    }
) {
    const length = curve.getLength();
    const samples = Math.max(minSamples, Math.ceil(length / spacingM) + 1);
    const vertexCount = samples * 2;
    const quadCount = samples - 1;

    const positions = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const indices = vertexCount > 65535 ? new Uint32Array(quadCount * 6) : new Uint16Array(quadCount * 6);

    for (let i = 0; i < samples; i++) {
        const t = i / (samples - 1);
        const frame = SplineUtils.computeFrame(curve, t);
        const distance = t * length; // arc-length parameterised: exact

        const a = frame.position.clone().addScaledVector(frame.left, offsetLeftM);
        const b = frame.position.clone().addScaledVector(frame.right, offsetRightM);

        positions[i * 6 + 0] = a.x;
        positions[i * 6 + 1] = a.y + y;
        positions[i * 6 + 2] = a.z;
        positions[i * 6 + 3] = b.x;
        positions[i * 6 + 4] = b.y + y;
        positions[i * 6 + 5] = b.z;

        if (uvTileM !== null) {
            uvs[i * 4 + 0] = -offsetLeftM / uvTileM;
            uvs[i * 4 + 1] = distance / uvTileM;
            uvs[i * 4 + 2] = offsetRightM / uvTileM;
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
            // Winding gives upward-facing normals (verified: left edge first).
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