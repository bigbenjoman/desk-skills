import { useEffect } from 'react';

const DARK = '(prefers-color-scheme: dark)';

// Keeps <html data-theme> on the Mac's appearance, which Electron passes to the page as
// prefers-color-scheme, and follows it when it changes while the window is open.
export function useColorScheme(root = document.documentElement) {
  useEffect(() => {
    const query = window.matchMedia(DARK);
    const apply = () => { root.dataset.theme = query.matches ? 'dark' : 'light'; };
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, [root]);
}
