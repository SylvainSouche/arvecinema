// ──────────────────────────────────────────────────────────────────────────
// Simple logger for shared/ modules that can't import from main/.
//
// These modules (connectionPool, fetchWithTimeout, networkRecorder,
// networkActivity) are used by BOTH the main process and potentially the
// renderer. They need logging but can't depend on the main-process Logger
// (which uses Electron's BrowserWindow for IPC).
//
// This module provides a minimal console-based logger that the main-process
// Logger captures via its ConsoleDispatcher. No circular dependency.
// ──────────────────────────────────────────────────────────────────────────


function ts(): string {
  const d = new Date();
  return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

export const simpleLog = {
  debug: (_msg: string) => { /* no-op in production */ },
  info: (msg: string) => { console.log(`[${ts()}] [INFO] ${msg}`); },
  warn: (msg: string) => { console.warn(`[${ts()}] [WARN] ${msg}`); },
  error: (msg: string) => { console.error(`[${ts()}] [ERROR] ${msg}`); },
};
