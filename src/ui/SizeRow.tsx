import { useEffect, useRef, useState } from 'react';
import type { SceneNode } from '../model/schema';
import { localGeometryKey } from '../model/schema';
import { geometry, GeometryCancelled } from '../geometry/client';
import { resizeScales, resizeTo, scalesFeatures } from '../model/resize';
import { NumInput, Row } from './fields';
import { runAction } from './runAction';

const LOCK_KEY = 'fabbrico.size.uniform';
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Size along the bed axes, in mm, editable; the chain keeps proportions. */
export function SizeRow({ node }: { node: SceneNode }) {
  const [uniform, setUniform] = useState(() => {
    try {
      return localStorage.getItem(LOCK_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const [size, setSize] = useState<number[] | null>(null);
  const [busy, setBusy] = useState(false);
  const key = JSON.stringify([localGeometryKey(node), node.transform]);
  const nodeRef = useRef(node);
  useEffect(() => {
    nodeRef.current = node;
  });

  useEffect(() => {
    let live = true;
    geometry.bounds(nodeRef.current).then(
      (b) => live && setSize([0, 1, 2].map((i) => r2(b.max[i] - b.min[i]))),
      (e: Error) => {
        if (live && !(e instanceof GeometryCancelled)) setSize(null);
      },
    );
    return () => {
      live = false;
    };
  }, [key]);

  const toggle = () => {
    setUniform((u) => {
      try {
        localStorage.setItem(LOCK_KEY, u ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !u;
    });
  };
  const scales = resizeScales(node);

  return (
    <>
      <Row label="size mm">
        <div className="size-row">
          <div className="vec">
            {(size ?? [0, 0, 0]).map((v, i) =>
              size ? (
                <NumInput
                  key={i}
                  value={v}
                  step={1}
                  onCommit={(nv) =>
                    runAction(async () => {
                      setBusy(true);
                      try {
                        await resizeTo(node.id, i as 0 | 1 | 2, nv, uniform);
                      } finally {
                        setBusy(false);
                      }
                    })
                  }
                />
              ) : (
                <input key={i} className="num" disabled value="…" readOnly />
              ),
            )}
          </div>
          <button
            className={`icon lock ${uniform ? 'active' : ''}`}
            title={uniform ? 'Proportions locked: all sizes change together' : 'Proportions free: only the size you edit changes'}
            onClick={toggle}
          >
            {uniform ? '🔗' : '⛓️‍💥'}
          </button>
        </div>
      </Row>
      {busy && <p className="muted small size-note">Resizing…</p>}
      {!busy && scales && scalesFeatures(node) && (
        <p className="warn-text small size-note">Resizing a group scales everything in it, holes and text included.</p>
      )}
    </>
  );
}
