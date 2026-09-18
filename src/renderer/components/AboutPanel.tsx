import React, { useEffect } from 'react';
import { t } from '../../shared/i18n';
import { openTicket } from '../api/cinemaApi';

// ──────────────────────────────────────────────────────────────────────────
// AboutPanel — modal overlay showing license, dependencies, attributions.
//
// Triggered by the ℹ️ button in the header. Closes on Esc, backdrop click,
// or × button.
//
// Content sections:
//   1. App name + version + GitHub link
//   2. License (BSD-3-Clause summary + link to full text)
//   3. Used software (dependencies + their licenses)
//   4. Attributions (IMDB mandatory credit + other data sources)
// ──────────────────────────────────────────────────────────────────────────

interface AboutPanelProps {
  open: boolean;
  onClose: () => void;
  version: string;
}

// ── Dependencies list ──────────────────────────────────────────────────────
// Hand-curated list of dependencies that end up in the packaged app.
// Dev-only deps (typescript, prettier, @types/*) are excluded — they don't
// ship in the .app / .dmg.
const DEPENDENCIES: Array<{ name: string; license: string; url: string }> = [
  {
    name: 'better-sqlite3',
    license: 'MIT',
    url: 'https://github.com/WiseLibs/better-sqlite3',
  },
  {
    name: 'cheerio',
    license: 'MIT',
    url: 'https://github.com/cheeriojs/cheerio',
  },
  {
    name: 'electron',
    license: 'MIT',
    url: 'https://github.com/electron/electron',
  },
  {
    name: 'react',
    license: 'MIT',
    url: 'https://github.com/facebook/react',
  },
  {
    name: 'react-dom',
    license: 'MIT',
    url: 'https://github.com/facebook/react',
  },
];

// ── BSD-3-Clause summary (full text in LICENSE file in the repo) ────────────
const BSD_LICENSE_SUMMARY = `Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.`;

// ── Styles ──────────────────────────────────────────────────────────────────

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0, left: 0, right: 0, bottom: 0,
  background: 'rgba(0, 0, 0, 0.6)',
  backdropFilter: 'blur(2px)',
  WebkitBackdropFilter: 'blur(2px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  animation: 'arve-about-fade 150ms ease-out',
};

const modalStyle: React.CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border-light)',
  borderRadius: 12,
  boxShadow: '0 12px 48px rgba(0,0,0,0.4)',
  maxWidth: 640,
  width: 'calc(100% - 32px)',
  maxHeight: '85vh',
  overflow: 'auto',
  padding: '24px 28px',
  position: 'relative',
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: 'var(--text-muted)',
  margin: '20px 0 8px 0',
  paddingBottom: 4,
  borderBottom: '1px solid var(--border)',
};

const bodyTextStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.5,
  color: 'var(--text-secondary)',
  margin: 0,
};

const licenseBoxStyle: React.CSSProperties = {
  background: 'var(--bg-card-2)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '12px 14px',
  fontSize: 11,
  lineHeight: 1.5,
  color: 'var(--text-muted)',
  whiteSpace: 'pre-wrap',
  fontFamily: 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace',
  maxHeight: 200,
  overflow: 'auto',
  margin: 0,
};

const attributionBoxStyle: React.CSSProperties = {
  background: 'var(--bg-card-2)',
  border: '1px solid var(--border)',
  borderLeft: '3px solid var(--accent, #4a9eff)',
  borderRadius: 6,
  padding: '12px 14px',
  margin: '8px 0',
};

const linkStyle: React.CSSProperties = {
  color: '#4a9eff',
  textDecoration: 'underline',
  cursor: 'pointer',
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
};

// ── Component ──────────────────────────────────────────────────────────────

export const AboutPanel: React.FC<AboutPanelProps> = ({ open, onClose, version }) => {
  // Close on Escape key
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const openExternal = (url: string) => {
    void openTicket(url);
  };

  return (
    <div
      style={overlayStyle}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={modalStyle} role="dialog" aria-modal="true" aria-label={t('aboutTitle')}>
        {/* Close button */}
        <button
          type="button"
          onClick={onClose}
          aria-label={t('close')}
          style={{
            position: 'absolute',
            top: 12, right: 14,
            background: 'transparent',
            border: 'none',
            color: 'var(--text-muted)',
            fontSize: 22,
            cursor: 'pointer',
            lineHeight: 1,
            padding: 4,
          }}
        >
          ×
        </button>

        {/* Header — app name + version + GitHub */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 4 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--text-primary)' }}>
              ArveCinema
            </h2>
            <p style={{ margin: '2px 0 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
              v{version}
            </p>
          </div>
        </div>
        <p style={{ ...bodyTextStyle, marginBottom: 4 }}>
          <button
            type="button"
            style={linkStyle}
            onClick={() => openExternal('https://github.com/SylvainSouche/arvecinema')}
          >
            github.com/SylvainSouche/arvecinema
          </button>
        </p>

        {/* License section */}
        <h3 style={sectionTitleStyle}>{t('aboutLicense')}</h3>
        <p style={bodyTextStyle}>
          {t('aboutLicenseIntro')}{' '}
          <button
            type="button"
            style={linkStyle}
            onClick={() => openExternal('https://github.com/SylvainSouche/arvecinema/blob/main/LICENSE')}
          >
            LICENSE
          </button>
          {' '}file in the repository.
        </p>
        <pre style={{ ...licenseBoxStyle, marginTop: 8 }}>
{BSD_LICENSE_SUMMARY}
        </pre>

        {/* Used software section */}
        <h3 style={sectionTitleStyle}>{t('aboutDependencies')}</h3>
        <p style={bodyTextStyle}>
          {t('aboutDependenciesIntro')}
        </p>
        <table style={{
          width: '100%',
          borderCollapse: 'collapse',
          marginTop: 8,
          fontSize: 12,
        }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>Package</th>
              <th style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>License</th>
              <th style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>URL</th>
            </tr>
          </thead>
          <tbody>
            {DEPENDENCIES.map(dep => (
              <tr key={dep.name}>
                <td style={{ padding: '4px 8px', color: 'var(--text-primary)', fontFamily: 'ui-monospace, monospace' }}>
                  {dep.name}
                </td>
                <td style={{ padding: '4px 8px', color: 'var(--text-secondary)' }}>
                  {dep.license}
                </td>
                <td style={{ padding: '4px 8px' }}>
                  <button
                    type="button"
                    style={linkStyle}
                    onClick={() => openExternal(dep.url)}
                  >
                    {dep.url.replace('https://github.com/', '')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Data sources + attributions section */}
        <h3 style={sectionTitleStyle}>{t('aboutAttributions')}</h3>

        {/* Personal navigation app disclaimer */}
        <div style={attributionBoxStyle}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>
            {t('aboutPersonalUse')}
          </div>
          <p style={bodyTextStyle}>
            {t('aboutPersonalUseDescription')}
          </p>
        </div>

        {/* IMDB — mandatory attribution */}
        <div style={attributionBoxStyle}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>
            IMDb ratings
          </div>
          <p style={{ ...bodyTextStyle, fontStyle: 'italic', marginBottom: 4 }}>
            “Information courtesy of IMDb (https://www.imdb.com). Used with permission.”
          </p>
          <p style={{ ...bodyTextStyle, fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>
            {t('aboutImdbDescription')}
          </p>
        </div>

        {/* Wikidata */}
        <div style={attributionBoxStyle}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>
            Wikidata
          </div>
          <p style={{ ...bodyTextStyle, marginBottom: 4 }}>
            {t('aboutWikidataDescription')}
          </p>
          <button
            type="button"
            style={linkStyle}
            onClick={() => openExternal('https://www.wikidata.org/wiki/Wikidata:Data_access')}
          >
            wikidata.org/wiki/Wikidata:Data_access
          </button>
        </div>

        {/* Footer */}
        <p style={{
          textAlign: 'center',
          fontSize: 11,
          color: 'var(--text-faint)',
          margin: '24px 0 0 0',
          paddingTop: 12,
          borderTop: '1px solid var(--border)',
        }}>
          ArveCinema · BSD-3-Clause ·{' '}
          <button
            type="button"
            style={linkStyle}
            onClick={() => openExternal('https://github.com/SylvainSouche/arvecinema')}
          >
            github.com/SylvainSouche/arvecinema
          </button>
        </p>
      </div>

      {/* Inline keyframes — injected once on mount */}
      <style>{`
        @keyframes arve-about-fade {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `}</style>
    </div>
  );
};
