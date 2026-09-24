import React from 'react';
import { t } from '../../shared/i18n';

interface Props {
  min: number;
  max: number;
  step?: number;
  valueMin: number;
  valueMax: number;
  onChange: (min: number, max: number) => void;
}

/**
 * Two-thumb min/max slider built from two overlaid native `<input type="range">`
 * elements. Pointer events are disabled on the inputs themselves and
 * re-enabled only on the thumbs (see the `.double-range-input` CSS in
 * `index.html`), so both tracks can occupy the same rectangle without
 * blocking each other.
 *
 * Z-index trick: when the min thumb gets within 10% of the max end of the
 * range, raise it above the max thumb so it stays grabbable — otherwise the
 * max thumb would cover it.
 */
const MIN_THUMB_RAISE_THRESHOLD = 0.1; // 10% of the range

export const DoubleRangeSlider: React.FC<Props> = ({
  min,
  max,
  step = 1,
  valueMin,
  valueMax,
  onChange,
}) => {
  const range = max - min;
  const minPct = ((valueMin - min) / range) * 100;
  const maxPct = ((valueMax - min) / range) * 100;

  // When the min thumb is near the right end, raise it so it isn't covered
  // by the max thumb.
  const minThumbZ = valueMin > max - range * MIN_THUMB_RAISE_THRESHOLD ? 5 : 3;

  return (
    <div style={{ position: 'relative', height: 28, width: 220, flex: '0 0 auto' }}>
      {/* Track */}
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: 0,
          right: 0,
          height: 4,
          background: 'var(--bg-slider)',
          borderRadius: 'var(--radius-sm)',
          transform: 'translateY(-50%)',
        }}
      />
      {/* Selected range */}
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: `${minPct}%`,
          width: `${maxPct - minPct}%`,
          height: 4,
          background: 'var(--text-primary)',
          borderRadius: 'var(--radius-sm)',
          transform: 'translateY(-50%)',
        }}
      />

      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={valueMin}
        onChange={(e) => {
          const v = Math.min(Number(e.target.value), valueMax - step);
          onChange(v, valueMax);
        }}
        aria-label={t('minHour')}
        className="double-range-input"
        style={{ zIndex: minThumbZ }}
      />
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={valueMax}
        onChange={(e) => {
          const v = Math.max(Number(e.target.value), valueMin + step);
          onChange(valueMin, v);
        }}
        aria-label={t('maxHour')}
        className="double-range-input"
        style={{ zIndex: 4 }}
      />
    </div>
  );
};
