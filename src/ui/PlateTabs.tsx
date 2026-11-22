import { useState } from 'react';
import { useStore } from '../model/store';

/** Plate tabs over the viewport: switch, add, rename (double-click) and remove plates. */
export function PlateTabs() {
  const plates = useStore((s) => s.plates);
  const active = useStore((s) => s.activePlate);
  const activeCount = useStore((s) => s.nodes.length);
  const { switchPlate, addPlate, renamePlate, removePlate } = useStore.getState();
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div className="plates">
      {plates.map((p) => {
        const count = p.id === active ? activeCount : p.nodes.length;
        return (
          <div key={p.id} className={`plate ${p.id === active ? 'active' : ''}`} onClick={() => switchPlate(p.id)}>
            {editing === p.id ? (
              <input
                autoFocus
                defaultValue={p.name}
                size={Math.max(6, p.name.length)}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  renamePlate(p.id, e.target.value);
                  setEditing(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') setEditing(null);
                }}
              />
            ) : (
              <span title="Double-click to rename" onDoubleClick={() => setEditing(p.id)}>
                {p.name}
              </span>
            )}
            <small>{count}</small>
            {plates.length > 1 && (
              <button
                className="icon"
                title="Remove plate"
                onClick={(e) => {
                  e.stopPropagation();
                  if (count === 0 || confirm(`Remove "${p.name}" and its ${count} object(s)?`)) removePlate(p.id);
                }}
              >
                ×
              </button>
            )}
          </div>
        );
      })}
      <button className="icon add" title="Add a plate" onClick={() => addPlate()}>
        +
      </button>
    </div>
  );
}
