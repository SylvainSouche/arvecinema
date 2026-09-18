import React from 'react';

// ──────────────────────────────────────────────────────────────────────────
// ProgressBar — 3px-high progress bar pinned to the bottom of the window.
//
// Shows enrichment progress: 0% → 100% as films are processed.
// Hides itself (height: 0) when:
//   - `pct >= 100` (enrichment complete)
//   - `total === 0` (no enrichment in progress)
// ──────────────────────────────────────────────────────────────────────────

interface ProgressBarProps {
  resolved: number;
  total: number;
  pct: number;
}

export const ProgressBar: React.FC<ProgressBarProps> = ({ resolved, total, pct }) => {
  // Hide when complete or no enrichment running.
  if (pct >= 100 || total === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        height: 3,
        background: 'var(--bg-card-2)',
        zIndex: 999,
        overflow: 'hidden',
      }}
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`Ratings: ${resolved}/${total}`}
    >
      {/* Filled portion — animated width transition */}
      <div
        style={{
          height: '100%',
          width: `${pct}%`,
          background: 'linear-gradient(90deg, #4a9eff 0%, #6cb5ff 100%)',
          transition: 'width 200ms ease-out',
          boxShadow: '0 0 8px rgba(74, 158, 255, 0.6)',
        }}
      />
    </div>
  );
};
