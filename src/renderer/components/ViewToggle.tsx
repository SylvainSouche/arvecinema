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
      borderRadius: 18,
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
              borderRadius: 16,
              border: 'none',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: 13,
              background: active ? '#fff' : 'transparent',
              color: active ? '#000' : '#999',
              transition: 'background 0.15s, color 0.15s',
            }}
          >
            {v === 'day' ? t('dayView') : t('weekView')}
          </button>
        );
      })}
    </div>
  );
};
