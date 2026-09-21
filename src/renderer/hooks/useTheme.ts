import { useState, useEffect, useCallback } from 'react';

// ──────────────────────────────────────────────────────────────────────────
// useTheme — manages the dark/light theme.
//
// State: 'dark' (default) or 'light', persisted in localStorage.
// Side effects: sets `data-theme` attribute on <html> so CSS variables
// switch accordingly.
// ──────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'arvecinema-theme';
export type Theme = 'dark' | 'light';

export function useTheme(): {
  theme: Theme;
  toggleTheme: () => void;
} {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem(STORAGE_KEY) as Theme) ?? 'dark';
    } catch {
      return 'dark';
    }
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  return { theme, toggleTheme };
}
