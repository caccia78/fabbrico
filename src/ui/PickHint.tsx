import { findNode, useStore } from '../model/store';

/** Banner shown while waiting for the user to click a face in the viewport. */
export function PickHint() {
  const picking = useStore((s) => s.picking);
  const name = useStore((s) => (s.picking ? findNode(s.nodes, s.picking.nodeId)?.name : null));
  if (!picking) return null;
  return (
    <div className="geo-status pick-hint">
      Click the face of “{name}” to texture
      <button className="small" onClick={() => useStore.getState().setPicking(null)}>
        Cancel
      </button>
    </div>
  );
}
