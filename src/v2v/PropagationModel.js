import * as THREE from 'three';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

const PROPAGATION = ConfigDefaults.v2v.propagation;

/**
 * PropagationModel — 5.9 GHz V2V link model (simplified). Buildings-only
 * LOS raycast (BVH shared with RaycastEngine), cumulative wall-thickness
 * attenuation with per-tick PDR re-rolls, and pair-geometry caching. See
 * the Phase 10 file notes for the full model description.
 */
export class PropagationModel {
    /**
     * @param {object} [options]
     * @param {number} [options.wallThicknessThresholdM] default: ConfigDefaults.v2v.propagation.wallThicknessThresholdM
     * @param {number} [options.recomputeDistanceM]
     */
    constructor({
        wallThicknessThresholdM = PROPAGATION.wallThicknessThresholdM,
        recomputeDistanceM = PROPAGATION.recomputeDistanceM,
    } = {}) {
        this.wallThicknessThresholdM = wallThicknessThresholdM;
        this._recomputeDistanceM = recomputeDistanceM;

        this._raycaster = new THREE.Raycaster();
        this._raycaster.near = 0;
        this._raycaster.firstHitOnly = false; // all crossings → thickness

        /** @type {THREE.Mesh[]} */
        this._buildings = [];
        this._meshVersion = 0;
        /** @type {Map<string, object>} unordered pair key → geometry entry */
        this._cache = new Map();

        this.stats = { pairs: 0, recomputed: 0, dropped: 0 };
    }

    /** Point the model at the building meshes (BVH shared with RaycastEngine). */
    setBuildingMeshes(meshes) {
        this._buildings = (meshes ?? []).filter((mesh) => mesh?.isMesh);
        this._meshVersion += 1;
        this._cache.clear();
    }

    /** Per tick: drop meshes removed from the scene; bump version on change. */
    update() {
        let changed = false;
        this._buildings = this._buildings.filter((mesh) => {
            if (!mesh.parent) {
                changed = true;
                return false;
            }
            return true;
        });
        if (changed) {
            this._meshVersion += 1;
            this._cache.clear();
        }
        this.stats.pairs = 0;
        this.stats.recomputed = 0;
        this.stats.dropped = 0;
    }

    /**
     * Can `sender`'s BSM reach `receiver` this tick?
     * @returns {{ received: boolean, los: boolean, thicknessM: number, pdr: number, hits: THREE.Vector3[] }}
     */
    evaluate(receiver, sender) {
        this.stats.pairs += 1;
        const a = receiver.motionModel.getState().position;
        const b = sender.motionModel.getState().position;

        if (this._buildings.length === 0) {
            return { received: true, los: true, thicknessM: 0, pdr: 1, hits: [] };
        }

        const key =
            receiver.id < sender.id ? `${receiver.id}|${sender.id}` : `${sender.id}|${receiver.id}`;
        let entry = this._cache.get(key);
        if (
            !entry ||
            entry.version !== this._meshVersion ||
            entry.a.distanceToSquared(a) > this._recomputeDistanceM * this._recomputeDistanceM ||
            entry.b.distanceToSquared(b) > this._recomputeDistanceM * this._recomputeDistanceM
        ) {
            entry = this._computeLink(a, b, key);
            this.stats.recomputed += 1;
        }

        const pdr = entry.los ? 1 : Math.max(0, 1 - entry.thicknessM / this.wallThicknessThresholdM);
        const received = pdr >= 1 ? true : Math.random() < pdr;
        if (!received) this.stats.dropped += 1;
        return { received, los: entry.los, thicknessM: entry.thicknessM, pdr, hits: entry.hits };
    }

    /** Raycast A→B against the buildings; measure per-building chords. */
    _computeLink(a, b, key) {
        const entry = {
            version: this._meshVersion,
            a: a.clone(),
            b: b.clone(),
            los: true,
            thicknessM: 0,
            hits: [],
        };

        const direction = new THREE.Vector3().subVectors(b, a);
        const distance = direction.length();
        if (distance > 1e-3) {
            direction.multiplyScalar(1 / distance);
            this._raycaster.set(a, direction);
            this._raycaster.far = distance;
            const hits = this._raycaster.intersectObjects(this._buildings, false);
            if (hits.length > 0) {
                entry.los = false;
                // Per building: first→last crossing distance = wall chord.
                const perMesh = new Map();
                for (const hit of hits) {
                    const id = hit.object.uuid;
                    if (!perMesh.has(id)) perMesh.set(id, []);
                    perMesh.get(id).push(hit.distance);
                }
                for (const distances of perMesh.values()) {
                    if (distances.length >= 2) {
                        entry.thicknessM += Math.max(...distances) - Math.min(...distances);
                    }
                }
                entry.hits = hits.slice(0, PROPAGATION.maxHitPoints).map((hit) => hit.point.clone());
            }
        }

        if (this._cache.size > PROPAGATION.maxCachedPairs) this._cache.clear();
        this._cache.set(key, entry);
        return entry;
    }
}