// Experience library on disk (experimental), served under /local-api/library
// by the local actions plugin (localActions.ts, which also checks that the
// request comes from Fabbrico on this computer).
//
//   GET  /library              index: every experience (experience.json) + a small thumbnail
//   GET  /library/item?id=     one experience: data, it.md, en.md, media as data URLs, model
//   POST /library/save         body = SavePayload JSON; writes the folder (?overwrite=1 to replace)
//   POST /library/open?id=     shows the library (or one experience) in Finder / Explorer
//
// Folder: ~/Documents/Fabbrico/Library (override with FABBRICO_LIBRARY_DIR).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ExperienceSchema, ID_PATTERN, SavePayloadSchema, type ExperienceSummary } from '../src/model/experienceSchema.ts';

export const libraryDir = () => process.env.FABBRICO_LIBRARY_DIR || join(homedir(), 'Documents', 'Fabbrico', 'Library');

const MEDIA_NAME = /^[a-z0-9][a-z0-9-]{0,60}\.jpg$/;
const JPEG_URL = 'data:image/jpeg;base64,';

type Json = (res: ServerResponse, status: number, body: unknown) => void;

async function readExperience(id: string) {
  const dir = join(libraryDir(), id);
  const parsed = ExperienceSchema.safeParse(JSON.parse(await readFile(join(dir, 'experience.json'), 'utf8')));
  if (!parsed.success) throw new Error(`${id}/experience.json is not valid`);
  return { dir, exp: parsed.data };
}

const dataUrl = async (file: string) => JPEG_URL + (await readFile(file)).toString('base64');

export async function handleLibrary(req: IncomingMessage, res: ServerResponse, url: URL, json: Json, readBody: (r: IncomingMessage) => Promise<Buffer>, open: (target: string) => Promise<void>) {
  const path = url.pathname.replace(/^\/library/, '') || '/';
  const id = url.searchParams.get('id') ?? '';
  if (id && !ID_PATTERN.test(id)) return json(res, 400, { error: 'Bad id' });

  if (req.method === 'GET' && path === '/') {
    const root = libraryDir();
    const items: ExperienceSummary[] = [];
    const skipped: string[] = [];
    if (existsSync(root)) {
      for (const d of await readdir(root, { withFileTypes: true })) {
        if (!d.isDirectory() || !ID_PATTERN.test(d.name)) continue;
        try {
          const { dir, exp } = await readExperience(d.name);
          const first = exp.media.find((m) => m.kind === 'photo') ?? exp.media[0];
          const thumb = first && MEDIA_NAME.test(first.file) && existsSync(join(dir, 'media', first.file)) ? await dataUrl(join(dir, 'media', first.file)) : undefined;
          const { id, kind, title, summary, tags, status, prints, context, updatedAt } = exp;
          items.push({ id, kind, title, summary, tags, status, prints, context, updatedAt, thumb });
        } catch {
          skipped.push(d.name);
        }
      }
    }
    items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return json(res, 200, { dir: root, items, skipped });
  }

  if (req.method === 'GET' && path === '/item') {
    if (!id) return json(res, 400, { error: 'Missing id' });
    if (!existsSync(join(libraryDir(), id, 'experience.json'))) return json(res, 404, { error: `No experience "${id}"` });
    const { dir, exp } = await readExperience(id);
    const text = async (f: string) => (existsSync(join(dir, f)) ? readFile(join(dir, f), 'utf8') : '');
    const media: Record<string, string> = {};
    for (const m of exp.media) if (MEDIA_NAME.test(m.file) && existsSync(join(dir, 'media', m.file))) media[m.file] = await dataUrl(join(dir, 'media', m.file));
    const model = exp.model && existsSync(join(dir, 'model.json')) ? JSON.parse(await readFile(join(dir, 'model.json'), 'utf8')) : undefined;
    return json(res, 200, { experience: exp, it: await text('it.md'), en: await text('en.md'), media, model, dir });
  }

  if (req.method === 'POST' && path === '/save') {
    const parsed = SavePayloadSchema.safeParse(JSON.parse((await readBody(req)).toString('utf8')));
    if (!parsed.success) return json(res, 400, { error: 'Invalid experience' });
    const { experience, it, en, media, model } = parsed.data;
    for (const [name, data] of Object.entries(media))
      if (!MEDIA_NAME.test(name) || !data.startsWith(JPEG_URL)) return json(res, 400, { error: `Bad media file ${name}` });
    const dir = join(libraryDir(), experience.id);
    const overwrite = url.searchParams.get('overwrite') === '1';
    if (existsSync(dir) && !overwrite) return json(res, 409, { error: `An experience "${experience.id}" already exists` });
    // Write into a temporary folder, then swap it in.
    await mkdir(libraryDir(), { recursive: true });
    const tmp = join(libraryDir(), `.tmp-${experience.id}-${Date.now()}`);
    await mkdir(join(tmp, 'media'), { recursive: true });
    await writeFile(join(tmp, 'experience.json'), JSON.stringify({ ...experience, model: !!model }, null, 2));
    await writeFile(join(tmp, 'it.md'), it);
    await writeFile(join(tmp, 'en.md'), en);
    for (const [name, data] of Object.entries(media)) await writeFile(join(tmp, 'media', name), Buffer.from(data.slice(JPEG_URL.length), 'base64'));
    if (model) await writeFile(join(tmp, 'model.json'), JSON.stringify(model, null, 2));
    if (existsSync(dir)) await rm(dir, { recursive: true });
    await rename(tmp, dir);
    return json(res, 200, { id: experience.id, dir });
  }

  if (req.method === 'POST' && path === '/open') {
    const target = id ? join(libraryDir(), id) : libraryDir();
    await mkdir(target, { recursive: true });
    await open(target);
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: 'Not found' });
}
