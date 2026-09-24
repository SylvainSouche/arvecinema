import React from 'react';
import type { CinemaInfo } from '../types';
import { t } from '../../shared/i18n';

interface Props {
  cinemas: CinemaInfo[];
  /** Empty array = "all cinemas" (this is also what gets emitted when the user
   *  deselects the last cinema). */
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}

/**
 * Multi-select chip bar of all known cinemas.
 *
 * Behaviour:
 *   - "Tous" pill is selected when `selectedIds` is empty (or all cinemas are
 *     individually selected).
 *   - Clicking "Tous" clears the selection (empty array).
 *   - Clicking a cinema while "Tous" is active starts a specific selection
 *     containing everyone except the clicked cinema (so the click has a
 *     visible effect).
 *   - Re-selecting the last deselected cinema switches back to "Tous" mode.
 */
export const CinemaSelector: React.FC<Props> = ({ cinemas, selectedIds, onChange }) => {
  if (cinemas.length === 0) return null;

  const allSelected = selectedIds.length === 0;

  const toggle = (id: string) => {
    if (allSelected) {
      onChange(cinemas.filter(c => c.id !== id).map(c => c.id));
    } else if (selectedIds.includes(id)) {
      const next = selectedIds.filter(x => x !== id);
      onChange(next.length === 0 ? [] : next);
    } else {
      const next = [...selectedIds, id];
      onChange(next.length === cinemas.length ? [] : next);
    }
  };

  const selectAll = () => onChange([]);

  return (
    <div style={{
      display: 'flex',
      gap: 8,
      padding: '10px 24px',
      borderBottom: '1px solid var(--border)',
      alignItems: 'center',
      flexWrap: 'wrap',
    }}>
      <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-md)', marginRight: 4 }}>{t('cinema')} :</span>

      <button
        onClick={selectAll}
        style={{
          padding: '6px 12px',
          borderRadius: 'var(--radius-2xl)',
          cursor: 'pointer',
          fontWeight: 'var(--weight-semibold)',
          fontSize: 'var(--text-base)',
          border: allSelected ? '1px solid var(--text-primary)' : '1px solid var(--border-light)',
          background: allSelected ? 'var(--text-primary)' : 'transparent',
          color: allSelected ? 'var(--bg-primary)' : 'var(--text-muted)',
        }}
      >
        {t('allCinemas')}
      </button>

      {cinemas.map(c => {
        const selected = allSelected || selectedIds.includes(c.id);
        return (
          <button
            key={c.id}
            onClick={() => toggle(c.id)}
            style={{
              padding: '6px 12px',
              borderRadius: 'var(--radius-2xl)',
              cursor: 'pointer',
              fontWeight: 'var(--weight-semibold)',
              fontSize: 'var(--text-base)',
              border: selected ? `1px solid ${c.color}` : '1px solid var(--border-light)',
              background: selected ? c.color : 'transparent',
              color: selected ? 'var(--bg-primary)' : '#999',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              background: selected ? 'var(--text-primary)' : c.color,
              display: 'inline-block',
            }} />
            {c.name}
            <span style={{ opacity: 0.7, fontWeight: 'var(--weight-normal)' }}>{c.city}</span>
          </button>
        );
      })}
    </div>
  );
};
