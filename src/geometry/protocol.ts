// Messages between the main thread (client.ts) and the geometry worker (worker.ts).

import type { SceneNode, Transform } from '../model/schema';
import type { AnalyzeOpts, PrintReport } from './analysis';
import type { MeshData } from './convert';
import type { MeshAsset } from '../model/assets';
import type { ThicknessData } from './thickness';
import type { OrientResult } from './orient';

export type Vec3 = [number, number, number];
export interface Bounds {
  min: Vec3;
  max: Vec3;
  empty: boolean;
}

/** Cross-section of a solid at height z, in world coordinates. */
export interface Outline {
  z: number;
  /** Closed contours, [x, y] in mm, counter-clockwise for outer outlines, clockwise for holes. */
  contours: [number, number][][];
  area: number;
  bounds: { min: [number, number]; max: [number, number] };
}

export type GeometryRequest =
  | { op: 'init' }
  | { op: 'asset'; id: string; asset: MeshAsset }
  | { op: 'mesh'; node: SceneNode }
  | { op: 'bounds'; node: SceneNode }
  | { op: 'thickness'; node: SceneNode }
  | { op: 'orient'; node: SceneNode; overhangAngle: number }
  | { op: 'outline'; node: SceneNode; ancestors: Transform[]; z?: number; offset: number; tolerance: number }
  | { op: 'analyze'; nodes: SceneNode[]; opts: AnalyzeOpts }
  | { op: 'export'; nodes: SceneNode[]; format: '3mf' | 'stl' };

export interface GeometryResults {
  init: true;
  asset: true;
  mesh: MeshData;
  bounds: Bounds;
  thickness: ThicknessData;
  orient: OrientResult;
  outline: Outline;
  analyze: PrintReport;
  export: Uint8Array;
}

export type GeometryResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
