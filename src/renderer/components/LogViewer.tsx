import React, { useState, useEffect, useRef } from 'react';
import { t } from '../../shared/i18n';

// ──────────────────────────────────────────────────────────────────────────
// LogViewer — displays main-process console output with filtering.
//
// Subscribes to `log:append` IPC events for real-time updates.
// Supports filtering by level (all/warn/error) and text search.
// ──────────────────────────────────────────────────────────────────────────

interface LogEntry {
  timestamp: string;
  level: 'log' | 'warn' | 'error' | 'debug' | 'info';
  component: string;
  message: string;
}

const LEVEL_COLORS: Record<string, string> = {
  debug: 'var(--text-faint)',
  info: 'var(--text-secondary)',
  log: 'var(--text-secondary)',
  warn: '#eab308',
  error: '#e50914',
};

const LEVEL_BG: Record<string, string> = {
  debug: 'transparent',
  info: 'transparent',
  log: 'transparent',
  warn: 'rgba(234, 179, 8, 0.05)',
  error: 'rgba(229, 9, 20, 0.05)',
};

export const LogViewer: React.FC = () => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<'all' | 'warn' | 'error'>('all');
  const [search, setSearch] = useState('');
  const [componentFilter, setComponentFilter] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load existing logs + subscribe to new ones
  useEffect(() => {
    // Load existing buffer
    window.electronAPI.getLogs().then((entries) => {
      setLogs(entries as LogEntry[]);
    });

    // Subscribe to real-time updates
    const unsubscribe = window.electronAPI.onLogAppend((entry) => {
      setLogs((prev) => {
        const next = [...prev, entry as LogEntry];
        if (next.length > 5000) next.shift();
        return next;
      });
    });

    return unsubscribe;
  }, []);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const filtered = logs.filter((e) => {
    if (filter === 'warn' && e.level !== 'warn' && e.level !== 'error') return false;
    if (filter === 'error' && e.level !== 'error') return false;
    if (componentFilter && !e.component.toLowerCase().includes(componentFilter.toLowerCase()))
      return false;
    if (search && !e.message.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  // Unique components for the dropdown
  const components = [...new Set(logs.map((e) => e.component))].sort();

  const handleClear = () => {
    void window.electronAPI.clearLogs();
    setLogs([]);
  };

  const handleExport = () => {
    const text = filtered
      .map((e) => `[${e.timestamp}] [${e.level.toUpperCase()}] [${e.component}] ${e.message}`)
      .join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `arvecinema-logs-${new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const btnStyle: React.CSSProperties = {
    padding: '4px 10px',
    borderRadius: 4,
    border: '1px solid var(--border-light)',
    background: 'transparent',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    fontSize: 12,
  };

  const activeBtnStyle: React.CSSProperties = {
    ...btnStyle,
    background: 'var(--bg-pill)',
    color: 'var(--text-primary)',
    borderColor: 'var(--border-light)',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 8,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            style={filter === 'all' ? activeBtnStyle : btnStyle}
            onClick={() => setFilter('all')}
          >
            {t('logAll')} ({logs.length})
          </button>
          <button
            style={filter === 'warn' ? activeBtnStyle : btnStyle}
            onClick={() => setFilter('warn')}
          >
            ⚠ {logs.filter((e) => e.level === 'warn' || e.level === 'error').length}
          </button>
          <button
            style={filter === 'error' ? activeBtnStyle : btnStyle}
            onClick={() => setFilter('error')}
          >
            ✗ {logs.filter((e) => e.level === 'error').length}
          </button>
        </div>

        <input
          type="text"
          placeholder={t('filterMessages')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            flex: 1,
            minWidth: 120,
            padding: '4px 8px',
            borderRadius: 4,
            border: '1px solid var(--border-light)',
            background: 'var(--bg-input)',
            color: 'var(--text-primary)',
            fontSize: 12,
          }}
        />

        <select
          value={componentFilter}
          onChange={(e) => setComponentFilter(e.target.value)}
          style={{
            padding: '4px 8px',
            borderRadius: 4,
            border: '1px solid var(--border-light)',
            background: 'var(--bg-input)',
            color: 'var(--text-primary)',
            fontSize: 12,
          }}
        >
          <option value="">{t('allComponents')}</option>
          {components.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        <label
          style={{
            fontSize: 11,
            color: 'var(--text-muted)',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          {t('autoScroll')}
        </label>

        <button style={btnStyle} onClick={handleExport}>
          ⤓ {t('export')}
        </button>
        <button style={btnStyle} onClick={handleClear}>
          {t('clear')}
        </button>
      </div>

      {/* Log entries */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          overflow: 'auto',
          background: 'var(--bg-card-2)',
          borderRadius: 6,
          border: '1px solid var(--border)',
          padding: 8,
          fontFamily: 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace',
          fontSize: 11,
          lineHeight: 1.5,
          minHeight: 200,
        }}
      >
        {filtered.length === 0 ? (
          <div style={{ color: 'var(--text-faint)', textAlign: 'center', padding: 20 }}>
            {t('noLogEntries')}
          </div>
        ) : (
          filtered.map((entry, i) => (
            <div
              key={i}
              style={{
                color: LEVEL_COLORS[entry.level] ?? 'var(--text-secondary)',
                background: LEVEL_BG[entry.level] ?? 'transparent',
                padding: '1px 4px',
                borderRadius: 2,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              <span style={{ color: 'var(--text-faint)' }}>{entry.timestamp}</span>{' '}
              <span style={{ color: LEVEL_COLORS[entry.level], fontWeight: 600 }}>
                [{entry.level.toUpperCase()}]
              </span>{' '}
              <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>[{entry.component}]</span>{' '}
              {entry.message}
            </div>
          ))
        )}
      </div>
    </div>
  );
};
