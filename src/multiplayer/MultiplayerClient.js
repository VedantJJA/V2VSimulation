import { RemoteVehicle } from './RemoteVehicle.js';

const STYLES_ID = 'multiplayer-hud-styles';
const STYLES = `
  .mp-hud { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 50; display: flex;
    align-items: center; gap: 8px; padding: 7px 16px; background: rgba(16, 20, 28, 0.90);
    backdrop-filter: blur(8px); border: 1px solid #2b3544; border-radius: 20px;
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; font-size: 12px;
    color: #e2e8f0; pointer-events: none; user-select: none; box-shadow: 0 4px 16px rgba(0,0,0,0.4); }
  .mp-dot { width: 8px; height: 8px; border-radius: 50%; background: #10b981;
    box-shadow: 0 0 8px #10b981; }
  .mp-dot--disconnected { background: #ef4444; box-shadow: 0 0 8px #ef4444; }
  .mp-dot--connecting { background: #f59e0b; box-shadow: 0 0 8px #f59e0b; }
  .mp-text { display: flex; align-items: center; gap: 6px; }
  .mp-count { color: #4ac9ff; font-weight: bold; }
  .mp-badge { font-size: 10px; padding: 2px 6px; border-radius: 4px; background: #223044; color: #94a3b8; }
`;

/**
 * MultiplayerClient — Manages WebSocket connection, high-frequency state
 * synchronization (30 Hz), remote player entity lifecycle, and UI HUD.
 */
export class MultiplayerClient {
  /**
   * @param {object} options
   * @param {string} options.serverUrl WebSocket URL (e.g. 'ws://localhost:8080')
   * @param {string} options.playerName Player display name
   * @param {number|string} options.vehicleColor Paint color
   * @param {import('../core/SceneManager.js').SceneManager} options.sceneManager
   * @param {import('../ui/Minimap.js').Minimap} [options.minimap]
   */
  constructor({
    serverUrl = 'ws://localhost:8080',
    playerName = 'Driver',
    vehicleColor = 0xc23b2e,
    sceneManager = null,
    minimap = null,
  } = {}) {
    this.serverUrl = serverUrl;
    this.playerName = playerName;
    this.vehicleColor = vehicleColor;
    this._sceneManager = sceneManager;
    this._minimap = minimap;

    this.localId = null;
    this.localSlot = 0;
    this.isConnected = false;
    this.isConnecting = false;

    /** @type {Map<string, RemoteVehicle>} */
    this.remotePlayers = new Map();

    this._sendTimer = 0;
    this._sendIntervalSec = 1 / 30; // 30 Hz updates

    this._initHud();
    this.connect();
  }

  _initHud() {
    if (!document.getElementById(STYLES_ID)) {
      const style = document.createElement('style');
      style.id = STYLES_ID;
      style.textContent = STYLES;
      document.head.appendChild(style);
    }

    this._hudEl = document.createElement('div');
    this._hudEl.className = 'mp-hud';
    this._hudEl.innerHTML = `
      <div class="mp-dot mp-dot--connecting" id="mp-dot"></div>
      <div class="mp-text" id="mp-text">Connecting to ${this.serverUrl}…</div>
      <div class="mp-badge" id="mp-badge">MULTIPLAYER</div>
    `;
    document.body.appendChild(this._hudEl);
  }

  _updateHud(status, count = 1) {
    if (!this._hudEl) return;
    const dot = this._hudEl.querySelector('#mp-dot');
    const text = this._hudEl.querySelector('#mp-text');

    if (status === 'connected') {
      if (dot) dot.className = 'mp-dot';
      if (text) {
        text.innerHTML = `Online · <span class="mp-count">${count} ${count === 1 ? 'Racer' : 'Racers'}</span> · Grid P${this.localSlot + 1}`;
      }
    } else if (status === 'connecting') {
      if (dot) dot.className = 'mp-dot mp-dot--connecting';
      if (text) text.textContent = `Connecting to ${this.serverUrl}…`;
    } else {
      if (dot) dot.className = 'mp-dot mp-dot--disconnected';
      if (text) text.textContent = `Disconnected · Retry in 3s`;
    }
  }

  connect() {
    if (this._ws || this.isConnected) return;
    this.isConnecting = true;
    this._updateHud('connecting');

    try {
      this._ws = new WebSocket(this.serverUrl);

      this._ws.onopen = () => {
        this.isConnected = true;
        this.isConnecting = false;
        console.log(`[Multiplayer] Connected to server: ${this.serverUrl}`);

        // Send initial identity payload
        this._send({
          type: 'init',
          name: this.playerName,
          color: this.vehicleColor,
        });
      };

      this._ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this._handleMessage(msg);
        } catch (e) {
          console.error('[Multiplayer] Message parse error:', e);
        }
      };

      this._ws.onclose = () => {
        this.isConnected = false;
        this.isConnecting = false;
        this._ws = null;
        console.log('[Multiplayer] Disconnected from server');
        this._updateHud('disconnected');
        // Clear remote players visually
        this._clearRemotePlayers();
      };

      this._ws.onerror = (err) => {
        console.warn('[Multiplayer] WebSocket connection error:', err);
      };
    } catch (err) {
      console.error('[Multiplayer] Error creating WebSocket:', err);
      this.isConnecting = false;
      this._updateHud('disconnected');
    }
  }

  _send(payload) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(payload));
    }
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'welcome': {
        this.localId = msg.id;
        this.localSlot = msg.slot ?? 0;
        console.log(`[Multiplayer] Welcome! Local ID: ${this.localId} | Starting Slot: P${this.localSlot + 1}`);

        // Spawn all players currently in the room
        if (Array.isArray(msg.players)) {
          for (const player of msg.players) {
            this._spawnRemotePlayer(player);
          }
        }
        this._updateHud('connected', this.remotePlayers.size + 1);
        this._refreshMinimapVehicles();
        break;
      }

      case 'player_joined': {
        console.log(`[Multiplayer] Racer joined: ${msg.player.name} (${msg.player.id})`);
        this._spawnRemotePlayer(msg.player);
        this._updateHud('connected', this.remotePlayers.size + 1);
        this._refreshMinimapVehicles();
        break;
      }

      case 'player_state': {
        const remote = this.remotePlayers.get(msg.id);
        if (remote) {
          remote.setNetworkState(msg.state);
        }
        break;
      }

      case 'player_updated': {
        const remote = this.remotePlayers.get(msg.player.id);
        if (remote) {
          remote.updateProfile(msg.player.name, msg.player.color);
        }
        break;
      }

      case 'player_left': {
        console.log(`[Multiplayer] Racer disconnected: ${msg.id}`);
        const remote = this.remotePlayers.get(msg.id);
        if (remote) {
          remote.dispose();
          this.remotePlayers.delete(msg.id);
        }
        this._updateHud('connected', this.remotePlayers.size + 1);
        this._refreshMinimapVehicles();
        break;
      }
    }
  }

  _spawnRemotePlayer(playerData) {
    if (this.remotePlayers.has(playerData.id) || playerData.id === this.localId) return;

    const remote = new RemoteVehicle({
      id: playerData.id,
      name: playerData.name || 'Racer',
      paintColor: playerData.color || 0x3f6d8c,
      sceneManager: this._sceneManager,
      initialSlot: playerData.slot || 0,
    });

    if (playerData.state) {
      remote.setNetworkState(playerData.state);
    }

    this.remotePlayers.set(playerData.id, remote);
  }

  _clearRemotePlayers() {
    for (const remote of this.remotePlayers.values()) {
      remote.dispose();
    }
    this.remotePlayers.clear();
    this._refreshMinimapVehicles();
  }

  _refreshMinimapVehicles() {
    if (!this._minimap) return;
    // Notify minimap about active vehicles list
    const currentVehicles = this._minimap.vehicles ? [...this._minimap.vehicles] : [];
    // Keep vehicles and append remote vehicles
    const remotes = Array.from(this.remotePlayers.values());
    const combined = [...currentVehicles.filter((v) => !v.isRemote), ...remotes];
    this._minimap.setVehicles(combined);
  }

  /**
   * Called every frame in the game loop.
   * @param {number} dt delta time in seconds
   * @param {import('../vehicles/Vehicle.js').Vehicle} [egoVehicle] local ego vehicle
   */
  update(dt, egoVehicle = null) {
    // 1. Update all remote vehicles (dead-reckoning & visual animations)
    for (const remote of this.remotePlayers.values()) {
      remote.update(dt);
    }

    // 2. Broadcast local ego state at ~30 Hz
    if (this.isConnected && egoVehicle?.motionModel) {
      this._sendTimer += dt;
      if (this._sendTimer >= this._sendIntervalSec) {
        this._sendTimer = 0;
        const state = egoVehicle.motionModel.getState();
        const input = egoVehicle.lastControlInput || {};

        this._send({
          type: 'state',
          state: {
            x: Number(state.position.x.toFixed(3)),
            y: Number(state.position.y.toFixed(3)),
            z: Number(state.position.z.toFixed(3)),
            headingRad: Number(state.headingRad.toFixed(4)),
            speedMps: Number(state.speedMps.toFixed(2)),
            steeringRad: Number((state.steeringRad ?? (input.steering ? input.steering * 0.52 : 0)).toFixed(4)),
            brake: Number((input.brake ?? 0).toFixed(2)),
            throttle: Number((input.throttle ?? 0).toFixed(2)),
          },
        });
      }
    }
  }

  /** Returns list of all active remote vehicle instances */
  getRemoteVehicles() {
    return Array.from(this.remotePlayers.values());
  }

  dispose() {
    this._clearRemotePlayers();
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this._hudEl?.remove();
    this._hudEl = null;
  }
}
