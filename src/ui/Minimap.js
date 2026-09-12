import { clamp } from '../utils/MathUtils.js';

/**
 * Minimap — GTA / Google Maps inspired Tactical Radar & Interactive Expanded Map.
 *
 * Features:
 * 1. Corner Driving Radar:
 *    - Sleek dark glassmorphic rounded HUD.
 *    - High-contrast road corridors with sharp borders, lane lines, and roundabout rings.
 *    - GTA-style Ego player blip with directional heading cone.
 *    - Real-time NPC traffic blips with alert state changes.
 *    - Glowing GPS shortest-path navigation polyline and pulsing checkpoint pin.
 *    - Active route HUD badge with distance & ETA.
 * 2. Interactive Expanded World Map:
 *    - Activated via [⛶ Expand] button or pressing 'M'.
 *    - Full interactive pan (drag) and zoom (scroll wheel).
 *    - Click anywhere on the map to set a Checkpoint (📍).
 *    - Computes and displays shortest-path GPS route.
 *    - Center on vehicle button [🎯].
 */
export class Minimap {
  /**
   * @param {object} options
   * @param {import('../road/RoadNetwork.js').RoadNetwork} options.network
   * @param {import('../vehicles/Vehicle.js').Vehicle} [options.ego]
   * @param {import('../vehicles/Vehicle.js').Vehicle[]} [options.vehicles]
   * @param {import('../navigation/NavigationSystem.js').NavigationSystem} [options.navigationSystem]
   */
  constructor({ network, ego = null, vehicles = [], navigationSystem = null, corners = [] } = {}) {
    this.network = network;
    this.ego = ego;
    this.vehicles = vehicles;
    this.navigationSystem = navigationSystem;
    this.corners = corners;

    this.scale = 0.95; // meters per pixel
    this.minScale = 0.25;
    this.maxScale = 3.0;

    this.isExpanded = false;
    this.visible = true;

    // Pan offset for expanded map
    this.expandedPan = { x: 0, z: 0 };
    this.isDragging = false;
    this.dragStart = { x: 0, y: 0 };

    this._radarAngle = 0;

    this._createDOM();
    this._bindEvents();
  }

  setEgo(ego) {
    this.ego = ego;
  }

  setVehicles(vehicles) {
    this.vehicles = vehicles;
  }

  setNetwork(network) {
    this.network = network;
  }

  setNavigationSystem(nav) {
    this.navigationSystem = nav;
  }

  setCorners(corners) {
    this.corners = corners;
  }

  _createDOM() {
    // 1. Driving Corner Radar Container (GTA V style rectangular radar)
    const radar = document.createElement('div');
    radar.id = 'v2v-radar-hud';
    radar.style.position = 'fixed';
    radar.style.bottom = '24px';
    radar.style.left = '24px';
    radar.style.width = '240px';
    radar.style.height = '180px';
    radar.style.borderRadius = '16px';
    radar.style.background = 'radial-gradient(ellipse at center, rgba(24, 30, 42, 0.92) 0%, rgba(12, 16, 24, 0.98) 100%)';
    radar.style.border = '2px solid rgba(74, 201, 255, 0.4)';
    radar.style.boxShadow = '0 12px 36px rgba(0, 0, 0, 0.75), inset 0 0 16px rgba(74, 201, 255, 0.12)';
    radar.style.overflow = 'hidden';
    radar.style.zIndex = '1000';
    radar.style.backdropFilter = 'blur(12px)';
    radar.style.userSelect = 'none';
    radar.style.transition = 'opacity 0.2s, transform 0.2s';

    const radarCanvas = document.createElement('canvas');
    radarCanvas.width = 480;
    radarCanvas.height = 360;
    radarCanvas.style.width = '100%';
    radarCanvas.style.height = '100%';
    radarCanvas.style.display = 'block';
    radar.appendChild(radarCanvas);

    // North Badge
    const northBadge = document.createElement('div');
    northBadge.textContent = 'N';
    northBadge.style.position = 'absolute';
    northBadge.style.top = '8px';
    northBadge.style.left = '12px';
    northBadge.style.fontSize = '12px';
    northBadge.style.fontWeight = 'bold';
    northBadge.style.fontFamily = 'monospace';
    northBadge.style.color = '#4ac9ff';
    northBadge.style.pointerEvents = 'none';
    northBadge.style.textShadow = '0 0 6px rgba(74, 201, 255, 0.8)';
    radar.appendChild(northBadge);

    // Radar Overlay Controls (Top-Right of Radar)
    const radarControls = document.createElement('div');
    radarControls.style.position = 'absolute';
    radarControls.style.top = '8px';
    radarControls.style.right = '8px';
    radarControls.style.display = 'flex';
    radarControls.style.gap = '4px';
    radarControls.style.zIndex = '10';

    // Expand Map Button [⛶]
    const btnExpand = document.createElement('button');
    btnExpand.title = 'Expand Full Map (M)';
    btnExpand.innerHTML = '⛶';
    this._styleButton(btnExpand, 24, 24);
    btnExpand.onclick = (e) => {
      e.stopPropagation();
      this.toggleExpand();
    };
    radarControls.appendChild(btnExpand);

    // Zoom Buttons
    const btnPlus = document.createElement('button');
    btnPlus.textContent = '+';
    btnPlus.title = 'Zoom In';
    this._styleButton(btnPlus, 24, 24);
    btnPlus.onclick = (e) => {
      e.stopPropagation();
      this.scale = clamp(this.scale / 1.25, this.minScale, this.maxScale);
    };

    const btnMinus = document.createElement('button');
    btnMinus.textContent = '−';
    btnMinus.title = 'Zoom Out';
    this._styleButton(btnMinus, 24, 24);
    btnMinus.onclick = (e) => {
      e.stopPropagation();
      this.scale = clamp(this.scale * 1.25, this.minScale, this.maxScale);
    };

    radarControls.appendChild(btnPlus);
    radarControls.appendChild(btnMinus);
    radar.appendChild(radarControls);

    // Active Route Info Bar (at bottom of radar)
    const routeBar = document.createElement('div');
    routeBar.id = 'v2v-radar-route-bar';
    routeBar.style.position = 'absolute';
    routeBar.style.bottom = '0';
    routeBar.style.left = '0';
    routeBar.style.right = '0';
    routeBar.style.height = '26px';
    routeBar.style.background = 'linear-gradient(90deg, rgba(147, 51, 234, 0.92), rgba(79, 70, 229, 0.92))';
    routeBar.style.display = 'none';
    routeBar.style.alignItems = 'center';
    routeBar.style.justifyContent = 'space-between';
    routeBar.style.padding = '0 8px';
    routeBar.style.fontSize = '11px';
    routeBar.style.fontWeight = 'bold';
    routeBar.style.color = '#ffffff';
    routeBar.style.fontFamily = 'system-ui, sans-serif';

    const routeText = document.createElement('span');
    routeText.id = 'v2v-radar-route-text';
    routeText.textContent = '📍 150m · 12s';
    routeBar.appendChild(routeText);

    const btnClearRoute = document.createElement('button');
    btnClearRoute.textContent = '✕';
    btnClearRoute.title = 'Clear Route';
    btnClearRoute.style.background = 'none';
    btnClearRoute.style.border = 'none';
    btnClearRoute.style.color = '#ffffff';
    btnClearRoute.style.cursor = 'pointer';
    btnClearRoute.style.fontWeight = 'bold';
    btnClearRoute.style.padding = '2px 4px';
    btnClearRoute.onclick = (e) => {
      e.stopPropagation();
      this.navigationSystem?.clearCheckpoint();
    };
    routeBar.appendChild(btnClearRoute);
    radar.appendChild(routeBar);

    document.body.appendChild(radar);
    this._radarContainer = radar;
    this._radarCanvas = radarCanvas;
    this._radarCtx = radarCanvas.getContext('2d');
    this._routeBar = routeBar;
    this._routeText = routeText;

    // 2. Expanded World Map Modal (Google Maps / GTA V interactive tactical map)
    const modal = document.createElement('div');
    modal.id = 'v2v-expanded-map-modal';
    modal.style.position = 'fixed';
    modal.style.top = '0';
    modal.style.left = '0';
    modal.style.width = '100vw';
    modal.style.height = '100vh';
    modal.style.background = 'rgba(6, 9, 15, 0.78)';
    modal.style.backdropFilter = 'blur(16px)';
    modal.style.zIndex = '2500';
    modal.style.display = 'none';
    modal.style.alignItems = 'center';
    modal.style.justifyContent = 'center';

    const dialog = document.createElement('div');
    dialog.style.width = '88vw';
    dialog.style.maxWidth = '1200px';
    dialog.style.height = '85vh';
    dialog.style.background = 'radial-gradient(circle, #151c27 0%, #0c1017 100%)';
    dialog.style.borderRadius = '20px';
    dialog.style.border = '1px solid rgba(74, 201, 255, 0.4)';
    dialog.style.boxShadow = '0 24px 64px rgba(0, 0, 0, 0.9), 0 0 32px rgba(74, 201, 255, 0.15)';
    dialog.style.display = 'flex';
    dialog.style.flexDirection = 'column';
    dialog.style.overflow = 'hidden';
    modal.appendChild(dialog);

    // Modal Header
    const header = document.createElement('div');
    header.style.padding = '14px 20px';
    header.style.background = 'rgba(20, 27, 38, 0.9)';
    header.style.borderBottom = '1px solid rgba(74, 201, 255, 0.2)';
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.justifyContent = 'space-between';

    const title = document.createElement('div');
    title.style.display = 'flex';
    title.style.alignItems = 'center';
    title.style.gap = '10px';
    title.innerHTML = `
      <span style="font-size: 18px;">🗺️</span>
      <span style="font-size: 15px; font-weight: 700; color: #4ac9ff; letter-spacing: 0.5px; font-family: system-ui;">WORLD GPS NAVIGATION</span>
      <span style="font-size: 12px; color: #88a0b8; font-family: system-ui;">(Click road to set checkpoint · Drag to pan)</span>
    `;
    header.appendChild(title);

    const headerActions = document.createElement('div');
    headerActions.style.display = 'flex';
    headerActions.style.alignItems = 'center';
    headerActions.style.gap = '8px';

    const btnCenter = document.createElement('button');
    btnCenter.innerHTML = '🎯 Center on Player';
    this._styleHeaderButton(btnCenter);
    btnCenter.onclick = () => this.centerOnEgo();
    headerActions.appendChild(btnCenter);

    const btnClearExpanded = document.createElement('button');
    btnClearExpanded.innerHTML = '✕ Clear Waypoint';
    this._styleHeaderButton(btnClearExpanded);
    btnClearExpanded.onclick = () => this.navigationSystem?.clearCheckpoint();
    headerActions.appendChild(btnClearExpanded);

    const btnClose = document.createElement('button');
    btnClose.innerHTML = '✕ Close (Esc)';
    this._styleHeaderButton(btnClose, true);
    btnClose.onclick = () => this.toggleExpand(false);
    headerActions.appendChild(btnClose);

    header.appendChild(headerActions);
    dialog.appendChild(header);

    // Modal Canvas Container
    const canvasWrap = document.createElement('div');
    canvasWrap.style.flex = '1';
    canvasWrap.style.position = 'relative';
    canvasWrap.style.overflow = 'hidden';
    canvasWrap.style.cursor = 'crosshair';

    const expandedCanvas = document.createElement('canvas');
    expandedCanvas.style.width = '100%';
    expandedCanvas.style.height = '100%';
    expandedCanvas.style.display = 'block';
    canvasWrap.appendChild(expandedCanvas);
    dialog.appendChild(canvasWrap);

    document.body.appendChild(modal);
    this._modal = modal;
    this._expandedCanvas = expandedCanvas;
    this._expandedCtx = expandedCanvas.getContext('2d');
  }

  _styleButton(btn, w = 24, h = 24) {
    btn.style.width = `${w}px`;
    btn.style.height = `${h}px`;
    btn.style.borderRadius = '6px';
    btn.style.border = '1px solid rgba(74, 201, 255, 0.35)';
    btn.style.background = 'rgba(20, 26, 38, 0.85)';
    btn.style.color = '#c5d5e5';
    btn.style.fontSize = '12px';
    btn.style.lineHeight = `${h - 2}px`;
    btn.style.cursor = 'pointer';
    btn.style.padding = '0';
    btn.style.textAlign = 'center';
    btn.style.outline = 'none';
    btn.onmouseenter = () => (btn.style.background = 'rgba(74, 201, 255, 0.35)');
    btn.onmouseleave = () => (btn.style.background = 'rgba(20, 26, 38, 0.85)');
  }

  _styleHeaderButton(btn, isPrimary = false) {
    btn.style.padding = '6px 14px';
    btn.style.borderRadius = '8px';
    btn.style.border = isPrimary ? '1px solid rgba(239, 68, 68, 0.5)' : '1px solid rgba(74, 201, 255, 0.4)';
    btn.style.background = isPrimary ? 'rgba(239, 68, 68, 0.2)' : 'rgba(74, 201, 255, 0.15)';
    btn.style.color = isPrimary ? '#fca5a5' : '#7dd3fc';
    btn.style.fontSize = '12px';
    btn.style.fontWeight = '600';
    btn.style.fontFamily = 'system-ui, sans-serif';
    btn.style.cursor = 'pointer';
    btn.style.outline = 'none';
    btn.onmouseenter = () => {
      btn.style.background = isPrimary ? 'rgba(239, 68, 68, 0.35)' : 'rgba(74, 201, 255, 0.3)';
    };
    btn.onmouseleave = () => {
      btn.style.background = isPrimary ? 'rgba(239, 68, 68, 0.2)' : 'rgba(74, 201, 255, 0.15)';
    };
  }

  _bindEvents() {
    // Wheel zoom on corner radar
    this._radarContainer.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 0.85 : 1.18;
      this.scale = clamp(this.scale * factor, this.minScale, this.maxScale);
    }, { passive: false });

    // Keydown toggle (M)
    this._onKeyDown = (e) => {
      if (document.activeElement?.tagName === 'INPUT') return;
      if (e.key === 'm' || e.key === 'M') {
        this.toggleExpand();
      } else if (e.key === 'Escape' && this.isExpanded) {
        this.toggleExpand(false);
      }
    };
    window.addEventListener('keydown', this._onKeyDown);

    // Expanded Map Interactions (Pan & Click to Place Checkpoint)
    this._expandedCanvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) { // Left click: start drag or click
        this.isDragging = true;
        this.dragStart = { x: e.clientX, y: e.clientY };
        this._dragMoved = false;
      } else if (e.button === 2) { // Right click: clear checkpoint
        e.preventDefault();
        this.navigationSystem?.clearCheckpoint();
      }
    });

    this._expandedCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging || !this.isExpanded) return;
      const dx = e.clientX - this.dragStart.x;
      const dy = e.clientY - this.dragStart.y;
      if (Math.hypot(dx, dy) > 4) {
        this._dragMoved = true;
        this.expandedPan.x -= dx * this.scale;
        this.expandedPan.z -= dy * this.scale;
        this.dragStart = { x: e.clientX, y: e.clientY };
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (!this.isDragging || !this.isExpanded) return;
      this.isDragging = false;

      // If user clicked without dragging, place or update checkpoint
      if (!this._dragMoved) {
        const rect = this._expandedCanvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Convert click to world coordinates
        const w = this._expandedCanvas.width;
        const h = this._expandedCanvas.height;
        const cx = w / 2;
        const cy = h / 2;

        const worldX = this.expandedPan.x + (mouseX * 2 - cx) * this.scale;
        const worldZ = this.expandedPan.z + (mouseY * 2 - cy) * this.scale;

        this.navigationSystem?.setCheckpoint(worldX, worldZ);
      }
    });

    this._expandedCanvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 0.85 : 1.18;
      this.scale = clamp(this.scale * factor, this.minScale, this.maxScale);
    }, { passive: false });
  }

  toggleExpand(forceState = null) {
    this.isExpanded = forceState !== null ? forceState : !this.isExpanded;
    if (this._modal) {
      this._modal.style.display = this.isExpanded ? 'flex' : 'none';
      if (this.isExpanded) {
        this._resizeExpandedCanvas();
        this.centerOnEgo();
      }
    }
  }

  centerOnEgo() {
    if (this.ego && this.ego.motionModel) {
      const s = this.ego.motionModel.getState();
      this.expandedPan = { x: s.position.x, z: s.position.z };
    } else {
      this.expandedPan = { x: 0, z: 0 };
    }
  }

  _resizeExpandedCanvas() {
    const rect = this._expandedCanvas.parentElement.getBoundingClientRect();
    this._expandedCanvas.width = rect.width * 2;
    this._expandedCanvas.height = rect.height * 2;
  }

  update(dt = 0.016) {
    if (!this.visible || !this.network) return;

    this._radarAngle += dt * 1.5;

    // 1. Render Corner Driving Radar
    this._renderMap(
      this._radarCtx,
      this._radarCanvas.width,
      this._radarCanvas.height,
      this._getEgoCenter(),
      true // isRadar (rotates with car heading or north-up)
    );

    // 2. Render Expanded Map if active
    if (this.isExpanded && this._expandedCtx) {
      this._renderMap(
        this._expandedCtx,
        this._expandedCanvas.width,
        this._expandedCanvas.height,
        this.expandedPan,
        false // full world view
      );
    }

    // 3. Update Route HUD bar on radar
    if (this.navigationSystem && this._routeBar) {
      const nav = this.navigationSystem.getNavState();
      if (nav.hasCheckpoint) {
        this._routeBar.style.display = 'flex';
        this._routeText.textContent = `📍 ${Math.round(nav.distanceRemainingM)}m · ETA ${nav.etaSeconds}s`;
      } else {
        this._routeBar.style.display = 'none';
      }
    }
  }

  _getEgoCenter() {
    if (this.ego && this.ego.motionModel) {
      const s = this.ego.motionModel.getState();
      return { x: s.position.x, z: s.position.z };
    }
    return { x: 0, z: 0 };
  }

  /**
   * Unified map renderer for both driving radar and expanded tactical map.
   */
  _renderMap(ctx, width, height, centerPos, isRadar) {
    const cx = width / 2;
    const cy = height / 2;

    ctx.clearRect(0, 0, width, height);

    ctx.save();

    // World transform: world (wx, wz) -> Canvas (x, y)
    const worldToMap = (wx, wz) => ({
      x: cx + (wx - centerPos.x) / this.scale,
      y: cy + (wz - centerPos.z) / this.scale,
    });

    // Background Grid
    ctx.strokeStyle = 'rgba(74, 201, 255, 0.06)';
    ctx.lineWidth = 1;
    const gridSizePx = 80 / this.scale;
    if (gridSizePx > 15) {
      const startX = (cx - centerPos.x / this.scale) % gridSizePx;
      const startY = (cy - centerPos.z / this.scale) % gridSizePx;
      for (let x = startX; x < width; x += gridSizePx) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      for (let y = startY; y < height; y += gridSizePx) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
    }

    // 1. Draw Road Asphalt Corridors (Google Maps / GTA V style high-contrast roads)
    for (const segment of this.network.segments.values()) {
      const curve = segment.getCurve();
      const length = segment.lengthM;
      const steps = Math.max(6, Math.ceil(length / 3));

      // Road outer border / outline
      ctx.beginPath();
      const halfWidthPx = (segment.roadWidthM / this.scale) * 0.5;
      ctx.lineWidth = Math.max(4, halfWidthPx * 2 + 3);
      ctx.strokeStyle = '#1e2430'; // Dark outline
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      for (let i = 0; i <= steps; i++) {
        const pt = curve.getPointAt(i / steps);
        const mapPt = worldToMap(pt.x, pt.z);
        if (i === 0) ctx.moveTo(mapPt.x, mapPt.y);
        else ctx.lineTo(mapPt.x, mapPt.y);
      }
      ctx.stroke();

      // Road asphalt surface
      ctx.beginPath();
      ctx.lineWidth = Math.max(2.5, halfWidthPx * 2);
      ctx.strokeStyle = '#323a48'; // Asphalt fill
      for (let i = 0; i <= steps; i++) {
        const pt = curve.getPointAt(i / steps);
        const mapPt = worldToMap(pt.x, pt.z);
        if (i === 0) ctx.moveTo(mapPt.x, mapPt.y);
        else ctx.lineTo(mapPt.x, mapPt.y);
      }
      ctx.stroke();

      // Yellow Centerline (if two-way)
      if (segment.lanesForward > 0 && segment.lanesBackward > 0) {
        ctx.beginPath();
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = '#f5c542';
        for (let i = 0; i <= steps; i++) {
          const pt = curve.getPointAt(i / steps);
          const mapPt = worldToMap(pt.x, pt.z);
          if (i === 0) ctx.moveTo(mapPt.x, mapPt.y);
          else ctx.lineTo(mapPt.x, mapPt.y);
        }
        ctx.stroke();
      }
    }

    // 2. Draw Intersections (Roundabouts & Multi-road Junctions)
    for (const nodeId of this.network.nodeIds) {
      const node = this.network.getNode(nodeId);
      if (!node) continue;
      const segs = this.network.getSegmentsAtNode(nodeId);
      if (segs.length < 2) continue;

      const mapPt = worldToMap(node.position.x, node.position.z);
      if (node.intersectionType === 'roundabout') {
        const outerR = 14.0 / this.scale;
        const islandR = 5.2 / this.scale;

        // Asphalt ring
        ctx.beginPath();
        ctx.arc(mapPt.x, mapPt.y, outerR, 0, Math.PI * 2);
        ctx.fillStyle = '#323a48';
        ctx.fill();

        // Central grass island
        ctx.beginPath();
        ctx.arc(mapPt.x, mapPt.y, islandR, 0, Math.PI * 2);
        ctx.fillStyle = '#2d533b';
        ctx.strokeStyle = '#5a7863';
        ctx.lineWidth = 1.5;
        ctx.fill();
        ctx.stroke();
      } else if (segs.length > 2) {
        // Multi-road junction pad (only for true 3-way/4-way junctions, not simple road bends)
        const r = Math.max(5, 7.5 / this.scale);
        ctx.beginPath();
        ctx.arc(mapPt.x, mapPt.y, r, 0, Math.PI * 2);
        ctx.fillStyle = '#323a48';
        ctx.fill();
      }
    }

    // 2B. Draw Circuit Corners (FastF1 Formula 1 Badges)
    if (this.corners && this.corners.length > 0) {
      for (const corner of this.corners) {
        const trk = corner.trackPosition;
        const mrk = corner.markerPosition;
        if (!trk || !mrk) continue;

        const pTrk = worldToMap(trk[0], trk[2]);
        const pMrk = worldToMap(mrk[0], mrk[2]);

        // Connecting line from track apex to corner circle
        ctx.beginPath();
        ctx.moveTo(pTrk.x, pTrk.y);
        ctx.lineTo(pMrk.x, pMrk.y);
        ctx.strokeStyle = 'rgba(160, 174, 192, 0.7)';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Grey circular corner badge
        const badgeR = Math.max(7, Math.min(13, 10 / Math.sqrt(this.scale)));
        ctx.beginPath();
        ctx.arc(pMrk.x, pMrk.y, badgeR, 0, Math.PI * 2);
        ctx.fillStyle = '#2d3748';
        ctx.fill();
        ctx.strokeStyle = '#cbd5e1';
        ctx.lineWidth = 1.2;
        ctx.stroke();

        // Corner text inside circle
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${Math.round(badgeR * 1.1)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(corner.name, pMrk.x, pMrk.y + 0.5);

        // In expanded map mode, also show the official corner name (e.g. Abbey, Stowe)
        if (this.isExpanded && corner.officialName) {
          ctx.fillStyle = '#94a3b8';
          ctx.font = '10px system-ui, sans-serif';
          ctx.textAlign = 'left';
          ctx.fillText(` ${corner.officialName}`, pMrk.x + badgeR + 2, pMrk.y + 0.5);
        }
      }
    }

    // 3. Draw Active GPS Route Line (Vibrant Glowing GTA Purple / Yellow Line)
    const navState = this.navigationSystem?.getNavState();
    if (navState && navState.hasCheckpoint && navState.route && navState.route.waypoints.length > 1) {
      const waypoints = navState.route.waypoints;

      // Glow underlay
      ctx.shadowColor = '#a855f7';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.lineWidth = Math.max(5, 7 / this.scale);
      ctx.strokeStyle = '#9333ea';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      for (let i = 0; i < waypoints.length; i++) {
        const mapPt = worldToMap(waypoints[i].x, waypoints[i].z);
        if (i === 0) ctx.moveTo(mapPt.x, mapPt.y);
        else ctx.lineTo(mapPt.x, mapPt.y);
      }
      ctx.stroke();

      // Sharp foreground core line
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.lineWidth = Math.max(2.5, 4 / this.scale);
      ctx.strokeStyle = '#e9d5ff';
      for (let i = 0; i < waypoints.length; i++) {
        const mapPt = worldToMap(waypoints[i].x, waypoints[i].z);
        if (i === 0) ctx.moveTo(mapPt.x, mapPt.y);
        else ctx.lineTo(mapPt.x, mapPt.y);
      }
      ctx.stroke();

      // 4. Draw Checkpoint Pin (GTA Waypoint Marker 📍)
      const cp = navState.checkpoint;
      if (cp) {
        const cpPt = worldToMap(cp.x, cp.z);

        // Pulsing radar ring
        const pulseR = 10 + Math.sin(this._radarAngle * 3.5) * 4;
        ctx.beginPath();
        ctx.arc(cpPt.x, cpPt.y, pulseR, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(168, 85, 247, 0.75)';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Pin marker
        ctx.save();
        ctx.translate(cpPt.x, cpPt.y);
        ctx.fillStyle = '#a855f7';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;

        ctx.beginPath();
        ctx.arc(0, -12, 7, 0, Math.PI * 2);
        ctx.moveTo(-5, -8);
        ctx.lineTo(0, 0);
        ctx.lineTo(5, -8);
        ctx.fill();
        ctx.stroke();

        // Pin center dot
        ctx.beginPath();
        ctx.arc(0, -12, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();

        ctx.restore();
      }
    }

    // 5. Draw NPC Vehicles
    if (this.vehicles) {
      for (const vehicle of this.vehicles) {
        if (!vehicle || !vehicle.motionModel || vehicle === this.ego) continue;
        const s = vehicle.motionModel.getState();
        const mapPt = worldToMap(s.position.x, s.position.z);

        // Visibility check within canvas
        if (mapPt.x < -20 || mapPt.x > width + 20 || mapPt.y < -20 || mapPt.y > height + 20) continue;

        ctx.save();
        ctx.translate(mapPt.x, mapPt.y);
        ctx.rotate(s.headingRad);

        const hasAlert = vehicle.v2vAlerts && vehicle.v2vAlerts.length > 0;
        ctx.fillStyle = hasAlert ? '#ff4a4a' : '#f59e0b';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;

        ctx.beginPath();
        ctx.rect(-3.5, -6, 7, 12);
        ctx.fill();
        ctx.stroke();

        // Heading tip
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.moveTo(-3, -6);
        ctx.lineTo(3, -6);
        ctx.lineTo(0, -9);
        ctx.closePath();
        ctx.fill();

        ctx.restore();
      }
    }

    // 6. Draw Ego Vehicle (Cyan directional cone & player arrow)
    if (this.ego && this.ego.motionModel) {
      const s = this.ego.motionModel.getState();
      const egoMapPt = worldToMap(s.position.x, s.position.z);

      ctx.save();
      ctx.translate(egoMapPt.x, egoMapPt.y);
      ctx.rotate(s.headingRad);

      // Forward sight cone
      ctx.fillStyle = 'rgba(74, 201, 255, 0.12)';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, 36, -Math.PI / 2 - 0.45, -Math.PI / 2 + 0.45);
      ctx.closePath();
      ctx.fill();

      // Ego directional triangle (GTA blip)
      ctx.shadowColor = '#4ac9ff';
      ctx.shadowBlur = 10;
      ctx.fillStyle = '#4ac9ff';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;

      ctx.beginPath();
      ctx.moveTo(0, -12); // tip
      ctx.lineTo(7.5, 9);  // right
      ctx.lineTo(0, 4.5);  // center indent
      ctx.lineTo(-7.5, 9); // left
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.restore();
    }

    ctx.restore();
  }

  dispose() {
    if (this._radarContainer?.parentNode) {
      this._radarContainer.parentNode.removeChild(this._radarContainer);
    }
    if (this._modal?.parentNode) {
      this._modal.parentNode.removeChild(this._modal);
    }
    window.removeEventListener('keydown', this._onKeyDown);
    this._radarContainer = null;
    this._modal = null;
    this._radarCanvas = null;
    this._expandedCanvas = null;
    this._radarCtx = null;
    this._expandedCtx = null;
  }
}
