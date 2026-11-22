import { useEffect, useState } from 'react';
import { geometry, useGeometryStatus } from '../geometry/client';

/** Small overlay shown while the geometry worker is busy for more than a moment, with a way out of slow builds. */
export function GeometryStatus() {
  const { busy, since } = useGeometryStatus();
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const update = () => setElapsed((performance.now() - since) / 1000);
    const t = setInterval(update, 250);
    return () => {
      clearInterval(t);
      setElapsed(0);
    };
  }, [busy, since]);
  if (!busy || elapsed < 0.4) return null;
  return (
    <div className="geo-status">
      <span className="spinner" />
      Building geometry… {elapsed >= 1 && <span className="muted">{Math.floor(elapsed)} s</span>}
      {elapsed >= 1 && (
        <button className="small" title="Stop the current build (the object keeps its last result)" onClick={() => geometry.cancel()}>
          Cancel
        </button>
      )}
    </div>
  );
}
