import { createContext, useCallback, useContext, useEffect, useState } from 'react';

const DARK = '(prefers-color-scheme: dark)';

// The app's own display preferences (screen-spec §9.2): Theme and Density. Desk.app keeps them in its
// preferences file outside desk's state (window.desk.prefs / setPref); no desk command runs. A window
// without that bridge (an older Desk.app, a browser) keeps them in localStorage instead. Anything
// missing or unreadable is the default, with no error.
export const THEMES = ['system', 'light', 'dark'];
export const DENSITIES = ['comfortable', 'compact'];
export const DEFAULT_PREFS = { theme: 'system', density: 'comfortable' };
const LOCAL = 'desk:prefs';
const valid = (p) => ({
  theme: THEMES.includes(p?.theme) ? p.theme : DEFAULT_PREFS.theme,
  density: DENSITIES.includes(p?.density) ? p.density : DEFAULT_PREFS.density,
});
const local = {
  read: () => { try { return valid(JSON.parse(globalThis.localStorage?.getItem(LOCAL) ?? 'null')); } catch { return { ...DEFAULT_PREFS }; } },
  write: (p) => { try { globalThis.localStorage?.setItem(LOCAL, JSON.stringify(p)); return p; } catch { return null; } },
};

// `bridge` is window.desk (the tests pass a stub). -> { prefs, setPref(key, value) -> Promise<boolean> }
export function usePrefs(bridge = globalThis.window?.desk) {
  const [prefs, setPrefs] = useState(() => (bridge?.prefs ? { ...DEFAULT_PREFS } : local.read()));
  useEffect(() => {
    if (!bridge?.prefs) return undefined;
    let live = true;
    Promise.resolve().then(() => bridge.prefs()).then((p) => { if (live) setPrefs(valid(p)); }, () => {});
    return () => { live = false; };
  }, [bridge]);
  const setPref = useCallback(async (key, value) => {
    if (!(key in DEFAULT_PREFS)) return false;
    let saved = null;
    // Shown at once; the file follows.
    setPrefs((p) => ({ ...p, [key]: value }));
    try {
      saved = bridge?.setPref ? await bridge.setPref(key, value) : local.write({ ...local.read(), [key]: value });
    } catch { saved = null; }
    if (saved && typeof saved === 'object') setPrefs(valid(saved));
    return !!saved;
  }, [bridge]);
  return { prefs, setPref };
}

export const Prefs = createContext({ prefs: DEFAULT_PREFS, setPref: async () => false });
export const usePrefsContext = () => useContext(Prefs);

// Keeps <html data-theme> on the chosen theme: with System, the Mac's appearance, which Electron passes
// to the page as prefers-color-scheme, followed when it changes while the window is open. <html
// data-density> carries the density.
export function useColorScheme(root = document.documentElement, { theme = 'system', density = 'comfortable' } = {}) {
  useEffect(() => {
    const query = window.matchMedia(DARK);
    const apply = () => { root.dataset.theme = theme === 'system' ? (query.matches ? 'dark' : 'light') : theme; };
    apply();
    if (theme !== 'system') return undefined;
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, [root, theme]);
  useEffect(() => { root.dataset.density = density; }, [root, density]);
}
