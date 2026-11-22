// Text shapes: glyph outlines from typeface fonts, turned into a 2D
// CrossSection the kernel extrudes. Fonts are Droid Sans / Serif / Mono
// (Apache 2.0, see fonts/NOTICE), loaded once by the geometry worker.

import { Font } from 'three/examples/jsm/loaders/FontLoader.js';
import type { CrossSection, ManifoldToplevel } from 'manifold-3d/manifold';
import type { FontName } from '../model/schema';

const fonts = new Map<FontName, { font: Font; capHeight: number }>();

/** Register a parsed typeface.json font. */
export function registerFont(name: FontName, json: unknown) {
  const font = new Font(json as ConstructorParameters<typeof Font>[0]);
  // Measure the cap height (top of "H") so `size` means the height of capital letters.
  let top = 0;
  for (const shape of font.generateShapes('H', 1000))
    for (const p of shape.getPoints(1)) top = Math.max(top, p.y);
  fonts.set(name, { font, capHeight: top / 1000 || 0.7 });
}

export function hasFont(name: FontName) {
  return fonts.has(name);
}

type Pt = [number, number];
const signedArea = (pts: Pt[]) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
};
/** Drop repeated points (including a closing copy of the first one). */
function dedupe(pts: Pt[]): Pt[] {
  const out = pts.filter((p, k) => k === 0 || p[0] !== pts[k - 1][0] || p[1] !== pts[k - 1][1]);
  if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  return out;
}
const ccw = (pts: Pt[]) => (signedArea(pts) < 0 ? [...pts].reverse() : pts);
const cw = (pts: Pt[]) => (signedArea(pts) > 0 ? [...pts].reverse() : pts);

/**
 * Outline of a block of text, centred on the origin. `size` is the cap height
 * in mm; lines are spaced 1.5 × size and aligned left, centre or right.
 */
export function textCrossSection(
  wasm: ManifoldToplevel,
  opts: { text: string; font: FontName; size: number; align: 'left' | 'center' | 'right' },
): CrossSection {
  const entry = fonts.get(opts.font);
  if (!entry) throw new Error(`Font "${opts.font}" is not loaded`);
  if (opts.size <= 0) throw new Error('Text size must be positive');
  const fontSize = opts.size / entry.capHeight;
  const lines = opts.text.split('\n');
  const lineStep = opts.size * 1.5;
  // Curve detail: about one segment per 0.3 mm of a typical curve.
  const divisions = Math.max(2, Math.min(12, Math.round(opts.size / 1.5)));

  const contours: Pt[][] = [];
  const lineContours: { pts: Pt[][]; minX: number; maxX: number }[] = [];
  lines.forEach((line, i) => {
    const y0 = -i * lineStep;
    const pts: Pt[][] = [];
    let minX = Infinity, maxX = -Infinity;
    for (const shape of entry.font.generateShapes(line, fontSize)) {
      const { shape: outer, holes } = shape.extractPoints(divisions);
      const toPts = (vs: { x: number; y: number }[]) => vs.map((v) => [v.x, v.y + y0] as Pt);
      // Glyph contours come with mixed orientation: outers counter-clockwise, holes clockwise.
      pts.push(ccw(toPts(outer)));
      for (const h of holes) pts.push(cw(toPts(h)));
      for (const v of outer) {
        minX = Math.min(minX, v.x);
        maxX = Math.max(maxX, v.x);
      }
    }
    lineContours.push({ pts, minX, maxX });
  });

  // Align each line, then centre the whole block.
  const widest = Math.max(...lineContours.map((l) => (isFinite(l.minX) ? l.maxX - l.minX : 0)));
  for (const l of lineContours) {
    if (!isFinite(l.minX)) continue;
    const w = l.maxX - l.minX;
    const dx = -l.minX + (opts.align === 'center' ? (widest - w) / 2 : opts.align === 'right' ? widest - w : 0);
    for (const c of l.pts) contours.push(dedupe(c.map(([x, y]) => [x + dx, y] as Pt)));
  }
  if (!contours.length) throw new Error('Text is empty');

  const cs = new wasm.CrossSection(contours.filter((c) => c.length >= 3), 'Positive');
  const b = cs.bounds();
  const centred = cs.translate([-(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2]);
  cs.delete();
  return centred;
}
