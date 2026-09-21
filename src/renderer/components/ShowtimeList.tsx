import React from 'react';
import type { Showtime, CinemaInfo } from '../types';
import { showtimeVersion } from '../types';
import { formatTime, cinemaColor, cinemaName } from '../../shared/cinema';
import { t } from '../../shared/i18n';

interface Props {
  showtimes: Showtime[];
  cinemas: CinemaInfo[];
}

/** Show a colored chip per showtime. The chip's color border matches the
 *  cinema's color so it's scannable when multiple cinemas are visible. */
export const ShowtimeList: React.FC<Props> = ({ showtimes, cinemas }) => {
  if (showtimes.length === 0) {
    return <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>{t('noShowtimes')}</span>;
  }

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {showtimes.map((st) => {
        const v = showtimeVersion(st.tags);
        const color = cinemaColor(cinemas, st.cinemaId);
        return (
          <button
            key={`${st.cinemaId}-${st.time}`}
            type="button"
            disabled={!st.ticketingUrl}
            onClick={() => {
              if (st.ticketingUrl) {
                // CMB-008: route through the validated main-process handler
                // rather than opening the URL directly from the renderer.
                void window.electronAPI.openTicket(st.ticketingUrl);
              }
            }}
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              background: st.ticketingUrl ? '#1a1a1a' : '#2a2a2a',
              color: 'var(--text-primary)',
              border: `1px solid ${color}40`,
              fontSize: 13,
              fontWeight: 600,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              cursor: st.ticketingUrl ? 'pointer' : 'default',
            }}
            title={[
              st.screen ? `${t('screen')}: ${st.screen}` : null,
              cinemaName(cinemas, st.cinemaId),
            ].filter(Boolean).join(' · ')}
          >
            <span
              aria-hidden
              style={{
                width: 8, height: 8, borderRadius: '50%',
                background: color, display: 'inline-block',
              }}
            />
            {formatTime(st.time)}
            {v && (
              <span style={{
                opacity: 0.95,
                fontSize: 10,
                background: 'rgba(0,0,0,0.45)',
                padding: '1px 5px',
                borderRadius: 3,
                fontWeight: 700,
              }}>
                {v}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};
