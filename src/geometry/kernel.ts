// Geometry kernel: turns scene nodes into watertight Manifold solids.
// Manifold guarantees manifold (printable) output for every boolean, which is
// the foundation of the "always printable" promise.

import Module from 'manifold-3d/manifold';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import type { Manifold, ManifoldToplevel, Vec3 as MVec3 } from 'manifold-3d/manifold';
import { localGeometryKey, type FaceRegion, type LeafShape, type Modifier, type SceneNode, type Transform } from '../model/schema';
import { compileExpr } from './expr';
import { fbm3, cells3 } from './noise';
import { textCrossSection } from './text';
import { imageSolid } from './image';
import { meshAsset } from './meshAssets';

let wasm: ManifoldToplevel | null = null;

export async function initKernel(): Promise<ManifoldToplevel> {
  if (wasm) return wasm;
  const m = await Module({ locateFile: () => wasmUrl });
  m.setup();
  m.setMinCircularEdgeLength(0.8);
  m.setMinCircularAngle(6);
  wasm = m;
  return m;
}

export function kernel(): ManifoldToplevel {
  if (!wasm) throw new Error('Geometry kernel not initialised');
  return wasm;
}

const MAX_TRIS = 600_000;

// ------------------------------------------------------------ primitives ----

function signedArea(pts: [number, number][]) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}
const ccw = (pts: [number, number][]) => (signedArea(pts) < 0 ? [...pts].reverse() : pts);
const segs = (n: number) => (n && n >= 3 ? Math.round(n) : undefined);

function buildLeaf(shape: LeafShape): Manifold {
  const { Manifold, CrossSection } = kernel();
  switch (shape.kind) {
    case 'box': {
      const [x, y, z] = shape.size;
      return Manifold.cube([x, y, z], false).translate([-x / 2, -y / 2, 0]);
    }
    case 'cylinder':
      return Manifold.cylinder(shape.height, shape.radius, Math.max(0, shape.radiusTop), segs(shape.segments), false);
    case 'sphere':
      return Manifold.sphere(shape.radius, segs(shape.segments)).translate([0, 0, shape.radius]);
    case 'torus': {
      const cs = CrossSection.circle(shape.minorRadius, segs(shape.segments)).translate([shape.majorRadius, 0]);
      return Manifold.revolve(cs, segs(shape.segments)).translate([0, 0, shape.minorRadius]);
    }
    case 'polygon': {
      if (shape.points.length < 3) throw new Error('Polygon needs at least 3 points');
      const cs = new CrossSection([ccw(shape.points)]);
      const div = Math.ceil(Math.abs(shape.twist) / 5);
      // Pass scaleTop as [x, y]: manifold-3d 3.5 turns a plain number n into
      // [n, 0], which flattens the top face onto the X axis.
      const st = Math.max(0, shape.scaleTop);
      return Manifold.extrude(cs, shape.height, div, shape.twist, [st, st]);
    }
    case 'revolve': {
      if (shape.profile.length < 3) throw new Error('Profile needs at least 3 points');
      const pts = shape.profile.map(([r, z]) => [Math.max(0, r), z] as [number, number]);
      return Manifold.revolve(new CrossSection([ccw(pts)]), segs(shape.segments), shape.degrees || 360);
    }
    case 'image':
      return imageSolid(kernel(), shape);
    case 'sketch': {
      if (!shape.contours.length) throw new Error('The sketch has no outline');
      if (shape.height <= 0) throw new Error('Sketch height must be positive');
      const raw = new CrossSection(shape.contours, 'EvenOdd');
      // Contours follow the inner edge of the traced line: move them to the line's
      // centre, then in by the pen offset (the pen runs outside the real edge).
      const cs = raw.offset(shape.strokeRadius - shape.penOffset, 'Round', 2, 16);
      raw.delete();
      if (cs.isEmpty()) {
        cs.delete();
        throw new Error('Pen offset too large: nothing is left of the outline');
      }
      const m = Manifold.extrude(cs, shape.height);
      cs.delete();
      return m;
    }
    case 'mesh': {
      const a = meshAsset(shape.asset);
      if (!a) throw new Error('Imported mesh data is missing (re-import the file)');
      const { Mesh } = kernel();
      const mesh = new Mesh({ numProp: 3, vertProperties: a.positions, triVerts: a.indices });
      mesh.merge();
      let m: Manifold;
      try {
        m = new Manifold(mesh);
      } catch {
        throw new Error(
          'The imported mesh is not a closed, watertight solid (holes or self-overlapping parts), so Fabbrico cannot use it. ' +
            'Repair it first (e.g. in PrusaSlicer / Bambu Studio "Fix model", Meshmixer or Blender 3D-Print Toolbox) and import it again.',
        );
      }
      if (m.status() !== 'NoError') throw new Error(`The imported mesh is invalid (${m.status()})`);
      return m;
    }
    case 'text': {
      if (shape.height <= 0) throw new Error('Text height must be positive');
      const cs = textCrossSection(kernel(), shape);
      const m = Manifold.extrude(cs, shape.height);
      cs.delete();
      return m;
    }
    case 'sdf': {
      const f = compileExpr(shape.expression);
      const min = shape.boundsMin, max = shape.boundsMax;
      const vol = Math.abs((max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]));
      // Keep the grid bounded so a careless resolution cannot freeze the tab.
      const res = Math.max(shape.resolution || 1, Math.cbrt((vol * 2) / 1_500_000), 0.2);
      const scope = { x: 0, y: 0, z: 0 };
      const m = Manifold.levelSet(
        (p: MVec3) => {
          scope.x = p[0];
          scope.y = p[1];
          scope.z = p[2];
          return f(scope);
        },
        { min, max },
        res,
      );
      if (m.isEmpty()) throw new Error('SDF produced an empty solid: check the expression sign (positive inside) and bounds');
      return m;
    }
  }
}

// ------------------------------------------------------------- modifiers ----

function bounds(m: Manifold) {
  const b = m.boundingBox();
  return {
    xmin: b.min[0], ymin: b.min[1], zmin: b.min[2],
    xmax: b.max[0], ymax: b.max[1], zmax: b.max[2],
  };
}

/** Refine so that deformations have enough vertices to bend smoothly. */
function refineFor(m: Manifold, length: number): Manifold {
  const area = m.surfaceArea();
  let l = Math.max(length, 0.15);
  // Each triangle of edge l covers ~0.43 l^2.
  while (area / (0.43 * l * l) > MAX_TRIS) l *= 1.25;
  return m.refineToLength(l);
}

function autoLength(m: Manifold) {
  const b = bounds(m);
  return Math.max(b.xmax - b.xmin, b.ymax - b.ymin, b.zmax - b.zmin) / 40;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const tri = (u: number) => Math.abs(2 * (u - Math.floor(u)) - 1);

function displace(m: Manifold, mod: Extract<Modifier, { type: 'displace' }>): Manifold {
  const { Manifold: M, Mesh } = kernel();
  const refined = refineFor(m, mod.resolution || autoLength(m));
  const mesh = refined.getMesh();
  const np = mesh.numProp;
  const vp = mesh.vertProperties;
  const nv = vp.length / np;

  // Canonical vertex per position (duplicates exist across property seams).
  const canon = new Uint32Array(nv);
  for (let i = 0; i < nv; i++) canon[i] = i;
  for (let i = 0; i < mesh.mergeFromVert.length; i++) canon[mesh.mergeFromVert[i]] = mesh.mergeToVert[i];

  // Area-weighted smooth normals on canonical vertices.
  const nrm = new Float64Array(nv * 3);
  const tv = mesh.triVerts;
  for (let t = 0; t < tv.length; t += 3) {
    const a = canon[tv[t]], b = canon[tv[t + 1]], c = canon[tv[t + 2]];
    const ax = vp[a * np], ay = vp[a * np + 1], az = vp[a * np + 2];
    const ux = vp[b * np] - ax, uy = vp[b * np + 1] - ay, uz = vp[b * np + 2] - az;
    const vx = vp[c * np] - ax, vy = vp[c * np + 1] - ay, vz = vp[c * np + 2] - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) {
      nrm[k * 3] += nx;
      nrm[k * 3 + 1] += ny;
      nrm[k * 3 + 2] += nz;
    }
  }

  const b = bounds(refined);
  const cx = (b.xmin + b.xmax) / 2, cy = (b.ymin + b.ymax) / 2;
  const rAvg = Math.max(1e-3, ((b.xmax - b.xmin) + (b.ymax - b.ymin)) / 4);
  const P = Math.max(0.05, mod.period);
  const k = (2 * Math.PI) / P;
  const N = Math.max(3, Math.round((2 * Math.PI * rAvg) / P));
  const custom = mod.pattern === 'expression' && mod.expression ? compileExpr(mod.expression) : null;
  const scope: Record<string, number> = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0 };
  const bedFade = Math.max(Math.abs(mod.amplitude) * 3, (mod.resolution || 1) * 2, 1);

  const pattern = (x: number, y: number, z: number, nx: number, ny: number, nz: number): number => {
    const th = Math.atan2(y - cy, x - cx);
    switch (mod.pattern) {
      case 'noise':
        return fbm3(x / P, y / P, z / P);
      case 'waves':
        return Math.sin(k * z);
      case 'ribs':
        return Math.cos(th * N);
      case 'knurl': {
        const u1 = (th * N) / (2 * Math.PI) + z / P;
        const u2 = (th * N) / (2 * Math.PI) - z / P;
        return 2 * Math.min(tri(u1), tri(u2)) - 1;
      }
      case 'bumps':
        return Math.sin(k * x) * Math.sin(k * y) * Math.sin(k * z) * 2.5;
      case 'cells':
        return 1 - 2 * Math.min(1, cells3(x / P, y / P, z / P));
      case 'expression':
        if (!custom) return 0;
        scope.x = x; scope.y = y; scope.z = z; scope.nx = nx; scope.ny = ny; scope.nz = nz;
        return custom(scope);
    }
  };

  let region: Float32Array | null = null;
  if (mod.faces === 'picked') {
    if (!mod.region) throw new Error('Pick a face for this texture (faces: picked)');
    region = regionWeights(vp, np, tv, canon, nv, mod.region);
  }

  const out = new Float32Array(vp);
  const done = new Uint8Array(nv);
  for (let i = 0; i < nv; i++) {
    const c = canon[i];
    if (!done[c]) {
      done[c] = 1;
      let nx = nrm[c * 3], ny = nrm[c * 3 + 1], nz = nrm[c * 3 + 2];
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      const x = vp[c * np], y = vp[c * np + 1], z = vp[c * np + 2];
      let w = 1;
      if (region) w = region[c];
      else if (mod.faces === 'top') w = smoothstep(0.4, 0.85, nz);
      else if (mod.faces === 'bottom') w = smoothstep(0.4, 0.85, -nz);
      else if (mod.faces === 'sides') w = 1 - smoothstep(0.4, 0.85, Math.abs(nz));
      // Keep a flat first layer: no displacement on the bed, fading in smoothly
      // above it (a hard cut leaves a ragged skirt at the base).
      w *= smoothstep(0, bedFade, z - b.zmin);
      const d = w === 0 ? 0 : w * mod.amplitude * Math.max(-1.5, Math.min(1.5, pattern(x, y, z, nx, ny, nz)));
      out[c * np] = x + nx * d;
      out[c * np + 1] = y + ny * d;
      out[c * np + 2] = z + nz * d;
    }
  }
  // Duplicated vertices (property seams) follow their canonical position.
  for (let i = 0; i < nv; i++) {
    const c = canon[i];
    if (c !== i) {
      out[i * np] = out[c * np];
      out[i * np + 1] = out[c * np + 1];
      out[i * np + 2] = out[c * np + 2];
    }
  }

  const newMesh = new Mesh({
    numProp: np,
    vertProperties: out,
    triVerts: mesh.triVerts,
    mergeFromVert: mesh.mergeFromVert,
    mergeToVert: mesh.mergeToVert,
  });
  return new M(newMesh);
}

/**
 * Chamfer = morphological opening (erode, then dilate) with a 45° cone:
 * convex edges get a 45° bevel of the given size, concave ones stay sharp and
 * the outer size is kept. The cone points up to bevel top edges, down for
 * bottom edges, both ways (bicone) for both. For axis-aligned outlines a
 * square pyramid keeps vertical edges sharp; "all" then uses an octahedron,
 * which bevels the vertical edges too.
 */
function chamfer(m: Manifold, mod: Extract<Modifier, { type: 'chamfer' }>, axisAligned: boolean): Manifold {
  const { Manifold: M } = kernel();
  const r = mod.size;
  if (r <= 0) return m;
  const square = axisAligned;
  const seg = square ? 4 : 24;
  // A 4-segment "cylinder" is a diamond; turned 45° and widened by √2 it is a square of half-side r.
  const turn = square && mod.edges !== 'all';
  const base = turn ? r * Math.SQRT2 : r;
  const parts: Manifold[] = [];
  if (mod.edges !== 'bottom') parts.push(M.cylinder(r, base, 0, seg, false));
  if (mod.edges !== 'top') parts.push(M.cylinder(r, 0, base, seg, false).translate([0, 0, -r]));
  const joined = parts.length > 1 ? M.union(parts) : parts[0];
  const tool = turn ? joined.rotate([0, 0, 45]) : joined;
  const mirrored = tool.scale([-1, -1, -1]);
  // minkowskiDifference(K) keeps p where p - K fits inside, so erode with the mirrored tool.
  const eroded = m.minkowskiDifference(mirrored);
  try {
    if (eroded.isEmpty()) throw new Error('Chamfer size too large for this object');
    return eroded.minkowskiSum(tool);
  } finally {
    for (const x of new Set([...parts, joined, tool, mirrored, eroded])) x.delete();
  }
}

/** Hull of a set of points given as flat xyz triples. */
function pointsOf(m: Manifold): [number, number, number][] {
  const mesh = m.getMesh();
  const np = mesh.numProp;
  const out: [number, number, number][] = [];
  for (let i = 0; i < mesh.vertProperties.length; i += np)
    out.push([mesh.vertProperties[i], mesh.vertProperties[i + 1], mesh.vertProperties[i + 2]]);
  return out;
}

/**
 * Teardrop: extend the (convex hull of the) shape upwards with roofs no steeper
 * than the overhang limit, so a hole made from it prints without supports.
 * It works in world orientation (where "up" is), so it needs the node's
 * rotation and scale; the result is brought back to the local frame.
 *
 * Construction, exact for cylinders: S' = shape swept straight up, cut by the
 * roof planes at the overhang limit; the teardrop is hull(shape ∪ the part of
 * S' above the shape's top).
 */
function teardrop(m: Manifold, mod: Extract<Modifier, { type: 'teardrop' }>, t: Transform): Manifold {
  const { Manifold: M } = kernel();
  if (t.scale.some((v) => Math.abs(v) < 1e-9)) throw new Error('Teardrop needs a non-zero scale');
  const scaled = m.scale(t.scale);
  const world = scaled.rotate(t.rotation); // world orientation, translation does not matter
  scaled.delete();
  const pts = pointsOf(world);
  const b = world.boundingBox();
  world.delete();
  const zTop = b.max[2];
  const L = 2 * Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) + 10;

  // Sweep the shape straight up, then cut it with the roof planes: for each
  // direction, the plane at the overhang limit that touches the shape.
  const angle = (Math.min(80, Math.max(10, mod.angle || 45)) * Math.PI) / 180;
  const sweepPts: [number, number, number][] = [];
  for (const p of pts) sweepPts.push(p, [p[0], p[1], p[2] + L]);
  let roofed = M.hull(sweepPts);
  const seg = 48;
  for (let i = 0; i < seg; i++) {
    const phi = (2 * Math.PI * i) / seg;
    // Normal of a roof face that is `angle` away from vertical.
    const n: [number, number, number] = [Math.cos(phi) * Math.cos(angle), Math.sin(phi) * Math.cos(angle), Math.sin(angle)];
    let h = -Infinity;
    for (const p of pts) h = Math.max(h, n[0] * p[0] + n[1] * p[1] + n[2] * p[2]);
    const next = roofed.trimByPlane([-n[0], -n[1], -n[2]], -h); // keep n·p <= h
    roofed.delete();
    roofed = next;
  }
  const above = roofed.trimByPlane([0, 0, 1], zTop);
  roofed.delete();
  let shape = M.hull([...pts, ...pointsOf(above)]);
  above.delete();
  if (mod.tip === 'flat') {
    const cut = shape.trimByPlane([0, 0, -1], -zTop);
    shape.delete();
    shape = cut;
  }

  // Back to the local frame: undo the rotation (Z, then Y, then X), then the scale.
  const [rx, ry, rz] = t.rotation;
  const r1 = shape.rotate([0, 0, -rz]);
  const r2 = r1.rotate([0, -ry, 0]);
  const r3 = r2.rotate([-rx, 0, 0]);
  const local = r3.scale(t.scale.map((v) => 1 / v) as [number, number, number]);
  for (const x of [shape, r1, r2, r3]) x.delete();
  return local;
}

/** True when every edge of the node's local outline is parallel to an axis (boxes, rectilinear polygons…). */
function isAxisAligned(node: SceneNode): boolean {
  const s = node.shape;
  if (s.kind === 'box') return true;
  if (s.kind === 'polygon') {
    if (s.twist !== 0 || s.scaleTop !== 1) return false;
    return s.points.every(([x, y], i) => {
      const [nx, ny] = s.points[(i + 1) % s.points.length];
      return Math.abs(nx - x) < 1e-9 || Math.abs(ny - y) < 1e-9;
    });
  }
  if (s.kind === 'group') {
    const quarter = (d: number) => Math.abs(d / 90 - Math.round(d / 90)) < 1e-9;
    return s.children.every(
      (c) => c.modifiers.every((mod) => mod.type === 'chamfer') && c.transform.rotation.every(quarter) && isAxisAligned(c),
    );
  }
  return false;
}

/**
 * Weight per (canonical) vertex for a face region: 1 inside, 0 on its border and
 * outside, so the rest of the object doesn't move. The region grows from the
 * triangle nearest to the picked point across edges flatter than region.angle.
 */
function regionWeights(
  vp: Float32Array, np: number, tv: Uint32Array, canon: Uint32Array, nv: number, region: FaceRegion,
): Float32Array {
  const nt = tv.length / 3;
  const tn = new Float32Array(nt * 3);
  const cen = new Float32Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    const a = canon[tv[t * 3]] * np, b = canon[tv[t * 3 + 1]] * np, c = canon[tv[t * 3 + 2]] * np;
    const ux = vp[b] - vp[a], uy = vp[b + 1] - vp[a + 1], uz = vp[b + 2] - vp[a + 2];
    const vx = vp[c] - vp[a], vy = vp[c + 1] - vp[a + 1], vz = vp[c + 2] - vp[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    tn.set([nx, ny, nz], t * 3);
    cen.set([(vp[a] + vp[b] + vp[c]) / 3, (vp[a + 1] + vp[b + 1] + vp[c + 1]) / 3, (vp[a + 2] + vp[b + 2] + vp[c + 2]) / 3], t * 3);
  }
  // Seed: nearest triangle facing roughly the picked way.
  const [px, py, pz] = region.point;
  const rl = Math.hypot(...region.normal) || 1;
  const [rx, ry, rz] = region.normal.map((v) => v / rl);
  let seed = -1, bestD = Infinity;
  for (let t = 0; t < nt; t++) {
    if (tn[t * 3] * rx + tn[t * 3 + 1] * ry + tn[t * 3 + 2] * rz < 0.5) continue;
    const d = (cen[t * 3] - px) ** 2 + (cen[t * 3 + 1] - py) ** 2 + (cen[t * 3 + 2] - pz) ** 2;
    if (d < bestD) {
      bestD = d;
      seed = t;
    }
  }
  const weights = new Float32Array(nv);
  if (seed < 0) throw new Error('The picked face is no longer there: pick it again');

  // Triangles sharing each edge (canonical vertex pair).
  const edges = new Map<number, number[]>();
  for (let t = 0; t < nt; t++)
    for (let k = 0; k < 3; k++) {
      const a = canon[tv[t * 3 + k]], b = canon[tv[t * 3 + ((k + 1) % 3)]];
      const key = a < b ? a * nv + b : b * nv + a;
      const list = edges.get(key);
      if (list) list.push(t);
      else edges.set(key, [t]);
    }
  const cosMax = Math.cos(((region.angle || 30) * Math.PI) / 180);
  const inside = new Uint8Array(nt);
  inside[seed] = 1;
  const queue = [seed];
  while (queue.length) {
    const t = queue.pop()!;
    for (let k = 0; k < 3; k++) {
      const a = canon[tv[t * 3 + k]], b = canon[tv[t * 3 + ((k + 1) % 3)]];
      for (const u of edges.get(a < b ? a * nv + b : b * nv + a)!) {
        if (inside[u]) continue;
        if (tn[t * 3] * tn[u * 3] + tn[t * 3 + 1] * tn[u * 3 + 1] + tn[t * 3 + 2] * tn[u * 3 + 2] < cosMax) continue;
        inside[u] = 1;
        queue.push(u);
      }
    }
  }
  // A vertex moves only if every triangle around it is in the region.
  const any = new Uint8Array(nv), out = new Uint8Array(nv);
  for (let t = 0; t < nt; t++)
    for (let k = 0; k < 3; k++) {
      const v = canon[tv[t * 3 + k]];
      if (inside[t]) any[v] = 1;
      else out[v] = 1;
    }
  for (let v = 0; v < nv; v++) weights[v] = any[v] && !out[v] ? 1 : 0;
  return weights;
}

function applyModifier(m: Manifold, mod: Modifier, node: SceneNode, axisAligned = false): Manifold {
  const { Manifold: M } = kernel();
  switch (mod.type) {
    case 'chamfer':
      return chamfer(m, mod, axisAligned);
    case 'teardrop':
      return teardrop(m, mod, node.transform);
    case 'twist': {
      const r = refineFor(m, autoLength(m));
      const b = bounds(r);
      const h = b.zmax - b.zmin || 1;
      const rad = (mod.degrees * Math.PI) / 180;
      return r.warp((v) => {
        const a = (rad * (v[2] - b.zmin)) / h;
        const c = Math.cos(a), s = Math.sin(a);
        const x = v[0], y = v[1];
        v[0] = x * c - y * s;
        v[1] = x * s + y * c;
      });
    }
    case 'taper': {
      const r = refineFor(m, autoLength(m));
      const b = bounds(r);
      const h = b.zmax - b.zmin || 1;
      return r.warp((v) => {
        const f = 1 + (mod.scaleTop - 1) * ((v[2] - b.zmin) / h);
        v[0] *= f;
        v[1] *= f;
      });
    }
    case 'bend': {
      const r = refineFor(m, autoLength(m));
      const b = bounds(r);
      const L = b.xmax - b.xmin || 1;
      const theta = (mod.degrees * Math.PI) / 180;
      if (Math.abs(theta) < 1e-4) return r;
      const R = L / theta; // signed radius
      const xc = (b.xmin + b.xmax) / 2;
      return r.warp((v) => {
        const a = (v[0] - xc) / R;
        const dz = v[2] - b.zmin;
        const rr = R - dz;
        v[0] = xc + rr * Math.sin(a);
        v[2] = b.zmin + R - rr * Math.cos(a);
      });
    }
    case 'round': {
      if (mod.radius <= 0) return m;
      const ball = M.sphere(mod.radius, 16);
      const raw = m.minkowskiDifference(ball);
      // The erosion is covered in tiny near-coplanar facets (imprints of the ball). Summing
      // straight onto them leaves zero-thickness fins on the surface, which slicers and the
      // wall-thickness check see as 0 mm walls. Merging those facets first avoids it.
      const eroded = raw.simplify(0.01);
      raw.delete();
      if (eroded.isEmpty()) {
        eroded.delete();
        ball.delete();
        throw new Error('Round radius too large for this object');
      }
      const rounded = eroded.minkowskiSum(ball);
      eroded.delete();
      ball.delete();
      return rounded;
    }
    case 'smooth': {
      const sm = m.smoothOut(mod.sharpAngle, Math.min(1, Math.max(0, 1 - mod.smoothness)));
      return refineFor(sm, mod.resolution || autoLength(m));
    }
    case 'displace':
      return displace(m, mod);
    case 'warp': {
      const fx = compileExpr(mod.x || 'x');
      const fy = compileExpr(mod.y || 'y');
      const fz = compileExpr(mod.z || 'z');
      const r = mod.resolution > 0 ? refineFor(m, mod.resolution) : m;
      const scope: Record<string, number> = { ...bounds(r), x: 0, y: 0, z: 0 };
      return r.warp((v) => {
        scope.x = v[0];
        scope.y = v[1];
        scope.z = v[2];
        const nx = fx(scope), ny = fy(scope), nz = fz(scope);
        v[0] = nx;
        v[1] = ny;
        v[2] = nz;
      });
    }
  }
}

// ----------------------------------------------------------------- nodes ----

const cache = new Map<string, Manifold>();
function cached(key: string, build: () => Manifold): Manifold {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit); // LRU bump
    return hit;
  }
  const m = build();
  cache.set(key, m);
  if (cache.size > 80) {
    const oldest = cache.keys().next().value!;
    cache.get(oldest)?.delete();
    cache.delete(oldest);
  }
  return m;
}

/** Returns a new Manifold (the input, usually cached, is left untouched). */
export function applyTransform(m: Manifold, t: Transform): Manifold {
  const scaled = m.scale(t.scale);
  const rotated = scaled.rotate(t.rotation);
  scaled.delete();
  const moved = rotated.translate(t.position);
  rotated.delete();
  return moved;
}

/** Geometry of a node in its own local frame (shape + modifiers). */
export function buildLocal(node: SceneNode): Manifold {
  return cached(localGeometryKey(node), () => {
    let m: Manifold;
    if (node.shape.kind === 'group') {
      const { Manifold: M } = kernel();
      const solids = node.shape.children.filter((c) => !c.hole).map(buildWorld);
      const holes = node.shape.children.filter((c) => c.hole).map(buildWorld);
      m = node.shape.op === 'intersection' && solids.length ? M.intersection(solids) : M.union(solids);
      if (holes.length) {
        const cut = M.union(holes);
        const body = m;
        m = body.subtract(cut);
        body.delete();
        cut.delete();
      }
      for (const c of [...solids, ...holes]) c.delete();
    } else {
      m = buildLeaf(node.shape);
    }
    // Chamfers keep an axis-aligned outline axis-aligned; any other modifier bends or rounds it.
    let aligned = isAxisAligned(node);
    for (const mod of node.modifiers) {
      const next = applyModifier(m, mod, node, aligned);
      if (mod.type !== 'chamfer') aligned = false;
      if (next !== m) m.delete(); // intermediate results are not cached, free the WASM memory
      m = next;
    }
    return m;
  });
}

export function buildWorld(node: SceneNode): Manifold {
  return applyTransform(buildLocal(node), node.transform);
}

/** Everything that would be printed: union of all root solids minus root holes. */
export function buildPrintable(nodes: SceneNode[]): Manifold {
  const { Manifold: M } = kernel();
  const solids = nodes.filter((n) => !n.hole).map(buildWorld);
  const holes = nodes.filter((n) => n.hole).map(buildWorld);
  let m = M.union(solids);
  if (holes.length) {
    const cut = M.union(holes);
    const body = m;
    m = body.subtract(cut);
    body.delete();
    cut.delete();
  }
  for (const c of [...solids, ...holes]) c.delete();
  return m;
}
