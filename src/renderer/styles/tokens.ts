// ──────────────────────────────────────────────────────────────────────────
// Design tokens — TypeScript constants mirroring the CSS variables in
// index.html. Use these in inline `style={{}}` objects for values that
// need to be computed (e.g. conditional colors) or for IDE autocomplete.
//
// For static values, prefer `var(--token-name)` directly in the style
// string — it's shorter and automatically picks up theme overrides.
//
// Example:
//   import { tokens } from '../styles/tokens';
//   <div style={{ padding: tokens.space[3], borderRadius: tokens.radius.lg }}>
//
//   // Or the simpler CSS-variable form:
//   <div style={{ padding: 'var(--space-3)', borderRadius: 'var(--radius-lg)' }}>
// ──────────────────────────────────────────────────────────────────────────

export const tokens = {
  space: {
    0: '0',
    1: '4px',
    2: '8px',
    3: '12px',
    4: '16px',
    5: '20px',
    6: '24px',
    8: '32px',
  },
  radius: {
    sm: '4px',
    md: '6px',
    lg: '8px',
    xl: '12px',
    '2xl': '16px',
    full: '50%',
  },
  fontSize: {
    xs: 10,
    sm: 11,
    base: 12,
    md: 13,
    lg: 14,
    xl: 16,
    '2xl': 22,
    '3xl': 24,
  },
  fontWeight: {
    normal: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
    extrabold: 800,
  },
  zIndex: {
    base: 0,
    sticky: 100,
    dropdown: 500,
    modal: 1000,
    progress: 999,
    toast: 1500,
  },
  // Brand colors — these are the same in both themes (source identities).
  // Use as `tokens.color.imdb` for computed values, or `var(--brand-imdb)`
  // for static values.
  color: {
    imdb: '#f5c518',
    allocine: '#fbc905',
    netflix: '#e50914',
    rtFresh: '#10b981',
    rtRotten: '#e50914',
    accent: '#4a9eff',
    warning: '#eab308',
    error: '#e50914',
    success: '#10b981',
    amber: '#ffb38a',
  },
  shadow: {
    sm: '0 1px 4px rgba(0, 0, 0, 0.5)',
    md: '0 8px 24px rgba(0, 0, 0, 0.3)',
    glow: '0 0 8px rgba(74, 158, 255, 0.6)',
  },
  transition: {
    fast: '0.1s ease',
    normal: '0.15s ease',
    slow: '0.2s ease-out',
  },
} as const;
