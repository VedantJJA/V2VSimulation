# V2V Three.js Simulation — Implementation Plan, File Structure & GLM-5.3 Prompts

## 0. How to read this document

This is a spec for a genuinely large project. It's organized so you can:

1. Skim **Section 1** to confirm every requirement is accounted for.
2. Skim **Section 3** (design decisions) — these are the calls I made where your brief was open-ended. Change any of them before you start generating code.
3. Hand **Section 7 (Master Prompt)** to GLM-5.3 once, then feed it the **Phase prompts (Section 8)** one at a time, in order.

Do not paste the whole document as one giant "build everything" prompt — no model, GLM-5.3 included, reliably produces a correct 40+ file project in one shot. The phased approach lets you compile/run and catch drift after every step.

---

## 1. Requirements → Architecture Map

| Your requirement | Where it's handled |
|---|---|
| Multi-file project, not a single file, easy to debug | Modular `src/` tree (Section 5), Vite dev server with HMR |
| Cars | `vehicles/` module |
| Customizable roads, not tied to a grid | `road/` — spline/graph-based, arbitrary XZ placement |
| Intersections, connecting road to road | `road/IntersectionBuilder.js`, node-snapping in `RoadNetwork.js` |
| Configurable lane count | `RoadSegment.lanesForward/lanesBackward`, editor lane control |
| Buildings placed anywhere, for blind spots | `buildings/` |
| Road obstructions | `road/RoadObstruction.js` |
| Lane widening moves buildings; overlapping buildings get removed | `buildings/CollisionResolver.js` |
| Separate map editor | `editor/` module, separate app mode |
| 1st person / 3rd person car views | `core/CameraRig.js` |
| Dawn / Day / Night | `environment/TimeOfDayController.js` |
| Fog control | `environment/FogController.js` |
| Place other cars on the map | `editor/VehiclePlaceTool.js` |
| Future: V2V on vehicles other than ego, radius-limited | `v2v/` module, tiered activation (Section 3.5) — built in now, gated by a flag |
| Proximity sensors, ray casting, computationally optimal | `sensors/ProximitySensorArray.js`, `sensors/RaycastEngine.js` (BVH + spatial grid) |
| Front camera for lane centering, simulated on all cars in 250m V2V radius | `sensors/LaneCenteringSensor.js` (analytic, cheap) + `sensors/FrontCameraSensor.js` (real rendered view, ego-only debug mode) — see Section 3.4 |
| Run on GPU if possible | `sensors/GPUCastEngine.js`, optional WebGPU/TSL compute path, Phase 8 |
| NPCs shouldn't rear-end each other or ignore obstructions | `vehicles/CarFollowingModel.js` (IDM), obstruction-aware `WaypointFollower.js` — Phase 9 |
| V2V safety alerts (blind-spot, intersection collision, EEBL) | `v2v/SafetyApplications.js`, `v2v/BSMProtocol.js` — Phase 10 |
| V2V signals blocked/attenuated by buildings (NLOS) | `v2v/PropagationModel.js` — Phase 10 |
| Vehicles react to received V2V data (brake, yield) | `WaypointFollower` + `VehicleController` consume V2V alerts — Phase 10 |
| HUD with speed, V2V alerts; minimap with vehicle dots | `ui/HUD.js`, `ui/Minimap.js` — Phase 9 |
| Centralized tunables, no magic numbers | `state/ConfigDefaults.js` — Phase 11 |
| GLTF model loading for cars and props | `core/AssetLoader.js` — Phase 11 |
| README documenting controls and architecture | `README.md` — Phase 9 |

---

## 2. Tech Stack

- **three.js** (current release, WebGPU-capable build) — rendering, scene graph, math
- **Vite** — dev server + bundler (fast HMR, native ES modules, matches your "easy to debug" ask)
- **cannon-es** — lightweight physics for the ego vehicle only (optional, swappable)
- **three-mesh-bvh** — accelerated raycasting against static geometry (roads, buildings)
- **lil-gui** — control panels (time of day, fog, lane count, sensor toggles)
- **GLTFLoader / TransformControls / OrbitControls** — from `three/addons/...` (or `three/examples/jsm/...` depending on the installed three.js version — pick one and be consistent)
- Plain JS classes + a small hand-rolled `EventBus` for cross-module communication — no heavy state-management framework, keeps everything traceable in the debugger

No build-tool magic beyond Vite. Every module is a plain ES class in its own file.

---

## 3. Key Design Decisions (read before generating code)

These are the places your brief was open to interpretation. I picked a default; all are easy to change later since they're isolated to one file/module each.

### 3.1 Road representation
A graph of `RoadNode`s (arbitrary XZ position, no grid snap) connected by `RoadSegment`s, each defined by a spline (Catmull-Rom) through control points. Lane centerlines are computed by offsetting the spline along its Frenet normal by `laneIndex * laneWidth`. This is what makes roads curve freely and intersections just "shared nodes."

### 3.2 Intersections
When a new segment's endpoint snaps within a small threshold of an existing node, it reuses that node — this is what "connects" roads. `IntersectionBuilder` generates a merged pad polygon sized to the widest connected road and simple straight lane-connector quads matching incoming/outgoing lanes by closest heading. No traffic-light logic is in scope; flagged as a natural Phase-9-and-beyond extension if you want it later.

### 3.3 Building collision policy
On any lane-count change: recompute the road's footprint polygon → any building overlapping it gets pushed along the vector from the road centerline to the building center, by the overlap depth plus a margin. After pushing, if the moved building now overlaps another building beyond a small threshold, **the moved building is removed** (deterministic, logged). This keeps the rule simple and predictable; if you'd rather remove the smaller of the two, or merge them, that's a one-function change in `CollisionResolver.js`.

### 3.4 Lane-centering sensor — the important trade-off
You asked for this to run on *every* car within the 250m V2V radius. Doing that with an actual rendered front camera + image-based lane detection per car would mean N extra render passes every frame — it won't scale past a handful of cars.

Default: every vehicle in the active/V2V tier gets an **analytic** lane sensor — since the simulation already knows the exact lane spline, it computes lateral offset and heading error directly (this is "what the camera would have derived," just skipping the pixel round-trip). This is effectively free and scales to dozens of cars.

A real rendered camera + edge-detection pass (`FrontCameraSensor.js`) is kept as an optional **debug/visualization view**, defaulting to the ego vehicle only. You can flip it on for another car to inspect it, but it's not the signal driving the simulation for every car.

### 3.5 V2V radius — generalized, not ego-only
Sensor simulation and V2V broadcasting run per "active" vehicle, each with its own 250m neighbor query — not hardcoded to only run around the ego. By default only the ego is "active" (this is your compute ceiling today); a config flag lets you promote N additional vehicles to "active" so they run their own local V2V + sensors, which is exactly your stated future direction, without restructuring anything.

### 3.6 Vehicle motion model
NPCs use a cheap kinematic bicycle model (position/heading/speed integrated each tick, following lane centerlines) — this is what lets you have many NPCs cheaply. The ego optionally uses full rigid-body physics (cannon-es) for a better feel. Both implement the same `IVehicleMotionModel` interface so you can swap either independently.

### 3.7 GPU compute
Three.js's `WebGPURenderer` + TSL (`three/tsl`) support compute shaders, which is a real way to batch the proximity raycasts on GPU. It's newer/less universally supported than WebGL, so it's built as an **additive** path (`GPUCastEngine.js`) behind a capability check, never a hard dependency. The CPU path (BVH + spatial grid) must work standalone.

---

## 4. Data Schemas

### 4.1 Map file (save/load format from the editor)

```json
{
  "meta": { "name": "map_01", "version": 1 },
  "environment": { "timeOfDay": "dawn", "fogDensity": 0.02 },
  "nodes": [
    { "id": "n1", "position": [0, 0, 0] },
    { "id": "n2", "position": [120, 0, 40] }
  ],
  "segments": [
    {
      "id": "s1",
      "startNodeId": "n1",
      "endNodeId": "n2",
      "controlPoints": [[0,0,0], [60,0,-10], [120,0,40]],
      "lanesForward": 2,
      "lanesBackward": 2,
      "laneWidthM": 3.5,
      "speedLimitKph": 50,
      "obstructions": [
        { "id": "o1", "type": "cone", "distanceAlongM": 40, "lane": 1, "blocking": "partial" }
      ]
    }
  ],
  "buildings": [
    { "id": "b1", "position": [15, 0, 20], "size": [10, 12, 8], "rotationY": 0.4 }
  ],
  "vehicles": [
    { "id": "ego", "isEgo": true, "segmentId": "s1", "lane": 0, "distanceAlongM": 0 },
    { "id": "npc1", "isEgo": false, "segmentId": "s1", "lane": 1, "distanceAlongM": 20, "speedKph": 40, "behavior": "cruise" }
  ]
}
```

### 4.2 Runtime sensor frame (per vehicle, per tick)

```js
{
  vehicleId: 'npc3',
  timestamp: 12.345,
  proximityM: {
    front: 24.1, frontLeft: 40.0, frontRight: 12.4,
    left: 3.5, right: 3.4, rearLeft: 50.0, rearRight: 50.0, rear: 15.2
  },
  laneSensor: { lateralOffsetM: -0.12, headingErrorRad: 0.008, segmentId: 's1', lane: 1 },
  v2vNeighbors: [ { id: 'ego', distanceM: 82.3, relSpeedMps: -3.1 } ]
}
```

---

## 5. File & Folder Structure

```text
v2v-simulation/
├── package.json
├── vite.config.js
├── index.html
├── README.md
├── public/
│   ├── models/                     # GLTF cars, props
│   ├── textures/                   # asphalt, sky, lane-marking textures
│   └── maps/                       # saved map JSON files
└── src/
    ├── main.js                     # boots Editor or Simulation based on mode
    ├── core/
    │   ├── Engine.js                # renderer (WebGL/WebGPU), scene, clock, main loop
    │   ├── SceneManager.js
    │   ├── InputManager.js
    │   ├── CameraRig.js             # 1st-person / 3rd-person logic + toggle
    │   ├── AssetLoader.js
    │   └── EventBus.js
    ├── environment/
    │   ├── TimeOfDayController.js   # dawn / day / night presets
    │   ├── FogController.js
    │   ├── SkyController.js
    │   └── Lighting.js
    ├── road/
    │   ├── RoadNetwork.js           # graph: nodes + segments, node snapping
    │   ├── RoadNode.js
    │   ├── RoadSegment.js
    │   ├── SplineUtils.js           # Frenet frames, lane offset curves
    │   ├── RoadMeshBuilder.js
    │   ├── LaneMarkingBuilder.js
    │   ├── IntersectionBuilder.js
    │   ├── RoadObstruction.js
    │   └── RoadSerializer.js        # map JSON <-> in-memory model
    ├── buildings/
    │   ├── Building.js
    │   ├── BuildingManager.js
    │   ├── CollisionResolver.js     # push-aside + overlap removal (Section 3.3)
    │   └── SpatialGrid.js
    ├── vehicles/
    │   ├── Vehicle.js               # base class
    │   ├── EgoVehicle.js
    │   ├── NPCVehicle.js
    │   ├── IVehicleMotionModel.js   # interface: kinematic vs physics-based
    │   ├── KinematicBicycleModel.js
    │   ├── PhysicsVehicleModel.js   # cannon-es, ego-only by default
    │   ├── VehicleController.js     # input -> motion model
    │   ├── VehicleFactory.js
    │   ├── WaypointFollower.js      # NPC lane-following AI
    │   └── CarFollowingModel.js     # IDM distance-keeping + obstruction avoidance (Phase 9)
    ├── sensors/
    │   ├── ProximitySensorArray.js
    │   ├── RaycastEngine.js         # CPU: BVH + spatial-grid broadphase
    │   ├── GPUCastEngine.js         # optional WebGPU/TSL compute path
    │   ├── FrontCameraSensor.js     # real rendered camera, ego debug view
    │   ├── LaneCenteringSensor.js   # analytic ground-truth sensor (default, all active cars)
    │   └── SensorVisualizer.js      # debug ray/hit overlay
    ├── v2v/
    │   ├── V2VManager.js            # per-active-vehicle neighbor discovery + broadcast
    │   ├── VehicleStateBroadcaster.js
    │   ├── NeighborIndex.js         # radius queries
    │   ├── LODManager.js            # active / passive / culled tiers
    │   ├── BSMProtocol.js           # Basic Safety Message encode/decode (Phase 10)
    │   ├── SafetyApplications.js    # ICW, BSW, EEBL alert logic (Phase 10)
    │   └── PropagationModel.js      # RF line-of-sight / NLOS occlusion by buildings (Phase 10)
    ├── editor/
    │   ├── MapEditor.js
    │   ├── RoadDrawTool.js
    │   ├── BuildingPlaceTool.js
    │   ├── ObstructionPlaceTool.js
    │   ├── VehiclePlaceTool.js
    │   ├── GizmoManager.js          # TransformControls wrapper
    │   └── EditorUI.js
    ├── ui/
    │   ├── HUD.js
    │   ├── ControlPanel.js          # lil-gui: time of day, fog, lanes, sensors
    │   ├── ModeSwitcher.js          # Editor <-> Simulation start screen
    │   └── Minimap.js
    ├── state/
    │   ├── AppState.js
    │   └── ConfigDefaults.js
    └── utils/
        ├── MathUtils.js
        ├── GeometryUtils.js
        └── Constants.js
```

---

## 6. Phased Implementation Roadmap

Each phase should leave you with something you can actually run. Don't move to the next phase until the acceptance check passes.

| Phase | Goal | Key files | Acceptance check |
|---|---|---|---|
| **0** | Scaffold | `main.js`, `Engine.js`, `SceneManager.js` | `npm run dev` shows a ground plane + orbit camera, no console errors |
| **1** | Environment | `TimeOfDayController`, `FogController`, `SkyController`, `Lighting` | Switching dawn/day/night in the GUI visibly changes sky, light, fog live |
| **2** | Roads | `RoadNetwork`, `RoadSegment`, `SplineUtils`, `RoadMeshBuilder`, `LaneMarkingBuilder`, `IntersectionBuilder`, `RoadSerializer` | Loading a hand-authored sample map JSON renders a curved multi-lane road with a fork/intersection and correct lane markings; changing `lanesForward` rebuilds the mesh |
| **3** | Buildings | `Building`, `BuildingManager`, `SpatialGrid`, `CollisionResolver` | Increasing lane count on a segment near a building moves it; forcing two buildings together after the push removes one, logged |
| **4** | Vehicles | `Vehicle`, `EgoVehicle`, `NPCVehicle`, motion models, `WaypointFollower`, `CameraRig` | Drive the ego with keyboard, toggle 1st/3rd person with a key, NPCs loop a route following lane centerlines |
| **5** | Map editor | `MapEditor`, all `*Tool.js`, `GizmoManager`, `EditorUI`, `ModeSwitcher` | Build a small map from scratch in the editor (roads, a building, an obstruction, ego + one NPC), save it, load it in simulation mode, drive it |
| **6** | Sensors | `ProximitySensorArray`, `RaycastEngine`, `LaneCenteringSensor`, `SensorVisualizer` | Debug panel shows live proximity + lane-offset readings for the ego; visualized rays shorten correctly against a building/obstruction/vehicle |
| **7** | V2V | `V2VManager`, `NeighborIndex`, `LODManager`, `VehicleStateBroadcaster` | Spawn ~50 NPCs; only vehicles within 250m of an "active" vehicle run full sensor sim (visible via a counter); frame rate holds as vehicles enter/leave radius |
| **8** (stretch) | GPU | `GPUCastEngine` | With WebGPU available, toggling GPU sensors on gives the same readings as CPU with measurably better frame time at high vehicle counts; app still runs fine on WebGL-only browsers with the toggle hidden |
| **9** | Polish | `HUD`, `Minimap`, `CarFollowingModel`, obstruction-aware `WaypointFollower` | NPCs maintain safe following distance (IDM), slow/merge around obstructions; HUD shows speed + V2V alert badges + minimap; README documents controls |
| **10** | V2V Safety | `BSMProtocol`, `SafetyApplications`, `PropagationModel` | Ego receives blind-spot / intersection-collision / EEBL alerts from NPCs via BSM; buildings attenuate/block V2V (visible in debug overlay); ego auto-brakes or warns on alert; NPCs also react to received alerts |
| **11** | Foundation cleanup | `ConfigDefaults`, `AssetLoader`, `AppState` | All magic numbers extracted to ConfigDefaults; GLTF car models load via AssetLoader with box fallback; orphan stubs (`debug/`, `player/`, `world/`) removed or implemented |

---

## 7. Working With GLM-5.3

1. Paste the **Master Prompt** (Section 8) as your first message. Let it respond with its understanding and any questions before generating anything.
2. Paste **Phase 0's prompt**. Run the code. Fix or report back any errors before moving on.
3. Repeat for each phase in order, always in the same conversation so it retains the file contents and interfaces from prior phases. If the conversation gets too long and it starts forgetting earlier files, start a new conversation and re-paste the Master Prompt plus a short "here's what already exists" summary (you can literally paste the file tree with a one-line status per file).
4. Always require full file contents back, not diffs — with a codebase this size, diffs drift silently.

---

## 8. Master Prompt for GLM-5.3

Copy everything in the block below as your first message to GLM-5.3.

```
You are an expert three.js engineer building a Vehicle-to-Vehicle (V2V) driving simulation as a properly modularized project — not a single file. Read this entire brief, then reply with your understanding and any clarifying questions before writing any code. Do not generate code yet.

PROJECT SUMMARY
A three.js simulation of cars driving on a customizable, free-form (non-grid) road network, with buildings that create blind spots, road obstructions, a separate map editor, day/dawn/night lighting with fog control, first-person and third-person driving cameras, and a per-vehicle sensor suite (proximity ray sensors + a lane-centering sensor) that also simulates on nearby vehicles for a future V2V (vehicle-to-vehicle) extension, scoped to a 250m radius to control compute cost.

TECH STACK (use exactly this; do not substitute frameworks)
- three.js (current release). Use `three/addons/...` import paths if available in the installed version, otherwise `three/examples/jsm/...` — pick one convention and use it consistently everywhere.
- Vite as the dev server/bundler.
- Plain ES module classes. No React/Vue/Svelte, no Redux/Zustand — use a small hand-rolled EventBus for cross-module communication.
- cannon-es for optional ego-vehicle physics (kept behind an interface, not required for NPCs).
- three-mesh-bvh for accelerated raycasting against static geometry.
- lil-gui for control panels.

HARD CODE-QUALITY RULES
- Every class lives in its own file. Never combine unrelated responsibilities in one file.
- No circular imports between modules — use the EventBus for anything that would otherwise require a circular dependency.
- Every public method gets a short JSDoc comment (params, return, purpose).
- No magic numbers inline — put tunables in `src/state/ConfigDefaults.js`.
- Prefer small, testable pure functions in `utils/` over inline math.

FUNCTIONAL REQUIREMENTS
1. Roads are a graph of nodes connected by spline-based segments, placeable at arbitrary XZ coordinates — never snapped to a grid. Segments can share a node to form intersections (auto-detected by proximity when authoring). Each segment has an independently configurable lane count (forward and backward) and lane width.
2. Buildings can be placed anywhere on the map, independent of roads, to create sightline obstructions (blind spots). When a road segment's lane count increases and the resulting wider road footprint overlaps a building, that building must be programmatically pushed aside along the vector away from the road centerline. If, after being pushed, a building overlaps another building beyond a small threshold, the moved building is removed and the removal is logged.
3. Road obstructions (e.g. cones, barriers) can be placed on a specific lane at a specific distance along a segment, and can either fully or partially block that lane.
4. A separate Map Editor mode (distinct screen/route from the Simulation mode) supports: drawing roads by placing/dragging control points, setting lane counts per segment, placing/moving/rotating/scaling buildings, placing obstructions on lanes, placing vehicles (including designating the ego) with a starting lane and position, and saving/loading the whole map as JSON (schema given below).
5. Vehicles: an ego (player-controlled) vehicle and any number of NPC vehicles that follow lane centerlines through the network, including through intersections, at a configurable speed. NPCs use a cheap kinematic bicycle model by default; the ego optionally uses cannon-es rigid-body physics — both implement the same `IVehicleMotionModel` interface so either can be swapped without touching calling code.
6. Camera: first-person (driver eye point) and third-person (spring-arm chase cam) views for the ego, toggled with a keybind.
7. Environment: three lighting/sky presets — dawn, day, night — switchable at runtime, each adjusting directional light, ambient light, and sky appearance. Independent fog control (density, color) layered on top of whichever preset is active.
8. Sensors, per "active" vehicle (see radius/LOD rule below):
   a. A proximity sensor array casting rays in multiple configurable directions (front, front-left, front-right, left, right, rear-left, rear-right, rear by default) with a configurable max range, reporting distance-to-nearest-hit against other vehicles, buildings, and obstructions. Use a spatial-grid broadphase (only test objects within range) plus three-mesh-bvh for static geometry — do not brute-force raycast against every object in the scene every frame.
   b. A lane-centering sensor reporting lateral offset from the current lane centerline and heading error relative to the lane tangent. Because this must run on every vehicle within the 250m V2V radius, implement it analytically from the known lane spline geometry (not by rendering an actual camera and running image processing) — that's the only way it stays cheap enough to run on many vehicles at once. Separately, implement an optional real rendered front camera + simple edge-detection debug view, defaulting to ego-only, purely for visualization — it must not be the signal that drives the simulation for every vehicle.
9. V2V / radius-based activation: sensor simulation and neighbor broadcasting must run per "active" vehicle, each independently discovering neighbors within 250m via a spatial index — not hardcoded to only query around the ego. By default only the ego is active (this is the compute ceiling), but the design must support flipping a config flag to promote additional vehicles to "active" so they run their own local sensors and V2V discovery too, without any restructuring. Vehicles outside any active radius should run a much cheaper update (position/heading integration only, no sensors).
10. GPU acceleration is optional and additive: if the browser supports WebGPU, provide a TSL compute-shader path in `GPUCastEngine.js` that batches the proximity raycasts on GPU; there must always be a working CPU (BVH + spatial grid) path, and the app must run fully on WebGL-only browsers with the GPU toggle simply hidden or disabled.

DATA SCHEMAS
Map save/load format:
<paste the JSON in Section 4.1 of the plan here>

Runtime per-vehicle sensor frame:
<paste the JS object in Section 4.2 of the plan here>

FILE STRUCTURE
Follow this exact file/folder structure. Create stub files with a one-line JSDoc header for anything not yet implemented in the current phase, rather than inventing a different structure:
<paste the full tree from Section 5 of the plan here>

WORKFLOW
We will build this in phases. Do not attempt the whole project in one response. I will send you one phase at a time; only implement the files relevant to that phase, and always output the complete content of every file you touch (never a partial diff). At the end of each phase, briefly list any assumptions you made or open questions for me.

Confirm you've understood all of the above, flag anything that seems inconsistent or underspecified, then wait for me to send Phase 0.
```

---

## 9. Phase Prompts for GLM-5.3

Send these one at a time, in order, after the Master Prompt has been acknowledged.

### Phase 0 — Scaffold

```
PHASE 0 — PROJECT SCAFFOLD

Set up the Vite + three.js project skeleton per the agreed file structure.

Deliverables:
- package.json with three, vite, lil-gui, cannon-es, three-mesh-bvh as dependencies
- vite.config.js
- index.html
- src/main.js — boots src/core/Engine.js
- src/core/Engine.js — creates the renderer (WebGL for now), a Scene, a PerspectiveCamera, an OrbitControls instance for this phase only (will be replaced by CameraRig later), a THREE.Clock, and a requestAnimationFrame loop
- src/core/SceneManager.js — owns the THREE.Scene, exposes add/remove helpers
- src/core/EventBus.js — minimal pub/sub (on, off, emit)
- A simple ground plane (e.g. 500x500) and a hemisphere + directional light so the scene isn't black
- Stub files (JSDoc header only, no logic yet) for every other file in the agreed structure, so the folder layout exists from the start

Acceptance: `npm install && npm run dev` shows a lit ground plane with orbit controls and no console errors.

Output the full content of every file listed above.
```

### Phase 1 — Environment

```
PHASE 1 — ENVIRONMENT (TIME OF DAY + FOG)

Implement:
- src/environment/TimeOfDayController.js — three presets: 'dawn', 'day', 'night'. Each preset defines directional light color/intensity/position, ambient/hemisphere light color/intensity, and background/sky color. Expose setPreset(name) and getPreset().
- src/environment/SkyController.js — a simple sky (gradient shader or THREE.Color background is fine for now; note in comments how it could be upgraded to a physical sky later)
- src/environment/FogController.js — THREE.FogExp2, with setDensity(value) and setColor(color), independent of the time-of-day preset (call it after setPreset so fog isn't overwritten)
- src/environment/Lighting.js — owns the actual THREE.Light instances, applies values coming from TimeOfDayController
- src/ui/ControlPanel.js — a lil-gui panel with a dropdown for the three presets and a slider for fog density, wired to the controllers above
- Wire all of this into Engine.js / main.js

Acceptance: switching the dropdown changes lighting/sky instantly; moving the fog slider visibly changes fog density; no regressions from Phase 0.

Output the full content of every file you create or modify.
```

### Phase 2 — Roads

```
PHASE 2 — ROAD NETWORK

Implement the road system:
- src/road/RoadNode.js — { id, position: THREE.Vector3 }
- src/road/RoadSegment.js — { id, startNodeId, endNodeId, controlPoints, lanesForward, lanesBackward, laneWidthM, speedLimitKph, obstructions[] }, plus a method returning a THREE.CatmullRomCurve3 built from controlPoints
- src/road/SplineUtils.js — given a segment's curve, compute Frenet-ish tangent/normal at arbitrary t, and produce an offset curve for a given lane index (lane 0 = centerline-adjacent, offset by laneIndex * laneWidthM along the normal)
- src/road/RoadNetwork.js — holds nodes + segments (Maps keyed by id); addNode, addSegment(with automatic node-snapping: if a new segment's endpoint is within a small threshold of an existing node, reuse that node id instead of creating a new one — this is how intersections form); getSegmentsAtNode(nodeId)
- src/road/RoadMeshBuilder.js — for a given segment, sample its curve at N steps, compute left/right edge points from total road width (based on lane counts + laneWidthM), and build a flat ribbon mesh (BufferGeometry, triangle strip) with UVs tiled along length for an asphalt texture. Must rebuild cleanly when lane counts change (dispose old geometry, build new).
- src/road/LaneMarkingBuilder.js — dashed white lines between same-direction lanes, solid yellow between opposing-direction lanes, solid white on outer edges. Use InstancedMesh for the dashes.
- src/road/IntersectionBuilder.js — for any node with 2+ connected segments, generate a simple flat pad polygon sized to the widest connected road, positioned/oriented to visually join the segment ends at that node. Full lane-connector routing across the intersection can be a simplified straight-quad approximation for now.
- src/road/RoadObstruction.js — a placeable prop (start with a simple box/cone proxy mesh) with { segmentId, lane, distanceAlongM, blocking: 'partial' | 'full' }, positioned by evaluating the segment's lane curve at that distance
- src/road/RoadSerializer.js — serialize a RoadNetwork (plus obstructions) to the map JSON schema, and deserialize back into a live RoadNetwork + meshes

Also provide a sample map JSON (place it at public/maps/sample.json) with at least one curved segment, one 3-way intersection, and one obstruction, and load it on startup for this phase.

Acceptance: the sample map renders with correct lane markings and a visible intersection; calling segment.lanesForward++ followed by RoadMeshBuilder.rebuild(segment) visibly widens the road.

Output the full content of every file you create or modify.
```

### Phase 3 — Buildings

```
PHASE 3 — BUILDINGS + COLLISION RESOLUTION

Implement:
- src/buildings/Building.js — { id, position, size: [w,d,h], rotationY }, box mesh, exposes getOBB() or equivalent for overlap tests
- src/buildings/SpatialGrid.js — generic uniform grid for broadphase queries (insert, remove, queryRadius, queryAABB) — this will be reused by the sensor system later, so keep it generic (not building-specific)
- src/buildings/BuildingManager.js — add/remove buildings, keeps them in SpatialGrid
- src/buildings/CollisionResolver.js — implement:
  - computeRoadFootprint(segment): returns an approximate polygon (or just a sampled set of capsule/OBB segments along the curve) representing the current road width
  - resolveForSegment(segment, buildingManager): find buildings overlapping the footprint, push each along the vector from nearest-centerline-point to building center by (overlap depth + margin), log each push
  - resolveOverlaps(buildingManager): after pushes, find building-building overlaps beyond a threshold; remove the more-recently-moved building in each overlapping pair, log each removal
  - Call resolveForSegment then resolveOverlaps whenever a segment's lane count changes

Wire a lil-gui control to bump a segment's lanesForward/lanesBackward at runtime so this is testable interactively.

Acceptance: place a building close to a road's edge, increase lane count, observe it move; place two buildings so a push forces an overlap, observe one gets removed with a console log explaining why.

Output the full content of every file you create or modify.
```

### Phase 4 — Vehicles

```
PHASE 4 — VEHICLES

Implement:
- src/vehicles/IVehicleMotionModel.js — interface (JSDoc typedef is fine) defining update(dt, controlInput) -> { position, headingRad, speedMps }
- src/vehicles/KinematicBicycleModel.js — implements the interface with a simple bicycle model (position, heading, speed, steering angle, wheelbase)
- src/vehicles/PhysicsVehicleModel.js — implements the interface using cannon-es (raycast vehicle or simple box body + wheel constraints); used only by the ego by default
- src/vehicles/Vehicle.js — base class: mesh (fallback to a box if no GLTF provided), holds a motion model instance, exposes update(dt)
- src/vehicles/EgoVehicle.js — extends Vehicle, uses PhysicsVehicleModel by default (configurable), reads input via VehicleController
- src/vehicles/NPCVehicle.js — extends Vehicle, uses KinematicBicycleModel, driven by WaypointFollower instead of player input
- src/vehicles/WaypointFollower.js — given a RoadNetwork, a starting segment/lane/distance, and a target speed, produces steering/throttle control input each tick to follow the lane centerline, and advances onto the next connected segment at intersections (pick the segment whose start heading best matches current heading)
- src/vehicles/VehicleController.js — keyboard input (WASD/arrows) -> control input for the ego
- src/vehicles/VehicleFactory.js — spawns an Ego or NPC vehicle at a given network location
- src/core/CameraRig.js — replaces the Phase-0 OrbitControls for the ego: first-person (fixed local offset near the windshield, locked to vehicle rotation) and third-person (smoothed follow position/target behind and above the vehicle), toggled with the 'V' key

Acceptance: drive the ego with keyboard controls, press 'V' to toggle between first- and third-person, and see at least one NPC vehicle looping a route through an intersection using WaypointFollower.

Output the full content of every file you create or modify.
```

### Phase 5 — Map Editor

```
PHASE 5 — MAP EDITOR (separate mode)

Implement:
- src/ui/ModeSwitcher.js — a start screen (simple DOM overlay is fine) with "Edit Map" and "Run Simulation" buttons; this decides what main.js boots
- src/editor/MapEditor.js — owns an editor-specific top-down/orbit camera, a toolbar (DOM or lil-gui) to pick the active tool, and the currently-edited RoadNetwork/BuildingManager/vehicle list
- src/editor/RoadDrawTool.js — click to place road nodes/control points; clicking near an existing node reuses it (intersection); a side panel to edit the selected segment's lane counts
- src/editor/BuildingPlaceTool.js — click-drag to place a box building; selecting one shows GizmoManager handles to move/rotate/scale it; triggers CollisionResolver validation on release
- src/editor/ObstructionPlaceTool.js — click a point on a lane to place an obstruction, choose partial/full blocking
- src/editor/VehiclePlaceTool.js — click a point on a lane to place a vehicle; a checkbox/flag marks it as the ego (only one ego allowed — reassign if a new one is marked)
- src/editor/GizmoManager.js — thin wrapper around THREE.TransformControls
- src/editor/EditorUI.js — the DOM/lil-gui chrome tying the tools together, plus Save (download JSON) and Load (file input) buttons using RoadSerializer

Acceptance: starting from a blank map, draw at least two connected road segments (forming an intersection), place a building, place an obstruction, place an ego and one NPC, save to JSON, switch to Simulation mode, load that JSON, and drive it.

Output the full content of every file you create or modify.
```

### Phase 6 — Sensors

```
PHASE 6 — SENSORS

Implement:
- src/sensors/RaycastEngine.js — CPU raycasting: build/maintain a three-mesh-bvh acceleratedRaycast for static geometry (roads, buildings, obstructions); for dynamic objects (other vehicles), use the SpatialGrid from Phase 3 to only test candidates within ray range, then do cheap analytic ray-vs-OBB or ray-vs-capsule checks (not full mesh raycasts) against vehicle proxies
- src/sensors/ProximitySensorArray.js — configurable set of ray directions/angles/max-range (defaults: front, front-left, front-right, left, right, rear-left, rear-right, rear), attached to a vehicle, produces the proximityM object from the sensor-frame schema each tick using RaycastEngine
- src/sensors/LaneCenteringSensor.js — analytic: given the vehicle's position/heading and its current segment+lane (tracked via WaypointFollower/NPC state, or nearest-lane lookup for the ego), compute lateralOffsetM and headingErrorRad against that lane's offset curve
- src/sensors/FrontCameraSensor.js — a real THREE.PerspectiveCamera mounted at the vehicle's front, rendered to a THREE.WebGLRenderTarget, with a basic edge-detection post-process (e.g. a Sobel shader pass) purely for visualization; wire a toggle so it's off by default and only active for the ego when enabled
- src/sensors/SensorVisualizer.js — debug overlay: draw the proximity rays as lines (green if no hit within range, red shortened to the hit point if it does), toggleable
- Add sensor readings to a debug panel (extend ControlPanel or add a small HUD readout) for the ego vehicle

Acceptance: live proximity + lane-offset numbers update in the debug panel as the ego drives; toggling the ray visualizer shows rays correctly shortening against a building, an obstruction, and another vehicle.

Output the full content of every file you create or modify.
```

### Phase 7 — V2V

```
PHASE 7 — V2V MANAGER

Implement:
- src/v2v/NeighborIndex.js — radius query (250m default, configurable) over all vehicles, built on the SpatialGrid
- src/v2v/LODManager.js — three tiers: 'active' (full sensors + full motion model, ego by default, promotable via a config flag to N nearest NPCs), 'passive' (kinematic position/heading update only, rendered, no sensors), 'culled' (no per-frame update beyond coarse path progression, e.g. for anything far outside the view/interest area). Runs each tick, reassigning tiers as vehicles move.
- src/v2v/VehicleStateBroadcaster.js — for each 'active' vehicle, package its own sensor-frame-shaped state and hand it to V2VManager
- src/v2v/V2VManager.js — for each 'active' vehicle, ask NeighborIndex for neighbors within radius, attach a v2vNeighbors list (id, distanceM, relSpeedMps) to that vehicle's sensor frame

Add a debug counter to the HUD/ControlPanel showing how many vehicles are currently 'active' vs 'passive' vs 'culled'.

Acceptance: spawn ~50 NPCs across a spread-out map; confirm via the counter that only vehicles within 250m of an active vehicle carry full sensor frames; frame rate stays stable as vehicles move in and out of radius. Flip the "promote N NPCs to active" config flag and confirm those NPCs also start running their own local sensors/V2V without errors.

Output the full content of every file you create or modify.
```

### Phase 8 — GPU acceleration (stretch)

```
PHASE 8 — GPU-ACCELERATED SENSORS (OPTIONAL)

Implement:
- src/sensors/GPUCastEngine.js — detect WebGPU support (three.js WebGPURenderer); if available, encode active vehicles' proximity ray origins/directions and nearby obstacle proxies (position + bounding info) into storage buffers, and use a TSL compute shader (three/tsl) to compute ray-vs-proxy hit distances for all rays in parallel; read results back asynchronously
- Wire a toggle in ControlPanel: "GPU sensors" (only shown/enabled if WebGPU is available), swapping ProximitySensorArray's backend between RaycastEngine (CPU) and GPUCastEngine (GPU) without changing its public API
- If WebGPU is unavailable, this toggle should be hidden or disabled and the app must run identically on the CPU path

Acceptance: on a WebGPU-capable browser, toggling GPU sensors on produces proximity readings matching the CPU path within a small tolerance, with measurably better frame time at high vehicle counts (e.g. 100+ active vehicles); on a WebGL-only browser, the app runs with no errors and the toggle is absent/disabled.

Output the full content of every file you create or modify.
```

### Phase 9 — Polish (HUD, Minimap, Car-Following, Obstruction Awareness)

```
PHASE 9 — POLISH: HUD, MINIMAP, CAR-FOLLOWING & OBSTRUCTION AWARENESS

This phase makes the simulation feel like a real traffic environment rather than a demo. Three focus areas:

A. Car-following model (Intelligent Driver Model — IDM)
- src/vehicles/CarFollowingModel.js — implement the IDM (Treiber et al. 2000): given own speed, speed of the car ahead, gap to the car ahead, and desired speed, compute a longitudinal acceleration. Key parameters: desired time headway (1.5s default), comfortable deceleration (3 m/s²), maximum acceleration (1.5 m/s²), minimum gap (2 m). Expose all as constructor options.
- Integrate into WaypointFollower.js: before computing throttle/brake, query ProximitySensorArray's 'front' reading (if the vehicle has an active sensor stack) or fall back to a simpler "look ahead on the same lane" analytic check against the SpatialGrid for passive vehicles. Feed the gap distance and relative speed into CarFollowingModel to get the IDM acceleration, then convert to throttle/brake. The IDM should OVERRIDE the existing speed-only control — the existing corner-slowing and U-turn logic remain layered on top.
- Obstruction awareness in WaypointFollower: at each tick, check the current segment's obstructions[]. If any obstruction is on the current lane within lookahead distance: if blocking === 'full', attempt to merge to an adjacent same-direction lane (check if that lane exists, and use lateral offset + steering to transition); if blocking === 'partial', slow to 30% of target speed but keep the current lane. If no adjacent lane is available for a 'full' block, brake to a stop before the obstruction.

B. HUD
- src/ui/HUD.js — a DOM overlay (not lil-gui) anchored to the bottom or top of the viewport showing:
  - Current speed (km/h and m/s)
  - Active V2V neighbor count
  - LOD tier counts (active / passive / culled)
  - A badge area for future V2V safety alerts (Phase 10 will populate this)
  - Current lane info (segment ID, lane index, lateral offset)
- Style it to be semi-transparent, readable over the 3D scene, and togglable with 'H' key.
- Move the sensor readout from ControlPanel's raw text box into HUD's structured layout.

C. Minimap
- src/ui/Minimap.js — a small canvas element (e.g. 200×200px, corner-anchored) rendering a top-down orthographic view:
  - Draw road segment centerlines as grey lines
  - Draw the ego as a distinct colored dot (e.g. blue)
  - Draw NPCs as smaller dots, color-coded by LOD tier (green=active, yellow=passive, grey=culled)
  - Draw the V2V radius as a translucent circle around the ego
  - Auto-center on the ego, auto-scale to fit the 250m radius
  - Togglable with 'M' key

D. README
- README.md at the project root documenting: controls (WASD, V for camera, H for HUD, M for minimap), how to run (npm install && npm run dev), how to use the editor, map format overview, and architecture summary.

Acceptance:
1. Spawn 20+ NPCs on the city map: observe that trailing NPCs decelerate smoothly behind slower ones (no rear-ending), and NPCs approaching a 'full' obstruction merge or stop.
2. HUD shows live speed, neighbor count, and tier breakdown without opening lil-gui.
3. Minimap shows the ego dot centered, NPC dots moving, and the V2V radius circle.
4. README exists and accurately documents the simulation.

Output the full content of every file you create or modify.
```

### Phase 10 — V2V Safety Applications

```
PHASE 10 — V2V SAFETY APPLICATIONS (BSM, ALERTS, RF PROPAGATION)

This phase turns the V2V system from a passive data pipeline into an active safety system.

A. BSM Protocol
- src/v2v/BSMProtocol.js — define a Basic Safety Message (BSM) structure, inspired by SAE J2735 but simplified for our simulation. Each BSM contains:
  - vehicleId, timestampSec
  - position (x, y, z), heading (rad), speed (m/s)
  - acceleration (m/s²), yawRate (rad/s)
  - braking (boolean), brakingIntensity (0–1)
  - turnSignal ('none' | 'left' | 'right')
  - vehicleSize { lengthM, widthM }
  - pathPrediction: array of 3–5 future (x, z) points at 0.5s intervals, computed from current heading + speed + steering
- BSMProtocol.encode(vehicle, motionState) → BSM object; BSMProtocol.decode(bsm) → validated object.
- Modify VehicleStateBroadcaster to produce BSM-shaped messages instead of (or in addition to) the current sensor-frame payload. Each active vehicle broadcasts a BSM every tick; the BSM is what neighbors receive.

B. RF Propagation Model
- src/v2v/PropagationModel.js — determines whether a BSM from vehicle A can be received by vehicle B:
  - Line-of-sight (LOS) check: cast a ray from A's position to B's position and test intersection against building geometry (reuse the BVH from RaycastEngine for statics). If the ray hits a building, the link is NLOS (non-line-of-sight).
  - Simple path-loss model: free-space path loss at 5.9 GHz. LOS links within 250m always succeed. NLOS links are attenuated: if the cumulative building-wall thickness along the ray exceeds a threshold (~10m of concrete), the packet is dropped entirely. Between 0 and the threshold, apply a packet delivery ratio (PDR) that degrades linearly from 1.0 to 0.0 — simulate this as a probability check each tick (if Math.random() > PDR, the BSM is dropped for that pair).
  - Integrate into V2VManager: after NeighborIndex returns candidates within radius, filter through PropagationModel. Only BSMs that pass the propagation check are delivered to the receiver's v2vNeighbors / alert system.

C. Safety Applications
- src/v2v/SafetyApplications.js — consumes received BSMs for a vehicle and produces safety alerts:
  - Intersection Collision Warning (ICW): if this vehicle and a received BSM's vehicle are both approaching the same intersection node (within 50m), and their pathPredictions intersect within the next 3 seconds, emit an 'icw' alert with severity and the conflicting vehicleId.
  - Blind Spot Warning (BSW): if a received BSM's vehicle is in this vehicle's blind zone (rear-left or rear-right quarter, within 10m, and NLOS via buildings — i.e., the proximity sensor shows no hit there but V2V says a car exists), emit a 'bsw' alert.
  - Emergency Electronic Brake Lights (EEBL): if a received BSM's vehicle is ahead on the same or an adjacent lane, within 100m, and its brakingIntensity > 0.6, emit an 'eebl' alert.
  - Each alert is { type, severity ('info'|'warning'|'critical'), vehicleId, distanceM, description }.
- Attach alerts to vehicle.v2vAlerts (array, cleared each tick) alongside vehicle.sensorFrame.

D. Vehicle reaction to alerts
- WaypointFollower: if vehicle.v2vAlerts contains an 'icw' alert with severity 'critical', reduce target speed to 20% and set brake to 0.7 until the alert clears. If 'eebl', reduce speed proportionally to the distance.
- VehicleController (ego): if ego.v2vAlerts is non-empty, feed the alerts to HUD for display (badge/flash). Optionally auto-brake on 'critical' ICW (behind a config flag, default off — the ego is player-controlled, so alerts should primarily be visual/audio).

E. Debug visualization
- Add a V2V links overlay (togglable): draw lines between the ego and its V2V neighbors, colored green for LOS and red for NLOS-but-received, no line for blocked. Show alert badges on the HUD with type and severity.
- Add a propagation debug mode: for the ego, draw the LOS rays to all neighbors, highlighting building intersections.

Acceptance:
1. Place the ego behind a large building. Place an NPC approaching the same intersection from behind the building. The ego should receive an ICW alert 2–3 seconds before the NPC would cross the intersection — visible on the HUD.
2. Temporarily remove the building: observe the V2V link to that NPC changes from NLOS (red) to LOS (green) in the debug overlay, and the ICW still fires (now via LOS rather than NLOS-attenuated).
3. Add a very thick building cluster between two vehicles: observe the BSM is dropped entirely (no alert, no v2vNeighbor entry) — visible as a missing line in the debug overlay.
4. NPC behind a hard-braking lead NPC (same lane, 80m gap) receives EEBL and visibly decelerates earlier than it would from proximity sensors alone.

Output the full content of every file you create or modify.
```

### Phase 11 — Foundation Cleanup

```
PHASE 11 — FOUNDATION CLEANUP (ConfigDefaults, AssetLoader, Dead Code)

This phase hardens the codebase by filling the structural gaps.

A. ConfigDefaults
- src/state/ConfigDefaults.js — audit every file for magic numbers and tunables. Extract them into a single defaults object, organized by module:
  - road: { laneWidthM, nodeSnapThresholdM, sampleSpacingM, ... }
  - vehicle: { egoWheelbaseM, npcDefaultSpeedMps, idmDesiredTimeHeadway, idmMaxAccel, idmComfortDecel, idmMinGapM, ... }
  - sensor: { proximityMaxRangeM, proximityRayDirections[], ... }
  - v2v: { radiusM, bsmIntervalSec, propagationNlosThresholdM, icwTimeHorizonSec, icwApproachDistanceM, eelblBrakeThreshold, ... }
  - environment: { fogDensityDefault, ... }
  - editor: { gridSnapSize, ... }
  - lod: { cullRadiusM, passiveRadiusM, ... }
- Every module imports its defaults from ConfigDefaults instead of using inline constants.
- Wire ConfigDefaults into ControlPanel so key tunables can be adjusted at runtime.

B. AppState
- src/state/AppState.js — a minimal singleton holding the current simulation mode ('edit' | 'simulate'), the active map data reference, and the ego vehicle reference. Other systems query AppState instead of reaching through module chains. NOT a full state management framework — just a thin lookup point.

C. AssetLoader
- src/core/AssetLoader.js — wraps THREE.GLTFLoader with a cache (Map<url, Promise<GLTF>>). Exposes loadModel(url) → Promise<THREE.Group>. If a GLTF fails to load or the URL is empty, return a fallback box mesh (the current behavior) and log a warning.
- Update VehicleFactory to attempt loading from public/models/car_sedan.glb (or similar) via AssetLoader, falling back to the existing box.
- Create public/models/ and public/textures/ directories (empty, with a .gitkeep).

D. Dead code cleanup
- Remove or implement the orphan stubs: src/debug/DebugPanel.js, src/input/InputManager.js, src/player/PlayerController.js, src/world/Terrain.js, src/world/World.js. If a stub was superseded by another file (e.g. InputManager → VehicleController), delete it. If it represents a genuine future feature (e.g. Terrain for procedural ground), leave the stub but add a clear "NOT IMPLEMENTED — future" comment.

E. Utilities consolidation
- Rename src/utils/helpers.js → src/utils/MathUtils.js (or merge into it) to match the planned structure.
- Create src/utils/GeometryUtils.js for any geometry helpers currently inline in road/ or buildings/ files.
- Create src/utils/Constants.js for truly global constants (e.g. METERS_PER_UNIT, DEFAULT_Y).

Acceptance:
1. `grep -rn 'magic\|TODO.*constant\|= 3\.5\|= 250\|= 0\.02' src/` returns zero hits outside ConfigDefaults.js.
2. Removing public/models/*.glb still works (box fallback), but placing a GLTF there loads the model.
3. No empty `export {};` stub files remain.
4. All imports resolve; `npm run build` succeeds with no warnings.

Output the full content of every file you create or modify.
```

---

## 12. Notes for you, not GLM

- Start Phase 0 through Phase 4 before worrying about the editor — you want a drivable core loop first.
- The editor (Phase 5) is the most UI-heavy phase and the most likely to need iteration; budget extra back-and-forth there.
- Phase 7's LOD tiering is what actually answers your "simulate V2V on other vehicles too, without blowing up compute" ask — test it with a genuinely large NPC count (50–100) before trusting it.
- Phase 8 is a real capability in current three.js but is the newest piece of the stack; treat it as optional and don't let it block anything else.
- Phase 9 (car-following / obstruction awareness) is what turns the simulation from a tech demo into something resembling real traffic. Without it, NPCs pile up and ignore obstacles — this is the biggest usability gap right now.
- Phase 10 (V2V safety) is the entire *point* of the project. The current V2V system only computes neighbor distances; Phase 10 is where you actually demonstrate that V2V provides safety value (e.g. seeing around blind corners). Budget serious testing here — the ICW scenario with a building between two vehicles at an intersection is the hero demo.
- Phase 11 is housekeeping. It's not glamorous, but extracting ConfigDefaults makes every future tuning session faster, and AssetLoader is the gateway to making the simulation look good with real car models.
