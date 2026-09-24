import React from 'react';
import { formatDayShort } from '../../shared/cinema';
import { t } from '../../shared/i18n';

interface Props {
  availableDays: string[];       // YYYY-MM-DD list
  selectedDay: string | null;    // YYYY-MM-DD, or null = "all days"
  onSelect: (day: string | null) => void;
}

/** Horizontal day picker. Each pill shows weekday + day number only
 *  (month removed to save vertical space — the user doesn't need it
 *  since all days are within the same 2-week window). */
export const DaySelector: React.FC<Props> = ({ availableDays, selectedDay, onSelect }) => {
  if (availableDays.length === 0) return null;

  const allSelected = selectedDay === null;

  return (
    <div style={{
      display: 'flex',
      gap: 8,
      padding: '10px 24px',
      borderBottom: '1px solid var(--border)',
      overflowX: 'auto',
      alignItems: 'center',
      flexShrink: 0,
    }}>
      <button
        onClick={() => onSelect(null)}
        style={{
          flex: '0 0 auto',
          padding: '8px 14px',
          borderRadius: 'var(--radius-xl)',
          cursor: 'pointer',
          fontWeight: 'var(--weight-semibold)',
          fontSize: 'var(--text-md)',
          border: allSelected ? '1px solid var(--text-primary)' : '1px solid var(--border-light)',
          background: allSelected ? 'var(--text-primary)' : 'var(--bg-strip-active)',
          color: allSelected ? 'var(--bg-primary)' : 'var(--text-secondary)',
          whiteSpace: 'nowrap',
        }}
      >
        {t('allDays')}
      </button>

      {availableDays.map((iso) => {
        const sel = selectedDay === iso;
        const { weekday, dayNum } = formatDayShort(iso);
        return (
          <button
            key={iso}
            onClick={() => onSelect(iso)}
            style={{
              flex: '0 0 auto',
              padding: '6px 14px',
              borderRadius: 'var(--radius-xl)',
              cursor: 'pointer',
              border: sel ? '1px solid var(--text-primary)' : '1px solid var(--border-light)',
              background: sel ? 'var(--text-primary)' : 'var(--bg-strip-active)',
              color: sel ? 'var(--bg-primary)' : 'var(--text-secondary)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 1,
              minWidth: 52,
              whiteSpace: 'nowrap',
            }}
          >
            <span style={{ fontSize: 'var(--text-sm)', textTransform: 'capitalize', opacity: 0.8 }}>
              {weekday}
            </span>
            <span style={{ fontSize: 'var(--text-xl)', fontWeight: 'var(--weight-bold)', lineHeight: 1 }}>
              {dayNum}
            </span>
          </button>
        );
      })}
    </div>
  );
};
