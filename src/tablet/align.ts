// Lining up tracings of the same object taken from different sides.
//
// The user may lay the object on the tablet turned by 90° or 180° from what
// the view hint asks (easy with side views of flat objects): its height then
// shows up across the screen instead of up it, and the intersection of the
// views comes out with the wrong size. Every axis of the object is seen by two
// views, so the tracings can be turned until the views agree.

import type { Pt } from './outline';
import type { View } from './views';

type Axis = 'x' | 'y' | 'z';

/** What alignment needs of a traced outline: centred contours and their size (screen width × height). */
export interface ViewOutline {
  label: View;
  contours: Pt[][];
  width: number;
  height: number;
}

/** The outline turned on the tablet by `quarter` × 90° counter-clockwise. */
export function rotateOutline<T extends ViewOutline>(o: T, quarter: number): T {
  const q = ((quarter % 4) + 4) % 4;
  if (!q) return o;
  const rot = ([x, y]: Pt): Pt => (q === 1 ? [-y, x] : q === 2 ? [-x, -y] : [y, -x]);
  const swap = q % 2 === 1;
  return {
    ...o,
    contours: o.contours.map((c) => c.map(rot)),
    width: swap ? o.height : o.width,
    height: swap ? o.width : o.height,
  };
}

/** World direction (axis and sign) of screen right (u) and screen up (v) for each view. */
const SCREEN_DIRS: Record<View, { u: [Axis, 1 | -1]; v: [Axis, 1 | -1] }> = {
  top: { u: ['x', 1], v: ['y', 1] },
  bottom: { u: ['x', 1], v: ['y', -1] },
  front: { u: ['x', 1], v: ['z', 1] },
  back: { u: ['x', -1], v: ['z', 1] },
  right: { u: ['y', 1], v: ['z', 1] },
  left: { u: ['y', -1], v: ['z', 1] },
};

const PROFILE_BINS = 24;

/**
 * How wide the silhouette is across `dir` ('u' or 'v'), sampled at evenly
 * spaced positions along it (normalised to the outline's extent), so two views
 * that share an axis can be compared even if their sizes differ a little.
 */
function widthProfile(o: ViewOutline, along: 'u' | 'v'): number[] {
  let a0 = Infinity, a1 = -Infinity;
  for (const c of o.contours) for (const p of c) {
    const a = along === 'u' ? p[0] : p[1];
    a0 = Math.min(a0, a); a1 = Math.max(a1, a);
  }
  const out: number[] = [];
  for (let i = 0; i < PROFILE_BINS; i++) {
    const t = a0 + ((i + 0.5) / PROFILE_BINS) * (a1 - a0);
    // Crossings of the line {along = t} with every contour edge; even-odd pairs give the inside spans.
    const xs: number[] = [];
    for (const c of o.contours)
      for (let k = 0; k < c.length; k++) {
        const p = c[k], q = c[(k + 1) % c.length];
        const pa = along === 'u' ? p[0] : p[1], qa = along === 'u' ? q[0] : q[1];
        const pb = along === 'u' ? p[1] : p[0], qb = along === 'u' ? q[1] : q[0];
        if ((pa <= t) !== (qa <= t)) xs.push(pb + ((t - pa) / (qa - pa)) * (qb - pb));
      }
    xs.sort((m, n) => m - n);
    let w = 0;
    for (let k = 0; k + 1 < xs.length; k += 2) w += xs[k + 1] - xs[k];
    out.push(w);
  }
  return out;
}

function correlation(a: number[], b: number[]) {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return saa > 1e-9 && sbb > 1e-9 ? sab / Math.sqrt(saa * sbb) : 0;
}

/** Where each world axis appears in a (turned) view: which screen direction, and whether it runs backwards. */
function axesOf(view: View) {
  const d = SCREEN_DIRS[view];
  return [
    { axis: d.u[0], sign: d.u[1], dir: 'u' as const },
    { axis: d.v[0], sign: d.v[1], dir: 'v' as const },
  ];
}

/**
 * The user may lay the object on the tablet turned by 90° or 180° from what the
 * view hint asks (easy with side views of flat objects). Every axis is seen by
 * two views, so try every quarter turn of every tracing and keep the one where
 * the views agree: same size along shared axes first, then a similar
 * silhouette profile along them. Unturned tracings are preferred on a tie.
 */
export function alignViews(outlines: ViewOutline[]): number[] {
  const n = outlines.length;
  // Per tracing and turn: the turned outline and its width profiles.
  const cand = outlines.map((o) =>
    [0, 1, 2, 3].map((q) => {
      const r = rotateOutline(o, q);
      return { r, prof: { u: widthProfile(r, 'u'), v: widthProfile(r, 'v') } };
    }),
  );
  const TURN_COST = [0, 0.35, 0.35, 0.35];
  let best = Infinity;
  let bestTurns = new Array(n).fill(0);
  const turns = new Array(n).fill(0);
  const total = 4 ** n;
  for (let code = 0; code < total; code++) {
    let c = code;
    for (let i = 0; i < n; i++) { turns[i] = c % 4; c = Math.floor(c / 4); }
    let cost = 0;
    // Pairs of views sharing an axis.
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const A = cand[i][turns[i]], B = cand[j][turns[j]];
        for (const a of axesOf(outlines[i].label))
          for (const b of axesOf(outlines[j].label)) {
            if (a.axis !== b.axis) continue;
            const la = a.dir === 'u' ? A.r.width : A.r.height;
            const lb = b.dir === 'u' ? B.r.width : B.r.height;
            // Size mismatch, relative: 0 when equal, 1 when one is twice the other.
            cost += 4 * (Math.abs(la - lb) / Math.min(la, lb));
            // Profiles in world order (flip the one whose screen direction runs backwards).
            const pa = a.sign > 0 ? A.prof[a.dir] : [...A.prof[a.dir]].reverse();
            const pb = b.sign > 0 ? B.prof[b.dir] : [...B.prof[b.dir]].reverse();
            cost += 0.5 * (1 - correlation(pa, pb));
          }
      }
    for (let i = 0; i < n; i++) cost += TURN_COST[turns[i]];
    if (cost < best - 1e-9) {
      best = cost;
      bestTurns = turns.slice();
    }
  }
  return bestTurns;
}

