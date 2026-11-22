// Printer presets: build volume (X, Y, Z in mm) and nozzle. The bed size drives
// the viewport, the printability check and what the AI is told.

export interface Printer {
  id: string;
  name: string;
  bed: [number, number, number];
  nozzle: number;
}

export const PRINTERS: Printer[] = [
  { id: 'bambu-a1', name: 'Bambu Lab A1', bed: [256, 256, 256], nozzle: 0.4 },
  { id: 'bambu-a1-mini', name: 'Bambu Lab A1 mini', bed: [180, 180, 180], nozzle: 0.4 },
  { id: 'bambu-p1', name: 'Bambu Lab P1P / P1S', bed: [256, 256, 256], nozzle: 0.4 },
  { id: 'bambu-x1', name: 'Bambu Lab X1 Carbon', bed: [256, 256, 256], nozzle: 0.4 },
  { id: 'prusa-mk4', name: 'Prusa MK4 / MK4S', bed: [250, 210, 220], nozzle: 0.4 },
  { id: 'prusa-core-one', name: 'Prusa CORE One', bed: [250, 220, 270], nozzle: 0.4 },
  { id: 'prusa-mini', name: 'Prusa MINI+', bed: [180, 180, 180], nozzle: 0.4 },
  { id: 'prusa-xl', name: 'Prusa XL', bed: [360, 360, 360], nozzle: 0.4 },
  { id: 'creality-ender3', name: 'Creality Ender-3 (V2, V3 SE)', bed: [220, 220, 250], nozzle: 0.4 },
  { id: 'creality-k1', name: 'Creality K1 / K1C', bed: [220, 220, 250], nozzle: 0.4 },
  { id: 'creality-k1-max', name: 'Creality K1 Max', bed: [300, 300, 300], nozzle: 0.4 },
];

export const DEFAULT_PRINTER = PRINTERS[0];
export const CUSTOM = 'custom';

export const printerById = (id: string) => PRINTERS.find((p) => p.id === id);

export const bedLabel = (b: [number, number, number]) => `${b[0]} × ${b[1]} × ${b[2]} mm`;
