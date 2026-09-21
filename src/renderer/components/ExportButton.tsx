import React, { useState, useRef, useEffect } from 'react';
import type { Movie } from '../types';

// ──────────────────────────────────────────────────────────────────────────
// ExportButton — dev-only dropdown button that exports movie data.
//
// Visible only in dev mode (import.meta.env.DEV). Hidden in packaged builds.
//
// Two export formats:
//   1. CSV  — ratings + IDs for spreadsheet analysis (existing format)
//   2. JSON — full Movie objects with ALL fields: showtimes, cast, genres,
//             runtime, release dates, status messages, URLs, etc.
//
// Both trigger a browser download via Blob + temporary anchor. No IPC needed.
// ──────────────────────────────────────────────────────────────────────────

interface ExportButtonProps {
  movies: Movie[];
}

// ── CSV generation (existing, unchanged) ───────────────────────────────────

function extractQid(wikidataUrl?: string): string {
  if (!wikidataUrl) return '';
  const m = wikidataUrl.match(/\/(Q\d+)$/);
  return m ? m[1] : '';
}

function extractAllocineId(allocineUrl?: string): string {
  if (!allocineUrl) return '';
  const m = allocineUrl.match(/cfilm=(\d+)/);
  return m ? m[1] : '';
}

function extractRtPath(rtUrl?: string): string {
  if (!rtUrl) return '';
  try {
    const u = new URL(rtUrl);
    return u.pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

function extractImdbId(imdbUrl?: string): string {
  if (!imdbUrl) return '';
  const m = imdbUrl.match(/title\/(tt\d+)\//);
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
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

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

// ── JSON generation (new — full data dump) ─────────────────────────────────

/** Generate a JSON string from the movies array. Includes ALL fields:
 *  - All cinema-extracted data (title, director, cast, genres, runtime,
 *    release date, poster URL, showtimes with times/tags/screens/ticketing URLs)
 *  - All Wikidata-resolved IDs (qid, imdbId, tmdbId, rtPath, allocineId)
 *  - All ratings (IMDB rating+votes, AlloCiné press+audience+votes,
 *    RT tomatometer+certified_fresh)
 *  - All status fields (imdbStatus, allocineStatus, rtStatus + messages)
 *  - All URLs (wikidata, imdb, allocine, rt)
 *
 *  The JSON is pretty-printed with 2-space indentation for readability. */
function generateJson(movies: Movie[]): string {
  // Sort by cinema then title for stable output
  const sorted = [...movies].sort((a, b) => {
    const c = a.cinemaId.localeCompare(b.cinemaId);
    return c !== 0 ? c : a.title.localeCompare(b.title, 'fr');
  });

  // Wrap in an object with metadata
  const exportData = {
    exportedAt: new Date().toISOString(),
    movieCount: sorted.length,
    cinemas: [...new Set(sorted.map(m => m.cinemaId))].sort(),
    movies: sorted.map(m => ({
      // ── Cinema-extracted data ──────────────────────────────────────────
      cinema: m.cinemaId,
      movieId: m.id,
      title: m.title,
      direction: m.direction,
      casting: m.casting,
      genres: m.genres,
      runtime: m.runtime,
      release: m.release,
      poster: m.poster,
      synopsis: m.synopsis,
      hasVF: m.hasVF,
      hasVO: m.hasVO,
      showtimes: m.showtimes.map(s => ({
        day: s.day,
        time: s.time,
        hour: s.hour,
        tags: s.tags,
        screen: s.screen,
        ticketingUrl: s.ticketingUrl,
        cinemaId: s.cinemaId,
      })),

      // ── Wikidata-resolved IDs ───────────────────────────────────────────
      wikidataUrl: m.wikidataUrl,
      qid: extractQid(m.wikidataUrl),
      imdbId: m.imdbId,
      allocineId: extractAllocineId(m.allocineUrl),
      rtPath: extractRtPath(m.rtUrl),

      // ── Ratings ─────────────────────────────────────────────────────────
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
  };

  return JSON.stringify(exportData, null, 2);
}

// ── Download helper ────────────────────────────────────────────────────────

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

// ── Component ──────────────────────────────────────────────────────────────

export const ExportButton: React.FC<ExportButtonProps> = ({ movies }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  // Only render in dev mode — hidden in packaged builds.
  if (!import.meta.env.DEV) return null;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);

  const handleCsv = () => {
    const csv = generateCsv(movies);
    downloadFile(csv, `arvecinema-${timestamp}.csv`, 'text/csv');
    setOpen(false);
  };

  const handleJson = () => {
    // Export what's currently in the renderer's memory — instant, no
    // re-fetch, no waiting for enrichment. The `movies` prop is the
    // full movie list from the currently-selected cinemas (before
    // day/hour/search filtering), with whatever ratings have been
    // enriched so far.
    //
    // If the user wants ALL 4 cinemas regardless of selection, they
    // should select all cinemas in the UI before clicking export.
    const json = generateJson(movies);
    downloadFile(json, `arvecinema-${timestamp}.json`, 'application/json');
    setOpen(false);
  };

  const btnStyle: React.CSSProperties = {
    padding: '6px 10px',
    borderRadius: 8,
    border: '1px solid var(--border-light)',
    background: 'transparent',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    fontSize: 14,
    lineHeight: 1,
  };

  const menuItemStyle: React.CSSProperties = {
    display: 'block',
    width: '100%',
    padding: '8px 14px',
    border: 'none',
    background: 'transparent',
    color: 'var(--text-primary)',
    cursor: 'pointer',
    fontSize: 13,
    textAlign: 'left',
    fontFamily: 'inherit',
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-label="Export data (dev)"
        title={`Export ${movies.length} movies (dev mode)`}
        style={btnStyle}
      >
        ⤓
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            minWidth: 180,
            background: 'var(--bg-card)',
            border: '1px solid var(--border-light)',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
            zIndex: 1000,
            overflow: 'hidden',
          }}
        >
          <button
            type="button"
            onClick={handleCsv}
            style={menuItemStyle}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-card-2)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            📊 CSV — ratings + IDs
          </button>
          <button
            type="button"
            onClick={handleJson}
            style={menuItemStyle}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-card-2)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            📦 JSON — full data + showtimes
          </button>
        </div>
      )}
    </div>
  );
};
