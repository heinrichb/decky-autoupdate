/**
 * Pure helper functions used by the UI. Extracted so they can be
 * unit tested without importing React.
 */

import { UpdateSource, SourceStatus, Trigger, UpdateCheckResult, NotificationLevel, HistoryEntry } from "./types";

const PREFIX = "[AutoUpdate]";

// ── Backend log bridge ──────────────────────────────────────

export type BackendLogEntry = [level: string, message: string, ts: number];
type BackendLogFn = (entries: BackendLogEntry[]) => void;

const LOG_FLUSH_INTERVAL_MS = 1000;
const LOG_URGENT_MIN_SPACING_MS = 250;
const LOG_BUFFER_CAP = 300;
const LOG_MESSAGE_CAP = 2000;
const TRUNCATED_SUFFIX = "...(truncated)";

let _backendLog: BackendLogFn | null = null;
let _logBuffer: BackendLogEntry[] = [];
let _flushTimer: ReturnType<typeof setTimeout> | null = null;
let _urgentScheduled = false;
let _lastFlushAt = 0;

export function setBackendLog(fn: BackendLogFn | null) {
  _backendLog = fn;
  _lastFlushAt = 0;
  _urgentScheduled = false;
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  if (!fn) {
    _logBuffer = [];
  } else if (_logBuffer.length > 0) {
    scheduleFlush(false);
  }
}

export function flushBackendLog() {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  if (!_backendLog || _logBuffer.length === 0) return;
  const entries = _logBuffer;
  _logBuffer = [];
  _lastFlushAt = Date.now();
  try {
    _backendLog(entries);
  } catch {
    /* never break the caller */
  }
}

// Urgent flushes are spaced out so a sink that logs its own failures cannot spin.
function scheduleFlush(urgent: boolean) {
  if (!_backendLog) return;
  if (urgent) {
    if (_urgentScheduled) return;
    const wait = _lastFlushAt + LOG_URGENT_MIN_SPACING_MS - Date.now();
    if (wait <= 0) {
      _urgentScheduled = true;
      Promise.resolve().then(() => {
        _urgentScheduled = false;
        flushBackendLog();
      });
      return;
    }
    if (_flushTimer) clearTimeout(_flushTimer);
    _flushTimer = setTimeout(flushBackendLog, wait);
    return;
  }
  if (!_flushTimer && !_urgentScheduled) {
    _flushTimer = setTimeout(flushBackendLog, LOG_FLUSH_INTERVAL_MS);
  }
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    const out = JSON.stringify(value, (_key, v: unknown) => {
      if (v instanceof Error) return v.stack || v.message;
      if (typeof v === "bigint") return v.toString();
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
      }
      return v;
    });
    return out === undefined ? String(value) : out;
  } catch {
    return String(value);
  }
}

function formatLogArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack || a.message;
  if (a === null || typeof a !== "object") return String(a);
  return safeStringify(a);
}

function logToBackend(level: string, args: unknown[]) {
  try {
    let message = args.map(formatLogArg).join(" ");
    if (message.length > LOG_MESSAGE_CAP) {
      message = message.slice(0, LOG_MESSAGE_CAP - TRUNCATED_SUFFIX.length) + TRUNCATED_SUFFIX;
    }
    _logBuffer.push([level, message, Date.now()]);
    if (_logBuffer.length > LOG_BUFFER_CAP) {
      const oldestDebug = _logBuffer.findIndex((e) => e[0] === "debug");
      _logBuffer.splice(oldestDebug >= 0 ? oldestDebug : 0, 1);
    }
    scheduleFlush(level === "warn" || level === "error");
  } catch {
    /* never break the caller */
  }
}

// ── Logging ──────────────────────────────────────────────────

export const log = (...args: unknown[]) => {
  console.info(PREFIX, ...args);
  logToBackend("info", args);
};
export const logWarn = (...args: unknown[]) => {
  console.warn(PREFIX, ...args);
  logToBackend("warn", args);
};
export const logError = (...args: unknown[]) => {
  console.error(PREFIX, ...args);
  logToBackend("error", args);
};

let _debugEnabled = false;

export function setDebugEnabled(enabled: boolean) {
  _debugEnabled = enabled;
  log("Debug logging:", enabled ? "ON" : "OFF");
}

export function isDebugEnabled(): boolean {
  return _debugEnabled;
}

export const debug = (...args: unknown[]) => {
  if (_debugEnabled) {
    console.info(PREFIX, "[DEBUG]", ...args);
    logToBackend("debug", args);
  }
};

/**
 * Fine-grained trace logging — CEF console only, never sent to the backend.
 * Use for high-frequency events (per-IPC-call diagnostics, per-event handlers).
 * View via chrome://inspect.
 */
export const trace = (...args: unknown[]) => {
  if (_debugEnabled) {
    console.info(PREFIX, "[TRACE]", ...args);
  }
};

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Wrap a promise with a timeout. If the promise doesn't settle within
 * the given milliseconds, reject with a timeout error. This prevents
 * the UI from hanging indefinitely when Decky IPC calls silently fail
 * (e.g. due to stale instance tracking after CEF reconnection).
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function sourceLabel(source: UpdateSource): string {
  switch (source) {
    case "flatpak":
      return "📦 Flatpak";
    case "decky":
      return "🔌 Decky plugins";
    case "decky-loader":
      return "🔧 Decky Loader";
    case "steamos":
      return "🖥️ SteamOS";
    case "steam":
      return "🎮 Steam Apps";
  }
}

export function sourceName(source: UpdateSource): string {
  switch (source) {
    case "flatpak":
      return "Flatpak";
    case "decky":
      return "Decky Plugins";
    case "decky-loader":
      return "Decky Loader";
    case "steamos":
      return "SteamOS";
    case "steam":
      return "Steam Apps";
  }
}

function pluralUpdates(n: number): string {
  return `update${n === 1 ? "" : "s"}`;
}

/**
 * Per-source verb for what we did with the update.
 *
 * Steam: we asked Steam to start the download — Steam handles the actual download
 * asynchronously, so "started" is the truthful word. (Previously this said
 * "applied" which sounded like the update was complete.)
 *
 * Flatpak / Decky: we ran the install — by the time forcedCount > 0 the bits
 * have been written.
 *
 * SteamOS: we staged the update to the inactive partition — activation requires
 * a reboot, so "staged" is what compactStatusText surfaces.
 *
 * Decky Loader: we triggered self-update; it then restarts itself.
 */
function actionVerb(source: UpdateSource): string {
  switch (source) {
    case "steam":
      return "started";
    case "steamos":
      return "staged";
    case "decky-loader":
      return "updated";
    case "flatpak":
    case "decky":
      return "applied";
  }
}

function updateSummaryCore(source: UpdateSource, pendingCount: number, forcedCount: number): string {
  if (forcedCount > 0 && pendingCount > 0) {
    const noun = source === "steam" ? "download" : "update";
    const plural = `${noun}${pendingCount === 1 ? "" : "s"}`;
    return `${forcedCount} of ${pendingCount} ${plural} ${actionVerb(source)}`;
  }
  if (pendingCount > 0) {
    return `${pendingCount} ${pluralUpdates(pendingCount)} available`;
  }
  return "Up to date";
}

export function formatUpdateSummary(result: {
  source: UpdateSource;
  pendingCount: number;
  forcedCount: number;
  errors?: string[];
}): string {
  const label = sourceLabel(result.source);
  if (result.pendingCount === 0 && result.forcedCount === 0 && result.errors?.length) {
    return `${label}: check failed (${clampText(result.errors[0], 60)})`;
  }
  const summary = updateSummaryCore(result.source, result.pendingCount, result.forcedCount);
  return result.pendingCount === 0 && result.forcedCount === 0
    ? `${label}: checked, no updates`
    : `${label}: ${summary}`;
}

export function shouldToastResult(
  level: NotificationLevel,
  result: { pendingCount: number; forcedCount: number },
): boolean {
  if (level === "off") return false;
  if (level === "all") return true;
  return result.pendingCount > 0 || result.forcedCount > 0;
}

export function combinedToastBody(
  results: UpdateCheckResult[],
  level: NotificationLevel = "updates-only",
): string | null {
  const filtered = results.filter((r) => shouldToastResult(level, r));
  const parts = filtered.map((r) => formatUpdateSummary(r));
  return parts.length > 0 ? parts.join(" | ") : null;
}

export function triggerLabel(trigger: Trigger): string {
  switch (trigger) {
    case "manual":
      return "Manual check";
    case "wake":
      return "After sleep";
    case "auto":
      return "Scheduled";
    case "game-close":
      return "After game";
  }
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "\u2014";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// All four reach 4.5:1 on the QAM background (#0e141b) and the focused-row background (#32373d).
export const COLOR_SUCCESS = "#4cc9b0";
export const COLOR_WARNING = "#fca311";
export const COLOR_ERROR = "#ff949c";
export const COLOR_MUTED = "#b8bcbf";

export function statusColor(result: { errors: string[]; pendingCount: number; forcedCount: number } | null): string {
  if (!result) return COLOR_MUTED;
  if (result.errors.length > 0) return COLOR_ERROR;
  // pendingCount > 0 with forcedCount > 0 means "we found updates and acted on
  // all of them" — that's a success, not a warning. Yellow is reserved for
  // genuine open problems (updates exist but we couldn't action them).
  if (result.pendingCount > 0 && result.forcedCount === 0) return COLOR_WARNING;
  return COLOR_SUCCESS;
}

function sourceStatusLabel(status: SourceStatus, applyingText: string, defaultText: string): string {
  switch (status) {
    case "checking":
      return "Checking for updates...";
    case "applying":
      return applyingText;
    default:
      return defaultText;
  }
}

export function steamStatusLabel(status: SourceStatus): string {
  return sourceStatusLabel(status, "Starting updates...", "Check Steam Apps");
}

export function flatpakStatusLabel(status: SourceStatus): string {
  return sourceStatusLabel(status, "Installing updates...", "Check Flatpak");
}

export function deckyStatusLabel(status: SourceStatus): string {
  return sourceStatusLabel(status, "Updating plugins...", "Check Plugins");
}

export function deckyLoaderStatusLabel(status: SourceStatus): string {
  return sourceStatusLabel(status, "Updating Decky...", "Check Decky");
}

export function steamosStatusLabel(status: SourceStatus): string {
  return sourceStatusLabel(status, "Downloading SteamOS update...", "Check SteamOS");
}

// ── Network ─────────────────────────────────────────────────

export function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

export function waitForNetwork(timeoutMs = 30_000, isCancelled?: () => boolean): Promise<boolean> {
  if (isOnline()) return Promise.resolve(true);

  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (isCancelled?.()) {
        clearInterval(interval);
        resolve(false);
      } else if (isOnline()) {
        clearInterval(interval);
        resolve(true);
      } else if (Date.now() - start >= timeoutMs) {
        clearInterval(interval);
        resolve(false);
      }
    }, 2000);
  });
}

export function compactStatusText(source: UpdateSource, lastCheck: UpdateCheckResult | null): string {
  if (!lastCheck) return "Never checked";
  if (lastCheck.errors.length > 0) {
    const msg = lastCheck.errors[0];
    return msg.length > 50 ? msg.slice(0, 47) + "..." : msg;
  }
  // SteamOS "staged" is a special post-apply state
  if (source === "steamos" && lastCheck.forcedCount > 0) return "Staged \u2014 reboot when ready";
  return updateSummaryCore(source, lastCheck.pendingCount, lastCheck.forcedCount);
}

// ── Compact status / history formatting ────────────────────

const SHORT_STATUS_MAX = 32;

function clampText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 3) + "..." : text;
}

function actedSummary(source: UpdateSource, pendingCount: number, forcedCount: number): string {
  return `${forcedCount} of ${Math.max(pendingCount, forcedCount)} ${actionVerb(source)}`;
}

export function shortStatusText(source: UpdateSource, lastCheck: UpdateCheckResult | null): string {
  if (!lastCheck) return "Not checked yet";
  if (lastCheck.errors.length > 0) return clampText(lastCheck.errors[0], SHORT_STATUS_MAX);
  if (source === "steamos" && lastCheck.forcedCount > 0) return "Staged, reboot to apply";
  if (lastCheck.forcedCount > 0) {
    return clampText(actedSummary(source, lastCheck.pendingCount, lastCheck.forcedCount), SHORT_STATUS_MAX);
  }
  if (lastCheck.pendingCount > 0) return clampText(`${lastCheck.pendingCount} available`, SHORT_STATUS_MAX);
  return "Up to date";
}

export function shortHistorySummary(entry: HistoryEntry): string {
  if (entry.source === "steamos" && entry.forcedCount > 0) return "Staged";
  if (entry.forcedCount > 0) return actedSummary(entry.source, entry.pendingCount, entry.forcedCount);
  if (entry.pendingCount > 0) return `${entry.pendingCount} available`;
  return "Up to date";
}

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function formatDayLabel(ts: number, now: number): string {
  const day = new Date(ts);
  const today = new Date(now);
  if (sameLocalDay(day, today)) return "Today";
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (sameLocalDay(day, yesterday)) return "Yesterday";
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (sameLocalDay(day, tomorrow)) return "Tomorrow";
  return day.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

export function formatWhen(ts: number, now: number): string {
  if (sameLocalDay(new Date(ts), new Date(now))) return formatClock(ts);
  return `${formatDayLabel(ts, now)} ${formatClock(ts)}`;
}

export interface HistoryRow {
  entry: HistoryEntry;
  count: number;
}

export interface HistoryGroup {
  day: string;
  rows: HistoryRow[];
}

/** Newest first, grouped by day label; `limit` caps the number of rows after collapsing repeats. */
export function groupHistory(entries: HistoryEntry[], limit: number, now: number): HistoryGroup[] {
  const sorted = [...entries].sort((a, b) => b.timestamp - a.timestamp);
  const groups: HistoryGroup[] = [];
  let rowCount = 0;
  let last: HistoryRow | null = null;
  for (const entry of sorted) {
    const day = formatDayLabel(entry.timestamp, now);
    let group = groups[groups.length - 1];
    if (!group || group.day !== day) {
      if (rowCount >= limit) break;
      group = { day, rows: [] };
      groups.push(group);
      last = null;
    }
    if (
      last &&
      last.entry.source === entry.source &&
      last.entry.pendingCount === entry.pendingCount &&
      last.entry.forcedCount === entry.forcedCount
    ) {
      last.count++;
      continue;
    }
    if (rowCount >= limit) break;
    last = { entry, count: 1 };
    group.rows.push(last);
    rowCount++;
  }
  return groups;
}
