// Fabbrico was called Forma before. This module keeps data saved under the old
// name working: browser settings, project files (.forma) and source labels.
// Imported first by each page, so the migration runs before the stores read.

/** Former project file extension and format tag, still opened. */
export const LEGACY_PROJECT_EXT = '.forma';
export const LEGACY_PROJECT_FORMAT = 'forma-project';

/** Maps the old "forma" source label (diary outcomes, notes) to "fabbrico". */
export const legacySource = (v: unknown) => (v === 'forma' ? 'fabbrico' : v);

// Browser settings saved as forma.* move to fabbrico.* (once; newer values win).
try {
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith('forma.')) continue;
    const next = `fabbrico.${key.slice('forma.'.length)}`;
    const value = localStorage.getItem(key);
    if (value !== null && localStorage.getItem(next) === null) localStorage.setItem(next, value);
    localStorage.removeItem(key);
  }
} catch {
  // Storage unavailable (private mode): nothing to migrate.
}
