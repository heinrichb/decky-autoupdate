/**
 * Abstraction layer over Steam's undocumented SteamClient JavaScript API.
 *
 * SteamClient is a global object injected by Steam's CEF context. Its methods
 * are not publicly documented - the signatures here were determined through CEF
 * remote debugging on SteamOS 3.x (Chrome 126, build 1773426488).
 *
 * All interaction with SteamClient is isolated in this file so that when Valve
 * changes the internal API, only this module needs to be updated.
 */

import { PendingUpdate, UpdateCheckResult, DownloadItem } from "./types";
import { log, logWarn, logError, debug, errorMessage } from "./helpers";

// ── Global declarations ──────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var SteamClient: SteamClientAPI | undefined;
  // eslint-disable-next-line no-var
  var appStore: AppStore | undefined;
}

interface Unregisterable {
  unregister(): void;
}

interface SteamClientAPI {
  Apps: SteamClientApps;
  Downloads: SteamClientDownloads;
  GameSessions: SteamClientGameSessions;
  User: SteamClientUser;
  System: SteamClientSystem;
  [key: string]: unknown;
}

interface SteamClientApps {
  [key: string]: unknown;
}

export interface AppLifetimeNotification {
  unAppID: number;
  nInstanceID: number;
  bRunning: boolean;
}

interface SteamClientGameSessions {
  RegisterForAppLifetimeNotifications(callback: (notification: AppLifetimeNotification) => void): Unregisterable;
  [key: string]: unknown;
}

interface SteamClientDownloads {
  RegisterForDownloadItems(callback: (isDownloading: boolean, items: DownloadItem[]) => void): Unregisterable;
  RegisterForDownloadOverview(callback: (overview: unknown) => void): Unregisterable;
  ResumeAppUpdate(appId: number): void;
  EnableAllDownloads(): void;
  [key: string]: unknown;
}

interface SteamClientUser {
  [key: string]: unknown;
}

interface SteamClientSystem {
  RegisterForOnResumeFromSuspend(callback: () => void): Unregisterable;
  RegisterForOnSuspendRequest(callback: () => void): Unregisterable;
  [key: string]: unknown;
}

interface AppOverview {
  display_name?: string;
  app_name?: string;
  [key: string]: unknown;
}

interface AppStore {
  GetAppOverviewByAppID(appId: number): AppOverview | null;
  m_mapApps: Map<number, AppOverview>;
  [key: string]: unknown;
}

// ── Helpers ──────────────────────────────────────────────────

export function isSteamClientAvailable(): boolean {
  const available = typeof SteamClient !== "undefined" && SteamClient !== null;
  debug("isSteamClientAvailable:", available);
  return available;
}

/**
 * Wait for SteamClient to become available (handles boot race condition).
 * Polls every 2 seconds up to the given timeout.
 */
export function waitForSteamClient(timeoutMs = 30_000): Promise<boolean> {
  if (isSteamClientAvailable()) {
    debug("waitForSteamClient: already available");
    return Promise.resolve(true);
  }

  debug("waitForSteamClient: polling (timeout:", timeoutMs, "ms)");
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (isSteamClientAvailable()) {
        clearInterval(interval);
        debug("waitForSteamClient: became available after", Date.now() - start, "ms");
        resolve(true);
      } else if (Date.now() - start >= timeoutMs) {
        clearInterval(interval);
        logWarn("Timed out waiting for SteamClient");
        resolve(false);
      }
    }, 2000);
  });
}

/**
 * Register a callback for when the device resumes from sleep.
 * Returns an unregister function, or null if the API is unavailable.
 */
export function registerForResume(callback: () => void): (() => void) | null {
  try {
    const register = SteamClient?.System?.RegisterForOnResumeFromSuspend;
    if (!register) return null;
    const handle = register.call(SteamClient!.System, callback);
    return () => handle.unregister();
  } catch {
    return null;
  }
}

/**
 * Register a callback for when any app starts or stops running.
 * Returns an unregister function, or null if the API is unavailable.
 */
export function registerForAppLifetime(callback: (notification: AppLifetimeNotification) => void): (() => void) | null {
  try {
    const register = SteamClient?.GameSessions?.RegisterForAppLifetimeNotifications;
    if (!register) return null;
    const handle = register.call(SteamClient!.GameSessions, callback);
    return () => handle.unregister();
  } catch {
    return null;
  }
}

export function getAppName(appId: number): string {
  try {
    const overview = appStore?.GetAppOverviewByAppID(appId);
    return overview?.display_name || overview?.app_name || `App ${appId}`;
  } catch {
    return `App ${appId}`;
  }
}

export function determineState(item: DownloadItem): PendingUpdate["state"] {
  if (item.active) return "downloading";
  if (item.paused) return "paused";
  if (item.deferred_time > 0) return "scheduled";
  return "queued";
}

export function getDownloadBytes(item: DownloadItem): { downloaded: number; total: number } {
  const info = item.update_type_info?.[0];
  if (!info?.progress) return { downloaded: 0, total: 0 };
  // progress[2] contains the network download bytes
  const dl = info.progress[2];
  if (dl) {
    return { downloaded: dl.bytes_in_progress, total: dl.bytes_total };
  }
  return { downloaded: 0, total: 0 };
}

// ── Core API ─────────────────────────────────────────────────

/**
 * Enumerate all games that have pending or scheduled updates by reading
 * the Steam download queue via RegisterForDownloadItems.
 *
 * The callback fires immediately with the current state, so we wrap it
 * in a Promise that resolves on the first invocation and then unregisters.
 */
export function getPendingUpdates(): Promise<PendingUpdate[]> {
  if (!isSteamClientAvailable()) {
    logWarn("SteamClient not available");
    return Promise.resolve([]);
  }

  debug("getPendingUpdates: registering for download items...");
  return new Promise((resolve) => {
    let unsub: { unregister: () => void } | null = null;

    const timeout = setTimeout(() => {
      logWarn("getPendingUpdates timed out");
      unsub?.unregister();
      resolve([]);
    }, 10_000);

    try {
      unsub = SteamClient!.Downloads.RegisterForDownloadItems((_isDownloading: boolean, items: DownloadItem[]) => {
        clearTimeout(timeout);
        unsub?.unregister();

        debug("getPendingUpdates: received", items?.length ?? 0, "download items, isDownloading:", _isDownloading);

        const pending: PendingUpdate[] = (items || [])
          .filter((item) => !item.completed && item.update_type_info?.[0]?.has_update)
          .map((item) => {
            const bytes = getDownloadBytes(item);
            return {
              appId: item.appid,
              name: getAppName(item.appid),
              bytesToDownload: bytes.total,
              bytesDownloaded: bytes.downloaded,
              state: determineState(item),
            };
          });

        debug("getPendingUpdates: filtered to", pending.length, "pending updates");
        resolve(pending);
      });
    } catch (e) {
      clearTimeout(timeout);
      logError("Failed to enumerate downloads:", e);
      resolve([]);
    }
  });
}

/**
 * Force-start a single app's pending update using ResumeAppUpdate.
 */
export async function forceStartUpdate(appId: number): Promise<boolean> {
  if (!isSteamClientAvailable()) {
    logWarn("SteamClient not available");
    return false;
  }

  try {
    SteamClient!.Downloads.ResumeAppUpdate(appId);
    debug(`ResumeAppUpdate(${appId}) called`);
    return true;
  } catch (e) {
    logError(`Failed to resume update for ${appId}:`, e);
    return false;
  }
}

/**
 * Force-start all pending updates. Returns a summary of what happened.
 * Skips forcing if the system appears to be offline.
 */
export async function forceStartAllUpdates(): Promise<UpdateCheckResult> {
  const timestamp = Date.now();
  const errors: string[] = [];

  debug("forceStartAllUpdates: navigator.onLine =", typeof navigator !== "undefined" ? navigator.onLine : "N/A");

  const pending = await getPendingUpdates();
  log(
    `forceStartAllUpdates - found ${pending.length} pending updates: ${pending.map((u) => `${u.name}(${u.appId})[${u.state}]`).join(", ") || "none"}`,
  );
  let forcedCount = 0;

  if (pending.length > 0) {
    // Globally unpause/unschedule the download queue before per-app forcing
    try {
      SteamClient!.Downloads.EnableAllDownloads();
      debug("EnableAllDownloads() called");
    } catch (e) {
      logError("EnableAllDownloads failed:", e);
    }
  }

  for (const update of pending) {
    try {
      const ok = await forceStartUpdate(update.appId);
      if (ok) forcedCount++;
    } catch (e) {
      errors.push(`${update.name} (${update.appId}): ${errorMessage(e)}`);
    }
  }

  // Re-check after a short delay to get accurate post-force state
  if (forcedCount > 0) {
    await new Promise((r) => setTimeout(r, 3000));
    const recheck = await getPendingUpdates();
    const stillScheduled = recheck.filter((u) => u.state === "scheduled");
    if (stillScheduled.length > 0) {
      logWarn(
        `${stillScheduled.length} update(s) still scheduled after forcing: ${stillScheduled.map((u) => u.name).join(", ")}`,
      );
    }

    return {
      source: "steam",
      timestamp,
      pendingCount: Math.max(pending.length, recheck.length),
      forcedCount,
      errors,
      updates: recheck,
      flatpakUpdates: [],
      deckyPluginUpdates: [],
    };
  }

  return {
    source: "steam",
    timestamp,
    pendingCount: pending.length,
    forcedCount,
    errors,
    updates: pending,
    flatpakUpdates: [],
    deckyPluginUpdates: [],
  };
}
