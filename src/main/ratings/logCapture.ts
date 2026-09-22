import { BrowserWindow } from 'electron';

// ──────────────────────────────────────────────────────────────────────────
// Log capture — captures console.log/warn/error output from the main process
// and makes it available to the renderer via IPC.
//
// The renderer's LogViewer component subscribes to `log:append` events
// and can also request the full log buffer via `log:get-all`.
// ──────────────────────────────────────────────────────────────────────────

interface LogEntry {
  timestamp: string;
  level: 'log' | 'warn' | 'error';
  message: string;
}

const MAX_ENTRIES = 5000;
const buffer: LogEntry[] = [];
let capturing = false;
let originalConsole: { log: typeof console.log; warn: typeof console.warn; error: typeof console.error } | null = null;

function ts(): string {
  const d = new Date();
  return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function addEntry(level: LogEntry['level'], args: unknown[]): void {
  const message = args.map(a =>
    typeof a === 'string' ? a :
    a instanceof Error ? a.message + (a.stack ? '\n' + a.stack : '') :
    typeof a === 'object' ? JSON.stringify(a) :
    String(a)
  ).join(' ');

  const entry: LogEntry = { timestamp: ts(), level, message };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.shift();

  // Broadcast to all renderer windows
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('log:append', entry);
  }
}

/** Start capturing console.log/warn/error. Call once at app startup. */
export function startLogCapture(): void {
  if (capturing) return;
  capturing = true;

  originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };

  console.log = (...args: unknown[]) => {
    addEntry('log', args);
    originalConsole!.log(...args);
  };
  console.warn = (...args: unknown[]) => {
    addEntry('warn', args);
    originalConsole!.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    addEntry('error', args);
    originalConsole!.error(...args);
  };
}

/** Stop capturing and restore original console methods. */
export function stopLogCapture(): void {
  if (!capturing || !originalConsole) return;
  console.log = originalConsole.log;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  originalConsole = null;
  capturing = false;
}

/** Get all captured log entries. */
export function getAllLogs(): LogEntry[] {
  return buffer.slice();
}

/** Clear the log buffer. */
export function clearLogs(): void {
  buffer.length = 0;
}
