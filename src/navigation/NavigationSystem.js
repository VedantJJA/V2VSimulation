import { RoadRouter } from './RoadRouter.js';
import { GPSVisualizer } from './GPSVisualizer.js';

/**
 * NavigationSystem — High-level GPS route manager for V2V Simulation.
 *
 * Integrates:
 * - Shortest path calculation via RoadRouter.
 * - In-world 3D GPS navigation path & beacon via GPSVisualizer.
 * - Dynamic route updates, turn-by-turn distance, and arrival detection.
 */
export class NavigationSystem {
  /**
   * @param {object} options
   * @param {import('../core/Engine.js').Engine} options.engine
   * @param {import('../road/RoadNetwork.js').RoadNetwork} options.network
   * @param {import('../vehicles/Vehicle.js').Vehicle} [options.ego]
   */
  constructor({ engine, network, ego = null }) {
    this.engine = engine;
    this.network = network;
    this.ego = ego;

    this.router = new RoadRouter(network);
    this.visualizer = new GPSVisualizer(engine);

    this.checkpoint = null; // { x, z }
    this.route = null;      // { waypoints, totalDistanceM, segments }
    this.distanceRemainingM = 0;
    this.etaSeconds = 0;

    this._rerouteCooldown = 0;
    this._toastElement = null;
    this._createToastDOM();
  }

  setEgo(ego) {
    this.ego = ego;
  }

  setNetwork(network) {
    this.network = network;
    this.router = new RoadRouter(network);
    if (this.checkpoint) {
      this.recalculateRoute();
    }
  }

  _createToastDOM() {
    const toast = document.createElement('div');
    toast.id = 'v2v-nav-toast';
    toast.style.position = 'fixed';
    toast.style.top = '72px';
    toast.style.left = '50%';
    toast.style.transform = 'translateX(-50%) translateY(-20px)';
    toast.style.padding = '12px 24px';
    toast.style.borderRadius = '24px';
    toast.style.background = 'linear-gradient(135deg, rgba(147, 51, 234, 0.95), rgba(79, 70, 229, 0.95))';
    toast.style.border = '1px solid rgba(255, 255, 255, 0.3)';
    toast.style.color = '#ffffff';
    toast.style.fontFamily = 'system-ui, -apple-system, sans-serif';
    toast.style.fontSize = '14px';
    toast.style.fontWeight = '600';
    toast.style.letterSpacing = '0.5px';
    toast.style.boxShadow = '0 10px 30px rgba(147, 51, 234, 0.5)';
    toast.style.zIndex = '3000';
    toast.style.opacity = '0';
    toast.style.pointerEvents = 'none';
    toast.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
    document.body.appendChild(toast);
    this._toastElement = toast;
  }

  showToast(message, durationMs = 3000) {
    if (!this._toastElement) return;
    this._toastElement.textContent = message;
    this._toastElement.style.opacity = '1';
    this._toastElement.style.transform = 'translateX(-50%) translateY(0)';
    setTimeout(() => {
      if (this._toastElement) {
        this._toastElement.style.opacity = '0';
        this._toastElement.style.transform = 'translateX(-50%) translateY(-20px)';
      }
    }, durationMs);
  }

  /**
   * Set target checkpoint destination.
   * @param {number} x
   * @param {number} z
   */
  setCheckpoint(x, z) {
    this.checkpoint = { x, z };
    this.visualizer.setCheckpoint({ x, z });
    this.recalculateRoute();
    this.showToast('📍 Checkpoint Set — Calculating Shortest GPS Route');
  }

  clearCheckpoint() {
    this.checkpoint = null;
    this.route = null;
    this.distanceRemainingM = 0;
    this.etaSeconds = 0;
    this.visualizer.clearCheckpoint();
    this.visualizer.clearRoute();
  }

  recalculateRoute() {
    if (!this.checkpoint) return;

    let startPos = { x: 0, z: 0 };
    let startHeading = null;
    let egoSpeed = 10;
    if (this.ego && this.ego.motionModel) {
      const s = this.ego.motionModel.getState();
      startPos = { x: s.position.x, z: s.position.z };
      startHeading = s.headingRad;
      egoSpeed = Math.max(5, s.speedMps);
    }

    const calculatedRoute = this.router.findRoute(startPos, this.checkpoint, startHeading);
    if (calculatedRoute && calculatedRoute.waypoints.length > 0) {
      this.route = calculatedRoute;
      this.distanceRemainingM = calculatedRoute.totalDistanceM;
      this.etaSeconds = Math.round(this.distanceRemainingM / egoSpeed);
      this.visualizer.setRoute(calculatedRoute.waypoints);
    } else {
      this.clearCheckpoint();
    }
  }

  /**
   * Per-frame navigation updates (arrival detection, route progress, 3D visualizer animation).
   */
  update(dt = 0.016) {
    this.visualizer.update(dt);

    if (!this.checkpoint || !this.ego || !this.ego.motionModel) return;

    const egoState = this.ego.motionModel.getState();
    const egoPos = egoState.position;
    const egoSpeed = Math.max(3, egoState.speedMps || 0);
    const currentSpeed = Math.abs(egoState.speedMps || 0);

    // Destination target point (the final waypoint along the road, or raw checkpoint)
    const finalWp = this.route?.waypoints?.[this.route.waypoints.length - 1];
    const destTarget = finalWp || this.checkpoint;
    const distToTarget = Math.hypot(destTarget.x - egoPos.x, destTarget.z - egoPos.z);

    // Arrival detection:
    // If auto-drive is active, let AutoDriveController handle its own arrival, full stop,
    // and holding brake lock, which then clears the checkpoint.
    // NavigationSystem only clears the checkpoint directly if in manual driving mode.
    const isAutoDriving = !!this.ego?.controller?.autoDriveEnabled;
    if (!isAutoDriving && distToTarget < 6.5 && (currentSpeed < 0.45 || distToTarget < 2.0)) {
      this.showToast('🎉 Destination Reached!', 4000);
      this.clearCheckpoint();
      return;
    }

    // Update remaining distance & ETA
    this.distanceRemainingM = distToTarget;
    this.etaSeconds = Math.round(distToTarget / egoSpeed);

    // Periodically re-evaluate route every 1.5s (only if > 12m away to prevent rerouting during final approach)
    this._rerouteCooldown += dt;
    if (this._rerouteCooldown > 1.5) {
      this._rerouteCooldown = 0;
      if (distToTarget > 12.0) {
        const calculatedRoute = this.router.findRoute(
          { x: egoPos.x, z: egoPos.z },
          this.checkpoint,
          egoState.headingRad
        );
        if (calculatedRoute) {
          this.route = calculatedRoute;
          this.visualizer.setRoute(calculatedRoute.waypoints);
        }
      }
    }
  }

  getNavState() {
    return {
      hasCheckpoint: this.checkpoint !== null,
      checkpoint: this.checkpoint,
      route: this.route,
      distanceRemainingM: this.distanceRemainingM,
      etaSeconds: this.etaSeconds,
    };
  }

  dispose() {
    this.clearCheckpoint();
    this.visualizer.dispose();
    if (this._toastElement && this._toastElement.parentNode) {
      this._toastElement.parentNode.removeChild(this._toastElement);
      this._toastElement = null;
    }
  }
}
