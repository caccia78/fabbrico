// Physical scale of the tablet screen: how many millimetres one CSS pixel is.
// Safari doesn't tell the iPad model, but the screen size in CSS pixels
// identifies the family, and Apple publishes each family's pixel density.

interface Family {
  /** Short side × long side, CSS pixels (portrait). */
  size: [number, number];
  name: string;
  ppi: number;
}

// Pixel ratio is 2 on every Retina iPad.
const FAMILIES: Family[] = [
  { size: [744, 1133], name: 'iPad mini (6th/7th gen)', ppi: 326 },
  { size: [810, 1080], name: 'iPad 10.2″ (7th–9th gen)', ppi: 264 },
  { size: [820, 1180], name: 'iPad 10.9″/11″ (iPad 10th gen+, iPad Air 4th gen+)', ppi: 264 },
  { size: [834, 1112], name: 'iPad Air 10.5″ / iPad Pro 10.5″', ppi: 264 },
  { size: [834, 1194], name: 'iPad Pro 11″ (1st–4th gen)', ppi: 264 },
  { size: [834, 1210], name: 'iPad Pro 11″ (M4 and later)', ppi: 264 },
  { size: [1024, 1366], name: 'iPad Pro 12.9″ / iPad Air 13″', ppi: 264 },
  { size: [1032, 1376], name: 'iPad Pro 13″ (M4 and later)', ppi: 264 },
];
// 768 × 1024 is shared by the iPad mini 2–5 (326 ppi) and 9.7″ iPads (264 ppi): ambiguous.

export interface ScaleInfo {
  /** Millimetres per CSS pixel. */
  mmPerPx: number;
  /** What we based it on. */
  source: string;
  /** True when we're confident (known model or user-calibrated). */
  sure: boolean;
}

const KEY = 'fabbrico.pad.scale';

export function detectScale(): ScaleInfo {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as ScaleInfo | null;
    if (saved?.mmPerPx) return saved;
  } catch {
    /* ignore */
  }
  const a = Math.min(screen.width, screen.height), b = Math.max(screen.width, screen.height);
  const dpr = window.devicePixelRatio || 2;
  const fam = FAMILIES.find((f) => f.size[0] === a && f.size[1] === b);
  if (fam) return { mmPerPx: (25.4 * dpr) / fam.ppi, source: fam.name, sure: true };
  // Unknown: assume the common 264 ppi and ask for a check.
  return { mmPerPx: (25.4 * dpr) / 264, source: `unknown screen ${a}×${b}`, sure: false };
}

export function saveCalibration(mmPerPx: number) {
  const info: ScaleInfo = { mmPerPx, source: 'calibrated by hand', sure: true };
  try {
    localStorage.setItem(KEY, JSON.stringify(info));
  } catch {
    /* ignore */
  }
  return info;
}

export function resetCalibration() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  return detectScale();
}
