// Print-preparation actions shared by the UI and the AI tools. They don't
// push undo history: callers checkpoint (one per click / per AI turn).

import { geometry } from '../geometry/client';
import { useStore } from './store';

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Move a root object vertically so its lowest point rests on z = 0. */
export async function dropToBed(id: string) {
  const node = useStore.getState().nodes.find((n) => n.id === id);
  if (!node) throw new Error(`No root object with id ${id}`);
  const b = await geometry.bounds(node);
  const p = node.transform.position;
  useStore.getState().updateNode(id, { transform: { ...node.transform, position: [p[0], p[1], r2(p[2] - b.min[2])] } });
}

/** Rotate a root object to the orientation that needs the least support, then drop it on the bed. */
export async function orientForPrint(id: string) {
  const st = useStore.getState();
  const node = st.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`No root object with id ${id}`);
  const result = await geometry.orient(node, st.settings.overhangAngle);
  useStore.getState().updateNode(id, { transform: { ...node.transform, rotation: result.rotation } });
  await dropToBed(id);
  return result;
}
