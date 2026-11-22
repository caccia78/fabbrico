// Client for the dev server's local actions (server/localActions.ts): save an
// export into the export folder, open it in an installed slicer, show the folder.
// Only available when Fabbrico runs from its own dev server (npm start); elsewhere
// `useLocalActions` reports nothing and the buttons stay hidden.

import { create } from 'zustand';
import type { SceneNode } from '../model/schema';
import { geometry } from '../geometry/client';

export interface LocalInfo {
  exportDir: string;
  slicers: { id: string; name: string }[];
}

const HEADERS = { 'X-Fabbrico': '1' };

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/local-api${path}`, { ...init, headers: { ...HEADERS, ...init.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

export const useLocalActions = create<{ info: LocalInfo | null }>(() => ({ info: null }));

/** Asks the dev server what it can do (once, at start-up). */
export function loadLocalActions() {
  call<LocalInfo>('/info')
    .then((info) => useLocalActions.setState({ info }))
    .catch(() => useLocalActions.setState({ info: null }));
}

/** Saves the model as 3MF in the export folder and opens it in the given slicer. */
export async function openInSlicer(nodes: SceneNode[], slicerId: string, name: string) {
  const bytes = await geometry.exportBytes(nodes, '3mf');
  return call<{ file: string }>(`/export?format=3mf&open=${encodeURIComponent(slicerId)}&name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes as BodyInit,
  });
}

export function openExportFolder() {
  return call<{ ok: true }>('/open-folder', { method: 'POST' });
}
