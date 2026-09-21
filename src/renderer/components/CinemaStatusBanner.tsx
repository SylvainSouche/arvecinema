import React from 'react';
import type { CinemaInfo, CinemaStatus } from '../types';
import { t, type TranslationKey } from '../../shared/i18n';

interface Props {
  cinemas: CinemaInfo[];
  statuses: CinemaStatus[];
}

/** CMB-005 — surfaces per-cinema fetch failures so the user can distinguish
 *  "no screenings this week" from "server unreachable". Renders nothing if
 *  every cinema returned a successful schedule. */
export const CinemaStatusBanner: React.FC<Props> = ({ cinemas, statuses }) => {
  const failures = statuses.filter((s) => s.status !== 'ok');
  if (failures.length === 0) return null;

  const cinemaName = (id: string) => cinemas.find((c) => c.id === id)?.name ?? id;

  const statusLabelKey: Record<CinemaStatus['status'], TranslationKey | null> = {
    ok: null,
    timeout: 'cinemaStatus_timeout',
    'http-error': 'cinemaStatus_http-error',
    'parse-error': 'cinemaStatus_parse-error',
  };

  return (
    <div
      style={{
        padding: '10px 24px',
        background: 'var(--bg-card)',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-1)',
      }}
    >
      {failures.map((s) => (
        <div
          key={s.cinemaId}
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
        >
          <span aria-hidden style={{ fontSize: 'var(--text-lg)' }}>
            ⚠️
          </span>
          <strong style={{ color: 'var(--brand-amber)', fontWeight: 'var(--weight-semibold)' }}>
            {cinemaName(s.cinemaId)}
          </strong>
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-md)' }}>
            — {t('cinemaUnavailable')} (
            {statusLabelKey[s.status] ? t(statusLabelKey[s.status]!) : s.status})
          </span>
        </div>
      ))}
    </div>
  );
};
