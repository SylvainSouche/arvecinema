import React from 'react';
import type { CinemaInfo, CinemaStatus } from '../types';

interface Props {
  cinemas: CinemaInfo[];
  statuses: CinemaStatus[];
}

/** CMB-005 — surfaces per-cinema fetch failures so the user can distinguish
 *  "no screenings this week" from "server unreachable". Renders nothing if
 *  every cinema returned a successful schedule. */
export const CinemaStatusBanner: React.FC<Props> = ({ cinemas, statuses }) => {
  const failures = statuses.filter(s => s.status !== 'ok');
  if (failures.length === 0) return null;

  const cinemaName = (id: string) =>
    cinemas.find(c => c.id === id)?.name ?? id;

  const label: Record<CinemaStatus['status'], string> = {
    ok: '',
    timeout: 'délai dépassé',
    'http-error': 'erreur HTTP',
    'parse-error': 'format du site modifié',
  };

  return (
    <div style={{
      padding: '10px 24px',
      background: 'var(--bg-card)',
      borderBottom: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
    }}>
      {failures.map(s => (
        <div key={s.cinemaId} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span aria-hidden style={{ fontSize: 14 }}>⚠️</span>
          <strong style={{ color: '#ffb38a', fontWeight: 600 }}>
            {cinemaName(s.cinemaId)}
          </strong>
          <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            — programmation temporairement indisponible ({label[s.status]})
          </span>
        </div>
      ))}
    </div>
  );
};
