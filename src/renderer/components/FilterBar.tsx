import React from 'react';
import type { AudioFilter } from '../types';
import { DoubleRangeSlider } from './DoubleRangeSlider';
import { SortSelector, type SortMode } from './SortSelector';
import { formatHour } from '../../shared/cinema';
import { t } from '../../shared/i18n';

interface Props {
  audioFilter: AudioFilter;
  setAudioFilter: (f: AudioFilter) => void;
  minHour: number;
  setMinHour: (h: number) => void;
  maxHour: number;
  setMaxHour: (h: number) => void;
  /** UX-01: dynamic slider bounds — derived from the actual showtime data
   *  so matinées and late shows are reachable. */
  hourBounds: { min: number; max: number };
  search: string;
  setSearch: (s: string) => void;
  sortMode: SortMode;
  setSortMode: (m: SortMode) => void;
}

/** The always-visible filter bar: search + audio version pills + hour slider + sort. */
export const FilterBar: React.FC<Props> = ({
  audioFilter, setAudioFilter,
  minHour, setMinHour, maxHour, setMaxHour,
  hourBounds, search, setSearch,
  sortMode, setSortMode,
}) => {
  return (
    <div style={{
      padding: '12px 24px',
      borderBottom: '1px solid var(--border)',
      display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap',
    }}>
      {/* Search input — matches against title + director + cast */}
      <div style={{ position: 'relative', flex: '1 1 220px', minWidth: 220, maxWidth: 360 }}>
        <span aria-hidden style={{
          position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)',
          color: 'var(--text-muted)', fontSize: 14, pointerEvents: 'none',
        }}>🔍</span>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('searchPlaceholder')}
          spellCheck={false}
          style={{
            width: '100%',
            padding: '8px 32px',
            background: 'var(--bg-card-2)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-light)',
            borderRadius: 18,
            fontSize: 13,
            outline: 'none',
            transition: 'border-color 0.15s',
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = '#555'; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = '#333'; }}
        />
        {search && (
          <button
            onClick={() => setSearch('')}
            aria-label="Effacer"
            style={{
              position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
              background: 'transparent', border: 'none', color: 'var(--text-muted)',
              cursor: 'pointer', fontSize: 16, padding: '4px 8px', lineHeight: 1,
            }}
          >×</button>
        )}
      </div>

      {/* Audio version pills */}
      <div style={{ display: 'flex', gap: 8 }}>
        {(['ALL', 'VF', 'VO'] as AudioFilter[]).map((f) => {
          const active = audioFilter === f;
          return (
            <button
              key={f}
              onClick={() => setAudioFilter(f)}
              style={{
                padding: '7px 14px',
                borderRadius: 18,
                border: 'none',
                cursor: 'pointer',
                fontWeight: 600,
                fontSize: 13,
                background: active ? '#fff' : '#262626',
                color: active ? '#000' : '#fff',
              }}
            >
              {f === 'ALL' ? t('allVersions') : f}
            </button>
          );
        })}
      </div>

      {/* Double min/max hour slider — quarter-hour steps */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ color: 'var(--text-muted)', fontSize: 13, flex: '0 0 auto' }}>{t('hourRange')} :</span>
        <DoubleRangeSlider
          min={hourBounds.min}
          max={hourBounds.max}
          step={0.25}
          valueMin={minHour}
          valueMax={maxHour}
          onChange={(vMin, vMax) => { setMinHour(vMin); setMaxHour(vMax); }}
        />
        <span style={{
          color: 'var(--text-primary)',
          fontVariantNumeric: 'tabular-nums',
          fontSize: 13,
          minWidth: 110,
          fontWeight: 600,
        }}>
          {formatHour(minHour)} – {formatHour(maxHour)}
        </span>
      </div>

      {/* Sort mode — default by next screening proximity */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' }}>
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{t('sortBy')} :</span>
        <SortSelector value={sortMode} onChange={setSortMode} />
      </div>
    </div>
  );
};
