// Printability checks. Each issue is phrased so it can be shown to the user
// AND handed to the AI as something to fix. Runs in the geometry worker.

import type { Manifold } from 'manifold-3d/manifold';
import type { SceneNode } from '../model/schema';
import { buildPrintable, buildWorld } from './kernel';
import { toTriangles } from './convert';
import { computeThickness } from './thickness';

export interface Issue {
  level: 'error' | 'warning' | 'info';
  message: string;
  objectId?: string;
}

export interface AnalyzeOpts {
  bed: [number, number, number];
  overhangAngle: number;
  nozzle: number;
}

export interface PrintReport {
  ok: boolean;
  size: [number, number, number];
  volumeCm3: number;
  massPlaG: number;
  triangles: number;
  parts: number;
  overhangPercent: number;
  /** Thinnest wall found (mm), null if none could be measured. */
  minWallMm: number | null;
  issues: Issue[];
}

const r1 = (v: number) => Math.round(v * 10) / 10;

export function analyze(nodes: SceneNode[], opts: AnalyzeOpts): PrintReport {
  const issues: Issue[] = [];
  const solids = nodes.filter((n) => !n.hole);
  if (!solids.length) {
    return {
      ok: false, size: [0, 0, 0], volumeCm3: 0, massPlaG: 0, triangles: 0, parts: 0, overhangPercent: 0, minWallMm: null,
      issues: [{ level: 'error', message: 'Scene is empty: nothing to print.' }],
    };
  }

  // Per-object checks (world boxes are kept to tell which object a thin wall belongs to).
  const boxes: { node: SceneNode; min: number[]; max: number[] }[] = [];
  for (const n of solids) {
    try {
      const m = buildWorld(n);
      const empty = m.isEmpty();
      const b = m.boundingBox();
      boxes.push({ node: n, min: b.min, max: b.max });
      m.delete();
      if (empty) issues.push({ level: 'error', objectId: n.id, message: `"${n.name}" has no volume.` });
    } catch (e) {
      issues.push({ level: 'error', objectId: n.id, message: `"${n.name}" failed to build: ${(e as Error).message}` });
    }
  }

  const m = buildPrintable(nodes);
  const status = m.status();
  if (status !== 'NoError') issues.push({ level: 'error', message: `Geometry error: ${status}` });

  const bb = m.boundingBox();
  const size: [number, number, number] = [
    bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2],
  ];
  const [bx, by, bz] = opts.bed;
  if (size[0] > bx || size[1] > by || size[2] > bz)
    issues.push({ level: 'error', message: `Model ${size.map(r1).join(' × ')} mm does not fit the bed ${bx} × ${by} × ${bz} mm.` });
  if (bb.min[2] < -0.01)
    issues.push({ level: 'error', message: `Model goes ${r1(-bb.min[2])} mm below the bed (z < 0). Use "Drop to bed" or raise it.` });
  if (bb.min[2] > 0.01)
    issues.push({ level: 'warning', message: `Model floats ${r1(bb.min[2])} mm above the bed: it would need supports from the first layer.` });

  const parts = m.decompose();
  const partCount = parts.length;
  for (const p of parts) p.delete();
  if (partCount > 1)
    issues.push({ level: 'info', message: `${partCount} separate parts. Fine if intended (printed side by side); otherwise make them overlap.` });

  // Overhangs: downward-facing area steeper than the threshold, ignoring the bed face.
  const { verts, tris } = toTriangles(m);
  // Half a degree of tolerance, so a face at exactly the limit (e.g. a 45° chamfer) does not count as overhang.
  const cosLimit = Math.cos(((90 - opts.overhangAngle - 0.5) * Math.PI) / 180);
  let total = 0, over = 0;
  // Faces on the bed don't overhang. If part of the model sinks below z = 0 (reported above as an
  // error), faces resting at z = 0 still count as on the bed.
  const zBed = Math.max(bb.min[2], 0) + 0.05;
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
    const ux = verts[b] - verts[a], uy = verts[b + 1] - verts[a + 1], uz = verts[b + 2] - verts[a + 2];
    const vx = verts[c] - verts[a], vy = verts[c + 1] - verts[a + 1], vz = verts[c + 2] - verts[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const area2 = Math.hypot(nx, ny, nz);
    if (!area2) continue;
    total += area2;
    const onBed = verts[a + 2] < zBed && verts[b + 2] < zBed && verts[c + 2] < zBed;
    if (!onBed && -nz / area2 > cosLimit) over += area2;
  }
  const overhangPercent = total ? (over / total) * 100 : 0;
  if (overhangPercent > 2)
    issues.push({
      level: overhangPercent > 15 ? 'warning' : 'info',
      message: `${r1(overhangPercent)}% of the surface overhangs more than ${opts.overhangAngle}°: needs supports or a different orientation.`,
    });

  const minWallMm = checkWalls(m, opts.nozzle, boxes, issues);

  const volumeCm3 = m.volume() / 1000;
  const triangles = m.numTri();
  m.delete();

  return {
    ok: !issues.some((i) => i.level === 'error'),
    size: size.map(r1) as [number, number, number],
    volumeCm3: r1(volumeCm3),
    massPlaG: r1(volumeCm3 * 1.24),
    triangles,
    parts: partCount,
    overhangPercent: r1(overhangPercent),
    minWallMm,
    issues,
  };
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Wall thickness: thinner than the nozzle won't print at all (the slicer drops
 * it), under 2 × nozzle is fragile, under 3 × nozzle (our minimum wall) is weak.
 */
function checkWalls(
  m: Manifold,
  nozzle: number,
  boxes: { node: SceneNode; min: number[]; max: number[] }[],
  issues: Issue[],
): number | null {
  const { position, thickness, area } = computeThickness(m, { maxTris: 250_000, minLength: Math.max(0.3, nozzle) });
  const levels = [
    { below: nozzle, level: 'warning' as const, minArea: 0.5, text: `thinner than the nozzle (${nozzle} mm): the slicer will drop it or print it badly` },
    { below: 2 * nozzle, level: 'warning' as const, minArea: 1, text: `thinner than 2 × nozzle (${r2(2 * nozzle)} mm): fragile` },
    { below: 3 * nozzle, level: 'info' as const, minArea: 2, text: `thinner than 3 × nozzle (${r2(3 * nozzle)} mm): may be weak` },
  ];
  // Per object (by world box; -1 = none), per level: area, thinnest value and where.
  const owners = [...boxes.map((b) => b.node), null];
  const stats = owners.map(() => levels.map(() => ({ area: 0, min: Infinity, at: -1 })));
  let min = Infinity;
  for (let t = 0; t < thickness.length; t++) {
    const th = thickness[t];
    if (!isFinite(th)) continue;
    if (th < min) min = th;
    const k = levels.findIndex((l) => th < l.below);
    if (k < 0) continue;
    const o = t * 9;
    const cx = (position[o] + position[o + 3] + position[o + 6]) / 3;
    const cy = (position[o + 1] + position[o + 4] + position[o + 7]) / 3;
    const cz = (position[o + 2] + position[o + 5] + position[o + 8]) / 3;
    let owner = boxes.findIndex(
      (b) => cx >= b.min[0] - 0.01 && cx <= b.max[0] + 0.01 && cy >= b.min[1] - 0.01 && cy <= b.max[1] + 0.01 && cz >= b.min[2] - 0.01 && cz <= b.max[2] + 0.01,
    );
    if (owner < 0) owner = boxes.length;
    const st = stats[owner][k];
    st.area += area[t];
    if (th < st.min) {
      st.min = th;
      st.at = t;
    }
  }
  // One issue per object: its most severe level with a meaningful area.
  owners.forEach((owner, i) => {
    const k = levels.findIndex((l, j) => stats[i][j].area >= l.minArea);
    if (k < 0) return;
    const st = stats[i][k];
    const o = st.at * 9;
    const p = [0, 1, 2].map((j) => (position[o + j] + position[o + 3 + j] + position[o + 6 + j]) / 3);
    issues.push({
      level: levels[k].level,
      objectId: owner?.id,
      message:
        `${r1(st.area)} mm² of ${owner ? `"${owner.name}"` : 'the model'} is ${levels[k].text}. ` +
        `Thinnest ${r2(st.min)} mm near (${p.map(r1).join(', ')}). Use the Thickness view to see where.`,
    });
  });
  return isFinite(min) ? r2(min) : null;
}
