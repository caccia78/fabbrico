// Image shapes: relief (bright = high), lithophane (dark = thick, to hold
// against the light) and logo (the dark or bright part, extruded).
// Images are stored in the scene as small grayscale data URLs; the worker
// decodes them before building (decoding is async, building is not).

import type { Manifold, ManifoldToplevel } from 'manifold-3d/manifold';
import type { LeafShape, SceneNode } from '../model/schema';

export type ImageShape = Extract<LeafShape, { kind: 'image' }>;

/** Grayscale pixels, 0 = black, 1 = white (transparent counts as white). */
export interface Gray {
  w: number;
  h: number;
  data: Float32Array;
}

const decoded = new Map<string, Gray>();

/** Make a decoded image available to the (synchronous) kernel, e.g. from tests. */
export function registerImage(url: string, gray: Gray) {
  decoded.set(url, gray);
}

function collect(nodes: SceneNode[], out: Set<string>) {
  for (const n of nodes) {
    if (n.shape.kind === 'image' && n.shape.image) out.add(n.shape.image);
    if (n.shape.kind === 'group') collect(n.shape.children, out);
  }
}

/** Decode every image used by these nodes that isn't decoded yet (worker only: needs OffscreenCanvas). */
export async function prepareImages(nodes: SceneNode[]) {
  const urls = new Set<string>();
  collect(nodes, urls);
  for (const url of urls) {
    if (decoded.has(url)) continue;
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const px = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const data = new Float32Array(bitmap.width * bitmap.height);
    for (let i = 0; i < data.length; i++) {
      const a = px[i * 4 + 3] / 255;
      const lum = (0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) / 255;
      data[i] = lum * a + (1 - a);
    }
    decoded.set(url, { w: bitmap.width, h: bitmap.height, data });
    if (decoded.size > 30) decoded.delete(decoded.keys().next().value!);
  }
}

/** Bilinear sample at (u, v) in 0..1, v = 0 at the top of the image. */
function sample(g: Gray, u: number, v: number) {
  const x = Math.min(g.w - 1, Math.max(0, u * (g.w - 1)));
  const y = Math.min(g.h - 1, Math.max(0, v * (g.h - 1)));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(g.w - 1, x0 + 1), y1 = Math.min(g.h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const a = g.data[y0 * g.w + x0], b = g.data[y0 * g.w + x1];
  const c = g.data[y1 * g.w + x0], d = g.data[y1 * g.w + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/** Solid for an image shape, centred on the Z axis, sitting on z = 0. */
export function imageSolid(wasm: ManifoldToplevel, shape: ImageShape): Manifold {
  if (!shape.image) throw new Error('No image loaded: choose an image in the inspector');
  const g = decoded.get(shape.image);
  if (!g) throw new Error('Image not decoded yet');
  const W = shape.width;
  if (!(W > 0)) throw new Error('Image width must be positive');
  const H = (W * g.h) / g.w;
  const res = Math.max(0.15, shape.resolution || 0.4);
  // Keep the grid bounded (~250k samples).
  const step = Math.max(res, Math.sqrt((W * H) / 250_000));
  const nx = Math.max(2, Math.round(W / step) + 1);
  const ny = Math.max(2, Math.round(H / step) + 1);

  if (shape.mode === 'logo') return logoSolid(wasm, shape, g, W, H, step);

  const value = (i: number, j: number) => {
    let t = sample(g, i / (nx - 1), 1 - j / (ny - 1)); // j = 0 is the bottom edge (y min) = image's last row
    if (shape.mode === 'lithophane') t = 1 - t; // dark = thick, lets less light through
    if (shape.invert) t = 1 - t;
    return t;
  };

  // Closed grid: top surface (heights), flat bottom, four side walls.
  const nTop = nx * ny;
  const vert = new Float32Array(nTop * 2 * 3);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const x = -W / 2 + (i * W) / (nx - 1), y = -H / 2 + (j * H) / (ny - 1);
      vert.set([x, y, shape.thickness + shape.depth * value(i, j)], k * 3);
      vert.set([x, y, 0], (nTop + k) * 3);
    }
  const top = (i: number, j: number) => j * nx + i;
  const bot = (i: number, j: number) => nTop + j * nx + i;
  const tris: number[] = [];
  const quad = (a: number, b: number, c: number, d: number) => tris.push(a, b, c, a, c, d); // counter-clockwise seen from outside
  for (let j = 0; j < ny - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      quad(top(i, j), top(i + 1, j), top(i + 1, j + 1), top(i, j + 1));
      quad(bot(i, j), bot(i, j + 1), bot(i + 1, j + 1), bot(i + 1, j));
    }
  for (let i = 0; i < nx - 1; i++) {
    quad(bot(i, 0), bot(i + 1, 0), top(i + 1, 0), top(i, 0)); // front (y min)
    quad(bot(i + 1, ny - 1), bot(i, ny - 1), top(i, ny - 1), top(i + 1, ny - 1)); // back
  }
  for (let j = 0; j < ny - 1; j++) {
    quad(bot(0, j + 1), bot(0, j), top(0, j), top(0, j + 1)); // left (x min)
    quad(bot(nx - 1, j), bot(nx - 1, j + 1), top(nx - 1, j + 1), top(nx - 1, j)); // right
  }
  const mesh = new wasm.Mesh({ numProp: 3, vertProperties: vert, triVerts: new Uint32Array(tris) });
  mesh.merge();
  return new wasm.Manifold(mesh);
}

/** Logo: the part of the image darker than the threshold (or lighter, if inverted), extruded by `depth`. */
function logoSolid(wasm: ManifoldToplevel, shape: ImageShape, g: Gray, W: number, H: number, step: number): Manifold {
  const thr = Math.min(0.99, Math.max(0.01, shape.threshold));
  const depth = shape.depth;
  if (!(depth > 0)) throw new Error('Logo depth must be positive');
  const scale = step * 2; // turns brightness distance into roughly mm near the edge
  const m = wasm.Manifold.levelSet(
    (p) => {
      const u = (p[0] + W / 2) / W, v = 1 - (p[1] + H / 2) / H;
      if (u < 0 || u > 1 || v < 0 || v > 1) return -1;
      let inside = (thr - sample(g, u, v)) / 0.1; // > 0 where darker than the threshold
      if (shape.invert) inside = -inside;
      return Math.min(inside * scale, p[2], depth - p[2]);
    },
    { min: [-W / 2 - step, -H / 2 - step, -step], max: [W / 2 + step, H / 2 + step, depth + step] },
    step,
  );
  if (m.isEmpty()) throw new Error('Logo is empty: adjust the threshold or invert');
  return m;
}
