/**
 * AppState — a thin, singleton lookup point for cross-cutting references.
 * NOT a state-management framework: no reactivity, no events (use the
 * Engine's EventBus for those). Writers: main.js mode transitions and the
 * simulation session. Readers: systems that would otherwise reach through
 * module chains (V2VManager falls back to AppState.ego).
 */
class _AppState {
    constructor() {
        /** @type {'edit' | 'simulate' | null} null until the first boot choice. */
        this._mode = null;
        /** Active map JSON reference (the data the current session was built from). */
        this._mapData = null;
        /** @type {import('../vehicles/Vehicle.js').Vehicle | null} */
        this._ego = null;
    }

    get mode() {
        return this._mode;
    }

    setMode(mode) {
        if (mode !== null && mode !== 'edit' && mode !== 'simulate') {
            throw new Error(`AppState.setMode: expected 'edit' | 'simulate' | null (got "${mode}")`);
        }
        this._mode = mode;
        return mode;
    }

    get mapData() {
        return this._mapData;
    }

    setMapData(mapData) {
        this._mapData = mapData ?? null;
        return this._mapData;
    }

    get ego() {
        return this._ego;
    }

    setEgo(ego) {
        this._ego = ego ?? null;
        return this._ego;
    }

    reset() {
        this._mode = null;
        this._mapData = null;
        this._ego = null;
    }
}

export const AppState = new _AppState();