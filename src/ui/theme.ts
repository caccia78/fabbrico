// Light / dark theme. The chosen setting goes on <html data-theme="…"> (the CSS
// variables in index.css follow it); the 3D view needs the resolved theme.

import { useEffect, useSyncExternalStore } from 'react';
import { useStore, type Theme } from '../model/store';

const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;
const subscribe = (cb: () => void) => {
  media?.addEventListener('change', cb);
  return () => media?.removeEventListener('change', cb);
};
const systemIsLight = () => !!media?.matches;

/** Keeps <html data-theme> in sync with the setting. Call once, in App. */
export function useApplyTheme() {
  const theme = useStore((s) => s.settings.theme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
}

/** The theme actually shown: "system" resolved through the OS setting. */
export function useResolvedTheme(): 'dark' | 'light' {
  const theme = useStore((s) => s.settings.theme);
  const light = useSyncExternalStore(subscribe, systemIsLight);
  return theme === 'system' ? (light ? 'light' : 'dark') : theme;
}

export const THEME_LABEL: Record<Theme, string> = { dark: 'Dark', light: 'Light', system: 'Same as system' };
export const THEME_ICON: Record<Theme, string> = { dark: '☾', light: '☀', system: '◐' };
export const nextTheme = (t: Theme): Theme => (t === 'dark' ? 'light' : t === 'light' ? 'system' : 'dark');

/** Colours of the 3D view per theme. */
export const SCENE_COLORS = {
  dark: { background: '#1b1e24', bed: '#262a33', cell: '#3a404c', section: '#56607a', ground: '#444455' },
  light: { background: '#e9ecf1', bed: '#d5dae3', cell: '#bcc3cf', section: '#8f99ad', ground: '#99a0b0' },
} as const;
