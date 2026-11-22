// Shape assist for sketches: hold the pencil still at the end of a stroke and a
// rough line, circle or rectangle becomes a clean one (like Notes on the iPad).
// Strokes are flat arrays in mm: x0, y0, x1, y1…

type Stroke = number[];

const pts = (s: Stroke) => Array.from({ length: s.length / 2 }, (_, i) => [s[2 * i], s[2 * i + 1]] as [number, number]);
const round = (v: number) => Math.round(v * 100) / 100;

function pathLength(p: [number, number][]) {
  let l = 0;
  for (let i = 1; i < p.length; i++) l += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return l;
}

/** Snap an angle to horizontal / vertical / 45° when within 6°. */
function snapAngle(a: number) {
  const step = Math.PI / 4;
  const k = Math.round(a / step) * step;
  return Math.abs(a - k) < (6 * Math.PI) / 180 ? k : a;
}

function line(p: [number, number][]): Stroke | null {
  const [a, b] = [p[0], p[p.length - 1]];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 4) return null;
  // Every point close to the chord, and the stroke doesn't wander back and forth.
  const tol = Math.max(0.8, len * 0.04);
  for (const q of p) {
    const d = Math.abs((b[0] - a[0]) * (a[1] - q[1]) - (a[0] - q[0]) * (b[1] - a[1])) / len;
    if (d > tol) return null;
  }
  if (pathLength(p) > len * 1.15) return null;
  const ang = snapAngle(Math.atan2(b[1] - a[1], b[0] - a[0]));
  return [round(a[0]), round(a[1]), round(a[0] + Math.cos(ang) * len), round(a[1] + Math.sin(ang) * len)];
}

function closed(p: [number, number][]) {
  const per = pathLength(p);
  const [a, b] = [p[0], p[p.length - 1]];
  return per > 12 && Math.hypot(b[0] - a[0], b[1] - a[1]) < Math.max(4, per * 0.12);
}

function circle(p: [number, number][]): Stroke | null {
  const cx = p.reduce((s, q) => s + q[0], 0) / p.length;
  const cy = p.reduce((s, q) => s + q[1], 0) / p.length;
  const d = p.map((q) => Math.hypot(q[0] - cx, q[1] - cy));
  const r = d.reduce((s, v) => s + v, 0) / d.length;
  if (r < 1.5) return null;
  const sd = Math.sqrt(d.reduce((s, v) => s + (v - r) ** 2, 0) / d.length);
  if (sd / r > 0.1) return null;
  const out: Stroke = [];
  const n = Math.max(24, Math.min(96, Math.round(r * 4)));
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * 2 * Math.PI;
    out.push(round(cx + r * Math.cos(t)), round(cy + r * Math.sin(t)));
  }
  return out;
}

function rectangle(p: [number, number][]): Stroke | null {
  const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const w = x1 - x0, h = y1 - y0;
  if (w < 3 || h < 3) return null;
  // Most of the stroke runs along the box's sides, and it visits all four corners.
  const tol = Math.max(1, Math.min(w, h) * 0.15);
  const onEdge = p.filter((q) => Math.min(q[0] - x0, x1 - q[0], q[1] - y0, y1 - q[1]) < tol).length;
  if (onEdge / p.length < 0.9) return null;
  const corners: [number, number][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const ctol = Math.max(2.5, Math.min(w, h) * 0.3);
  if (!corners.every((c) => p.some((q) => Math.hypot(q[0] - c[0], q[1] - c[1]) < ctol))) return null;
  return [x0, y0, x1, y0, x1, y1, x0, y1, x0, y0].map(round);
}

/** The clean shape for a rough stroke, or null if it doesn't look like one. */
export function recognize(s: Stroke): { kind: 'line' | 'circle' | 'rectangle'; stroke: Stroke } | null {
  if (s.length < 8) return null;
  const p = pts(s);
  const l = line(p);
  if (l) return { kind: 'line', stroke: l };
  if (!closed(p)) return null;
  const c = circle(p);
  if (c) return { kind: 'circle', stroke: c };
  const r = rectangle(p);
  if (r) return { kind: 'rectangle', stroke: r };
  return null;
}
