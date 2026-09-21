import type React from 'react';

// ──────────────────────────────────────────────────────────────────────────
// Shared style presets — common `React.CSSProperties` objects used across
// multiple components. Extracted to avoid duplication and ensure visual
// consistency.
//
// Usage:
//   import { buttonStyles, cardStyles } from '../styles/components';
//   <button style={buttonStyles.header}>...</button>
//   <div style={cardStyles.default}>...</div>
//
// These presets use CSS variables (var(--token)) so they automatically
// pick up theme overrides.
// ──────────────────────────────────────────────────────────────────────────

export const buttonStyles = {
  /** Header icon button (refresh, theme toggle, language, about, retry).
   *  Compact, transparent, bordered. */
  header: {
    padding: '6px 10px',
    borderRadius: 'var(--radius-lg)',
    border: '1px solid var(--border-light)',
    background: 'transparent',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    fontSize: 'var(--text-lg)',
    lineHeight: 1,
  } as React.CSSProperties,

  /** Small button (LogViewer toolbar, dev-only export menu).
   *  Tighter padding than header buttons. */
  small: {
    padding: '4px 10px',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border-light)',
    background: 'transparent',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    fontSize: 'var(--text-base)',
  } as React.CSSProperties,

  /** Small button in active/pressed state (LogViewer filter pills). */
  smallActive: {
    padding: '4px 10px',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border-light)',
    background: 'var(--bg-pill)',
    color: 'var(--text-primary)',
    cursor: 'pointer',
    fontSize: 'var(--text-base)',
  } as React.CSSProperties,
} as const;

export const cardStyles = {
  /** Standard card (movie card, about panel section).
   *  Rounded, bordered, padded. */
  default: {
    background: 'var(--bg-card)',
    borderRadius: 'var(--radius-xl)',
    border: '1px solid var(--border)',
    padding: 'var(--space-4)',
  } as React.CSSProperties,

  /** Compact card (LogViewer container, status banner). */
  compact: {
    background: 'var(--bg-card)',
    borderRadius: 'var(--radius-lg)',
    border: '1px solid var(--border)',
  } as React.CSSProperties,

  /** Inner surface (log entries area, debug output). */
  inner: {
    background: 'var(--bg-card-2)',
    borderRadius: 'var(--radius-lg)',
    border: '1px solid var(--border)',
    padding: 'var(--space-2)',
  } as React.CSSProperties,
} as const;

export const inputStyles = {
  /** Standard text input / search box. */
  default: {
    padding: 'var(--space-2) var(--space-3)',
    background: 'var(--bg-card-2)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-2xl)',
    fontSize: 'var(--text-md)',
    outline: 'none',
  } as React.CSSProperties,

  /** Compact input (LogViewer filter, smaller height). */
  compact: {
    padding: '4px 8px',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border-light)',
    background: 'var(--bg-input)',
    color: 'var(--text-primary)',
    fontSize: 'var(--text-base)',
  } as React.CSSProperties,
} as const;

export const badgeStyles = {
  /** Cinema badge — colored pill with cinema name. */
  cinema: (color: string): React.CSSProperties => ({
    background: color,
    color: 'var(--text-primary)',
    padding: '2px 9px',
    borderRadius: 'var(--radius-sm)',
    fontSize: 'var(--text-sm)',
    fontWeight: 'var(--weight-semibold)',
    letterSpacing: 0.3,
  }),

  /** VF version badge — solid background. */
  vf: {
    background: 'var(--text-primary)',
    color: 'var(--bg-card)',
    padding: '2px 9px',
    borderRadius: 'var(--radius-sm)',
    fontSize: 'var(--text-sm)',
    fontWeight: 'var(--weight-semibold)',
    letterSpacing: 0.3,
  } as React.CSSProperties,

  /** VO version badge — outlined. */
  vo: {
    background: 'transparent',
    color: 'var(--text-primary)',
    padding: '2px 9px',
    borderRadius: 'var(--radius-sm)',
    fontSize: 'var(--text-sm)',
    fontWeight: 'var(--weight-semibold)',
    letterSpacing: 0.3,
    border: '1px solid var(--text-primary)',
  } as React.CSSProperties,
} as const;

export const textStyles = {
  /** Section heading (e.g. "Cinéma :", "Trier :"). */
  label: {
    color: 'var(--text-muted)',
    fontSize: 'var(--text-md)',
  } as React.CSSProperties,

  /** Muted caption / hint text. */
  muted: {
    color: 'var(--text-muted)',
    fontSize: 'var(--text-base)',
  } as React.CSSProperties,

  /** Faint hint text (less important than muted). */
  faint: {
    color: 'var(--text-faint)',
    fontSize: 'var(--text-base)',
  } as React.CSSProperties,
} as const;

// ── Draggable region helpers (Electron-specific) ───────────────────────────

export const dragRegion = {
  WebkitAppRegion: 'drag',
  WebkitUserSelect: 'none',
} as React.CSSProperties;

export const noDragRegion = {
  WebkitAppRegion: 'no-drag',
} as React.CSSProperties;
