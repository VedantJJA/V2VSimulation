import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createVehicleMesh } from '../utils/GeometryUtils.js';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

/**
 * AssetLoader — cached GLTF loading with graceful fallback.
 *
 * loadModel(url) → Promise<THREE.Group>, ALWAYS resolving:
 * - success: the prepared gltf scene (shadows enabled, named after the URL);
 * - failure / empty URL: a fallback box mesh (the composite fallback car)
 *   tagged `mesh.userData.assetFallback = true`, with ONE warning per URL.
 *
 * The promise is cached per URL (including the fallback resolution), so a
 * missing model costs a single load attempt + warning per session. Callers
 * that need per-instance fallbacks (e.g. VehicleFactory's paint-colored
 * cars) check userData.assetFallback and apply their own.
 *
 * Model convention: authored in meters, facing −Z, origin at the chassis
 * center — matching the fallback mesh and every motion model.
 */
class AssetLoaderClass {
    constructor() {
        /** @type {Map<string, Promise<THREE.Group>>} */
        this._cache = new Map();
        this._gltfLoader = new GLTFLoader();
    }

    /**
     * @param {string} url relative to BASE_URL, absolute, or empty
     * @param {object} [options]
     * @param {number} [options.fallbackPaintColor] paint for the fallback mesh
     * @returns {Promise<THREE.Group>}
     */
    loadModel(url, { fallbackPaintColor = ConfigDefaults.vehicle.fallbackPaintHex } = {}) {
        if (!url) {
            console.warn('[AssetLoader] no model URL given — using fallback mesh');
            return Promise.resolve(this._fallback(fallbackPaintColor));
        }

        if (!this._cache.has(url)) {
            const promise = this._gltfLoader
                .loadAsync(this._resolveUrl(url))
                .then((gltf) => {
                    const model = gltf.scene ?? gltf.scenes?.[0] ?? null;
                    if (!model) throw new Error('GLTF contains no scene');
                    model.traverse((child) => {
                        if (child.isMesh) {
                            child.castShadow = true;
                            child.receiveShadow = true;
                        }
                    });
                    model.name = `model:${url}`;
                    return model;
                })
                .catch((error) => {
                    console.warn(
                        `[AssetLoader] failed to load "${url}" — using fallback mesh:`,
                        error?.message ?? error
                    );
                    return this._fallback(fallbackPaintColor);
                });
            this._cache.set(url, promise);
        }
        return this._cache.get(url);
    }

    /** Drop the cache (GLTF scenes share GPU resources with clones; page
     *  teardown handles them). */
    dispose() {
        this._cache.clear();
    }

    _fallback(paintColor) {
        const mesh = createVehicleMesh(paintColor);
        mesh.userData.assetFallback = true;
        return mesh;
    }

    _resolveUrl(url) {
        return /^(https?:)?\//.test(url) ? url : `${import.meta.env.BASE_URL}${url}`;
    }
}

export const AssetLoader = new AssetLoaderClass();