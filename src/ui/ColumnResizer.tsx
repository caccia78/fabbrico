import { useEffect, useRef } from 'react';

// The two side columns of the layout. Each width lives in a CSS variable used
// by the grid in index.css and is remembered in localStorage.
const COLUMNS = {
  left: { cssVar: '--side-w', key: 'fabbrico.sidebar.width', min: 220, max: 640, def: 290 },
  right: { cssVar: '--chat-w', key: 'fabbrico.chat.width', min: 260, max: 720, def: 370 },
} as const;
type Side = keyof typeof COLUMNS;

const width = (side: Side) =>
  parseFloat(getComputedStyle(document.documentElement).getPropertyValue(COLUMNS[side].cssVar)) || COLUMNS[side].def;
const apply = (side: Side, w: number) => document.documentElement.style.setProperty(COLUMNS[side].cssVar, `${Math.round(w)}px`);
const save = (side: Side, w: number) => {
  try {
    localStorage.setItem(COLUMNS[side].key, String(Math.round(w)));
  } catch {
    /* ignore */
  }
};

/**
 * Drag handle on the inner edge of a side column (right edge of the left one,
 * left edge of the right one); double-click resets it.
 */
export function ColumnResizer({ side }: { side: Side }) {
  const c = COLUMNS[side];
  const drag = useRef<{ x: number; w: number } | null>(null);

  useEffect(() => {
    try {
      const w = Number(localStorage.getItem(c.key));
      if (w >= c.min && w <= c.max) apply(side, w);
    } catch {
      /* ignore */
    }
  }, [c, side]);

  const done = () => {
    save(side, width(side));
    window.dispatchEvent(new Event('resize')); // let the 3D view re-measure
  };

  return (
    <div
      className={`col-resizer ${side}`}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, w: width(side) };
        document.body.classList.add('resizing');
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const dx = (e.clientX - drag.current.x) * (side === 'left' ? 1 : -1);
        // Keep at least 300 px for the 3D view.
        const other = width(side === 'left' ? 'right' : 'left');
        const max = Math.min(c.max, window.innerWidth - other - 300);
        apply(side, Math.min(max, Math.max(c.min, drag.current.w + dx)));
      }}
      onPointerUp={() => {
        if (!drag.current) return;
        drag.current = null;
        document.body.classList.remove('resizing');
        done();
      }}
      onDoubleClick={() => {
        apply(side, c.def);
        done();
      }}
    />
  );
}
