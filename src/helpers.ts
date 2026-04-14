/**
 * Pure helper functions used by the UI. Extracted so they can be
 * unit tested without importing React.
 */

import { UpdateSource, SourceStatus, Trigger, UpdateCheckResult, NotificationLevel } from "./types";

const PREFIX = "[AutoUpdate]";

// ── Logging ──────────────────────────────────────────────────

/** Always emits — for important lifecycle events, results, and errors. */
export const log = (...args: unknown[]) => console.info(PREFIX, ...args);
export const logWarn = (...args: unknown[]) => console.warn(PREFIX, ...args);
export const logError = (...args: unknown[]) => console.error(PREFIX, ...args);

/**
 * Debug logging — only emits when debug mode is enabled.
 * Call setDebugEnabled() when settings load or change.
 */
let _debugEnabled = false;

export function setDebugEnabled(enabled: boolean) {
  _debugEnabled = enabled;
  if (enabled) log("Debug logging enabled");
}

export const debug = (...args: unknown[]) => {
  if (_debugEnabled) console.info(PREFIX, "[DEBUG]", ...args);
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
      return "🎮 Steam";
  }
}

function pluralUpdates(n: number): string {
  return `update${n === 1 ? "" : "s"}`;
}

export function formatUpdateSummary(result: {
  source: UpdateSource;
  pendingCount: number;
  forcedCount: number;
}): string {
  const label = sourceLabel(result.source);

  if (result.forcedCount > 0 && result.pendingCount > 0) {
    return `${label}: ${result.forcedCount} of ${result.pendingCount} ${pluralUpdates(result.pendingCount)} applied`;
  }

  if (result.pendingCount > 0) {
    return `${label}: ${result.pendingCount} ${pluralUpdates(result.pendingCount)} available`;
  }

  return `${label}: checked, no updates`;
}

export function shouldToastResult(level: NotificationLevel, result: { pendingCount: number; forcedCount: number }): boolean {
  if (level === "off") return false;
  if (level === "all") return true;
  return result.pendingCount > 0 || result.forcedCount > 0;
}

export function combinedToastBody(results: UpdateCheckResult[], level: NotificationLevel = "updates-only"): string | null {
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

export function statusColor(result: { errors: string[]; pendingCount: number } | null): string {
  if (!result) return "#888";
  if (result.errors.length > 0) return "#e63946";
  if (result.pendingCount > 0) return "#fca311";
  return "#2a9d8f";
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
  return sourceStatusLabel(status, "Starting updates...", "Check Steam");
}

export function flatpakStatusLabel(status: SourceStatus): string {
  return sourceStatusLabel(status, "Installing updates...", "Check Flatpak");
}

export function deckyStatusLabel(status: SourceStatus): string {
  return sourceStatusLabel(status, "Updating plugins...", "Check Decky");
}

export function deckyLoaderStatusLabel(status: SourceStatus): string {
  return sourceStatusLabel(status, "Updating Decky Loader...", "Check Decky Loader");
}

export function steamosStatusLabel(status: SourceStatus): string {
  return sourceStatusLabel(status, "Downloading SteamOS update...", "Check SteamOS");
}
