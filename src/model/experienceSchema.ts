// Experience library (experimental): format of one experience, shared by the
// page and the local server (server/library.ts). Free of browser dependencies.
//
// On disk, one folder per experience in ~/Documents/Fabbrico/Library/<id>/:
//   experience.json   this schema
//   it.md, en.md      the text in Italian and English
//   media/            renders and photos (JPEG)
//   model.json        the scene objects it is about (insertable in a project)

import { z } from 'zod/v4';

export const EXPERIENCE_KINDS = ['component', 'technique', 'fit', 'problem'] as const;
export const KIND_LABEL: Record<(typeof EXPERIENCE_KINDS)[number], string> = {
  component: 'Component',
  technique: 'Technique',
  fit: 'Fit / tolerance',
  problem: 'Solved problem',
};

/** Derived from the outcomes the maker reported, never set by the AI. */
export const STATUSES = ['hypothesis', 'tested', 'confirmed'] as const;

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,59}$/;

const Bilingual = z.object({ it: z.string(), en: z.string() });

export const ExperienceSchema = z.object({
  format: z.literal('fabbrico-experience'),
  version: z.literal(1),
  id: z.string().regex(ID_PATTERN),
  kind: z.enum(EXPERIENCE_KINDS),
  title: Bilingual,
  summary: Bilingual,
  tags: z.array(z.string()).default([]),
  status: z.enum(STATUSES),
  /** Prints with a reported outcome. */
  prints: z.number().int().min(0),
  /** Where it was learnt: printer, nozzle, material of the attempts. */
  context: z.object({ printer: z.string(), nozzle: z.number(), material: z.string() }),
  /** Key values, language-neutral (e.g. clearance_mm: 0.5). */
  values: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  /** The attempts it comes from: what changed and how it went. */
  attempts: z
    .array(
      z.object({
        n: z.number().int(),
        plate: z.string(),
        at: z.string(),
        changes: z.array(z.string()).default([]),
        outcome: z.string(),
        note: z.string().default(''),
        render: z.string().optional(),
        photos: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  source: z.object({ project: z.string() }),
  /** Files in media/, with what they show. */
  media: z.array(z.object({ file: z.string(), kind: z.enum(['render', 'photo']), caption: z.string().default('') })).default([]),
  model: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Experience = z.infer<typeof ExperienceSchema>;

/** One entry of the library index. */
export type ExperienceSummary = Pick<Experience, 'id' | 'kind' | 'title' | 'summary' | 'tags' | 'status' | 'prints' | 'context' | 'updatedAt'> & {
  thumb?: string;
};

/** What the page sends to save an experience. */
export const SavePayloadSchema = z.object({
  experience: ExperienceSchema,
  it: z.string(),
  en: z.string(),
  /** media/<file> → JPEG data URL. */
  media: z.record(z.string(), z.string()).default({}),
  /** Scene objects, as in a project file. */
  model: z.array(z.unknown()).optional(),
});
export type SavePayload = z.infer<typeof SavePayloadSchema>;

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'experience';
