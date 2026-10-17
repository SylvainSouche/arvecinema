import React, { useCallback, useEffect, useState } from 'react';
import { t } from '../../shared/i18n';
import { readCustomCinemas, saveCustomCinemas, listPluginKinds } from '../api/cinemaApi';

// ──────────────────────────────────────────────────────────────────────────
// CustomCinemasEditor — About panel → "Cinemas" tab.
//
// Edits the user's custom cinema registry (userData/custom-cinemas.json)
// through the IPC round trip:
//   readCustomCinemas → editable rows → saveCustomCinemas (write + reload)
// and surfaces main-process validation rejections inline (invalid entries
// are skipped by the registry; errors are shown here).
//
// The form fields map onto the CinemaInstance shape: id is derived from the
// name (slugified), kind comes from the registered plugin list, and
// baseUrl/theaterId are the adapter config fields all bundled plugins
// currently understand.
// ──────────────────────────────────────────────────────────────────────────

interface EditorEntry {
  id?: string;
  name: string;
  city: string;
  color: string;
  kind: string;
  baseUrl: string;
  theaterId: string;
}

interface PluginKindInfo {
  id: string;
  displayName: string;
  description?: string;
}

/** Adapter config fields each kind needs (mirrors the plugins' configs). */
const KIND_FIELDS: Record<string, { baseUrl: boolean; theaterId: boolean }> = {
  boxofficeapi: { baseUrl: true, theaterId: true },
  cinechateau: { baseUrl: true, theaterId: true },
  cinevox: { baseUrl: true, theaterId: false },
  example: { baseUrl: true, theaterId: false },
};
const fallbackFields = { baseUrl: true, theaterId: false };

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 40) || 'cinema'
  );
}

export const CustomCinemasEditor: React.FC = () => {
  const [entries, setEntries] = useState<EditorEntry[]>([]);
  const [kinds, setKinds] = useState<PluginKindInfo[]>([]);
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [rowErrors, setRowErrors] = useState<Set<number>>(new Set());

  useEffect(() => {
    let cancelled = false;
    listPluginKinds()
      .then((k) => {
        if (!cancelled) setKinds(k);
      })
      .catch(() => {
        /* non-fatal: select renders empty */
      });
    readCustomCinemas()
      .then(({ cinemas }) => {
        if (cancelled) return;
        setEntries(cinemas.map(rawToEditorEntry));
      })
      .catch(() => {
        /* non-fatal: empty form */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback((i: number, patch: Partial<EditorEntry>) => {
    setEntries((prev) => prev.map((e, j) => (j === i ? { ...e, ...patch } : e)));
    setRowErrors((prev) => {
      const next = new Set(prev);
      next.delete(i);
      return next;
    });
    setStatus('idle');
  }, []);

  const addRow = useCallback(() => {
    setStatus('idle');
    setEntries((prev) => [
      ...prev,
      {
        name: '',
        city: '',
        color: '#3b82f6',
        kind: kinds[0]?.id ?? 'boxofficeapi',
        baseUrl: '',
        theaterId: '',
      },
    ]);
  }, [kinds]);

  const removeRow = useCallback((i: number) => {
    setStatus('idle');
    setEntries((prev) => prev.filter((_, j) => j !== i));
  }, []);

  const save = useCallback(async () => {
    // Renderer-side validation: name/city/kind/baseUrl are required for
    // every bundled adapter kind; ids are derived from names.
    const errs = new Set<number>();
    const seenIds = new Set<string>();
    entries.forEach((e, i) => {
      const id = slugify(e.name);
      if (!e.name || !e.city || !e.baseUrl) errs.add(i);
      if (KIND_FIELDS[e.kind]?.theaterId === true && !e.theaterId) errs.add(i);
      if (seenIds.has(id)) errs.add(i);
      seenIds.add(id);
    });
    setRowErrors(errs);
    if (errs.size > 0) {
      setStatus('error');
      return;
    }

    try {
      const { written, reload } = await saveCustomCinemas(
        entries.map((e) => ({
          id: slugify(e.name),
          name: e.name,
          city: e.city,
          color: e.color,
          adapter: {
            kind: e.kind,
            baseUrl: e.baseUrl,
            ...(KIND_FIELDS[e.kind]?.theaterId === true ? { theaterId: e.theaterId } : {}),
          },
        })),
      );
      if (!written) {
        setStatus('error');
        return;
      }
      setStatus('saved');
      // Surface main-side rejections (builtin-id collisions, plugin config
      // errors) — map them onto error badges for their rows.
      const rejectErrors = new Set<number>();
      reload.errors.forEach((err) => {
        const match = err.entry.match(/^cinemas\[(\d+)\]/);
        if (match) rejectErrors.add(Number(match[1]));
      });
      setRowErrors(rejectErrors);
      if (rejectErrors.size > 0) setStatus('error');
    } catch {
      setStatus('error');
    }
  }, [entries]);

  return (
    <div>
      <h3 style={{ margin: '0 0 6px', fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-bold)' }}>
        {t('customCinemasTitle')}
      </h3>
      <p style={{ margin: '0 0 12px', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
        {t('customCinemasHint')}
      </p>

      {entries.length === 0 && (
        <p style={{ margin: '0 0 12px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
          {t('customCinemasEmpty')}
        </p>
      )}

      {entries.map((entry, i) => {
        const fields = KIND_FIELDS[entry.kind] ?? fallbackFields;
        const hasError = rowErrors.has(i);
        return (
          <div
            key={i}
            data-testid="custom-cinema-row"
            style={{
              border: `1px solid ${hasError ? '#ef4444' : 'var(--border)'}`,
              borderRadius: 'var(--radius-md, 8px)',
              padding: 10,
              marginBottom: 8,
              display: 'grid',
              gridTemplateColumns: '1fr 1fr auto auto',
              gap: 6,
              alignItems: 'center',
            }}
          >
            <input
              data-testid={`custom-cinema-name-${i}`}
              placeholder={t('customCinemaName')}
              value={entry.name}
              onChange={(e) => update(i, { name: e.target.value })}
              style={inputStyle}
            />
            <input
              data-testid={`custom-cinema-city-${i}`}
              placeholder={t('customCinemaCity')}
              value={entry.city}
              onChange={(e) => update(i, { city: e.target.value })}
              style={inputStyle}
            />
            <input
              type="color"
              data-testid={`custom-cinema-color-${i}`}
              aria-label={t('customCinemaColor')}
              value={/^#[0-9a-fA-F]{6}$/.test(entry.color) ? entry.color : '#3b82f6'}
              onChange={(e) => update(i, { color: e.target.value })}
              style={inputStyle}
            />
            <button
              type="button"
              data-testid={`custom-cinema-remove-${i}`}
              onClick={() => removeRow(i)}
              style={removeBtnStyle}
            >
              {t('customCinemasRemove')}
            </button>

            <select
              data-testid={`custom-cinema-kind-${i}`}
              value={entry.kind}
              onChange={(e) => update(i, { kind: e.target.value })}
              style={inputStyle}
            >
              {kinds.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.displayName}
                </option>
              ))}
            </select>
            <input
              data-testid={`custom-cinema-baseurl-${i}`}
              placeholder={t('customCinemaBaseUrl')}
              value={entry.baseUrl}
              onChange={(e) => update(i, { baseUrl: e.target.value })}
              style={inputStyle}
            />
            <input
              data-testid={`custom-cinema-theaterid-${i}`}
              placeholder={t('customCinemaTheaterId')}
              value={entry.theaterId}
              onChange={(e) => update(i, { theaterId: e.target.value })}
              style={{ ...inputStyle, gridColumn: fields.theaterId ? 'span 1' : 'span 2' }}
              disabled={!fields.theaterId}
            />
            <span />
          </div>
        );
      })}

      <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
        <button type="button" data-testid="custom-cinemas-add" onClick={addRow} style={btnStyle}>
          {t('customCinemasAdd')}
        </button>
        <button
          type="button"
          data-testid="custom-cinemas-save"
          onClick={() => void save()}
          style={btnStyle}
        >
          {t('customCinemasSave')}
        </button>
        <span
          data-testid="custom-cinemas-status"
          style={{
            fontSize: 'var(--text-sm)',
            color:
              status === 'error' ? '#ef4444' : status === 'saved' ? '#10b981' : 'var(--text-muted)',
          }}
        >
          {status === 'saved' ? t('customCinemasSaved') : status === 'error' ? t('customCinemasSaveError') : ''}
        </span>
      </div>
    </div>
  );
};

function rawToEditorEntry(raw: unknown): EditorEntry {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const adapter = (obj.adapter ?? {}) as Record<string, unknown>;
  return {
    id: typeof obj.id === 'string' ? obj.id : undefined,
    name: typeof obj.name === 'string' ? obj.name : '',
    city: typeof obj.city === 'string' ? obj.city : '',
    color: typeof obj.color === 'string' ? obj.color : '#3b82f6',
    kind: typeof adapter.kind === 'string' ? adapter.kind : 'boxofficeapi',
    baseUrl: typeof adapter.baseUrl === 'string' ? adapter.baseUrl : '',
    theaterId: typeof adapter.theaterId === 'string' ? adapter.theaterId : '',
  };
}

const inputStyle: React.CSSProperties = {
  padding: '4px 8px',
  fontSize: 'var(--text-sm)',
  color: 'var(--text)',
  background: 'var(--bg-elev, transparent)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm, 6px)',
  minWidth: 0,
};

const btnStyle: React.CSSProperties = {
  padding: '6px 14px',
  fontSize: 'var(--text-sm)',
  cursor: 'pointer',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm, 6px)',
  color: 'var(--text)',
  background: 'var(--bg, transparent)',
};

const removeBtnStyle: React.CSSProperties = {
  ...btnStyle,
  color: '#ef4444',
  padding: '4px 10px',
};
