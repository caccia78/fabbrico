// Geometry worker: owns the Manifold WASM kernel and its cache, so heavy
// builds (SDF, displacement, round) never freeze the UI. The main thread talks
// to it through client.ts; one request is processed at a time.

import { applyTransform, buildLocal, buildWorld, initKernel } from './kernel';
import { analyze } from './analysis';
import { build3MF, buildSTL } from './export';
import { toMeshData } from './convert';
import { computeThickness } from './thickness';
import { prepareImages } from './image';
import { registerMesh } from './meshAssets';
import { orientForPrint } from './orient';
import type { GeometryRequest, GeometryResponse } from './protocol';

import { registerFont } from './text';
import { FONT_URLS } from './fontUrls';
import type { FontName } from '../model/schema';

async function loadFonts() {
  await Promise.all(
    Object.entries(FONT_URLS).map(async ([name, url]) => registerFont(name as FontName, await (await fetch(url)).json())),
  );
}

const ready = Promise.all([initKernel(), loadFonts()]);

function run(req: GeometryRequest): { result: unknown; transfer?: Transferable[] } {
  switch (req.op) {
    case 'init':
      return { result: true };
    case 'asset':
      registerMesh(req.id, req.asset);
      return { result: true };
    case 'mesh': {
      const data = toMeshData(buildLocal(req.node));
      const transfer: Transferable[] = [data.position.buffer, data.index.buffer];
      if (data.normal) transfer.push(data.normal.buffer);
      return { result: data, transfer };
    }
    case 'bounds': {
      const m = buildWorld(req.node);
      const b = m.boundingBox();
      const empty = m.isEmpty();
      m.delete();
      return { result: { min: b.min, max: b.max, empty } };
    }
    case 'thickness': {
      // Distances need the node's scale (rotation and position don't change them).
      const scale = req.node.transform.scale;
      const scaled = buildLocal(req.node).scale(scale);
      const data = computeThickness(scaled, { maxTris: 150_000, minLength: 0.3 });
      scaled.delete();
      const p = data.position;
      for (let i = 0; i < p.length; i += 3) {
        p[i] /= scale[0] || 1;
        p[i + 1] /= scale[1] || 1;
        p[i + 2] /= scale[2] || 1;
      }
      return { result: data, transfer: [data.position.buffer, data.thickness.buffer, data.area.buffer] };
    }
    case 'orient': {
      const t = req.node.transform;
      const scaled = buildLocal(req.node).scale(t.scale);
      const world = scaled.rotate(t.rotation);
      scaled.delete();
      const result = orientForPrint(world, t.rotation, req.overhangAngle);
      world.delete();
      return { result };
    }
    case 'outline': {
      // Into world space through the parent groups (innermost first).
      let m = buildWorld(req.node);
      for (const t of req.ancestors) {
        const next = applyTransform(m, t);
        m.delete();
        m = next;
      }
      const bb = m.boundingBox();
      if (m.isEmpty()) {
        m.delete();
        throw new Error('The object has no volume');
      }
      const z = req.z ?? (bb.min[2] + bb.max[2]) / 2;
      if (z <= bb.min[2] || z >= bb.max[2])
        throw new Error(`z = ${z} is outside the object (it spans z ${bb.min[2].toFixed(2)} to ${bb.max[2].toFixed(2)})`);
      const slice = m.slice(z);
      m.delete();
      let cs = slice;
      if (req.offset) {
        cs = slice.offset(req.offset, 'Round', 2, 32);
        slice.delete();
      }
      const simple = cs.simplify(Math.max(1e-6, req.tolerance));
      cs.delete();
      const r = (v: number) => Math.round(v * 100) / 100;
      const contours = simple.toPolygons().map((poly) => poly.map(([x, y]) => [r(x), r(y)] as [number, number]));
      const area = simple.area();
      const b = simple.bounds();
      simple.delete();
      if (!contours.length) throw new Error('Nothing left at that height (or the offset removed everything)');
      return { result: { z: r(z), contours, area: r(area), bounds: { min: [r(b.min[0]), r(b.min[1])], max: [r(b.max[0]), r(b.max[1])] } } };
    }
    case 'analyze':
      return { result: analyze(req.nodes, req.opts) };
    case 'export': {
      const bytes = req.format === '3mf' ? build3MF(req.nodes) : new Uint8Array(buildSTL(req.nodes));
      return { result: bytes, transfer: [bytes.buffer] };
    }
  }
}

self.onmessage = async (e: MessageEvent<{ id: number; req: GeometryRequest }>) => {
  const { id, req } = e.data;
  let msg: GeometryResponse;
  let transfer: Transferable[] = [];
  try {
    await ready;
    if ('node' in req) await prepareImages([req.node]);
    else if ('nodes' in req) await prepareImages(req.nodes);
    const out = run(req);
    msg = { id, ok: true, result: out.result };
    transfer = out.transfer ?? [];
  } catch (err) {
    msg = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  (self as unknown as Worker).postMessage(msg, transfer);
};
