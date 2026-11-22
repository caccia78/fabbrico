// Wall thickness: for each surface triangle, cast a ray from its centre
// straight into the material and measure how far it travels before leaving
// the solid. Runs in the geometry worker.
//
// The mesh is refined first so that thin spots are sampled even on large flat
// faces (a box face is only two triangles).

import type { Manifold } from 'manifold-3d/manifold';

export interface ThicknessData {
  /** Non-indexed triangle soup, 9 floats per triangle, in the frame the manifold was given in. */
  position: Float32Array;
  /** Thickness per triangle in mm (Infinity if the ray found no exit). */
  thickness: Float32Array;
  /** Area per triangle in mm². */
  area: Float32Array;
}

const WALL_COS = Math.cos(Math.PI / 4);

/** Dot product of a triangle's unit normal with (nx, ny, nz). */
function dot(pos: Float32Array, t: number, nx: number, ny: number, nz: number) {
  const o = t * 9;
  const ux = pos[o + 3] - pos[o], uy = pos[o + 4] - pos[o + 1], uz = pos[o + 5] - pos[o + 2];
  const vx = pos[o + 6] - pos[o], vy = pos[o + 7] - pos[o + 1], vz = pos[o + 8] - pos[o + 2];
  const mx = uy * vz - uz * vy, my = uz * vx - ux * vz, mz = ux * vy - uy * vx;
  const l = Math.hypot(mx, my, mz) || 1;
  return (mx * nx + my * ny + mz * nz) / l;
}

/** Edge length to refine to so that roughly `maxTris` triangles cover the surface. */
function sampleLength(m: Manifold, maxTris: number, minLength: number) {
  return Math.max(minLength, Math.sqrt(m.surfaceArea() / (0.43 * maxTris)));
}

export function computeThickness(m: Manifold, opts: { maxTris: number; minLength: number }): ThicknessData {
  const refined = m.refineToLength(sampleLength(m, opts.maxTris, opts.minLength));
  const mesh = refined.getMesh();
  refined.delete();
  const np = mesh.numProp;
  const vp = mesh.vertProperties;
  const tv = mesh.triVerts;
  const n = tv.length / 3;

  // Flat triangle soup: much simpler to traverse than shared vertices.
  const pos = new Float32Array(n * 9);
  for (let t = 0; t < n; t++)
    for (let k = 0; k < 3; k++) {
      const v = tv[t * 3 + k] * np;
      pos[t * 9 + k * 3] = vp[v];
      pos[t * 9 + k * 3 + 1] = vp[v + 1];
      pos[t * 9 + k * 3 + 2] = vp[v + 2];
    }

  const bvh = new TriangleBVH(pos);
  const thickness = new Float32Array(n);
  const area = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const ax = pos[o], ay = pos[o + 1], az = pos[o + 2];
    const ux = pos[o + 3] - ax, uy = pos[o + 4] - ay, uz = pos[o + 5] - az;
    const vx = pos[o + 6] - ax, vy = pos[o + 7] - ay, vz = pos[o + 8] - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    area[t] = len / 2;
    if (len < 1e-12) {
      thickness[t] = Infinity;
      continue;
    }
    nx /= len; ny /= len; nz /= len;
    // From the centre, inwards (outward normal is counter-clockwise in Manifold).
    const cx = ax + (ux + vx) / 3, cy = ay + (uy + vy) / 3, cz = az + (uz + vz) / 3;
    const d = bvh.firstHit(cx, cy, cz, -nx, -ny, -nz, t);
    // Only count it as a wall if the ray leaves through a face roughly opposite
    // (within 45°). Otherwise it just crossed the corner of an edge sharper than
    // 90° (e.g. a sloped side meeting the bottom), which is not a thin wall.
    thickness[t] = isFinite(d) && dot(pos, bvh.lastHit, nx, ny, nz) < -WALL_COS ? d : Infinity;
  }
  return { position: pos, thickness, area };
}

// ----------------------------------------------------------------- BVH ----

const LEAF = 4;

/** Bounding volume hierarchy over a triangle soup, for first-hit ray queries. */
class TriangleBVH {
  private pos: Float32Array;
  private order: Uint32Array;
  // Per node: bounds, and either children (left, right) or a leaf range (start, count).
  private bounds: Float32Array;
  private a: Uint32Array;
  private b: Uint32Array;
  private leaf: Uint8Array;
  private count = 0;
  /** Triangle hit by the last firstHit call (-1 if none). */
  lastHit = -1;

  constructor(pos: Float32Array) {
    this.pos = pos;
    const n = pos.length / 9;
    this.order = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.order[i] = i;
    const maxNodes = Math.max(1, 2 * Math.ceil(n / LEAF) * 2);
    this.bounds = new Float32Array(maxNodes * 6);
    this.a = new Uint32Array(maxNodes);
    this.b = new Uint32Array(maxNodes);
    this.leaf = new Uint8Array(maxNodes);

    const cen = new Float32Array(n * 3);
    for (let t = 0; t < n; t++)
      for (let k = 0; k < 3; k++) cen[t * 3 + k] = (pos[t * 9 + k] + pos[t * 9 + 3 + k] + pos[t * 9 + 6 + k]) / 3;
    if (n) this.build(0, n, cen);
  }

  private grow() {
    const size = this.a.length * 2;
    const nb = new Float32Array(size * 6);
    nb.set(this.bounds);
    this.bounds = nb;
    const na = new Uint32Array(size);
    na.set(this.a);
    this.a = na;
    const nB = new Uint32Array(size);
    nB.set(this.b);
    this.b = nB;
    const nl = new Uint8Array(size);
    nl.set(this.leaf);
    this.leaf = nl;
  }

  /** Builds the node for order[start, end) and returns its index. Iterative split at the centroid midpoint. */
  private build(start: number, end: number, cen: Float32Array): number {
    const node = this.count++;
    if (node >= this.a.length) this.grow();
    const { pos, order } = this;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
    for (let i = start; i < end; i++) {
      const t = order[i];
      for (let k = 0; k < 9; k += 3) {
        const x = pos[t * 9 + k], y = pos[t * 9 + k + 1], z = pos[t * 9 + k + 2];
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      const cx = cen[t * 3], cy = cen[t * 3 + 1], cz = cen[t * 3 + 2];
      if (cx < cx0) cx0 = cx; if (cx > cx1) cx1 = cx;
      if (cy < cy0) cy0 = cy; if (cy > cy1) cy1 = cy;
      if (cz < cz0) cz0 = cz; if (cz > cz1) cz1 = cz;
    }
    this.bounds.set([x0, y0, z0, x1, y1, z1], node * 6);

    if (end - start <= LEAF) {
      this.leaf[node] = 1;
      this.a[node] = start;
      this.b[node] = end - start;
      return node;
    }
    const ex = cx1 - cx0, ey = cy1 - cy0, ez = cz1 - cz0;
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    const mid = axis === 0 ? (cx0 + cx1) / 2 : axis === 1 ? (cy0 + cy1) / 2 : (cz0 + cz1) / 2;
    let i = start, j = end - 1;
    while (i <= j) {
      if (cen[order[i] * 3 + axis] < mid) i++;
      else {
        const tmp = order[i];
        order[i] = order[j];
        order[j] = tmp;
        j--;
      }
    }
    let split = i;
    if (split === start || split === end) split = (start + end) >> 1; // all centroids equal on this axis
    this.leaf[node] = 0;
    const left = this.build(start, split, cen);
    const right = this.build(split, end, cen);
    this.a[node] = left;
    this.b[node] = right;
    return node;
  }

  /** Distance to the first triangle hit (other than `skip`), or Infinity. */
  firstHit(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, skip: number): number {
    this.lastHit = -1;
    if (!this.count) return Infinity;
    const { pos, bounds, order, a, b, leaf } = this;
    const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
    let best = Infinity;
    const stack = [0];
    while (stack.length) {
      const node = stack.pop()!;
      const o = node * 6;
      // Slab test.
      let t1 = (bounds[o] - ox) * ix, t2 = (bounds[o + 3] - ox) * ix;
      let tmin = Math.min(t1, t2), tmax = Math.max(t1, t2);
      t1 = (bounds[o + 1] - oy) * iy; t2 = (bounds[o + 4] - oy) * iy;
      tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2));
      t1 = (bounds[o + 2] - oz) * iz; t2 = (bounds[o + 5] - oz) * iz;
      tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2));
      if (tmax < Math.max(tmin, 0) || tmin > best) continue;

      if (!leaf[node]) {
        stack.push(a[node], b[node]);
        continue;
      }
      for (let i = a[node], e = a[node] + b[node]; i < e; i++) {
        const t = order[i];
        if (t === skip) continue;
        const p = t * 9;
        // Möller–Trumbore.
        const e1x = pos[p + 3] - pos[p], e1y = pos[p + 4] - pos[p + 1], e1z = pos[p + 5] - pos[p + 2];
        const e2x = pos[p + 6] - pos[p], e2y = pos[p + 7] - pos[p + 1], e2z = pos[p + 8] - pos[p + 2];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        const inv = 1 / det;
        const sx = ox - pos[p], sy = oy - pos[p + 1], sz = oz - pos[p + 2];
        const u = (sx * px + sy * py + sz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (dist > 1e-5 && dist < best) {
          best = dist;
          this.lastHit = t;
        }
      }
    }
    return best;
  }
}
