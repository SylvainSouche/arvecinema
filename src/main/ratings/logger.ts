// ──────────────────────────────────────────────────────────────────────────
// Logging framework — pluggable dispatchers + formatters.
//
// Architecture:
//
//   Logger (singleton)
//     ├── dispatches each entry to all registered Dispatchers
//     │     ├── ConsoleDispatcher  → console.log/warn/error (always on)
//     │     ├── MemoryDispatcher   → in-memory ring buffer (for LogViewer)
//     │     └── FileDispatcher     → rotating log file in userData/logs/
//     │
//     └── formats each entry via a Formatter before dispatching
//           ├── TextFormatter      → "[HH:MM:ss.sss] [LEVEL] [component] msg"
//           ├── JsonFormatter      → {"ts":..., "level":..., "component":..., "msg":...}
//           └── CsvFormatter       → timestamp,level,component,message
//
// Each module creates a logger via `getLogger('component-name')` and calls
//   logger.info("message"), logger.warn("..."), logger.error("...")
//
// The LogViewer in the renderer reads from the MemoryDispatcher via IPC.
// The file dispatcher writes to userData/logs/arvecinema.log (rotated at 5MB).
// ──────────────────────────────────────────────────────────────────────────

import { app, BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';

// ── Types ─────────────────────────────────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
}

/** Formats a LogEntry into a string for a specific output target. */
export type Formatter = (entry: LogEntry) => string;

/** Receives formatted log entries. Each dispatcher decides what to do
 *  with them (console, memory buffer, file, IPC, etc.). */
export interface LogDispatcher {
  name: string;
  format: Formatter;
  dispatch(entry: LogEntry, formatted: string): void;
  /** Called at shutdown — flush buffers, close files, etc. */
  flush?(): void;
}

// ── Formatters ────────────────────────────────────────────────────────────

function ts(): string {
  const d = new Date();
  return (
    d.toLocaleTimeString('en-GB', { hour12: false }) +
    '.' +
    String(d.getMilliseconds()).padStart(3, '0')
  );
}

export const textFormatter: Formatter = (e) =>
  `[${e.timestamp}] [${e.level.toUpperCase()}] [${e.component}] ${e.message}`;

export const jsonFormatter: Formatter = (e) =>
  JSON.stringify({ ts: e.timestamp, level: e.level, component: e.component, msg: e.message });

export const csvFormatter: Formatter = (e) =>
  `${e.timestamp},${e.level},${e.component},"${e.message.replace(/"/g, '""')}"`;

// ── Dispatchers ────────────────────────────────────────────────────────────

/** Dispatches to console.log/warn/error with color coding. */
export function createConsoleDispatcher(): LogDispatcher {
  const LEVEL_FN: Record<LogLevel, (...args: unknown[]) => void> = {
    debug: (...a) => console.log(...a),
    info: (...a) => console.log(...a),
    warn: (...a) => console.warn(...a),
    error: (...a) => console.error(...a),
  };
  return {
    name: 'console',
    format: textFormatter,
    dispatch(entry, formatted) {
      // Use the original console methods — we DON'T re-intercept here
      // (avoids infinite loop if logCapture is also active).
      // We pass the formatted string to the appropriate console method.
      LEVEL_FN[entry.level](formatted);
    },
  };
}

/** Dispatches to an in-memory ring buffer. Used by the LogViewer. */
export function createMemoryDispatcher(maxEntries = 5000): LogDispatcher {
  const buffer: LogEntry[] = [];
  return {
    name: 'memory',
    format: () => '', // not used — raw entry stored
    dispatch(entry) {
      buffer.push(entry);
      if (buffer.length > maxEntries) buffer.shift();
      // Broadcast to all renderer windows
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('log:append', entry);
      }
    },
    flush() {
      /* nothing to flush — data lives in memory */
    },
  };
}

/** Dispatches to a rotating log file in userData/logs/. */
export function createFileDispatcher(maxSizeMB = 5): LogDispatcher {
  const logDir = path.join(app.getPath('userData'), 'logs');
  const logFile = path.join(logDir, 'arvecinema.log');
  const maxBytes = maxSizeMB * 1024 * 1024;
  let stream: fs.WriteStream | null = null;
  let initialized = false;

  function ensureStream() {
    if (initialized) return;
    initialized = true;
    try {
      fs.mkdirSync(logDir, { recursive: true });
      // Rotate if file is too large
      try {
        const stat = fs.statSync(logFile);
        if (stat.size > maxBytes) {
          const backup = logFile + '.old';
          try {
            fs.unlinkSync(backup);
          } catch {}
          fs.renameSync(logFile, backup);
        }
      } catch {
        /* file doesn't exist yet */
      }
      stream = fs.createWriteStream(logFile, { flags: 'a', mode: 0o644 });
    } catch (err) {
      // Can't write logs to disk — fall back to console only
      console.error('[file-dispatcher] cannot open log file:', err);
    }
  }

  return {
    name: 'file',
    format: (e) => textFormatter(e),
    dispatch(_entry, formatted) {
      ensureStream();
      if (stream) {
        stream.write(formatted + '\n');
        // Check rotation
        try {
          const stat = fs.statSync(logFile);
          if (stat.size > maxBytes) {
            stream.end();
            const backup = logFile + '.old';
            try {
              fs.unlinkSync(backup);
            } catch {}
            fs.renameSync(logFile, backup);
            stream = fs.createWriteStream(logFile, { flags: 'a', mode: 0o644 });
          }
        } catch {
          /* ignore stat errors */
        }
      }
    },
    flush() {
      if (stream) {
        stream.end();
        stream = null;
      }
    },
  };
}

// ── Logger (singleton) ────────────────────────────────────────────────────

class Logger {
  private dispatchers: LogDispatcher[] = [];
  private minLevel: LogLevel = 'debug';

  /** Add a dispatcher. Call before any logging happens. */
  addDispatcher(d: LogDispatcher): void {
    this.dispatchers.push(d);
  }

  /** Set minimum level (debug < info < warn < error). */
  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  private shouldLog(level: LogLevel): boolean {
    const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
    return order[level] >= order[this.minLevel];
  }

  private log(level: LogLevel, component: string, message: string): void {
    if (!this.shouldLog(level)) return;
    const entry: LogEntry = { timestamp: ts(), level, component, message };
    for (const d of this.dispatchers) {
      const formatted = d.format(entry);
      d.dispatch(entry, formatted);
    }
  }

  debug(component: string, message: string): void {
    this.log('debug', component, message);
  }
  info(component: string, message: string): void {
    this.log('info', component, message);
  }
  warn(component: string, message: string): void {
    this.log('warn', component, message);
  }
  error(component: string, message: string): void {
    this.log('error', component, message);
  }

  /** Get all entries from the memory dispatcher. */
  getMemoryEntries(): LogEntry[] {
    return (this as unknown as { _memoryBuffer?: LogEntry[] })._memoryBuffer ?? [];
  }

  /** Clear the memory buffer. */
  clearMemory(): void {
    (this as unknown as { _memoryBuffer?: LogEntry[] })._memoryBuffer = [];
  }

  /** Flush all dispatchers (call at shutdown). */
  flush(): void {
    for (const d of this.dispatchers) {
      d.flush?.();
    }
  }
}

// ── Singleton + component loggers ──────────────────────────────────────────

const globalLogger = new Logger();

/** Initialize the logging framework. Call once at app startup. */
export function initLogging(debug: boolean = false): void {
  globalLogger.setLevel(debug ? 'debug' : 'info');

  const memDispatcher = createMemoryDispatcher();
  // Stash the buffer reference on the dispatcher for getMemoryEntries()
  (globalLogger as unknown as { _memoryBuffer: LogEntry[] })._memoryBuffer = [];
  // Wrap the memory dispatcher to also store into our stashed buffer
  const origDispatch = memDispatcher.dispatch.bind(memDispatcher);
  memDispatcher.dispatch = (entry, formatted) => {
    (globalLogger as unknown as { _memoryBuffer: LogEntry[] })._memoryBuffer.push(entry);
    if ((globalLogger as unknown as { _memoryBuffer: LogEntry[] })._memoryBuffer.length > 5000) {
      (globalLogger as unknown as { _memoryBuffer: LogEntry[] })._memoryBuffer.shift();
    }
    origDispatch(entry, formatted);
  };

  globalLogger.addDispatcher(createConsoleDispatcher());
  globalLogger.addDispatcher(memDispatcher);
  globalLogger.addDispatcher(createFileDispatcher());
}

/** Get the global logger instance. */
export function getLogger(): Logger {
  return globalLogger;
}

/** Create a component-specific logger that pre-fills the component name. */
export function getComponentLogger(component: string) {
  return {
    debug: (msg: string) => globalLogger.debug(component, msg),
    info: (msg: string) => globalLogger.info(component, msg),
    warn: (msg: string) => globalLogger.warn(component, msg),
    error: (msg: string) => globalLogger.error(component, msg),
  };
}

/** Get all log entries from the memory buffer. */
export function getAllLogs(): LogEntry[] {
  return globalLogger.getMemoryEntries();
}

/** Clear the memory buffer. */
export function clearLogs(): void {
  globalLogger.clearMemory();
}

/** Flush all dispatchers. Call at shutdown. */
export function flushLogs(): void {
  globalLogger.flush();
}
