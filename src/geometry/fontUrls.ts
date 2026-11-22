// Font files for text shapes (Droid, Apache 2.0: see fonts/NOTICE). Imported
// only by the worker, which fetches them once at start-up.

import sans from './fonts/droid_sans_regular.typeface.json?url';
import sansBold from './fonts/droid_sans_bold.typeface.json?url';
import serif from './fonts/droid_serif_regular.typeface.json?url';
import mono from './fonts/droid_sans_mono_regular.typeface.json?url';
import type { FontName } from '../model/schema';

export const FONT_URLS: Record<FontName, string> = { sans, 'sans-bold': sansBold, serif, mono };
