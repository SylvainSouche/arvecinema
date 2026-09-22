import React from 'react';
import type { Movie } from '../types';

// ──────────────────────────────────────────────────────────────────────────
// ExportCsvButton — dev-only button that exports all movies + their IDs +
// ratings as a CSV file.
//
// Visible only in dev mode (import.meta.env.DEV). Hidden in packaged builds.
//
// Generates a CSV with columns:
//   cinema, title, year, qid, imdb_id, imdb_rating, imdb_votes, imdb_status,
//   allocine_id, allocine_press, allocine_audience, allocine_votes, allocine_status,
//   rt_path, rt_tomatometer, rt_certified_fresh, rt_status,
//   wikidata_url, imdb_url, allocine_url, rt_url
//
// Triggers a browser download via Blob + temporary anchor. No IPC needed.
// ──────────────────────────────────────────────────────────────────────────

interface ExportCsvButtonProps {
  movies: Movie[];
}

/** Extract the QID from a Wikidata URL (e.g. "https://www.wikidata.org/wiki/Q12345" → "Q12345"). */
function extractQid(wikidataUrl?: string): string {
  if (!wikidataUrl) return '';
  const m = wikidataUrl.match(/\/(Q\d+)$/);
  return m ? m[1] : '';
}

/** Extract the AlloCiné numeric ID from an AlloCiné URL (e.g. "...fichefilm_gen_cfilm=55774.html" → "55774"). */
function extractAllocineId(allocineUrl?: string): string {
  if (!allocineUrl) return '';
  const m = allocineUrl.match(/cfilm=(\d+)/);
  return m ? m[1] : '';
}

/** Extract the RT path from an RT URL (e.g. "https://www.rottentomatoes.com/m/cars" → "m/cars"). */
function extractRtPath(rtUrl?: string): string {
  if (!rtUrl) return '';
  try {
    const u = new URL(rtUrl);
    return u.pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

/** Extract the IMDB ID from an IMDB URL (e.g. "https://www.imdb.com/title/tt0111161/" → "tt0111161"). */
function extractImdbId(imdbUrl?: string): string {
  if (!imdbUrl) return '';
  const m = imdbUrl.match(/title\/(tt\d+)\//);
  return m ? m[1] : '';
}

/** Extract the release year from an ISO date string. */
function extractYear(release?: string): string {
  if (!release) return '';
  try {
    return String(new Date(release).getUTCFullYear());
  } catch {
    return '';
  }
}

/** Escape a CSV field — wraps in double quotes if it contains commas, quotes, or newlines. */
function csvEscape(value: string | number | undefined | null | boolean): string {
  if (value === undefined || value === null) return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Generate a CSV string from the movies array. */
function generateCsv(movies: Movie[]): string {
  const headers = [
    'cinema', 'title', 'year', 'qid',
    'imdb_id', 'imdb_rating', 'imdb_votes', 'imdb_status',
    'allocine_id', 'allocine_press', 'allocine_audience', 'allocine_votes', 'allocine_status',
    'rt_path', 'rt_tomatometer', 'rt_certified_fresh', 'rt_status',
    'wikidata_url', 'imdb_url', 'allocine_url', 'rt_url',
  ];

  const rows = movies.map(m => [
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
  ].map(csvEscape).join(','));

  return [headers.join(','), ...rows].join('\n');
}

/** Trigger a CSV file download in the browser. */
function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export const ExportCsvButton: React.FC<ExportCsvButtonProps> = ({ movies }) => {
  // Only render in dev mode — hidden in packaged builds.
  if (!import.meta.env.DEV) return null;

  const handleExport = () => {
    const csv = generateCsv(movies);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    downloadCsv(csv, `arvecinema-export-${timestamp}.csv`);
  };

  return (
    <button
      type="button"
      onClick={handleExport}
      aria-label="Export movies as CSV (dev)"
      title={`Export ${movies.length} movies as CSV (dev mode)`}
      style={{
        padding: '6px 10px',
        borderRadius: 8,
        border: '1px solid var(--border-light)',
        background: 'transparent',
        color: 'var(--text-muted)',
        cursor: 'pointer',
        fontSize: 14,
        lineHeight: 1,
      }}
    >
      ⤓
    </button>
  );
};
