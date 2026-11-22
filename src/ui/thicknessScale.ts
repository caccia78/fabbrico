// Colour bands for the Thickness view, relative to the nozzle diameter.
// Shared by the viewport and its legend.

export const THICKNESS_BANDS = [
  { factor: 1, color: '#ff3b30', label: (n: number) => `< ${fmt(n)} mm · won't print` },
  { factor: 2, color: '#ff9500', label: (n: number) => `< ${fmt(2 * n)} mm · fragile` },
  { factor: 3, color: '#ffd60a', label: (n: number) => `< ${fmt(3 * n)} mm · weak` },
  { factor: 6, color: '#34c759', label: (n: number) => `< ${fmt(6 * n)} mm · good` },
  { factor: Infinity, color: '#4f8cff', label: (n: number) => `≥ ${fmt(6 * n)} mm · solid` },
] as const;

function fmt(v: number) {
  return Math.round(v * 100) / 100;
}

export function thicknessColor(t: number, nozzle: number): string {
  for (const b of THICKNESS_BANDS) if (t < b.factor * nozzle) return b.color;
  return THICKNESS_BANDS[THICKNESS_BANDS.length - 1].color;
}
