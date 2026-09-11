import * as THREE from 'three';
import { mulberry32 } from '../utils/MathUtils.js';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

const GPU = ConfigDefaults.gpu;
const SENSOR = ConfigDefaults.sensor;
const VEHICLE_PROXY_HALF = ConfigDefaults.vehicle.vehicleProxyHalf;

const MAX_RAYS = GPU.maxRays; // 512 vehicles × 8 rays
const MAX_PROXIES = GPU.maxProxies;
const WORKGROUP_SIZE = GPU.workgroupSize;
const VALIDATION_DISPATCHES = GPU.validationDispatches;
const VALIDATION_TOLERANCE_M = GPU.validationToleranceM;

/**
 * GPUCastEngine — optional WebGPU compute backend for proximity rays.
 *
 * Capability detection via a probe three.js WebGPURenderer (spec); compute
 * on its own GPUDevice with a raw WGSL kernel (the language TSL emits —
 * see the Phase 8 notes for why TSL authoring was deferred). Pipeline per
 * tick: beginFrame() → submitRays() per array → flush() (one dispatch for
 * all rays) → async staging-buffer readback (~1 frame latency) → results
 * applied onto the arrays. Self-validation against the CPU reference
 * during warmup; any mismatch/device loss disables the engine and reverts
 * to CPU.
 */
const WGSL_KERNEL = /* wgsl */ `
  struct Params {
    rayCount: u32,
    proxyCount: u32,
    pad0: u32,
    pad1: u32,
  };

  @group(0) @binding(0) var<uniform> params : Params;
  @group(0) @binding(1) var<storage, read> raysOrigin : array<vec4<f32>>;
  @group(0) @binding(2) var<storage, read> raysDir : array<vec4<f32>>;
  @group(0) @binding(3) var<storage, read> proxyCenter : array<vec4<f32>>;
  @group(0) @binding(4) var<storage, read> proxyHalf : array<vec4<f32>>;
  @group(0) @binding(5) var<storage, read> proxyMeta : array<vec4<f32>>;
  @group(0) @binding(6) var<storage, read_write> results : array<vec4<f32>>;

  fn slab(d : f32, s : f32, h : f32, tMin : ptr<function, f32>, tMax : ptr<function, f32>) {
    let pad = select(1.0, 0.0, abs(d) >= 1e-6);
    let inv = 1.0 / (d + pad * 1e-6);
    var t1 = (h - s) * inv;
    var t2 = (-h - s) * inv;
    if (t1 > t2) {
      let swap = t1;
      t1 = t2;
      t2 = swap;
    }
    *tMin = max(*tMin, t1);
    *tMax = min(*tMax, t2);
  }

  @compute @workgroup_size(${WORKGROUP_SIZE})
  fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let index = gid.x;
    if (index >= params.rayCount) { return; }

    let ray = raysOrigin[index];
    let dirData = raysDir[index];
    let origin = ray.xyz;
    let dir = dirData.xyz;
    let maxRange = ray.w;
    let ignoreId = dirData.w;

    var bestT = 1e8;
    var bestKind = 0.0;

    for (var p : u32 = 0u; p < params.proxyCount; p = p + 1u) {
      let center = proxyCenter[p];
      let half = proxyHalf[p].xyz;
      let meta = proxyMeta[p];

      let skip = select(1.0, 0.0, abs(meta.x - ignoreId) >= 0.5);
      let rel = origin - center.xyz;
      let axisX = vec3<f32>(center.w, 0.0, meta.y);
      let axisZ = vec3<f32>(meta.y, 0.0, -center.w);

      var tMin = 0.0;
      var tMax = 1e8;
      slab(dot(dir, axisX), dot(rel, axisX), half.x, &tMin, &tMax);
      slab(dir.y,        rel.y,         half.y, &tMin, &tMax);
      slab(dot(dir, axisZ), dot(rel, axisZ), half.z, &tMin, &tMax);

      let valid = select(0.0, 1.0, tMax >= tMin);
      let t = tMin + 1e7 * (skip + (1.0 - valid));
      if (t < bestT) {
        bestT = t;
        bestKind = meta.z;
      }
    }

    let dist = min(bestT, maxRange);
    let kind = select(0.0, bestKind, bestT < maxRange);
    results[index] = vec4<f32>(dist, kind, 0.0, 0.0);
  }
`;

export class GPUCastEngine {
  constructor({ vehicles = [], cpuReference = null, onDisabled = null } = {}) {
    this._vehicles = vehicles;
    this._cpuReference = cpuReference;
    this._onDisabled = onDisabled;

    this._device = null;
    this._pipeline = null;
    this._bindGroup = null;
    this._supported = false;
    this._failed = false;

    /** @type {Set<THREE.Mesh>} */
    this._staticMeshes = new Set();
    this._staticProxies = [];
    this._staticsDirty = true;

    this._submissions = [];
    this._vehicleIds = new Map(); // vehicle → numeric id (1..n)
    this._vehicleById = new Map();
    this._vehicleIdSequence = 0;

    this._rayOriginArray = new Float32Array(MAX_RAYS * 4);
    this._rayDirArray = new Float32Array(MAX_RAYS * 4);
    this._proxyCenterArray = new Float32Array(MAX_PROXIES * 4);
    this._proxyHalfArray = new Float32Array(MAX_PROXIES * 4);
    this._proxyMetaArray = new Float32Array(MAX_PROXIES * 4);
    this._proxyCount = 0;
    this._paramsData = new Uint32Array(4);

    this._staging = null; // [{ buffer, pending }, { buffer, pending }]
    this._stagingFlip = 0;
    this._benchStaging = null;

    this._validationRemaining = VALIDATION_DISPATCHES;
    this._overflowWarned = false;

    this.stats = {
      supported: false,
      raysLastFrame: 0,
      gpuSubmitMs: 0,
      readbackMs: 0,
      cpuCastMs: 0,
      lastMaxDeltaM: null,
    };
  }

  /**
   * Factory: resolves to a ready engine, or null when WebGPU is
   * unavailable — never throws.
   */
  static async create(options = {}) {
    const engine = new GPUCastEngine(options);
    const ok = await engine._initialize();
    return ok ? engine : null;
  }

  get supported() {
    return this._supported;
  }

  /** Healthy and usable (probe passed, nothing failed since). */
  get active() {
    return this._supported && !this._failed;
  }

  async _initialize() {
    try {
      if (typeof navigator === 'undefined' || !navigator.gpu) return false;

      // Probe three's WebGPURenderer (the spec's detection path).
      const { WebGPURenderer } = await import('three/webgpu');
      const probe = new WebGPURenderer({ canvas: document.createElement('canvas'), antialias: false });
      await probe.init();
      probe.dispose?.();

      // Own device for the raw compute pipeline.
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return false;
      const device = await adapter.requestDevice();
      this._device = device;
      device.lost.then((info) => this._fail(`device lost (${info?.reason ?? 'unknown'})`));

      this._allocateBuffers();
      const module = device.createShaderModule({ code: WGSL_KERNEL, label: 'gpucast-kernel' });
      this._pipeline = device.createComputePipeline({
        label: 'gpucast-pipeline',
        layout: 'auto',
        compute: { module, entryPoint: 'main' },
      });
      this._bindGroup = device.createBindGroup({
        layout: this._pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this._paramsBuffer } },
          { binding: 1, resource: { buffer: this._rayOriginBuffer } },
          { binding: 2, resource: { buffer: this._rayDirBuffer } },
          { binding: 3, resource: { buffer: this._proxyCenterBuffer } },
          { binding: 4, resource: { buffer: this._proxyHalfBuffer } },
          { binding: 5, resource: { buffer: this._proxyMetaBuffer } },
          { binding: 6, resource: { buffer: this._resultsBuffer } },
        ],
      });

      this._supported = true;
      this.stats.supported = true;
      return true;
    } catch (error) {
      console.info('[GPUCast] WebGPU unavailable — CPU raycasting only:', error?.message ?? error);
      return false;
    }
  }

  _allocateBuffers() {
    const device = this._device;
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    const size = MAX_RAYS * 16;

    this._paramsBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this._rayOriginBuffer = device.createBuffer({ size, usage: storage });
    this._rayDirBuffer = device.createBuffer({ size, usage: storage });
    this._proxyCenterBuffer = device.createBuffer({ size: MAX_PROXIES * 16, usage: storage });
    this._proxyHalfBuffer = device.createBuffer({ size: MAX_PROXIES * 16, usage: storage });
    this._proxyMetaBuffer = device.createBuffer({ size: MAX_PROXIES * 16, usage: storage });
    this._resultsBuffer = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });

    const stagingUsage = GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST;
    this._staging = [0, 1].map(() => ({
      buffer: device.createBuffer({ size, usage: stagingUsage }),
      pending: false,
    }));
    this._benchStaging = device.createBuffer({ size, usage: stagingUsage });
  }

  // ---- static registry ---------------------------------------------------------

  /** Register a static obstacle mesh (idempotent); its OBB proxy is cached. */
  registerStatic(mesh) {
    if (!mesh || !mesh.isMesh || this._staticMeshes.has(mesh)) return;
    this._staticMeshes.add(mesh);
    this._staticsDirty = true;
  }

  unregisterStatic(mesh) {
    if (this._staticMeshes.delete(mesh)) this._staticsDirty = true;
  }

  /** Per-tick: drop meshes removed from the scene (e.g. resolver deletions). */
  beginFrame() {
    if (!this.active) return;
    let changed = false;
    for (const mesh of [...this._staticMeshes]) {
      if (!mesh.parent) {
        this._staticMeshes.delete(mesh);
        changed = true;
      }
    }
    if (changed || this._staticsDirty) {
      this._staticProxies = [...this._staticMeshes]
        .map((mesh) => this._extractStaticProxy(mesh))
        .filter(Boolean);
      this._staticsDirty = false;
    }
  }

  /** OBB proxy from the mesh's local bounding box + yaw/position transform. */
  _extractStaticProxy(mesh) {
    const geometry = mesh.geometry;
    if (!geometry) return null;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    const halfW = (box.max.x - box.min.x) / 2;
    const halfH = (box.max.y - box.min.y) / 2;
    const halfL = (box.max.z - box.min.z) / 2;
    const cx = (box.max.x + box.min.x) / 2;
    const cy = (box.max.y + box.min.y) / 2;
    const cz = (box.max.z + box.min.z) / 2;
    const yaw = mesh.rotation.y;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    return {
      cx: mesh.position.x + cx * cos + cz * sin,
      cy: mesh.position.y + cy,
      cz: mesh.position.z + -cx * sin + cz * cos,
      halfW,
      halfH,
      halfL,
      cosYaw: cos,
      sinYaw: sin,
    };
  }

  // ---- ray staging ----------------------------------------------------------------

  /**
   * Stage one sensor array's rays (called from ProximitySensorArray.update
   * on the GPU backend). Snapshots geometry for late application.
   */
  submitRays(sensorArray) {
    if (!this.active) return;
    const segments = sensorArray.raySegments;
    const count = Math.min(segments.length, MAX_RAYS);
    const origins = new Float32Array(count * 3);
    const directions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const segment = segments[i];
      origins[i * 3] = segment.origin.x;
      origins[i * 3 + 1] = segment.origin.y;
      origins[i * 3 + 2] = segment.origin.z;
      directions[i * 3] = segment.direction.x;
      directions[i * 3 + 1] = segment.direction.y;
      directions[i * 3 + 2] = segment.direction.z;
    }
    this._submissions.push({
      sensorArray,
      raySegments: segments,
      origins,
      directions,
      maxRangeM: sensorArray.maxRangeM,
      vehicleId: sensorArray.vehicle ? this._vehicleId(sensorArray.vehicle) : -1,
      rayBase: 0,
      rayCount: 0,
    });
  }

  _vehicleId(vehicle) {
    let id = this._vehicleIds.get(vehicle);
    if (id === undefined) {
      id = ++this._vehicleIdSequence;
      this._vehicleIds.set(vehicle, id);
      this._vehicleById.set(id, vehicle);
    }
    return id;
  }

  // ---- dispatch + readback -------------------------------------------------------------

  /** Encode, dispatch once for ALL staged rays, schedule async application. */
  flush() {
    if (!this.active || this._submissions.length === 0) return;
    const submissions = this._submissions;
    this._submissions = [];

    // 1) Encode rays.
    let rayCount = 0;
    let reach = 0;
    for (const submission of submissions) {
      submission.rayBase = rayCount;
      const count = Math.min(submission.raySegments.length, MAX_RAYS - rayCount);
      for (let i = 0; i < count; i++) {
        const segment = submission.raySegments[i];
        const o = rayCount * 4;
        this._rayOriginArray[o] = segment.origin.x;
        this._rayOriginArray[o + 1] = segment.origin.y;
        this._rayOriginArray[o + 2] = segment.origin.z;
        this._rayOriginArray[o + 3] = submission.maxRangeM;
        this._rayDirArray[o] = segment.direction.x;
        this._rayDirArray[o + 1] = segment.direction.y;
        this._rayDirArray[o + 2] = segment.direction.z;
        this._rayDirArray[o + 3] = submission.vehicleId;
        rayCount += 1;
      }
      submission.rayCount = count;
      reach = Math.max(reach, submission.maxRangeM);
    }
    if (rayCount === 0) return;
    if (rayCount === MAX_RAYS && !this._overflowWarned) {
      this._overflowWarned = true;
      console.warn(`[GPUCast] ray cap reached (${MAX_RAYS}) — some vehicles cast no rays this frame`);
    }

    // 2) Rays AABB (for the static "nearby" cull) + proxies.
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const submission of submissions) {
      for (let i = 0; i < submission.rayCount; i++) {
        const o = (submission.rayBase + i) * 4;
        const x = this._rayOriginArray[o];
        const z = this._rayOriginArray[o + 2];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }
    this._rebuildProxyArrays({ minX, maxX, minZ, maxZ }, reach + 60);

    // 3) Warmup validation: CPU reference on the identical rays.
    let expected = null;
    if (this._validationRemaining > 0 && this._cpuReference) {
      this._cpuReference.beginFrame();
      const started = performance.now();
      expected = this._runValidationReference(rayCount);
      this.stats.cpuCastMs = performance.now() - started;
    }

    // 4) Upload, dispatch, copy to staging, apply asynchronously.
    const device = this._device;
    const staging = this._staging[this._stagingFlip];
    this._stagingFlip ^= 1;
    if (staging.pending) {
      // Two readbacks still in flight — drop this frame rather than risk
      // mapping an already-mapped buffer.
      console.debug('[GPUCast] readback backlog — dropping one frame of results');
      return;
    }

    const submitStarted = performance.now();
    device.queue.writeBuffer(this._rayOriginBuffer, 0, this._rayOriginArray, 0, rayCount * 4);
    device.queue.writeBuffer(this._rayDirBuffer, 0, this._rayDirArray, 0, rayCount * 4);
    device.queue.writeBuffer(this._proxyCenterBuffer, 0, this._proxyCenterArray, 0, this._proxyCount * 4);
    device.queue.writeBuffer(this._proxyHalfBuffer, 0, this._proxyHalfArray, 0, this._proxyCount * 4);
    device.queue.writeBuffer(this._proxyMetaBuffer, 0, this._proxyMetaArray, 0, this._proxyCount * 4);
    this._paramsData[0] = rayCount;
    this._paramsData[1] = this._proxyCount;
    device.queue.writeBuffer(this._paramsBuffer, 0, this._paramsData);

    const byteLength = rayCount * 16;
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this._pipeline);
    pass.setBindGroup(0, this._bindGroup);
    pass.dispatchWorkgroups(Math.ceil(rayCount / WORKGROUP_SIZE));
    pass.end();
    encoder.copyBufferToBuffer(this._resultsBuffer, 0, staging.buffer, 0, byteLength);
    device.queue.submit([encoder.finish()]);
    this.stats.gpuSubmitMs = performance.now() - submitStarted;
    this.stats.raysLastFrame = rayCount;

    staging.pending = true;
    const readStarted = performance.now();
    staging.buffer
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        try {
          const view = new Float32Array(staging.buffer.getMappedRange(0, byteLength));
          const results = view.slice(); // copy out before unmap
          staging.buffer.unmap();
          this.stats.readbackMs = performance.now() - readStarted;
          this._applyResults(submissions, results, rayCount, expected);
        } catch (error) {
          this._fail(`readback failed: ${error?.message ?? error}`);
        } finally {
          staging.pending = false;
        }
      })
      .catch((error) => {
        staging.pending = false;
        this._fail(`mapAsync rejected: ${error?.message ?? error}`);
      });
  }

  /** Statics (culled to the rays' neighborhood) + all live vehicles. */
  _rebuildProxyArrays(raysAABB, reach) {
    let count = 0;
    const push = (cx, cy, cz, cosYaw, sinYaw, halfW, halfH, halfL, vehicleId, kind) => {
      if (count >= MAX_PROXIES) return;
      const o = count * 4;
      this._proxyCenterArray[o] = cx;
      this._proxyCenterArray[o + 1] = cy;
      this._proxyCenterArray[o + 2] = cz;
      this._proxyCenterArray[o + 3] = cosYaw;
      this._proxyHalfArray[o] = halfW;
      this._proxyHalfArray[o + 1] = halfH;
      this._proxyHalfArray[o + 2] = halfL;
      this._proxyMetaArray[o] = vehicleId;
      this._proxyMetaArray[o + 1] = sinYaw;
      this._proxyMetaArray[o + 2] = kind;
      count += 1;
    };

    if (raysAABB) {
      for (const proxy of this._staticProxies) {
        const px = Math.max(raysAABB.minX, Math.min(proxy.cx, raysAABB.maxX));
        const pz = Math.max(raysAABB.minZ, Math.min(proxy.cz, raysAABB.maxZ));
        const radius = Math.hypot(proxy.halfW, proxy.halfL);
        if (Math.hypot(proxy.cx - px, proxy.cz - pz) > reach + radius) continue;
        push(proxy.cx, proxy.cy, proxy.cz, proxy.cosYaw, proxy.sinYaw, proxy.halfW, proxy.halfH, proxy.halfL, -1, 1);
      }
    }

    for (const vehicle of this._vehicles) {
      if (!vehicle?.motionModel) continue;
      const state = vehicle.motionModel.getState();
      const h = state.headingRad;
      push(
        state.position.x,
        state.position.y,
        state.position.z,
        Math.cos(h),
        Math.sin(h),
        VEHICLE_PROXY_HALF.width,
        VEHICLE_PROXY_HALF.height,
        VEHICLE_PROXY_HALF.length,
        this._vehicleId(vehicle),
        2
      );
    }
    this._proxyCount = count;
  }

  /** Apply GPU results to each submitting array (readings + ray hits). */
  _applyResults(submissions, results, rayCount, expected) {
    for (const submission of submissions) {
      const array = submission.sensorArray;
      for (let i = 0; i < submission.rayCount; i++) {
        const o = (submission.rayBase + i) * 4;
        const distance = results[o];
        const kindCode = results[o + 1];
        const kind = kindCode === 2 ? 'vehicle' : kindCode === 1 ? 'static' : 'none';
        const segment = submission.raySegments[i];
        array.readings.proximityM[segment.name] = distance;
        array.readings.hitKind[segment.name] = kind;
        if (kindCode > 0) {
          const ox = submission.origins[i * 3];
          const oy = submission.origins[i * 3 + 1];
          const oz = submission.origins[i * 3 + 2];
          const dx = submission.directions[i * 3];
          const dz = submission.directions[i * 3 + 2];
          segment.hit = {
            distanceM: distance,
            point: new THREE.Vector3(ox + dx * distance, oy, oz + dz * distance),
            kind,
            object: null,
          };
        } else {
          segment.hit = null;
        }
      }
    }

    if (!expected) return;

    // Warmup validation against the CPU reference.
    let mismatches = 0;
    let maxDelta = 0;
    for (let i = 0; i < rayCount; i++) {
      const delta = Math.abs(results[i * 4] - expected[i]);
      if (delta > maxDelta) maxDelta = delta;
      if (delta > VALIDATION_TOLERANCE_M + 0.02 * expected[i]) mismatches += 1;
    }
    this.stats.lastMaxDeltaM = maxDelta;

    if (mismatches > Math.max(1, Math.floor(rayCount * 0.05))) {
      this._fail(
        `validation mismatch (${mismatches}/${rayCount} rays beyond ${VALIDATION_TOLERANCE_M} m; ` +
        `max Δ ${maxDelta.toFixed(2)} m) — reverting to CPU`
      );
      return;
    }
    this._validationRemaining -= 1;
    if (this._validationRemaining === 0) {
      console.info(
        `[GPUCast] validated vs CPU: max Δ ${maxDelta.toFixed(2)} m over ${rayCount} rays · ` +
        `CPU cast ${this.stats.cpuCastMs.toFixed(2)} ms vs GPU submit ${this.stats.gpuSubmitMs.toFixed(2)} ms ` +
        `+ ${this.stats.readbackMs.toFixed(2)} ms readback per frame`
      );
    }
  }

  /** CPU reference distances for the currently encoded rays. */
  _runValidationReference(rayCount) {
    const expected = new Float32Array(rayCount);
    const origin = new THREE.Vector3();
    const direction = new THREE.Vector3();
    for (let i = 0; i < rayCount; i++) {
      const o = i * 4;
      origin.set(this._rayOriginArray[o], this._rayOriginArray[o + 1], this._rayOriginArray[o + 2]);
      direction.set(this._rayDirArray[o], this._rayDirArray[o + 1], this._rayDirArray[o + 2]);
      const hit = this._cpuReference.castRay({
        origin,
        direction,
        maxRangeM: this._rayOriginArray[o + 3],
        ignoreVehicle: this._vehicleById.get(this._rayDirArray[o + 3]) ?? null,
      });
      expected[i] = hit ? hit.distanceM : this._rayOriginArray[o + 3];
    }
    return expected;
  }

  // ---- benchmark -------------------------------------------------------------------

  /**
   * Time CPU vs GPU on identical synthetic rays (seeded, aimed at the live
   * proxy field). Returns and logs { rayCount, cpuMs, gpuMs, maxDeltaM }.
   */
  async runBenchmark(rayCount = 1024) {
    if (!this._supported) {
      console.warn('[GPUCast] unsupported — nothing to benchmark');
      return null;
    }
    rayCount = Math.min(rayCount, MAX_RAYS);
    this.beginFrame();
    this._rebuildProxyArrays(null, 1e9); // all statics + vehicles

    const random = mulberry32(9917);
    const proxyCount = Math.max(1, this._proxyCount);
    for (let i = 0; i < rayCount; i++) {
      const p = Math.floor(random() * proxyCount) * 4;
      const cx = this._proxyCenterArray[p];
      const cz = this._proxyCenterArray[p + 2];
      const angle = random() * Math.PI * 2;
      const distance = 3 + random() * 30;
      const ox = cx + Math.cos(angle) * distance;
      const oz = cz + Math.sin(angle) * distance;
      const len = Math.max(1e-6, Math.hypot(cx - ox, cz - oz));
      const o = i * 4;
      this._rayOriginArray[o] = ox;
      this._rayOriginArray[o + 1] = SENSOR.proximityOriginHeightM;
      this._rayOriginArray[o + 2] = oz;
      this._rayOriginArray[o + 3] = SENSOR.proximityMaxRangeM;
      this._rayDirArray[o] = (cx - ox) / len;
      this._rayDirArray[o + 1] = 0;
      this._rayDirArray[o + 2] = (cz - oz) / len;
      this._rayDirArray[o + 3] = -1;
    }

    let cpuMs = 0;
    if (this._cpuReference) {
      this._cpuReference.beginFrame();
      const started = performance.now();
      const expected = this._runValidationReference(rayCount);
      cpuMs = performance.now() - started;

      const device = this._device;
      const byteLength = rayCount * 16;
      const gpuStarted = performance.now();
      device.queue.writeBuffer(this._rayOriginBuffer, 0, this._rayOriginArray, 0, rayCount * 4);
      device.queue.writeBuffer(this._rayDirBuffer, 0, this._rayDirArray, 0, rayCount * 4);
      device.queue.writeBuffer(this._proxyCenterBuffer, 0, this._proxyCenterArray, 0, this._proxyCount * 4);
      device.queue.writeBuffer(this._proxyHalfBuffer, 0, this._proxyHalfArray, 0, this._proxyCount * 4);
      device.queue.writeBuffer(this._proxyMetaBuffer, 0, this._proxyMetaArray, 0, this._proxyCount * 4);
      this._paramsData[0] = rayCount;
      this._paramsData[1] = this._proxyCount;
      device.queue.writeBuffer(this._paramsBuffer, 0, this._paramsData);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(this._pipeline);
      pass.setBindGroup(0, this._bindGroup);
      pass.dispatchWorkgroups(Math.ceil(rayCount / WORKGROUP_SIZE));
      pass.end();
      encoder.copyBufferToBuffer(this._resultsBuffer, 0, this._benchStaging, 0, byteLength);
      device.queue.submit([encoder.finish()]);
      await this._benchStaging.mapAsync(GPUMapMode.READ);
      const view = new Float32Array(this._benchStaging.getMappedRange(0, byteLength));
      const results = view.slice();
      this._benchStaging.unmap();
      const gpuMs = performance.now() - gpuStarted;

      let maxDelta = 0;
      for (let i = 0; i < rayCount; i++) {
        maxDelta = Math.max(maxDelta, Math.abs(results[i * 4] - expected[i]));
      }
      console.info(
        `[GPUCast] benchmark ${rayCount} rays: CPU ${cpuMs.toFixed(2)} ms vs GPU ${gpuMs.toFixed(2)} ms ` +
        `(incl. readback) — max Δ ${maxDelta.toFixed(3)} m`
      );
      return { rayCount, cpuMs, gpuMs, maxDeltaM: maxDelta };
    }

    console.info(`[GPUCast] benchmark ${rayCount} rays: no CPU reference wired — GPU-only timing skipped`);
    return { rayCount, cpuMs, gpuMs: 0, maxDeltaM: null };
  }

  // ---- teardown ---------------------------------------------------------------------

  _fail(reason) {
    if (this._failed) return;
    this._failed = true;
    this._submissions = [];
    this._onDisabled?.(reason);
  }

  dispose() {
    this._fail('disposed');
    this._staticMeshes.clear();
    this._staticProxies = [];
    this._vehicleIds.clear();
    this._vehicleById.clear();
    this._submissions = [];
    try {
      this._device?.destroy();
    } catch {
      /* device may already be lost */
    }
    this._device = null;
    this._pipeline = null;
    this._bindGroup = null;
    this._staging = null;
    this._benchStaging = null;
  }
}