// Turns hand-traced pen strokes (mm) into clean closed outlines.
//
// 1. Strokes are drawn into a grid as thick lines, so small gaps close and
//    multi-stroke tracings join up. Stroke ends left open are bridged to the
//    nearest other end when close enough.
// 2. The free cells are grouped into regions. Counting how many stroke lines
//    separate a region from the outside gives nesting: 1 = material, 2 = a
//    hole in it (a traced inner loop), 3 = an island in the hole, and so on.
// 3. Marching squares turns the material cells into contours, which are then
//    simplified and lightly smoothed. The contours run along the inner edge of
//    the drawn line; the kernel offsets them back by `strokeRadius`.

export type Pt = [number, number];

export interface OutlineResult {
  /** Closed contours in mm (even-odd: outer outlines and holes). */
  contours: Pt[][];
  /** Half the width the strokes were drawn with: contours sit this far inside the pen line. */
  strokeRadius: number;
}

const CELL = 0.25; // mm
const RADIUS = 0.75; // mm: closes gaps up to 1.5 mm
const BRIDGE = 20; // mm: open ends closer than this get joined

export function tracingToOutline(strokes: number[][]): OutlineResult {
  const lines = strokes.filter((s) => s.length >= 4).map((s) => s.slice());
  if (!lines.length) throw new Error('The tracing is empty');
  bridgeOpenEnds(lines);

  // Grid covering the strokes plus a margin.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of lines)
    for (let i = 0; i < s.length; i += 2) {
      x0 = Math.min(x0, s[i]); x1 = Math.max(x1, s[i]);
      y0 = Math.min(y0, s[i + 1]); y1 = Math.max(y1, s[i + 1]);
    }
  const margin = RADIUS + 2 * CELL;
  x0 -= margin; y0 -= margin; x1 += margin; y1 += margin;
  const w = Math.ceil((x1 - x0) / CELL) + 1, h = Math.ceil((y1 - y0) / CELL) + 1;
  if (w * h > 8_000_000) throw new Error('The tracing is too big');
  const ink = new Uint8Array(w * h);
  const stamp = (cx: number, cy: number) => {
    const r = Math.ceil(RADIUS / CELL);
    const gx = (cx - x0) / CELL, gy = (cy - y0) / CELL;
    for (let j = Math.floor(gy - r); j <= Math.ceil(gy + r); j++)
      for (let i = Math.floor(gx - r); i <= Math.ceil(gx + r); i++)
        if (i >= 0 && j >= 0 && i < w && j < h && (i - gx) ** 2 + (j - gy) ** 2 <= (RADIUS / CELL) ** 2) ink[j * w + i] = 1;
  };
  for (const s of lines) {
    stamp(s[0], s[1]);
    for (let k = 2; k < s.length; k += 2) {
      const ax = s[k - 2], ay = s[k - 1], bx = s[k], by = s[k + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (CELL * 0.7)));
      for (let t = 1; t <= steps; t++) stamp(ax + ((bx - ax) * t) / steps, ay + ((by - ay) * t) / steps);
    }
  }

  // Label connected regions of free cells and of ink cells (4-connected).
  const label = new Int32Array(w * h).fill(-1);
  const isInk: boolean[] = [];
  let regions = 0;
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (label[start] >= 0) continue;
    const kind = ink[start];
    const id = regions++;
    isInk.push(kind === 1);
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const c = stack.pop()!;
      const ci = c % w, cj = (c - ci) / w;
      for (const n of [ci > 0 ? c - 1 : -1, ci < w - 1 ? c + 1 : -1, cj > 0 ? c - w : -1, cj < h - 1 ? c + w : -1]) {
        if (n < 0 || label[n] >= 0 || ink[n] !== kind) continue;
        label[n] = id;
        stack.push(n);
      }
    }
  }
  // Region adjacency, then nesting depth = stroke lines crossed from the outside.
  const adj: Set<number>[] = Array.from({ length: regions }, () => new Set());
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const a = label[j * w + i];
      if (i < w - 1) {
        const b = label[j * w + i + 1];
        if (a !== b) { adj[a].add(b); adj[b].add(a); }
      }
      if (j < h - 1) {
        const b = label[(j + 1) * w + i];
        if (a !== b) { adj[a].add(b); adj[b].add(a); }
      }
    }
  // 0-1 BFS: entering a line costs nothing, leaving it into a free region costs one.
  const depth = new Int32Array(regions).fill(1 << 30);
  const outside = label[0]; // the margin guarantees the corner is free and outside
  depth[outside] = 0;
  const deque: number[] = [outside];
  while (deque.length) {
    const r = deque.shift()!;
    for (const n of adj[r]) {
      const cost = !isInk[n] && isInk[r] ? 1 : 0;
      if (depth[r] + cost >= depth[n]) continue;
      depth[n] = depth[r] + cost;
      if (cost) deque.push(n);
      else deque.unshift(n);
    }
  }
  const solid = new Uint8Array(w * h);
  let any = false;
  for (let c = 0; c < w * h; c++) {
    const r = label[c];
    if (!isInk[r] && depth[r] % 2 === 1) {
      solid[c] = 1;
      any = true;
    }
  }
  if (!any) throw new Error('No closed outline found: trace all the way around the object (gaps up to 2 cm are closed automatically)');

  const contours = marchingSquares(solid, w, h)
    .map((loop) => loop.map(([i, j]) => [x0 + i * CELL, y0 + j * CELL] as Pt))
    // Smooth while the points are dense (removes the grid staircase and tremble), then simplify.
    .map((loop) => simplify(smooth(smooth(loop)), 0.08))
    .filter((loop) => loop.length >= 3 && Math.abs(area(loop)) > 1); // drop specks under 1 mm²
  if (!contours.length) throw new Error('The outline is too small');
  return { contours, strokeRadius: RADIUS };
}

/** Join open stroke ends to the nearest free end of another stroke (or its own start) within BRIDGE mm. */
function bridgeOpenEnds(lines: number[][]) {
  type End = { s: number; head: boolean; x: number; y: number; used: boolean };
  const ends: End[] = [];
  lines.forEach((s, k) => {
    const n = s.length;
    // A stroke that already comes back near its start is closed.
    if (Math.hypot(s[0] - s[n - 2], s[1] - s[n - 1]) < 2 * RADIUS) return;
    ends.push({ s: k, head: true, x: s[0], y: s[1], used: false });
    ends.push({ s: k, head: false, x: s[n - 2], y: s[n - 1], used: false });
  });
  // Greedy: closest pairs first.
  const pairs: [number, number, number][] = [];
  for (let a = 0; a < ends.length; a++)
    for (let b = a + 1; b < ends.length; b++) {
      const d = Math.hypot(ends[a].x - ends[b].x, ends[a].y - ends[b].y);
      if (d < BRIDGE) pairs.push([d, a, b]);
    }
  pairs.sort((p, q) => p[0] - q[0]);
  for (const [, a, b] of pairs) {
    if (ends[a].used || ends[b].used) continue;
    ends[a].used = ends[b].used = true;
    lines.push([ends[a].x, ends[a].y, ends[b].x, ends[b].y]);
  }
}

/** Contours of the cells set in `grid` (cell centres at integer coordinates), as closed loops. */
function marchingSquares(grid: Uint8Array, w: number, h: number): Pt[][] {
  const at = (i: number, j: number) => (i >= 0 && j >= 0 && i < w && j < h ? grid[j * w + i] : 0);
  // Edge midpoints as keys: horizontal edge between (i,j)-(i+1,j) and vertical between (i,j)-(i,j+1).
  const key = (x2: number, y2: number) => y2 * (2 * w + 4) + x2; // doubled coordinates
  const next = new Map<number, number>();
  const pos = new Map<number, Pt>();
  const seg = (ax2: number, ay2: number, bx2: number, by2: number) => {
    const a = key(ax2, ay2), b = key(bx2, by2);
    next.set(a, b);
    pos.set(a, [ax2 / 2, ay2 / 2]);
    pos.set(b, [bx2 / 2, by2 / 2]);
  };
  for (let j = -1; j < h; j++)
    for (let i = -1; i < w; i++) {
      // Corners: a = (i,j), b = (i+1,j), c = (i+1,j+1), d = (i,j+1)
      const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
      const code = a | (b << 1) | (c << 2) | (d << 3);
      if (code === 0 || code === 15) continue;
      // Edge midpoints (doubled coordinates)
      const top: [number, number] = [2 * i + 1, 2 * j];
      const right: [number, number] = [2 * i + 2, 2 * j + 1];
      const bottom: [number, number] = [2 * i + 1, 2 * j + 2];
      const left: [number, number] = [2 * i, 2 * j + 1];
      // Segments oriented with the solid on the left (counter-clockwise outer loops in y-up terms vary; even-odd fill doesn't care).
      const S = (p: [number, number], q: [number, number]) => seg(p[0], p[1], q[0], q[1]);
      switch (code) {
        case 1: S(left, top); break;
        case 2: S(top, right); break;
        case 3: S(left, right); break;
        case 4: S(right, bottom); break;
        case 5: S(left, top); S(right, bottom); break; // saddle: keep the diagonal cells apart
        case 6: S(top, bottom); break;
        case 7: S(left, bottom); break;
        case 8: S(bottom, left); break;
        case 9: S(bottom, top); break;
        case 10: S(top, right); S(bottom, left); break;
        case 11: S(bottom, right); break;
        case 12: S(right, left); break;
        case 13: S(right, top); break;
        case 14: S(top, left); break;
      }
    }
  const loops: Pt[][] = [];
  const seen = new Set<number>();
  for (const startKey of next.keys()) {
    if (seen.has(startKey)) continue;
    const loop: Pt[] = [];
    let k: number | undefined = startKey;
    while (k !== undefined && !seen.has(k)) {
      seen.add(k);
      loop.push(pos.get(k)!);
      k = next.get(k);
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

function area(loop: Pt[]) {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x1, y1] = loop[i];
    const [x2, y2] = loop[(i + 1) % loop.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** Ramer–Douglas–Peucker on a closed loop. */
function simplify(loop: Pt[], tol: number): Pt[] {
  if (loop.length < 8) return loop;
  // Split the loop at its two farthest points and simplify both halves as open lines.
  let far = 0, best = -1;
  for (let i = 1; i < loop.length; i++) {
    const d = (loop[i][0] - loop[0][0]) ** 2 + (loop[i][1] - loop[0][1]) ** 2;
    if (d > best) { best = d; far = i; }
  }
  const a = rdp(loop.slice(0, far + 1), tol);
  const b = rdp([...loop.slice(far), loop[0]], tol);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

function rdp(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts;
  const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
  const len = Math.hypot(bx - ax, by - ay) || 1e-9;
  let idx = 0, dmax = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
    if (d > dmax) { dmax = d; idx = i; }
  }
  if (dmax <= tol) return [pts[0], pts[pts.length - 1]];
  return [...rdp(pts.slice(0, idx + 1), tol).slice(0, -1), ...rdp(pts.slice(idx), tol)];
}

/** One pass of Chaikin corner cutting on a dense loop: softens hand tremble and grid steps. */
function smooth(loop: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < loop.length; i++) {
    const [x1, y1] = loop[i];
    const [x2, y2] = loop[(i + 1) % loop.length];
    out.push([0.75 * x1 + 0.25 * x2, 0.75 * y1 + 0.25 * y2], [0.25 * x1 + 0.75 * x2, 0.25 * y1 + 0.75 * y2]);
  }
  return out.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]);
}
