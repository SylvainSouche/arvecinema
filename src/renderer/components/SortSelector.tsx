import React from 'react';
import { t, type TranslationKey } from '../../shared/i18n';

/** Sort modes offered in the UI.
 *
 *  - `next-screening` (default): movies ordered by the start time of the
 *    earliest showtime that passes the current filters. Movies with no
 *    upcoming match sink to the bottom.
 *  - `title`: A→Z alphabetical, case-insensitive, accent-insensitive.
 *  - `cinema`: grouped by cinema (in registry order), then by title within
 *    each cinema.
 *
 *  When the user switches sort mode, the previous ordering is preserved
 *  as a stable secondary key — so equal-ranked movies keep their relative
 *  order from the previous sort rather than shuffling randomly. */
export type SortMode = 'next-screening' | 'title' | 'cinema';

interface Props {
  value: SortMode;
  onChange: (m: SortMode) => void;
}

const LABELS: Record<SortMode, TranslationKey> = {
  'next-screening': 'sort_nextScreening',
  'title': 'sort_title',
  'cinema': 'sort_cinema',
};

export const SortSelector: React.FC<Props> = ({ value, onChange }) => {
  return (
    <div style={{
      display: 'inline-flex',
      background: 'var(--bg-pill)',
      borderRadius: 16,
      padding: 3,
      border: '1px solid var(--border-light)',
      flex: '0 0 auto',
    }}>
      {(Object.keys(LABELS) as SortMode[]).map(m => {
        const active = value === m;
        return (
          <button
            key={m}
            type="button"
            onClick={() => onChange(m)}
            aria-pressed={active}
            title={
              m === 'next-screening'
                ? t('sort_nextScreening')
                : m === 'title'
                ? t('sort_title')
                : t('sort_cinema')
            }
            style={{
              padding: '5px 11px',
              borderRadius: 13,
              border: 'none',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: 12,
              background: active ? '#fff' : 'transparent',
              color: active ? '#000' : '#999',
              transition: 'background 0.15s, color 0.15s',
            }}
          >
            {t(LABELS[m])}
          </button>
        );
      })}
    </div>
  );
};
