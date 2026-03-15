/** Log severity levels in ascending order */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** Numeric severity for threshold comparison */
export type LogLevelValue = 0 | 1 | 2 | 3 | 4;

/** Numeric mapping from log level string to severity value */
export const LOG_LEVEL_VALUES: Record<LogLevel, LogLevelValue> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

/** Context fields attached to every log entry */
export type LogContext = Record<string, string | number | boolean | null | undefined>;

/** The structured log entry emitted as JSON */
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
  context: LogContext;
}

/** Logger interface exposed to consumers */
export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, errorOrContext?: Error | LogContext, context?: LogContext): void;
  error(message: string, errorOrContext?: Error | LogContext, context?: LogContext): void;
  fatal(message: string, errorOrContext?: Error | LogContext, context?: LogContext): void;
  child(context: LogContext): Logger;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** Global log level threshold — default to info (1) */
let currentLevel: LogLevelValue = 1;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Escape newlines and backslashes inside a string value for JSON safety */
function escapeString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/** Serialize a single JSON value (primitive) to its string representation */
function serializeValue(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return `"${escapeString(value)}"`;
  return String(value);
}

/** Serialize a LogContext object to a JSON object string with escaped values */
function serializeContext(context: LogContext): string {
  const keys = Object.keys(context);
  if (keys.length === 0) return '{}';
  let result = '{';
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    if (i > 0) result += ',';
    result += `"${escapeString(key)}":${serializeValue(context[key])}`;
  }
  result += '}';
  return result;
}

/**
 * Serialize a log entry to a single-line JSON string with deterministic field
 * order: timestamp, level, service, message, context.
 *
 * Returns the JSON string, or `undefined` if the level is below the current
 * threshold (in which case serialization is skipped entirely).
 */
function serializeEntry(
  level: LogLevel,
  service: string,
  message: string,
  context: LogContext,
): string | undefined {
  // Skip serialization when below threshold (Req 9.2)
  if (LOG_LEVEL_VALUES[level] < currentLevel) return undefined;

  const timestamp = new Date().toISOString();

  return (
    '{"timestamp":"' + timestamp +
    '","level":"' + level +
    '","service":"' + escapeString(service) +
    '","message":"' + escapeString(message) +
    '","context":' + serializeContext(context) +
    '}'
  );
}

/**
 * Write a serialized log line to the appropriate console method.
 *
 * Mapping (Req 7.2):
 *   debug / info  → console.log
 *   warn          → console.warn
 *   error / fatal → console.error
 */
function writeOutput(level: LogLevel, line: string): void {
  if (level === 'warn') {
    // eslint-disable-next-line no-console
    console.warn(line);
  } else if (level === 'error' || level === 'fatal') {
    // eslint-disable-next-line no-console
    console.error(line);
  } else {
    // debug and info
    // eslint-disable-next-line no-console
    console.log(line);
  }
}

/**
 * Core emit function: serializes the entry and writes it to the console.
 * Returns immediately (no-op) when the level is below the threshold.
 */
function emit(
  level: LogLevel,
  service: string,
  message: string,
  context: LogContext,
): void {
  const line = serializeEntry(level, service, message, context);
  if (line === undefined) return;
  writeOutput(level, line);
}

// ---------------------------------------------------------------------------
// Default threshold initialization (Req 3.3, 2.4)
// ---------------------------------------------------------------------------

/**
 * Determine the initial log level from environment variables.
 *
 * Priority:
 *   1. VITE_LOG_LEVEL (client / Vite)
 *   2. LOG_LEVEL (server / Node)
 *   3. 'debug' when running in development mode
 *   4. 'info' (production default)
 */
function resolveInitialLevel(): LogLevelValue {
  // Try environment-provided log level
  const envLevel: string | undefined =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (import.meta as any).env?.VITE_LOG_LEVEL ??
    (typeof process !== 'undefined' ? process.env?.LOG_LEVEL : undefined);

  if (envLevel && envLevel in LOG_LEVEL_VALUES) {
    return LOG_LEVEL_VALUES[envLevel as LogLevel];
  }

  // Detect development mode
  const isDev =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (import.meta as any).env?.DEV === true ||
    (typeof process !== 'undefined' && process.env?.NODE_ENV === 'development');

  return isDev ? LOG_LEVEL_VALUES.debug : LOG_LEVEL_VALUES.info;
}

// Apply the resolved initial level
currentLevel = resolveInitialLevel();

// ---------------------------------------------------------------------------
// Public API (Req 3.1, 3.2, 3.4, 2.3, 2.4, 4.4, 9.4, 10.2, 10.4)
// ---------------------------------------------------------------------------

/**
 * Set the global log level threshold for all logger instances.
 * Ignores invalid values (Req 3.4).
 */
export function setLevel(level: LogLevel): void {
  if (level in LOG_LEVEL_VALUES) {
    currentLevel = LOG_LEVEL_VALUES[level];
  }
}

/** Get the current global log level threshold */
export function getLevel(): LogLevel {
  const entries = Object.entries(LOG_LEVEL_VALUES) as [LogLevel, LogLevelValue][];
  const match = entries.find(([, v]) => v === currentLevel);
  return match ? match[0] : 'info';
}

/**
 * Create a new Logger with the given base context.
 * The `service` field defaults to "world-monitor" (Req 4.4).
 */
export function createLogger(context?: LogContext): Logger {
  const baseContext: LogContext = context ?? {};
  const service = typeof baseContext.service === 'string' ? baseContext.service : 'world-monitor';

  function makeLogMethod(level: LogLevel) {
    return (message: string, context?: LogContext): void => {
      emit(level, service, message, { ...baseContext, ...context });
    };
  }

  /** Max stack trace length to prevent oversized log entries (Req 8.3) */
  const MAX_STACK_LENGTH = 4096;

  function makeErrorMethod(level: LogLevel) {
    return (message: string, errorOrContext?: Error | LogContext, context?: LogContext): void => {
      let merged: LogContext;
      if (errorOrContext instanceof Error) {
        // Structured error extraction (Req 8.1, 8.3)
        const errorFields: LogContext = {
          errorName: errorOrContext.name,
          errorMessage: errorOrContext.message,
        };
        if (errorOrContext.stack) {
          errorFields.stackTrace = errorOrContext.stack.length > MAX_STACK_LENGTH
            ? errorOrContext.stack.slice(0, MAX_STACK_LENGTH)
            : errorOrContext.stack;
        }
        merged = { ...baseContext, ...errorFields, ...context };
      } else if (errorOrContext !== null && errorOrContext !== undefined && typeof errorOrContext !== 'object') {
        // Non-Error, non-object edge case: coerce to string (Req 8.2)
        merged = { ...baseContext, errorMessage: String(errorOrContext), ...context };
      } else {
        merged = { ...baseContext, ...errorOrContext, ...context };
      }
      emit(level, service, message, merged);
    };
  }

  return {
    debug: makeLogMethod('debug'),
    info: makeLogMethod('info'),
    warn: makeErrorMethod('warn'),
    error: makeErrorMethod('error'),
    fatal: makeErrorMethod('fatal'),
    child(childContext: LogContext): Logger {
      return createLogger({ ...baseContext, ...childContext });
    },
  };
}

/** Pre-configured singleton for quick single-import usage (Req 10.2) */
export const logger: Logger = createLogger();

// ---------------------------------------------------------------------------
// Request-scoped loggers (Req 5.1, 5.2)
// ---------------------------------------------------------------------------

/** WeakMap storing request-scoped loggers — auto-GC'd when the Request is collected */
const requestLoggers = new WeakMap<Request, Logger>();

/** Attach a request-scoped child logger (e.g. with correlationId) to a Request */
export function setRequestLogger(req: Request, log: Logger): void {
  requestLoggers.set(req, log);
}

/** Retrieve the request-scoped logger, falling back to the root singleton */
export function getRequestLogger(req: Request): Logger {
  return requestLoggers.get(req) ?? logger;
}
