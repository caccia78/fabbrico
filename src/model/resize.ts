// Resizing an object to a size in millimetres (the inspector's Size row).
//
// Sizes are measured along the bed axes (what you see and what has to fit
// the printer). Simple shapes change their own parameters, so fillets,
// chamfers, textures and holes keep their size in mm; everything else (groups,
// imported meshes, organic shapes…) is scaled. The object keeps its place:
// same centre on the bed, same bottom height.

import { Euler, Matrix4 } from 'three';
import { geometry } from '../geometry/client';
import { findNode, useStore } from './store';
import type { LeafShape, Modifier, SceneNode, Shape } from './schema';

type V3 = [number, number, number];
const DEG = Math.PI / 180;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** For each bed axis, the object's own axis that points along it, or null if the rotation isn't in steps of 90°. */
export function axisMapping(rotation: V3): [number, number, number] | null {
  const m = new Matrix4().makeRotationFromEuler(new Euler(rotation[0] * DEG, rotation[1] * DEG, rotation[2] * DEG, 'ZYX'));
  const e = m.elements; // column-major: e[col * 4 + row]
  const map: number[] = [];
  for (let world = 0; world < 3; world++) {
    const local = [0, 1, 2].find((i) => Math.abs(e[i * 4 + world]) > 0.9999);
    if (local === undefined) return null;
    map.push(local);
  }
  return map as [number, number, number];
}

/** The shape with its own dimensions multiplied by f (per local axis), or null if it can't (then the object is scaled). */
export function scaleShape(shape: Shape, [fx, fy, fz]: V3): LeafShape | null {
  const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  switch (shape.kind) {
    case 'box':
      return { ...shape, size: [r3(shape.size[0] * fx), r3(shape.size[1] * fy), r3(shape.size[2] * fz)] };
    case 'cylinder':
      if (!same(fx, fy)) return null;
      return { ...shape, radius: r3(shape.radius * fx), radiusTop: r3(shape.radiusTop * fx), height: r3(shape.height * fz) };
    case 'sphere':
      if (!same(fx, fy) || !same(fx, fz)) return null;
      return { ...shape, radius: r3(shape.radius * fx) };
    case 'torus':
      if (!same(fx, fy) || !same(fx, fz)) return null;
      return { ...shape, majorRadius: r3(shape.majorRadius * fx), minorRadius: r3(shape.minorRadius * fx) };
    case 'polygon':
      return { ...shape, points: shape.points.map(([x, y]) => [r3(x * fx), r3(y * fy)]), height: r3(shape.height * fz) };
    case 'revolve':
      if (!same(fx, fy)) return null;
      return { ...shape, profile: shape.profile.map(([r, z]) => [r3(r * fx), r3(z * fz)]) };
    case 'text':
      if (!same(fx, fy)) return null;
      return { ...shape, size: r3(shape.size * fx), height: r3(shape.height * fz) };
    case 'sketch':
      return { ...shape, contours: shape.contours.map((c) => c.map(([x, y]) => [r3(x * fx), r3(y * fy)])), height: r3(shape.height * fz) };
    default:
      return null; // group, sdf, image, mesh
  }
}

/** Keep picked texture regions on their face when the shape grows or shrinks. */
function scaleRegions(mods: Modifier[], [fx, fy, fz]: V3): Modifier[] {
  return mods.map((m) =>
    m.type === 'displace' && m.region
      ? { ...m, region: { ...m.region, point: [r3(m.region.point[0] * fx), r3(m.region.point[1] * fy), r3(m.region.point[2] * fz)] } }
      : m,
  );
}

/** Whether resizing this object scales it as a whole (rather than changing its own dimensions). */
export function resizeScales(node: SceneNode) {
  return scaleShape(node.shape, [2, 2, 2]) === null;
}

/**
 * Resize `id` so that its size along bed axis `axis` becomes `value` mm.
 * `uniform` keeps the proportions. Returns how it was done.
 */
export async function resizeTo(id: string, axis: 0 | 1 | 2, value: number, uniform: boolean): Promise<'parameters' | 'scale'> {
  if (!(value > 0)) throw new Error('The size must be positive');
  const st = useStore.getState();
  const node0 = findNode(st.nodes, id);
  if (!node0) throw new Error('Object not found');
  const b0 = await geometry.bounds(node0);
  const S0 = [0, 1, 2].map((i) => b0.max[i] - b0.min[i]);
  if (S0[axis] < 1e-6) throw new Error('This object has no size along that axis');
  const map = axisMapping(node0.transform.rotation);
  if (!uniform && !map) throw new Error('Free resizing works when the rotation is in steps of 90°. Lock the proportions, or straighten the object first.');

  // Factors per local axis for a factor f along the chosen bed axis.
  const localFactors = (f: number): V3 => {
    if (uniform) return [f, f, f];
    const l: V3 = [1, 1, 1];
    l[map![axis]] = f;
    return l;
  };
  const apply = (f: number) => {
    const L = localFactors(f);
    const shape = scaleShape(node0.shape, L);
    if (shape) {
      useStore.getState().updateNode(id, { shape, modifiers: scaleRegions(node0.modifiers, L) });
      return 'parameters' as const;
    }
    const s = node0.transform.scale;
    useStore.getState().updateNode(id, { transform: { ...node0.transform, scale: [r3(s[0] * L[0]), r3(s[1] * L[1]), r3(s[2] * L[2])] } });
    return 'scale' as const;
  };
  const sizeNow = async () => {
    const n = findNode(useStore.getState().nodes, id)!;
    const b = await geometry.bounds(n);
    return { node: n, b, size: b.max[axis] - b.min[axis] };
  };

  st.checkpoint(); // one undo step for the whole resize
  const f1 = value / S0[axis];
  const how = apply(f1);
  let { b } = await sizeNow();
  const s1 = b.max[axis] - b.min[axis];
  // Parameters: modifiers (textures, chamfers…) add a fixed amount, so the size is
  // a·f + c rather than proportional. Two measurements give a and c: correct once.
  if (how === 'parameters' && Math.abs(s1 - value) > 0.01 && Math.abs(f1 - 1) > 1e-6) {
    const a = (s1 - S0[axis]) / (f1 - 1);
    const c = S0[axis] - a;
    if (a > 1e-9) {
      const f2 = (value - c) / a;
      if (f2 > 0) {
        apply(f2);
        b = (await sizeNow()).b;
      }
    }
  }
  // Keep the place: same centre on the bed, same bottom.
  const n = findNode(useStore.getState().nodes, id)!;
  const p = n.transform.position;
  const dx = (b0.min[0] + b0.max[0]) / 2 - (b.min[0] + b.max[0]) / 2;
  const dy = (b0.min[1] + b0.max[1]) / 2 - (b.min[1] + b.max[1]) / 2;
  const dz = b0.min[2] - b.min[2];
  if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 1e-4)
    useStore.getState().updateNode(id, { transform: { ...n.transform, position: [r3(p[0] + dx), r3(p[1] + dy), r3(p[2] + dz)] } });
  return how;
}

/** True if a group contains holes or text, which scaling would resize too. */
export function scalesFeatures(node: SceneNode): boolean {
  if (node.shape.kind !== 'group') return false;
  return node.shape.children.some((c) => c.hole || c.shape.kind === 'text' || scalesFeatures(c));
}
