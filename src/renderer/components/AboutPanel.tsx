import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { t } from '../../shared/i18n';
import { openTicket } from '../api/cinemaApi';
import type { Movie } from '../types';
import type { CinemaInfo, CinemaStatus } from '../../shared/types';
import { LogViewer } from './LogViewer';

// ──────────────────────────────────────────────────────────────────────────
// AboutPanel — modal overlay with tabbed navigation:
//   - About: license, dependencies, attributions
//   - Logs: log viewer with filter + export
//   - Export: CSV + JSON export of movie data
//
// Always visible (not dev-only). The ℹ button in the header opens it.
// ──────────────────────────────────────────────────────────────────────────

interface AboutPanelProps {
  open: boolean;
  onClose: () => void;
  version: string;
  movies: Movie[];
  cinemas: CinemaInfo[];
  cinemaStatuses: CinemaStatus[];
  networkActive: boolean;
}

type Tab = 'about' | 'logs' | 'export' | 'diagnostics';

const DEPENDENCIES: Array<{ name: string; license: string; url: string }> = [
  { name: 'better-sqlite3', license: 'MIT', url: 'https://github.com/WiseLibs/better-sqlite3' },
  { name: 'cheerio', license: 'MIT', url: 'https://github.com/cheeriojs/cheerio' },
  { name: 'electron', license: 'MIT', url: 'https://github.com/electron/electron' },
  { name: 'react', license: 'MIT', url: 'https://github.com/facebook/react' },
  { name: 'react-dom', license: 'MIT', url: 'https://github.com/facebook/react' },
];

const BSD_LICENSE_SUMMARY = `Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.`;

// ── CSV generation ────────────────────────────────────────────────────────

function extractQid(url?: string): string {
  if (!url) return '';
  const m = url.match(/\/(Q\d+)$/);
  return m ? m[1] : '';
}
function extractAllocineId(url?: string): string {
  if (!url) return '';
  const m = url.match(/cfilm=(\d+)/);
  return m ? m[1] : '';
}
function extractRtPath(url?: string): string {
  if (!url) return '';
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}
function extractImdbId(url?: string): string {
  if (!url) return '';
  const m = url.match(/title\/(tt\d+)\//);
  return m ? m[1] : '';
}
function extractYear(release?: string): string {
  if (!release) return '';
  try {
    return String(new Date(release).getUTCFullYear());
  } catch {
    return '';
  }
}
function csvEscape(value: string | number | undefined | null | boolean): string {
  if (value === undefined || value === null) return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r'))
    return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function generateCsv(movies: Movie[]): string {
  const headers = [
    'cinema',
    'title',
    'year',
    'qid',
    'imdb_id',
    'imdb_rating',
    'imdb_votes',
    'imdb_status',
    'allocine_id',
    'allocine_press',
    'allocine_audience',
    'allocine_votes',
    'allocine_status',
    'rt_path',
    'rt_tomatometer',
    'rt_certified_fresh',
    'rt_status',
    'wikidata_url',
    'imdb_url',
    'allocine_url',
    'rt_url',
  ];
  const rows = movies.map((m) =>
    [
      m.cinemaId,
      m.title,
      extractYear(m.release),
      extractQid(m.wikidataUrl),
      m.imdbId ?? extractImdbId(m.imdbUrl),
      m.imdbRating,
      m.imdbVotes,
      m.imdbStatus,
      extractAllocineId(m.allocineUrl),
      m.allocinePress,
      m.allocineAudience,
      m.allocineVotes,
      m.allocineStatus,
      extractRtPath(m.rtUrl),
      m.rtTomatometer,
      m.rtCertifiedFresh,
      m.rtStatus,
      m.wikidataUrl,
      m.imdbUrl,
      m.allocineUrl,
      m.rtUrl,
    ]
      .map(csvEscape)
      .join(','),
  );
  return [headers.join(','), ...rows].join('\n');
}

function generateJson(movies: Movie[]): string {
  const sorted = [...movies].sort((a, b) => {
    const c = a.cinemaId.localeCompare(b.cinemaId);
    return c !== 0 ? c : a.title.localeCompare(b.title, 'fr');
  });
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      movieCount: sorted.length,
      cinemas: [...new Set(sorted.map((m) => m.cinemaId))].sort(),
      movies: sorted.map((m) => ({
        cinema: m.cinemaId,
        movieId: m.id,
        title: m.title,
        direction: m.direction,
        casting: m.casting,
        genres: m.genres,
        runtime: m.runtime,
        release: m.release,
        poster: m.poster,
        hasVF: m.hasVF,
        hasVO: m.hasVO,
        showtimes: m.showtimes.map((s) => ({
          day: s.day,
          time: s.time,
          hour: s.hour,
          tags: s.tags,
          screen: s.screen,
          ticketingUrl: s.ticketingUrl,
          cinemaId: s.cinemaId,
        })),
        wikidataUrl: m.wikidataUrl,
        qid: extractQid(m.wikidataUrl),
        imdbId: m.imdbId,
        allocineId: extractAllocineId(m.allocineUrl),
        rtPath: extractRtPath(m.rtUrl),
        imdb: {
          rating: m.imdbRating,
          votes: m.imdbVotes,
          url: m.imdbUrl,
          status: m.imdbStatus,
          statusMessage: m.imdbStatusMessage,
        },
        allocine: {
          press: m.allocinePress,
          audience: m.allocineAudience,
          votes: m.allocineVotes,
          url: m.allocineUrl,
          status: m.allocineStatus,
          statusMessage: m.allocineStatusMessage,
        },
        rottenTomatoes: {
          tomatometer: m.rtTomatometer,
          certifiedFresh: m.rtCertifiedFresh,
          url: m.rtUrl,
          status: m.rtStatus,
          statusMessage: m.rtStatusMessage,
        },
      })),
    },
    null,
    2,
  );
}

function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Styles ────────────────────────────────────────────────────────────────

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  background: 'rgba(0, 0, 0, 0.6)',
  backdropFilter: 'blur(2px)',
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
  maxWidth: 800,
  width: 'calc(100% - 32px)',
  maxHeight: '85vh',
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  position: 'relative',
};
const tabBtnStyle = (active: boolean): React.CSSProperties => ({
  padding: '8px 16px',
  border: 'none',
  background: active ? 'var(--bg-card-2)' : 'transparent',
  color: active ? 'var(--text-primary)' : 'var(--text-muted)',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: active ? 600 : 400,
  borderBottom: active ? '2px solid #4a9eff' : '2px solid transparent',
});
const bodyStyle: React.CSSProperties = { padding: '24px 28px', overflow: 'auto', flex: 1 };
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

export const AboutPanel: React.FC<AboutPanelProps> = ({
  open,
  onClose,
  version,
  movies,
  cinemas,
  cinemaStatuses,
  networkActive,
}) => {
  const [tab, setTab] = useState<Tab>('about');

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
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);

  return (
    <div
      style={overlayStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div style={modalStyle} role="dialog" aria-modal="true" aria-label={t('aboutTitle')}>
        {/* Header with tabs + close */}
        <div
          style={{ display: 'flex', borderBottom: '1px solid var(--border)', alignItems: 'center' }}
        >
          <button style={tabBtnStyle(tab === 'about')} onClick={() => setTab('about')}>
            ℹ About
          </button>
          <button style={tabBtnStyle(tab === 'logs')} onClick={() => setTab('logs')}>
            📋 Logs
          </button>
          <button style={tabBtnStyle(tab === 'export')} onClick={() => setTab('export')}>
            ⤓ Export
          </button>
          <button style={tabBtnStyle(tab === 'diagnostics')} onClick={() => setTab('diagnostics')}>
            🩺 {t('diagnostics')}
          </button>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onClose}
            aria-label={t('close')}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              fontSize: 22,
              cursor: 'pointer',
              padding: '4px 14px',
            }}
          >
            ×
          </button>
        </div>

        {/* Tab content */}
        <div style={bodyStyle}>
          {tab === 'about' && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 4 }}>
                <div>
                  <h2
                    style={{
                      margin: 0,
                      fontSize: 20,
                      fontWeight: 700,
                      color: 'var(--text-primary)',
                    }}
                  >
                    ArveCinema
                  </h2>
                  <p style={{ margin: '2px 0 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
                    v{version}
                  </p>
                </div>
              </div>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4 }}>
                <button
                  type="button"
                  style={linkStyle}
                  onClick={() => openExternal('https://github.com/SylvainSouche/arvecinema')}
                >
                  github.com/SylvainSouche/arvecinema
                </button>
              </p>

              <h3
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  color: 'var(--text-muted)',
                  margin: '20px 0 8px 0',
                  paddingBottom: 4,
                  borderBottom: '1px solid var(--border)',
                }}
              >
                {t('aboutLicense')}
              </h3>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                {t('aboutLicenseIntro')}{' '}
                <button
                  type="button"
                  style={linkStyle}
                  onClick={() =>
                    openExternal('https://github.com/SylvainSouche/arvecinema/blob/main/LICENSE')
                  }
                >
                  LICENSE
                </button>{' '}
                file in the repository.
              </p>
              <pre
                style={{
                  background: 'var(--bg-card-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '12px 14px',
                  fontSize: 11,
                  color: 'var(--text-muted)',
                  whiteSpace: 'pre-wrap',
                  fontFamily: 'ui-monospace, monospace',
                  maxHeight: 200,
                  overflow: 'auto',
                  margin: '8px 0 0 0',
                }}
              >
                {BSD_LICENSE_SUMMARY}
              </pre>

              <h3
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  color: 'var(--text-muted)',
                  margin: '20px 0 8px 0',
                  paddingBottom: 4,
                  borderBottom: '1px solid var(--border)',
                }}
              >
                {t('aboutDependencies')}
              </h3>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr>
                    <th
                      style={{
                        textAlign: 'left',
                        padding: '4px 8px',
                        borderBottom: '1px solid var(--border)',
                        color: 'var(--text-muted)',
                      }}
                    >
                      Package
                    </th>
                    <th
                      style={{
                        textAlign: 'left',
                        padding: '4px 8px',
                        borderBottom: '1px solid var(--border)',
                        color: 'var(--text-muted)',
                      }}
                    >
                      License
                    </th>
                    <th
                      style={{
                        textAlign: 'left',
                        padding: '4px 8px',
                        borderBottom: '1px solid var(--border)',
                        color: 'var(--text-muted)',
                      }}
                    >
                      URL
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {DEPENDENCIES.map((dep) => (
                    <tr key={dep.name}>
                      <td
                        style={{
                          padding: '4px 8px',
                          color: 'var(--text-primary)',
                          fontFamily: 'ui-monospace, monospace',
                        }}
                      >
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

              <h3
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  color: 'var(--text-muted)',
                  margin: '20px 0 8px 0',
                  paddingBottom: 4,
                  borderBottom: '1px solid var(--border)',
                }}
              >
                {t('aboutAttributions')}
              </h3>
              <div
                style={{
                  background: 'var(--bg-card-2)',
                  border: '1px solid var(--border)',
                  borderLeft: '3px solid #4a9eff',
                  borderRadius: 6,
                  padding: '12px 14px',
                  margin: '8px 0',
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: 'var(--text-primary)',
                    marginBottom: 4,
                  }}
                >
                  {t('aboutPersonalUse')}
                </div>
                <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  {t('aboutPersonalUseDescription')}
                </p>
              </div>
              <div
                style={{
                  background: 'var(--bg-card-2)',
                  border: '1px solid var(--border)',
                  borderLeft: '3px solid #4a9eff',
                  borderRadius: 6,
                  padding: '12px 14px',
                  margin: '8px 0',
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: 'var(--text-primary)',
                    marginBottom: 4,
                  }}
                >
                  IMDb ratings
                </div>
                <p style={{ fontSize: 13, fontStyle: 'italic', color: 'var(--text-secondary)' }}>
                  "Information courtesy of IMDb (https://www.imdb.com). Used with permission."
                </p>
                <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {t('aboutImdbDescription')}
                </p>
              </div>
              <div
                style={{
                  background: 'var(--bg-card-2)',
                  border: '1px solid var(--border)',
                  borderLeft: '3px solid #4a9eff',
                  borderRadius: 6,
                  padding: '12px 14px',
                  margin: '8px 0',
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: 'var(--text-primary)',
                    marginBottom: 4,
                  }}
                >
                  Wikidata
                </div>
                <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
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

              <p
                style={{
                  textAlign: 'center',
                  fontSize: 11,
                  color: 'var(--text-faint)',
                  margin: '24px 0 0 0',
                  paddingTop: 12,
                  borderTop: '1px solid var(--border)',
                }}
              >
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
          )}

          {tab === 'logs' && <LogViewer />}

          {tab === 'export' && (
            <div>
              <h3
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  color: 'var(--text-muted)',
                  marginBottom: 12,
                }}
              >
                Export movie data
              </h3>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
                Export the current movie list ({movies.length} films) for debugging or analysis. CSV
                includes ratings + IDs for spreadsheet analysis. JSON includes full data with
                showtimes, cast, genres, and all status fields.
              </p>
              <div style={{ display: 'flex', gap: 12 }}>
                <button
                  type="button"
                  onClick={() => {
                    const csv = generateCsv(movies);
                    downloadFile(csv, `arvecinema-${timestamp}.csv`, 'text/csv');
                  }}
                  style={{
                    padding: '10px 20px',
                    borderRadius: 8,
                    border: '1px solid var(--border-light)',
                    background: 'var(--bg-card-2)',
                    color: 'var(--text-primary)',
                    cursor: 'pointer',
                    fontSize: 14,
                  }}
                >
                  📊 CSV — ratings + IDs
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const json = generateJson(movies);
                    downloadFile(json, `arvecinema-${timestamp}.json`, 'application/json');
                  }}
                  style={{
                    padding: '10px 20px',
                    borderRadius: 8,
                    border: '1px solid var(--border-light)',
                    background: 'var(--bg-card-2)',
                    color: 'var(--text-primary)',
                    cursor: 'pointer',
                    fontSize: 14,
                  }}
                >
                  📦 JSON — full data + showtimes
                </button>
              </div>
            </div>
          )}

          {tab === 'diagnostics' && (
            <DiagnosticsTab
              version={version}
              movies={movies}
              cinemas={cinemas}
              cinemaStatuses={cinemaStatuses}
              networkActive={networkActive}
            />
          )}
        </div>
      </div>
      <style>{`@keyframes arve-about-fade { from { opacity: 0; } to { opacity: 1; } }`}</style>
    </div>
  );
};

// ──────────────────────────────────────────────────────────────────────────
// DiagnosticsTab — shows app health + "Copy diagnostics" for bug reports.
//
// When a server changes or breaks, the user opens this tab to see:
//   - Which cinemas are OK vs failing (with specific error messages)
//   - Which rating sources have blocked films (with counts)
//   - Which specific films are blocked (with their error messages)
//   - The last 10 log entries (for context)
//
// The "Copy diagnostics" button puts a structured text summary on the
// clipboard — ready to paste into a GitHub issue or email. This is the
// key feedback mechanism: when something breaks, the user can copy a
// detailed diagnostic report in one click.
// ──────────────────────────────────────────────────────────────────────────

interface DiagnosticsTabProps {
  version: string;
  movies: Movie[];
  cinemas: CinemaInfo[];
  cinemaStatuses: CinemaStatus[];
  networkActive: boolean;
}

const DiagnosticsTab: React.FC<DiagnosticsTabProps> = ({
  version,
  movies,
  cinemas,
  cinemaStatuses,
  networkActive,
}) => {
  const [copied, setCopied] = useState(false);
  const [logs, setLogs] = useState<
    Array<{ timestamp: string; level: string; component: string; message: string }>
  >([]);

  // Load last 10 log entries — lazy-loaded only when this tab is opened
  // (not on every app render). This is a deliberate boundary crossing:
  // the component calls the IPC layer directly instead of receiving logs
  // as a prop. The trade-off: we avoid loading ~5000 log entries into
  // App.tsx state on every render, and only fetch them when the user
  // actually opens the Diagnostics tab.
  useEffect(() => {
    window.electronAPI.getLogs().then((entries) => {
      setLogs(entries.slice(-10));
    });
  }, []);

  // Aggregate rating source health from movie objects
  const sourceStats = useMemo(() => {
    const stats = {
      imdb: { ok: 0, absent: 0, blocked: 0, pending: 0 },
      allocine: { ok: 0, absent: 0, blocked: 0, pending: 0 },
      rt: { ok: 0, absent: 0, blocked: 0, pending: 0 },
    };
    for (const m of movies) {
      if (m.imdbStatus === 'ok') stats.imdb.ok++;
      else if (m.imdbStatus === 'absent') stats.imdb.absent++;
      else if (m.imdbStatus === 'blocked') stats.imdb.blocked++;
      else stats.imdb.pending++;

      if (m.allocineStatus === 'ok') stats.allocine.ok++;
      else if (m.allocineStatus === 'absent') stats.allocine.absent++;
      else if (m.allocineStatus === 'blocked') stats.allocine.blocked++;
      else stats.allocine.pending++;

      if (m.rtStatus === 'ok') stats.rt.ok++;
      else if (m.rtStatus === 'absent') stats.rt.absent++;
      else if (m.rtStatus === 'blocked') stats.rt.blocked++;
      else stats.rt.pending++;
    }
    return stats;
  }, [movies]);

  // Build the list of blocked films (with their specific error messages)
  const blockedFilms = useMemo(() => {
    const out: Array<{
      title: string;
      cinemaId: string;
      sources: Array<{ source: string; status: string; message?: string }>;
    }> = [];
    for (const m of movies) {
      const sources: Array<{ source: string; status: string; message?: string }> = [];
      if (m.imdbStatus === 'blocked') {
        sources.push({ source: 'IMDB', status: 'blocked', message: m.imdbStatusMessage });
      }
      if (m.allocineStatus === 'blocked') {
        sources.push({ source: 'AlloCiné', status: 'blocked', message: m.allocineStatusMessage });
      }
      if (m.rtStatus === 'blocked') {
        sources.push({ source: 'RT', status: 'blocked', message: m.rtStatusMessage });
      }
      if (sources.length > 0) {
        out.push({ title: m.title, cinemaId: m.cinemaId, sources });
      }
    }
    return out;
  }, [movies]);

  // Build the diagnostic text summary for clipboard
  const buildDiagnosticText = useCallback(() => {
    const lines: string[] = [];
    lines.push(`ArveCinema v${version} — Diagnostics`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push(`Network: ${networkActive ? 'active' : 'idle'}`);
    lines.push(`Movies loaded: ${movies.length}`);
    lines.push('');

    lines.push('Cinemas:');
    for (const cinema of cinemas) {
      const status = cinemaStatuses.find((s) => s.cinemaId === cinema.id);
      const statusStr = status ? status.status : 'unknown';
      const error = status?.error ? ` — ${status.error}` : '';
      lines.push(`- ${cinema.id} (${cinema.name}, ${cinema.city}): ${statusStr}${error}`);
    }
    lines.push('');

    lines.push('Rating sources:');
    lines.push(
      `- IMDB: ${sourceStats.imdb.ok} ok, ${sourceStats.imdb.absent} absent, ${sourceStats.imdb.blocked} blocked, ${sourceStats.imdb.pending} pending`,
    );
    lines.push(
      `- AlloCiné: ${sourceStats.allocine.ok} ok, ${sourceStats.allocine.absent} absent, ${sourceStats.allocine.blocked} blocked, ${sourceStats.allocine.pending} pending`,
    );
    lines.push(
      `- RT: ${sourceStats.rt.ok} ok, ${sourceStats.rt.absent} absent, ${sourceStats.rt.blocked} blocked, ${sourceStats.rt.pending} pending`,
    );
    lines.push('');

    if (blockedFilms.length > 0) {
      lines.push('Blocked films:');
      for (const film of blockedFilms) {
        const sourcesStr = film.sources
          .map((s) => `${s.source}: ${s.status}${s.message ? ` (${s.message})` : ''}`)
          .join(', ');
        lines.push(`- "${film.title}" (${film.cinemaId}) — ${sourcesStr}`);
      }
      lines.push('');
    }

    if (logs.length > 0) {
      lines.push('Last log entries:');
      for (const entry of logs) {
        lines.push(
          `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.component}] ${entry.message}`,
        );
      }
    }

    return lines.join('\n');
  }, [
    version,
    networkActive,
    movies.length,
    cinemas,
    cinemaStatuses,
    sourceStats,
    blockedFilms,
    logs,
  ]);

  const handleCopy = useCallback(async () => {
    const text = buildDiagnosticText();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('[diagnostics] copy failed:', err);
    }
  }, [buildDiagnosticText]);

  const sectionStyle: React.CSSProperties = {
    marginBottom: 20,
  };

  const headingStyle: React.CSSProperties = {
    fontSize: 13,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: 'var(--text-muted)',
    marginBottom: 8,
    paddingBottom: 4,
    borderBottom: '1px solid var(--border)',
  };

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '4px 0',
    fontSize: 13,
  };

  const statusDot = (status: string): string => {
    if (status === 'ok') return '✅';
    if (status === 'blocked') return '⚠️';
    if (status === 'absent') return '–';
    if (status === 'pending' || status === 'unknown') return '⏳';
    return '❌';
  };

  return (
    <div>
      {/* App info */}
      <div style={sectionStyle}>
        <h3 style={headingStyle}>ArveCinema</h3>
        <div style={rowStyle}>
          <span style={{ color: 'var(--text-muted)' }}>Version:</span>
          <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>v{version}</span>
        </div>
        <div style={rowStyle}>
          <span style={{ color: 'var(--text-muted)' }}>{t('diagnosticsNetworkIdle')}:</span>
          <span style={{ color: networkActive ? 'var(--brand-accent)' : 'var(--text-secondary)' }}>
            {networkActive
              ? `● ${t('diagnosticsNetworkActive')}`
              : `○ ${t('diagnosticsNetworkIdle')}`}
          </span>
        </div>
        <div style={rowStyle}>
          <span style={{ color: 'var(--text-muted)' }}>{t('diagnosticsMoviesLoaded')}:</span>
          <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{movies.length}</span>
        </div>
      </div>

      {/* Cinemas */}
      <div style={sectionStyle}>
        <h3 style={headingStyle}>{t('diagnosticsCinemas')}</h3>
        {cinemas.map((cinema) => {
          const status = cinemaStatuses.find((s) => s.cinemaId === cinema.id);
          const statusStr = status?.status ?? 'unknown';
          const error = status?.error;
          return (
            <div
              key={cinema.id}
              style={{ ...rowStyle, flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>{statusDot(statusStr)}</span>
                <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{cinema.name}</span>
                <span style={{ color: 'var(--text-muted)' }}>({cinema.city})</span>
              </div>
              {error && (
                <div
                  style={{
                    color: 'var(--brand-error)',
                    fontSize: 12,
                    marginLeft: 24,
                    wordBreak: 'break-word',
                  }}
                >
                  {error}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Rating sources */}
      <div style={sectionStyle}>
        <h3 style={headingStyle}>{t('diagnosticsRatingSources')}</h3>
        {(['imdb', 'allocine', 'rt'] as const).map((source) => {
          const s = sourceStats[source];
          const total = s.ok + s.absent + s.blocked + s.pending;
          const name =
            source === 'imdb' ? 'IMDB' : source === 'allocine' ? 'AlloCiné' : 'Rotten Tomatoes';
          return (
            <div key={source} style={{ ...rowStyle, justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{name}</span>
              <span style={{ color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                {s.ok > 0 && <span style={{ color: 'var(--brand-success)' }}>{s.ok} ✅ </span>}
                {s.blocked > 0 && (
                  <span style={{ color: 'var(--brand-error)' }}>{s.blocked} ⚠️ </span>
                )}
                {s.absent > 0 && <span style={{ color: 'var(--text-faint)' }}>{s.absent} – </span>}
                {s.pending > 0 && <span style={{ color: 'var(--text-dim)' }}>{s.pending} ⏳</span>}
                <span style={{ color: 'var(--text-faint)' }}> / {total}</span>
              </span>
            </div>
          );
        })}
      </div>

      {/* Blocked films */}
      <div style={sectionStyle}>
        <h3 style={headingStyle}>{t('diagnosticsBlockedFilms')}</h3>
        {blockedFilms.length === 0 ? (
          <div style={{ ...rowStyle, color: 'var(--text-faint)' }}>{t('diagnosticsNoBlocked')}</div>
        ) : (
          blockedFilms.map((film, i) => (
            <div
              key={i}
              style={{
                ...rowStyle,
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: 2,
                marginBottom: 6,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>⚠️</span>
                <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{film.title}</span>
                <span style={{ color: 'var(--text-muted)' }}>({film.cinemaId})</span>
              </div>
              {film.sources.map((s, j) => (
                <div key={j} style={{ color: 'var(--brand-error)', fontSize: 12, marginLeft: 24 }}>
                  {s.source}: {s.status}
                  {s.message ? ` — ${s.message}` : ''}
                </div>
              ))}
            </div>
          ))
        )}
      </div>

      {/* Copy diagnostics + Report issue buttons */}
      <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
        <button
          type="button"
          onClick={handleCopy}
          style={{
            padding: '10px 20px',
            borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--border-light)',
            background: 'var(--bg-card-2)',
            color: 'var(--text-primary)',
            cursor: 'pointer',
            fontSize: 'var(--text-md)',
            fontWeight: 'var(--weight-semibold)',
          }}
        >
          {copied ? `✓ ${t('diagnosticsCopied')}` : `📋 ${t('diagnosticsCopy')}`}
        </button>
        <button
          type="button"
          onClick={() => {
            void openTicket('https://github.com/SylvainSouche/arvecinema/issues/new');
          }}
          style={{
            padding: '10px 20px',
            borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--border-light)',
            background: 'transparent',
            color: 'var(--brand-accent)',
            cursor: 'pointer',
            fontSize: 'var(--text-md)',
            fontWeight: 'var(--weight-semibold)',
          }}
        >
          🔗 {t('diagnosticsReportIssue')}
        </button>
      </div>
    </div>
  );
};
