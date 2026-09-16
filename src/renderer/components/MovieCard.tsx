import React from 'react';
import type { Movie, CinemaInfo } from '../types';
import { ShowtimeList } from './ShowtimeList';
import { t } from '../../shared/i18n';

/** Pick a color for a 0-100 score. */
const scoreColor = (score: number | undefined): string => {
  if (score === undefined) return '#666';
  if (score >= 75) return '#10b981';   // green — fresh
  if (score >= 60) return '#eab308';   // yellow — meh
  return '#e50914';                    // red — rotten
};

interface Props {
  movie: Movie;
  cinemas: CinemaInfo[];
}

/** Big bold movie card for the day view.
 *
 *  Layout:
 *  ┌─────────┬───────────────────────────────────────┐
 *  │ poster  │  Title (big bold)                    │
 *  │ (110px) │  [cinema badge] [VF] [VO] · genres  │
 *  │         │  Réalisation : ...                   │
 *  │         │  Avec : ...                          │
 *  │         │  synopsis (2 lines clamp)            │
 *  │         │  [showtime chips]                    │
 *  └─────────┴───────────────────────────────────────┘
 */
export const MovieCard: React.FC<Props> = ({ movie, cinemas }) => {
  return (
    <div style={{
      display: 'flex',
      gap: 20,
      padding: 16,
      background: 'var(--bg-card)',
      borderRadius: 12,
      border: '1px solid var(--border)',
      alignItems: 'flex-start',
    }}>
      {/* Poster — fixed width */}
      <div style={{
        flex: '0 0 110px',
        width: 110,
        aspectRatio: '2 / 3',
        background: 'var(--bg-card-2)',
        borderRadius: 8,
        overflow: 'hidden',
        position: 'relative',
      }}>
        {movie.poster ? (
          <img
            src={movie.poster}
            alt={movie.title}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-faint)', fontSize: 11, textAlign: 'center', padding: 8,
          }}>
            {t('noPoster')}
          </div>
        )}
      </div>

      {/* Right column */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h3 style={{
          margin: 0,
          fontSize: 22,
          color: 'var(--text-primary)',
          fontWeight: 800,
          lineHeight: 1.2,
          letterSpacing: -0.2,
        }}>
          {movie.title}
        </h3>

        {/* Line 1: all cinema badges */}
        <div style={{ display: 'flex', gap: 6, marginTop: 2, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Show ALL cinemas that have showtimes for this movie (deduplicated
              from the showtimes' cinemaId field). */}
          {Array.from(new Set(movie.showtimes.map(s => s.cinemaId)))
            .map(id => cinemas.find(c => c.id === id))
            .filter((c): c is NonNullable<typeof c> => c !== undefined)
            .map(cinema => (
              <span key={cinema.id} style={{
                background: cinema.color,
                color: 'var(--text-primary)',
                padding: '2px 9px',
                borderRadius: 4,
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 0.3,
              }}>
                {cinema.name} · {cinema.city}
              </span>
            ))
          }
        </div>

        {/* Line 2: VF/VO badges + genres + runtime + ratings */}
        <div style={{ display: 'flex', gap: 8, marginTop: 2, alignItems: 'center', flexWrap: 'wrap' }}>
          {movie.hasVF && (
            <span style={{
              background: 'var(--text-primary)', color: 'var(--bg-card)',
              padding: '2px 9px', borderRadius: 4,
              fontSize: 11, fontWeight: 700, letterSpacing: 0.3,
            }}>VF</span>
          )}
          {movie.hasVO && (
            <span style={{
              background: 'transparent', color: 'var(--text-primary)',
              padding: '2px 9px', borderRadius: 4,
              fontSize: 11, fontWeight: 700, letterSpacing: 0.3,
              border: '1px solid var(--text-primary)',
            }}>VO</span>
          )}
          {movie.genres && (
            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>· {movie.genres}</span>
          )}
          {movie.runtime ? (
            <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>· {movie.runtime} {t('minutes')}</span>
          ) : null}
          {(movie.imdbId || movie.allocineUrl || movie.rtUrl ||
            movie.imdbStatus !== undefined || movie.allocineStatus !== undefined || movie.rtStatus !== undefined ||
            movie.wikidataUrl === undefined) && (
            <RatingBadges movie={movie} />
          )}
        </div>

        {/* Director + actors */}
        <div style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.45, marginTop: 4 }}>
          <div>
            <strong style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{t('realization')} :</strong>{' '}
            {movie.direction}
          </div>
          <div>
            <strong style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{t('with_')} :</strong>{' '}
            {movie.casting}
          </div>
        </div>

        {movie.synopsis && (
          <p style={{
            margin: '6px 0 0',
            color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}>
            {movie.synopsis.replace(/<[^>]+>/g, '')}
          </p>
        )}

        {/* Showtimes (colored dot per cinema) */}
        <div style={{ marginTop: 8 }}>
          <ShowtimeList showtimes={movie.showtimes} cinemas={cinemas} />
        </div>
      </div>
    </div>
  );
};

// ── Rating badges (AlloCiné + Rotten Tomatoes) ──────────────────────────────

/** Color for a score on its native scale.
 *  AlloCiné is 0-5, RT is 0-100. */
const acColor = (score: number | undefined): string => {
  if (score === undefined) return '#666';
  if (score >= 3.5) return '#10b981';
  if (score >= 2.5) return '#eab308';
  return '#e50914';
};

/** Status indicator dot: green = ok, red = absent/blocked. */
const statusColor = (status: string | undefined): string => {
  if (status === 'ok') return '#10b981';
  if (status === 'blocked') return '#e50914';
  if (status === 'absent') return '#e50914';
  return '#666';   // unknown / loading
};

const RatingBadges: React.FC<{ movie: Movie }> = ({ movie }) => {
  // Compact status badge — shows source name + colored dot.
  // If the rating is available, shows the score. If not, shows why.
  const StatusBadge: React.FC<{
    source: 'imdb' | 'allocine' | 'rt';
  }> = ({ source }) => {
    const status = source === 'imdb' ? movie.imdbStatus
      : source === 'allocine' ? movie.allocineStatus
      : movie.rtStatus;
    const msg = source === 'imdb' ? movie.imdbStatusMessage
      : source === 'allocine' ? movie.allocineStatusMessage
      : movie.rtStatusMessage;
    const label = source === 'imdb' ? 'IMDB' : source === 'allocine' ? 'AC' : 'RT';

    // If we have a rating, show the compact badge with green dot
    if (status === 'ok') return null;   // the actual rating badge handles this

    // No rating — show a red dot with explanation
    if (status === undefined) return null;   // not yet fetched

    return (
      <span
        title={`${label}: ${msg ?? status}`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 2,
          fontSize: 10,
          color: 'var(--text-dim)',
          padding: '2px 4px',
        }}
      >
        <span style={{ fontSize: 9 }}>{label}</span>
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: statusColor(status),
          display: 'inline-block',
        }} />
      </span>
    );
  };

  return (
    <>
      {/* If Wikidata found nothing (no wikidataUrl, no statuses set),
          show a single ❓ badge. */}
      {movie.wikidataUrl === undefined &&
       movie.imdbStatus === undefined &&
       movie.allocineStatus === undefined &&
       movie.rtStatus === undefined ? (
        <span
          title="Wikidata n'a pas trouvé ce film — pas de notes disponibles"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            fontSize: 11,
            color: 'var(--text-faint)',
            padding: '2px 6px',
          }}
        >
          ❓
        </span>
      ) : (
        <>
      {/* IMDB — show icon if we have an ID (score appears when status=ok) */}
      {movie.imdbStatus === 'ok' && movie.imdbRating !== undefined ? (
        <button
          type="button"
          onClick={() => { if (movie.imdbUrl) void window.electronAPI.openTicket(movie.imdbUrl); }}
          title={[
            t('imdbRating'),
            `Note : ${movie.imdbRating.toFixed(1)}/10`,
            movie.imdbVotes !== undefined ? `${movie.imdbVotes.toLocaleString('fr-FR')} ${t('votes')}` : null,
            movie.imdbUrl ? '\n' + t('openImdb') : null,
          ].filter(Boolean).join(' · ')}
          style={okBadgeStyle('rgba(245,197,24,0.1)', 'rgba(245,197,24,0.3)')}
        >
          <span aria-hidden>⭐</span>
          <span style={{ color: '#f5c518' }}>{movie.imdbRating.toFixed(1)}</span>
        </button>
      ) : movie.imdbId && movie.imdbUrl ? (
        /* ID exists, rating not yet scraped — show faded icon with … */
        <a
          href={movie.imdbUrl}
          onClick={(e) => { e.preventDefault(); if (movie.imdbUrl) void window.electronAPI.openTicket(movie.imdbUrl); }}
          title={`IMDB — ${t('openImdb')}`}
          style={okBadgeStyle('rgba(245,197,24,0.05)', 'rgba(245,197,24,0.15)')}
        >
          <span aria-hidden style={{ opacity: 0.5 }}>⭐</span>
          <span style={{ color: 'rgba(245,197,24,0.5)', fontSize: 10 }}>…</span>
        </a>
      ) : <StatusBadge source="imdb" />}

      {/* AlloCiné — show icon if we have an ID (score appears when status=ok) */}
      {movie.allocineStatus === 'ok' && (movie.allocinePress !== undefined || movie.allocineAudience !== undefined) ? (
        <button
          type="button"
          onClick={() => { if (movie.allocineUrl) void window.electronAPI.openTicket(movie.allocineUrl); }}
          title={[
            'AlloCiné',
            movie.allocinePress !== undefined ? `${t('pressRating')} : ${movie.allocinePress.toFixed(1).replace('.', ',')}/5` : null,
            movie.allocineAudience !== undefined ? `${t('audienceRating')} : ${movie.allocineAudience.toFixed(1).replace('.', ',')}/5` : null,
            movie.allocineVotes !== undefined ? `${movie.allocineVotes} ${t('votes')}` : null,
            movie.allocineUrl ? '\n' + t('openAllocine') : null,
          ].filter(Boolean).join(' · ')}
          style={okBadgeStyle('rgba(251,204,5,0.1)', 'rgba(251,204,5,0.3)')}
        >
          {movie.allocinePress !== undefined && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              <span aria-hidden style={{ fontSize: 9 }}>✍</span>
              <span style={{ color: acColor(movie.allocinePress) }}>{movie.allocinePress.toFixed(1).replace('.', ',')}</span>
            </span>
          )}
          {movie.allocineAudience !== undefined && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              <span aria-hidden style={{ fontSize: 9 }}>👥</span>
              <span style={{ color: acColor(movie.allocineAudience) }}>{movie.allocineAudience.toFixed(1).replace('.', ',')}</span>
            </span>
          )}
        </button>
      ) : movie.allocineUrl ? (
        /* URL exists, rating not yet scraped — show faded icon with … */
        <a
          href={movie.allocineUrl}
          onClick={(e) => { e.preventDefault(); if (movie.allocineUrl) void window.electronAPI.openTicket(movie.allocineUrl); }}
          title={`AlloCiné — ${t('openAllocine')}`}
          style={okBadgeStyle('rgba(251,204,5,0.05)', 'rgba(251,204,5,0.15)')}
        >
          <span aria-hidden style={{ fontSize: 9, opacity: 0.5 }}>✍</span>
          <span style={{ color: 'rgba(251,204,5,0.5)', fontSize: 10 }}>…</span>
        </a>
      ) : <StatusBadge source="allocine" />}

      {/* RT — show icon if we have a URL (score appears when status=ok) */}
      {movie.rtStatus === 'ok' && movie.rtTomatometer !== undefined ? (
        <button
          type="button"
          onClick={() => { if (movie.rtUrl) void window.electronAPI.openTicket(movie.rtUrl); }}
          title={[
            movie.rtCertifiedFresh ? t('certifiedFresh') : t('rottenTomatoes'),
            `${t('pressRating')} : ${movie.rtTomatometer}%`,
            movie.rtUrl ? '\n' + t('openRt') : null,
          ].filter(Boolean).join(' · ')}
          style={okBadgeStyle('rgba(255,255,255,0.05)', 'var(--border-light)')}
        >
          <span aria-hidden>{movie.rtTomatometer >= 60 ? '🍅' : '🤢'}</span>
          <span style={{ color: scoreColor(movie.rtTomatometer) }}>{movie.rtTomatometer}%</span>
        </button>
      ) : movie.rtUrl ? (
        /* URL exists, rating not yet scraped — show faded icon with … */
        <a
          href={movie.rtUrl}
          onClick={(e) => { e.preventDefault(); if (movie.rtUrl) void window.electronAPI.openTicket(movie.rtUrl); }}
          title={`Rotten Tomatoes — ${t('openRt')}`}
          style={okBadgeStyle('rgba(255,255,255,0.03)', 'var(--border-light)')}
        >
          <span aria-hidden style={{ opacity: 0.5 }}>🍅</span>
          <span style={{ color: 'var(--text-faint)', fontSize: 10 }}>…</span>
        </a>
      ) : <StatusBadge source="rt" />}
        </>
      )}
    </>
  );
};

/** Shared style for OK rating badges (clickable, colored border). */
const okBadgeStyle = (bg: string, border: string): React.CSSProperties => ({
  background: bg,
  border: `1px solid ${border}`,
  borderRadius: 4,
  padding: '2px 8px',
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 2,
});
