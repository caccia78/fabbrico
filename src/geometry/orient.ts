// Auto-orientation: choose which way down an object should print so it needs
// as little support as possible and sits on the bed with a good flat face.
// Runs in the geometry worker.
//
// Candidates are the directions of the convex hull's biggest faces (an object
// can only rest stably on its hull) plus the six axis directions. Each one is
// scored on the real mesh: estimated support volume, overhang area, contact
// area with the bed, and a small penalty for rotating far from the current pose.

import { Euler, Quaternion, Vector3 } from 'three';
import type { Manifold } from 'manifold-3d/manifold';
import { toTriangles } from './convert';

export interface OrientResult {
  /** New node rotation in degrees (X, Y, Z order as in Transform). */
  rotation: [number, number, number];
  /** Scores, for the record / the AI. */
  supportVolumeMm3: number;
  overhangAreaMm2: number;
  contactAreaMm2: number;
  /** Same values for the current orientation, to compare. */
  before: { supportVolumeMm3: number; overhangAreaMm2: number; contactAreaMm2: number };
}

interface Tri {
  nx: number; ny: number; nz: number; // unit normal
  area: number;
  cx: number; cy: number; cz: number; // centroid
}

const DEG = Math.PI / 180;

/** `world` is the node's geometry in world orientation (scale and rotation applied). */
export function orientForPrint(world: Manifold, rotationDeg: [number, number, number], overhangAngle: number): OrientResult {
  const { verts, tris } = toTriangles(world);
  const faces: Tri[] = [];
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
    const ux = verts[b] - verts[a], uy = verts[b + 1] - verts[a + 1], uz = verts[b + 2] - verts[a + 2];
    const vx = verts[c] - verts[a], vy = verts[c + 1] - verts[a + 1], vz = verts[c + 2] - verts[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) continue;
    faces.push({
      nx: nx / l, ny: ny / l, nz: nz / l, area: l / 2,
      cx: (verts[a] + verts[b] + verts[c]) / 3, cy: (verts[a + 1] + verts[b + 1] + verts[c + 1]) / 3, cz: (verts[a + 2] + verts[b + 2] + verts[c + 2]) / 3,
    });
  }
  const totalArea = faces.reduce((s, f) => s + f.area, 0) || 1;

  // Lowest point along a direction, from the vertices.
  const lowest = (dx: number, dy: number, dz: number) => {
    let m = Infinity;
    for (let i = 0; i < verts.length; i += 3) m = Math.min(m, -(verts[i] * dx + verts[i + 1] * dy + verts[i + 2] * dz));
    return m;
  };

  // `d` is the direction that will point down (towards the bed).
  const cosLimit = Math.cos((90 - overhangAngle - 0.5) * DEG);
  const evaluate = (dx: number, dy: number, dz: number) => {
    const h0 = lowest(dx, dy, dz);
    let support = 0, overhang = 0, contact = 0;
    for (const f of faces) {
      const down = f.nx * dx + f.ny * dy + f.nz * dz; // > 0: the face looks towards the bed
      if (down <= cosLimit) continue;
      const h = -(f.cx * dx + f.cy * dy + f.cz * dz) - h0;
      if (h < 0.05 && down > 0.999) {
        contact += f.area;
        continue;
      }
      overhang += f.area;
      support += f.area * down * h; // projected area × height above the bed
    }
    return { support, overhang, contact };
  };

  // Candidate directions: hull faces grouped by normal, biggest first.
  const hull = world.hull();
  const hm = toTriangles(hull);
  hull.delete();
  const groups: { n: Vector3; area: number }[] = [];
  for (let t = 0; t < hm.tris.length; t += 3) {
    const a = hm.tris[t] * 3, b = hm.tris[t + 1] * 3, c = hm.tris[t + 2] * 3;
    const u = new Vector3(hm.verts[b] - hm.verts[a], hm.verts[b + 1] - hm.verts[a + 1], hm.verts[b + 2] - hm.verts[a + 2]);
    const v = new Vector3(hm.verts[c] - hm.verts[a], hm.verts[c + 1] - hm.verts[a + 1], hm.verts[c + 2] - hm.verts[a + 2]);
    const n = u.cross(v);
    const area = n.length() / 2;
    if (area < 1e-9) continue;
    n.normalize();
    const g = groups.find((x) => x.n.dot(n) > 0.9995);
    if (g) g.area += area;
    else groups.push({ n, area });
  }
  groups.sort((x, y) => y.area - x.area);
  const candidates = groups.slice(0, 40).map((g) => g.n);
  for (const v of [[0, 0, -1], [0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]])
    if (!candidates.some((c) => c.dot(new Vector3(...v)) > 0.9995)) candidates.push(new Vector3(...v));

  const current = evaluate(0, 0, -1);
  let best = { d: new Vector3(0, 0, -1), score: Infinity, ...current };
  for (const d of candidates) {
    const r = evaluate(d.x, d.y, d.z);
    // Support volume dominates; overhang area and bed contact break ties
    // (more contact = better adhesion); prefer small rotations when equal.
    const turn = Math.acos(Math.max(-1, Math.min(1, -d.z))); // angle from the current "down"
    const scale = Math.sqrt(totalArea);
    const score = r.support + scale * (r.overhang - 0.5 * r.contact) + 0.01 * scale * totalArea * turn / Math.PI;
    if (score < best.score) best = { d, score, ...r };
  }

  // Rotate so that `d` points down, on top of the current rotation.
  const align = new Quaternion().setFromUnitVectors(best.d.clone().normalize(), new Vector3(0, 0, -1));
  // Spin about Z (free once the bottom is chosen) to the smallest footprint, so
  // boxy parts end up square to the bed axes instead of at an arbitrary angle.
  const pts: Vector3[] = [];
  for (let i = 0; i < hm.verts.length; i += 3) pts.push(new Vector3(hm.verts[i], hm.verts[i + 1], hm.verts[i + 2]).applyQuaternion(align));
  const footprint = (deg: number) => {
    const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of pts) {
      const x = p.x * c - p.y * s, y = p.x * s + p.y * c;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return (x1 - x0) * (y1 - y0);
  };
  const yaws: { deg: number; area: number }[] = [];
  for (let deg = -90; deg < 90; deg += 0.5) yaws.push({ deg, area: footprint(deg) });
  const minArea = Math.min(...yaws.map((y) => y.area));
  // Among footprints within 1% of the smallest, turn as little as possible (round parts stay put).
  const bestYaw = yaws.filter((y) => y.area <= minArea * 1.01).sort((a, b) => Math.abs(a.deg) - Math.abs(b.deg))[0].deg;
  const spin = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), bestYaw * DEG);
  const q0 = new Quaternion().setFromEuler(new Euler(rotationDeg[0] * DEG, rotationDeg[1] * DEG, rotationDeg[2] * DEG, 'ZYX'));
  const e = new Euler().setFromQuaternion(spin.multiply(align).multiply(q0), 'ZYX');
  const r2 = (v: number) => Math.round(v * 100) / 100;
  // Snap tiny numerical noise to round angles (e.g. 90.09° -> 90°).
  const clean = (deg: number) => {
    const snapped = Math.round(deg / 45) * 45;
    const v = Math.abs(deg - snapped) < 0.25 ? snapped : r2(deg);
    return Object.is(v, -0) || Math.abs(v) < 0.005 ? 0 : v;
  };
  return {
    rotation: [clean(e.x / DEG), clean(e.y / DEG), clean(e.z / DEG)],
    supportVolumeMm3: Math.round(best.support),
    overhangAreaMm2: Math.round(best.overhang),
    contactAreaMm2: Math.round(best.contact),
    before: {
      supportVolumeMm3: Math.round(current.support),
      overhangAreaMm2: Math.round(current.overhang),
      contactAreaMm2: Math.round(current.contact),
    },
  };
}
