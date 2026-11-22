// Main-thread side of the geometry worker.
//
// Requests are queued here and sent to the worker one at a time, so a request
// that is superseded while waiting (e.g. the same object re-edited while a
// slider is dragged) is dropped without being computed. A build that takes too
// long can be cancelled: the worker is terminated and restarted (its cache is
// lost, everything else keeps working).

import { create } from 'zustand';
import { localGeometryKey, meshAssetsOf, type SceneNode, type Transform } from '../model/schema';
import { getAsset } from '../model/assets';
import type { AnalyzeOpts } from './analysis';
import type { MeshData } from './convert';
import type { ThicknessData } from './thickness';
import type { GeometryRequest, GeometryResponse, GeometryResults } from './protocol';

/** Thrown for requests dropped because a newer one replaced them, or cancelled by the user. */
export class GeometryCancelled extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'GeometryCancelled';
  }
}

interface Job {
  id: number;
  req: GeometryRequest;
  /** Jobs sharing a slot replace each other while queued. */
  slot?: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

interface Status {
  /** A request is running or queued. */
  busy: boolean;
  /** When the request now running started (ms), so the UI can offer Cancel on slow ones. */
  since: number;
}
export const useGeometryStatus = create<Status>(() => ({ busy: false, since: 0 }));

let worker: Worker | null = null;
let nextId = 1;
let running: Job | null = null;
let queue: Job[] = [];
let idleWaiters: (() => void)[] = [];

function spawn(): Worker {
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<GeometryResponse>) => {
    const job = running;
    if (!job || job.id !== e.data.id) return;
    running = null;
    if (e.data.ok) job.resolve(e.data.result);
    else job.reject(new Error(e.data.error));
    pump();
  };
  w.onerror = (e) => {
    e.preventDefault();
    const job = running;
    running = null;
    restart();
    job?.reject(new Error(`Geometry engine crashed: ${e.message || 'unknown error'}`));
    pump();
  };
  return w;
}

function restart() {
  worker?.terminate();
  worker = spawn();
  sentAssets = new Set();
}

function updateStatus(jobStarted = false) {
  const busy = !!running || queue.length > 0;
  const prev = useGeometryStatus.getState();
  if (busy !== prev.busy || jobStarted) useGeometryStatus.setState({ busy, since: busy ? performance.now() : 0 });
  if (!busy) {
    const w = idleWaiters;
    idleWaiters = [];
    for (const f of w) f();
  }
}

/** Imported meshes the current worker already has. */
let sentAssets = new Set<string>();

function nodesOf(req: GeometryRequest): SceneNode[] {
  return 'node' in req ? [req.node] : 'nodes' in req ? req.nodes : [];
}

function pump() {
  let started = false;
  if (!running && queue.length) {
    running = queue.shift()!;
    worker ??= spawn();
    // Send any imported mesh this request needs and the worker doesn't have yet.
    for (const id of meshAssetsOf(nodesOf(running.req))) {
      if (sentAssets.has(id)) continue;
      const asset = getAsset(id);
      if (!asset) continue; // the kernel reports it as missing
      worker.postMessage({ id: 0, req: { op: 'asset', id, asset } });
      sentAssets.add(id);
    }
    worker.postMessage({ id: running.id, req: running.req });
    started = true;
  }
  updateStatus(started);
}

function request<Op extends GeometryRequest['op']>(
  req: Extract<GeometryRequest, { op: Op }>,
  slot?: string,
): Promise<GeometryResults[Op]> {
  return new Promise((resolve, reject) => {
    if (slot) {
      queue = queue.filter((j) => {
        if (j.slot !== slot) return true;
        j.reject(new GeometryCancelled('superseded'));
        return false;
      });
    }
    queue.push({ id: nextId++, req, slot, resolve: resolve as (v: unknown) => void, reject });
    pump();
  });
}

// ------------------------------------------------------------ mesh cache ----

// Meshes by geometry key, so undo/redo and remounts show results instantly.
const meshCache = new Map<string, MeshData>();
const MESH_CACHE_SIZE = 60;

/** The cache key of a node's local geometry (what the worker builds). */
export const geometryKey = localGeometryKey;

export function cachedMesh(key: string): MeshData | undefined {
  const hit = meshCache.get(key);
  if (hit) {
    meshCache.delete(key);
    meshCache.set(key, hit);
  }
  return hit;
}

const thicknessCache = new Map<string, ThicknessData>();
/** Thickness depends on the geometry and the node's scale. */
export const thicknessKey = (node: SceneNode) => JSON.stringify([localGeometryKey(node), node.transform.scale]);

// ---------------------------------------------------------------- public ----

export const geometry = {
  /** Start the worker and load the WASM kernel. */
  init: () => request({ op: 'init' }),

  /** Render mesh of a node in its local frame. `slot` (usually the node id) lets newer edits replace queued ones. */
  async mesh(node: SceneNode, slot?: string): Promise<MeshData> {
    const key = geometryKey(node);
    const hit = cachedMesh(key);
    if (hit) return hit;
    const data = await request({ op: 'mesh', node }, slot && `mesh:${slot}`);
    meshCache.set(key, data);
    if (meshCache.size > MESH_CACHE_SIZE) meshCache.delete(meshCache.keys().next().value!);
    return data;
  },

  /** Wall thickness per triangle of a node, in its local frame. */
  async thickness(node: SceneNode, slot?: string): Promise<ThicknessData> {
    const key = thicknessKey(node);
    const hit = thicknessCache.get(key);
    if (hit) return hit;
    const data = await request({ op: 'thickness', node }, slot && `thickness:${slot}`);
    thicknessCache.set(key, data);
    if (thicknessCache.size > 20) thicknessCache.delete(thicknessCache.keys().next().value!);
    return data;
  },

  /** World-space bounding box of a node; throws if it fails to build. */
  bounds: (node: SceneNode) => request({ op: 'bounds', node }),

  /** Best rotation of a node for printing (least support, good bed contact). */
  orient: (node: SceneNode, overhangAngle: number) => request({ op: 'orient', node, overhangAngle }),

  /** Cross-section of a node at world height z (default: mid-height), optionally offset, in world coordinates. */
  outline: (node: SceneNode, ancestors: Transform[], opts: { z?: number; offset?: number; tolerance?: number } = {}) =>
    request({ op: 'outline', node, ancestors, z: opts.z, offset: opts.offset ?? 0, tolerance: opts.tolerance ?? 0.1 }),

  analyze: (nodes: SceneNode[], opts: AnalyzeOpts) => request({ op: 'analyze', nodes, opts }),

  /** The printable model as a 3MF or STL file. */
  exportBytes: (nodes: SceneNode[], format: '3mf' | 'stl') => request({ op: 'export', nodes, format }),

  async download(nodes: SceneNode[], format: '3mf' | 'stl', baseName = 'model') {
    const bytes = await request({ op: 'export', nodes, format });
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: `model/${format}` }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName.replace(/[\\/:*?"<>|]+/g, '-') || 'model'}.${format}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  /** Resolves once nothing is running or queued. */
  idle(): Promise<void> {
    if (!running && !queue.length) return Promise.resolve();
    return new Promise((r) => idleWaiters.push(r));
  },

  /** Abort everything: terminate the worker (losing its cache) and reject all pending requests. */
  cancel() {
    const jobs = [...(running ? [running] : []), ...queue];
    running = null;
    queue = [];
    restart();
    for (const j of jobs) j.reject(new GeometryCancelled('Cancelled'));
    void request({ op: 'init' }).catch(() => {});
    updateStatus();
  },
};
