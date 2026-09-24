import React from 'react';
import { t } from '../../shared/i18n';

export type ViewMode = 'day' | 'week';

interface Props {
  value: ViewMode;
  onChange: (v: ViewMode) => void;
}

/** Segmented `[ Jour | Semaine ]` toggle for switching between day view
 *  (per-day MovieCard list) and week view (WeekGrid swimlane). */
export const ViewToggle: React.FC<Props> = ({ value, onChange }) => {
  return (
    <div style={{
      display: 'inline-flex',
      background: 'var(--bg-pill)',
      borderRadius: 'var(--radius-2xl)',
      padding: 3,
      border: '1px solid var(--border-light)',
      flex: '0 0 auto',
    }}>
      {(['day', 'week'] as const).map(v => {
        const active = value === v;
        return (
          <button
            key={v}
            onClick={() => onChange(v)}
            aria-pressed={active}
            style={{
              padding: '6px 14px',
              borderRadius: 'var(--radius-2xl)',
              border: 'none',
              cursor: 'pointer',
              fontWeight: 'var(--weight-semibold)',
              fontSize: 'var(--text-md)',
              background: active ? 'var(--text-primary)' : 'transparent',
              color: active ? 'var(--bg-primary)' : 'var(--text-muted)',
              transition: 'var(--transition-normal)',
            }}
          >
            {v === 'day' ? t('dayView') : t('weekView')}
          </button>
        );
      })}
    </div>
  );
};
