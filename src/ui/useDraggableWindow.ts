import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';

/**
 * A floating window the user can drag by its header (spread `handle` on it).
 * The position is remembered under `storageKey` and kept on screen.
 */
export function useDraggableWindow(storageKey: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    } catch {
      return null;
    }
  });
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  const clamp = useCallback((x: number, y: number) => {
    const el = ref.current;
    const w = el?.offsetWidth ?? 300, h = el?.offsetHeight ?? 200;
    // Keep at least the header reachable.
    return {
      x: Math.min(Math.max(x, 40 - w), window.innerWidth - 40),
      y: Math.min(Math.max(y, 0), window.innerHeight - Math.min(h, 40)),
    };
  }, []);

  useEffect(() => {
    if (pos) localStorage.setItem(storageKey, JSON.stringify(pos));
  }, [pos, storageKey]);

  useEffect(() => {
    const onResize = () => setPos((p) => (p ? clamp(p.x, p.y) : p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clamp]);

  const handle = {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if ((e.target as HTMLElement).closest('button, input, select')) return;
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      if (!drag.current) return;
      setPos(clamp(e.clientX - drag.current.dx, e.clientY - drag.current.dy));
    },
    onPointerUp: () => {
      drag.current = null;
    },
    style: { cursor: 'move', touchAction: 'none' } as CSSProperties,
  };

  // Until moved, centre it near the top.
  const style: CSSProperties = pos ? { left: pos.x, top: pos.y } : { left: '50%', top: 60, transform: 'translateX(-50%)' };
  return { ref, style, handle };
}
