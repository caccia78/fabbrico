// Safe(ish) math expression evaluation for AI- or user-written formulas.
// math.js parses into its own AST, so expressions cannot reach JS globals.
// We additionally disable the functions that could be abused.

import { create, all } from 'mathjs';
import { noise3, cells3 } from './noise';

const math = create(all, {});

const len3 = (x: number, y: number, z: number) => Math.sqrt(x * x + y * y + z * z);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

// SDF helpers. Convention (Manifold.levelSet): POSITIVE INSIDE.
const sdf = {
  sphere: (x: number, y: number, z: number, r: number) => r - len3(x, y, z),
  box: (x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
    const qx = Math.abs(x) - sx / 2;
    const qy = Math.abs(y) - sy / 2;
    const qz = Math.abs(z) - sz / 2;
    const outside = len3(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
    const inside = Math.min(Math.max(qx, qy, qz), 0);
    return -(outside + inside);
  },
  cylinder: (x: number, y: number, z: number, r: number, h: number) => {
    const dx = Math.hypot(x, y) - r;
    const dz = Math.abs(z) - h / 2;
    const outside = Math.hypot(Math.max(dx, 0), Math.max(dz, 0));
    return -(outside + Math.min(Math.max(dx, dz), 0));
  },
  torus: (x: number, y: number, z: number, R: number, r: number) =>
    r - Math.hypot(Math.hypot(x, y) - R, z),
  capsule: (
    x: number, y: number, z: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number, r: number,
  ) => {
    const pax = x - ax, pay = y - ay, paz = z - az;
    const bax = bx - ax, bay = by - ay, baz = bz - az;
    const h = clamp((pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz || 1), 0, 1);
    return r - len3(pax - bax * h, pay - bay * h, paz - baz * h);
  },
  // Named sdf* so they don't shadow math.js built-ins (`subtract` is the - operator!).
  sdfUnion: (a: number, b: number) => Math.max(a, b),
  sdfSubtract: (a: number, b: number) => Math.min(a, -b),
  sdfIntersect: (a: number, b: number) => Math.min(a, b),
  smoothUnion: (a: number, b: number, k: number) => {
    const h = clamp(0.5 + (0.5 * (a - b)) / k, 0, 1);
    return b + (a - b) * h + k * h * (1 - h);
  },
  smoothIntersect: (a: number, b: number, k: number) => {
    const h = clamp(0.5 - (0.5 * (a - b)) / k, 0, 1);
    return b + (a - b) * h - k * h * (1 - h);
  },
  smoothSubtract: (a: number, b: number, k: number) => {
    const nb = -b;
    const h = clamp(0.5 - (0.5 * (a - nb)) / k, 0, 1);
    return nb + (a - nb) * h - k * h * (1 - h);
  },
  noise: noise3,
  cells: cells3,
};

// Refuse to shadow anything math.js already defines.
for (const name of Object.keys(sdf)) {
  if (name in math) throw new Error(`SDF helper "${name}" would shadow a math.js function`);
}
math.import(sdf);

// Keep our own handle to compile before locking the public functions down.
const compile = math.compile;

// Lock down: no further imports, no string evaluation from inside expressions.
const blocked = () => {
  throw new Error('Function disabled');
};
math.import(
  {
    import: blocked,
    createUnit: blocked,
    evaluate: blocked,
    parse: blocked,
    simplify: blocked,
    derivative: blocked,
    resolve: blocked,
    reviver: blocked,
  },
  { override: true },
);

export type Scope = Record<string, number>;

/** Compile an expression into a fast numeric function of a scope object. */
export function compileExpr(src: string): (scope: Scope) => number {
  const code = compile(src);
  return (scope) => {
    const v = code.evaluate(scope);
    return typeof v === 'number' ? v : Number(v);
  };
}
