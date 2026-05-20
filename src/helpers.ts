/**
 * Pure helper functions used by the UI. Extracted so they can be
 * unit tested without importing React.
 */

import { UpdateSource, SourceStatus, Trigger, UpdateCheckResult, NotificationLevel } from "./types";

const PREFIX = "[AutoUpdate]";

// ── Backend log bridge ──────────────────────────────────────

type BackendLogFn = (level: string, message: string) => void;
let _backendLog: BackendLogFn | null = null;

export function setBackendLog(fn: BackendLogFn | null) {
  _backendLog = fn;
}

function logToBackend(level: string, ...args: unknown[]) {
  if (!_backendLog) return;
  try {
    const message = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    _backendLog(level, message);
  } catch {
    /* never break the caller */
  }
}

// ── Logging ──────────────────────────────────────────────────

export const log = (...args: unknown[]) => {
  console.info(PREFIX, ...args);
  logToBackend("info", ...args);
};
export const logWarn = (...args: unknown[]) => {
  console.warn(PREFIX, ...args);
  logToBackend("warn", ...args);
};
export const logError = (...args: unknown[]) => {
  console.error(PREFIX, ...args);
  logToBackend("error", ...args);
};

let _debugEnabled = false;

export function setDebugEnabled(enabled: boolean) {
  _debugEnabled = enabled;
  log("Debug logging:", enabled ? "ON" : "OFF");
}

export const debug = (...args: unknown[]) => {
  if (_debugEnabled) {
    console.info(PREFIX, "[DEBUG]", ...args);
    logToBackend("debug", ...args);
  }
};

/**
 * Fine-grained trace logging — CEF console only, never goes through IPC.
 * Use for high-frequency events (per-IPC-call diagnostics, per-event handlers)
 * where backend logging would saturate the WS channel. View via chrome://inspect.
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
}): string {
  const label = sourceLabel(result.source);
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

export const COLOR_SUCCESS = "#2a9d8f";
export const COLOR_WARNING = "#fca311";
export const COLOR_ERROR = "#e63946";
export const COLOR_MUTED = "#888";

export function statusColor(
  result: { errors: string[]; pendingCount: number; forcedCount: number } | null,
): string {
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
  return typeof navigator !== "undefined" ? navigator.onLine : true;
}

export function waitForNetwork(timeoutMs = 30_000): Promise<boolean> {
  if (isOnline()) return Promise.resolve(true);

  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (isOnline()) {
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
