// Turning tracings into objects: one tracing becomes an extruded outline;
// several tracings of the same object from different sides become the
// intersection of their extrusions (each along its own viewing direction),
// which approximates the object (cavities hidden from every view are lost).

import { useStore } from '../model/store';
import { identity, type SceneNode, type Transform } from '../model/schema';
import { dropToBed } from '../model/printActions';
import { tracingToOutline, type Pt } from './outline';
import type { Tracing } from './connection';
import type { View } from './views';
import { alignViews, rotateOutline } from './align';

type Axis = 'x' | 'y' | 'z';

/**
 * How a view's outline maps to the world: screen right (u) and screen up (v)
 * become `u` and `v` axes, the extrusion runs along `w`. The rotation does
 * exactly that for a shape extruded along its local Z (rotate X, then Y, then Z).
 */
const VIEW_MAP: Record<View, { rotation: [number, number, number]; u: Axis; v: Axis; w: Axis; wSign: 1 | -1 }> = {
  top: { rotation: [0, 0, 0], u: 'x', v: 'y', w: 'z', wSign: 1 },
  bottom: { rotation: [180, 0, 0], u: 'x', v: 'y', w: 'z', wSign: -1 },
  front: { rotation: [90, 0, 0], u: 'x', v: 'z', w: 'y', wSign: -1 },
  back: { rotation: [90, 0, 180], u: 'x', v: 'z', w: 'y', wSign: 1 },
  right: { rotation: [90, 0, 90], u: 'y', v: 'z', w: 'x', wSign: 1 },
  left: { rotation: [90, 0, -90], u: 'y', v: 'z', w: 'x', wSign: -1 },
};

interface Outline {
  tracing: Tracing;
  label: View;
  contours: Pt[][];
  strokeRadius: number;
  width: number;
  height: number;
}

function outlineOf(t: Tracing): Outline {
  const { contours, strokeRadius } = tracingToOutline(t.strokes);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of contours)
    for (const [x, y] of c) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return {
    tracing: t,
    label: t.label,
    // Centred, so views line up by their bounding boxes.
    contours: contours.map((c) => c.map(([x, y]) => [r3(x - cx), r3(y - cy)] as Pt)),
    strokeRadius,
    width: x1 - x0 + 2 * strokeRadius,
    height: y1 - y0 + 2 * strokeRadius,
  };
}

function sketchNode(o: Outline, height: number, transform: Transform): Omit<SceneNode, 'id' | 'color'> {
  return {
    name: `tracing (${o.tracing.label})`,
    hole: false,
    modifiers: [],
    transform,
    shape: { kind: 'sketch', contours: o.contours, height, penOffset: 0.8, strokeRadius: o.strokeRadius },
  };
}

/** One tracing → an outline extruded straight up by `height` mm, on the bed. */
export async function extrudeTracing(t: Tracing, height: number) {
  const o = outlineOf(t);
  const st = useStore.getState();
  st.checkpoint();
  const id = st.addNode(sketchNode(o, height, identity()));
  return id;
}

/**
 * Several tracings of the same object from different sides → one object: the
 * intersection of each outline extruded along its viewing direction.
 * Returns the group and the views that were turned to line up with the others.
 */
export async function combineTracings(ts: Tracing[]) {
  const labels = new Set(ts.map((t) => t.label));
  if (ts.length < 2 || labels.size !== ts.length) throw new Error('Pick at least two tracings with different views');
  const raw = ts.map(outlineOf);
  const turns = alignViews(raw);
  const outlines = raw.map((o, i) => rotateOutline(o, turns[i]));
  const turned = outlines.flatMap((o, i) => (turns[i] ? [`${o.tracing.label} ${turns[i] === 2 ? '180°' : '90°'}`] : []));

  // Size of the object along each axis, from the views that see it.
  const extent: Record<Axis, number> = { x: 0, y: 0, z: 0 };
  for (const o of outlines) {
    const m = VIEW_MAP[o.tracing.label];
    extent[m.u] = Math.max(extent[m.u], o.width);
    extent[m.v] = Math.max(extent[m.v], o.height);
  }
  const fallback = Math.max(extent.x, extent.y, extent.z);
  const st = useStore.getState();
  st.checkpoint();
  const ids: string[] = [];
  for (const o of outlines) {
    const m = VIEW_MAP[o.tracing.label];
    // Extrude a little longer than the object so the cut is clean, centred on it.
    const h = (extent[m.w] || fallback) + 2;
    const position: [number, number, number] = [0, 0, 0];
    position[{ x: 0, y: 1, z: 2 }[m.w]] = -m.wSign * (h / 2);
    ids.push(st.addNode(sketchNode(o, h, { ...identity(), rotation: m.rotation, position })));
  }
  const group = st.groupNodes(ids, 'intersection', 'traced object');
  if (!group) throw new Error('Could not combine the views');
  await dropToBed(group);
  return { group, turned };
}

/** Bounding size of a tracing's strokes (mm), for previews. */
export function strokeBounds(strokes: number[][]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes)
    for (let i = 0; i < s.length; i += 2) {
      x0 = Math.min(x0, s[i]); x1 = Math.max(x1, s[i]);
      y0 = Math.min(y0, s[i + 1]); y1 = Math.max(y1, s[i + 1]);
    }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}
