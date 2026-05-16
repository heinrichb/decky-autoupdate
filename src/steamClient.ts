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
  SetAppAutoUpdateBehavior?(appId: number, behavior: number): void;
  SetAppBackgroundDownloadsBehavior?(appId: number, behavior: number): void;
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
  PauseAppUpdate?(appId: number): void;
  QueueAppUpdate?(appId: number): void;
  MoveAppUpdateUp?(appId: number): void;
  SetQueueIndex?(appId: number, index: number): void;
  RemoveFromDownloadList?(appId: number): void;
  EnableAllDownloads(): void;
  SuspendDownloadThrottling?(suspend?: boolean): void;
  [key: string]: unknown;
}

interface SteamClientUser {
  RegisterForResumeSuspendedGamesProgress?(callback: () => void): Unregisterable;
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
  // Try the original API (SteamOS < May 2026)
  try {
    const oldRegister = SteamClient?.System?.RegisterForOnResumeFromSuspend;
    if (typeof oldRegister === "function") {
      const handle = oldRegister.call(SteamClient!.System, callback);
      log("Wake detection: using System.RegisterForOnResumeFromSuspend");
      return () => handle.unregister();
    }
  } catch {
    /* continue to fallback */
  }

  // Try the new API (SteamOS May 2026+)
  try {
    const newRegister = SteamClient?.User?.RegisterForResumeSuspendedGamesProgress;
    if (typeof newRegister === "function") {
      const handle = newRegister.call(SteamClient!.User, callback);
      log("Wake detection: using User.RegisterForResumeSuspendedGamesProgress");
      return () => handle.unregister();
    }
  } catch {
    /* fall through */
  }

  logWarn("Wake detection: no suspend/resume API found, will use heartbeat fallback");
  return null;
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
 * Probe and log the shape of SteamClient APIs at startup.
 * Creates a diagnostic trail when Valve changes the internal API.
 */
export function probeSteamClientApi(): void {
  if (!isSteamClientAvailable()) {
    logWarn("probeSteamClientApi: SteamClient not available");
    return;
  }

  const namespaces = Object.keys(SteamClient!).filter(
    (k) =>
      typeof (SteamClient as Record<string, unknown>)[k] === "object" &&
      (SteamClient as Record<string, unknown>)[k] !== null,
  );
  log("SteamClient namespaces:", namespaces.join(", "));

  const dl = SteamClient!.Downloads;
  if (!dl) {
    logError("SteamClient.Downloads is missing!");
    return;
  }
  const dlMethods = Object.keys(dl).filter((k) => typeof (dl as Record<string, unknown>)[k] === "function");
  log("SteamClient.Downloads methods:", dlMethods.join(", "));

  const expected = ["RegisterForDownloadItems", "ResumeAppUpdate", "EnableAllDownloads"];
  const missing = expected.filter((m) => typeof (dl as Record<string, unknown>)[m] !== "function");
  if (missing.length > 0) {
    logError("SteamClient.Downloads MISSING expected methods:", missing.join(", "));
  }

  // Probe Updates namespace too — relevant for forcing scheduled-state apps to start
  const sc = SteamClient as Record<string, unknown>;
  const updates = sc.Updates as Record<string, unknown> | undefined;
  if (updates && typeof updates === "object") {
    const updateMethods = Object.keys(updates).filter((k) => typeof updates[k] === "function");
    log("SteamClient.Updates methods:", updateMethods.join(", ") || "(none)");
  } else {
    debug("SteamClient.Updates namespace not present");
  }

  // Probe Apps namespace for app-level update operations
  const apps = sc.Apps as Record<string, unknown> | undefined;
  if (apps && typeof apps === "object") {
    const appMethods = Object.keys(apps)
      .filter((k) => typeof apps[k] === "function")
      .filter((k) => /update|install|download|queue|resume/i.test(k));
    if (appMethods.length > 0) {
      log("SteamClient.Apps update-related methods:", appMethods.join(", "));
    }
  }

  // Probe Settings namespace for download-schedule-related methods (often where
  // scheduled-download time / restricted-download-hours toggles live).
  const settings = sc.Settings as Record<string, unknown> | undefined;
  if (settings && typeof settings === "object") {
    const settingMethods = Object.keys(settings)
      .filter((k) => typeof settings[k] === "function")
      .filter((k) => /download|schedule|throttle|restrict/i.test(k));
    if (settingMethods.length > 0) {
      log("SteamClient.Settings download-related methods:", settingMethods.join(", "));
    }
  }

  // Probe Installs namespace
  const installs = sc.Installs as Record<string, unknown> | undefined;
  if (installs && typeof installs === "object") {
    const installMethods = Object.keys(installs).filter((k) => typeof installs[k] === "function");
    if (installMethods.length > 0) {
      log("SteamClient.Installs methods:", installMethods.join(", "));
    }
  }

  // Wide net: scan ALL namespaces for any method name containing download/
  // update/schedule/defer/start. This is how we'll find the Steam UI's
  // "Update Now" backing call if it lives somewhere unexpected.
  const seen: string[] = [];
  for (const ns of namespaces) {
    const obj = sc[ns] as Record<string, unknown>;
    if (!obj || typeof obj !== "object") continue;
    for (const k of Object.keys(obj)) {
      if (typeof obj[k] !== "function") continue;
      if (/start|defer|schedule|forcestart|forceupdate|updatenow|downloadnow/i.test(k)) {
        seen.push(`${ns}.${k}`);
      }
    }
  }
  if (seen.length > 0) {
    log("SteamClient methods matching start/defer/schedule:", seen.join(", "));
  }
}

/**
 * Extract DownloadItem[] from the callback data, handling both the old flat
 * format and the new wrapper format introduced in a ~May 2026 Steam client update.
 *
 * Old: items is DownloadItem[]
 * New: items is { remote_client_id, item_data: { "0": DownloadItem, ... } }[]
 */
function extractDownloadItems(rawItems: unknown[]): DownloadItem[] {
  const result: DownloadItem[] = [];
  for (const item of rawItems) {
    const obj = item as Record<string, unknown>;
    if (obj.item_data && typeof obj.item_data === "object") {
      for (const val of Object.values(obj.item_data as Record<string, unknown>)) {
        if (val && typeof val === "object" && "appid" in (val as Record<string, unknown>)) {
          result.push(val as DownloadItem);
        }
      }
    } else if ("appid" in obj) {
      result.push(obj as unknown as DownloadItem);
    }
  }
  return result;
}

/**
 * Get the raw DownloadItem list from Steam — same source as getPendingUpdates
 * but skipping our filter so we can inspect items in any state.
 * Used by diagnostic dumps to see fields like `deferred_time` and `queue_index`.
 */
export function getRawDownloadItems(): Promise<DownloadItem[]> {
  if (!isSteamClientAvailable()) return Promise.resolve([]);
  return new Promise((resolve) => {
    let unsub: { unregister: () => void } | null = null;
    const timeout = setTimeout(() => {
      unsub?.unregister();
      resolve([]);
    }, 5_000);
    try {
      unsub = SteamClient!.Downloads.RegisterForDownloadItems((_isDownloading: boolean, rawItems: unknown[]) => {
        clearTimeout(timeout);
        unsub?.unregister();
        resolve(extractDownloadItems(rawItems || []));
      });
    } catch (e) {
      clearTimeout(timeout);
      logWarn("getRawDownloadItems failed:", errorMessage(e));
      resolve([]);
    }
  });
}

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
      logWarn("getPendingUpdates timed out - callback never fired");
      unsub?.unregister();
      resolve([]);
    }, 10_000);

    try {
      unsub = SteamClient!.Downloads.RegisterForDownloadItems((_isDownloading: boolean, rawItems: unknown[]) => {
        clearTimeout(timeout);
        unsub?.unregister();

        const items = extractDownloadItems(rawItems || []);
        debug(
          "getPendingUpdates: received",
          rawItems?.length ?? 0,
          "raw items, extracted",
          items.length,
          "download items, isDownloading:",
          _isDownloading,
        );

        if (items.length > 0) {
          try {
            const sample = items[0];
            debug(
              "getPendingUpdates: sample item keys:",
              Object.keys(sample).join(", "),
              "| appid:",
              sample.appid,
              "completed:",
              sample.completed,
              "has_update:",
              sample.update_type_info?.[0]?.has_update ?? "N/A",
            );
            // Full raw dump of the first scheduled-looking item — shows
            // deferred_time, paused, active, queue_index, update flags etc.
            // This is what we need to understand what's pinning items in
            // "scheduled" state across all the force-start API calls.
            const firstScheduled = items.find(
              (it) => !it.completed && (it.deferred_time ?? 0) > 0 && it.update_type_info?.[0]?.has_update,
            );
            if (firstScheduled) {
              log(
                "getPendingUpdates: raw scheduled DownloadItem dump (first match):",
                JSON.stringify(firstScheduled),
              );
            }
          } catch (e) {
            logWarn("getPendingUpdates: failed to log sample item:", errorMessage(e));
          }
        }

        const pending: PendingUpdate[] = items
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
 * Force-start a single app's pending update. Post-Steam-update, ResumeAppUpdate
 * alone no longer reliably transitions "scheduled" → "queued" — many apps stay
 * scheduled. To work around this we call QueueAppUpdate first (when available)
 * to explicitly queue the app, then ResumeAppUpdate to kick off the download.
 */
export async function forceStartUpdate(appId: number): Promise<boolean> {
  if (!isSteamClientAvailable()) {
    logWarn("SteamClient not available");
    return false;
  }

  const downloads = SteamClient!.Downloads;
  const apps = SteamClient!.Apps;
  let calledSomething = false;

  // The DownloadItem dump showed scheduled apps have deferred_time set to a
  // future timestamp (Steam's off-peak download window) and queue_index = -1.
  // None of MoveAppUpdateUp/QueueAppUpdate/SetQueueIndex/ResumeAppUpdate
  // cleared deferred_time on current Steam builds.
  //
  // The strategy here mirrors what the Steam Library UI does when you click
  // "Update Now" on a scheduled item:
  //   1. SetAppAutoUpdateBehavior(appId, 0) — "Always keep this game up to
  //      date." Overrides the per-app schedule policy so Steam stops deferring.
  //   2. PauseAppUpdate(appId) — flips the item from "scheduled" into "paused",
  //      which is a state ResumeAppUpdate can actually act on.
  //   3. ResumeAppUpdate(appId) — starts the download from the paused state.
  if (typeof apps.SetAppAutoUpdateBehavior === "function") {
    try {
      apps.SetAppAutoUpdateBehavior(appId, 0);
      debug(`SetAppAutoUpdateBehavior(${appId}, 0) called (always update)`);
      calledSomething = true;
    } catch (e) {
      debug(`SetAppAutoUpdateBehavior(${appId}, 0) failed: ${errorMessage(e)}`);
    }
  }

  // Steam's behavior enum values are not documented externally. Best guesses:
  //   0 = use global default (which probably IS what defers)
  //   1 = always allow background downloads
  //   2 = pause during gameplay
  // We try 1 here ("always allow") to override any global throttle.
  if (typeof apps.SetAppBackgroundDownloadsBehavior === "function") {
    try {
      apps.SetAppBackgroundDownloadsBehavior(appId, 1);
      debug(`SetAppBackgroundDownloadsBehavior(${appId}, 1) called (always allow)`);
      calledSomething = true;
    } catch (e) {
      debug(`SetAppBackgroundDownloadsBehavior(${appId}, 1) failed: ${errorMessage(e)}`);
    }
  }

  if (typeof downloads.PauseAppUpdate === "function") {
    try {
      downloads.PauseAppUpdate(appId);
      debug(`PauseAppUpdate(${appId}) called`);
      calledSomething = true;
    } catch (e) {
      debug(`PauseAppUpdate(${appId}) failed: ${errorMessage(e)}`);
    }
  }

  try {
    downloads.ResumeAppUpdate(appId);
    debug(`ResumeAppUpdate(${appId}) called`);
    calledSomething = true;
  } catch (e) {
    logError(`Failed to resume update for ${appId}:`, e);
  }

  return calledSomething;
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
    // Globally unpause/unschedule the download queue before per-app forcing.
    // Recent Steam builds appear to leave items stuck in "scheduled" even after
    // ResumeAppUpdate. We pair these three calls because each clears a
    // different gate that can keep a download "scheduled":
    //   - EnableAllDownloads(true): downloads-paused master switch
    //   - SuspendDownloadThrottling(true): off-peak/scheduled-hours throttle
    //   - MoveAppUpdateUp(appId): force to top of queue (per-app, later)
    try {
      SteamClient!.Downloads.EnableAllDownloads();
      debug("EnableAllDownloads() called");
    } catch (e) {
      logError("EnableAllDownloads failed:", e);
    }
    // SuspendDownloadThrottling(true) tells Steam to suspend its throttling/
    // scheduling logic — i.e. ignore the configured "download during off-peak
    // hours" or "pause during gameplay" rules so the queue can run NOW.
    if (typeof SteamClient!.Downloads.SuspendDownloadThrottling === "function") {
      try {
        SteamClient!.Downloads.SuspendDownloadThrottling(true);
        debug("SuspendDownloadThrottling(true) called");
      } catch (e) {
        logError("SuspendDownloadThrottling failed:", e);
      }
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

  // Diagnostic: after all the force-start calls, dump the raw DownloadItem of
  // the first scheduled app to see whether any of our calls had measurable
  // effect on its fields (deferred_time, queue_index, paused, etc.). Compare
  // this with the pre-force dump in getPendingUpdates to see what changed.
  if (pending.length > 0 && pending.some((u) => u.state === "scheduled")) {
    try {
      const firstScheduledId = pending.find((u) => u.state === "scheduled")?.appId;
      if (firstScheduledId != null) {
        await new Promise((r) => setTimeout(r, 500));
        const postItems = await getRawDownloadItems();
        const post = postItems.find((it) => it.appid === firstScheduledId);
        log(
          `POST-FORCE raw DownloadItem for appid=${firstScheduledId}:`,
          post ? JSON.stringify(post) : "(no longer in download list)",
        );
      }
    } catch (e) {
      debug("Post-force dump failed:", errorMessage(e));
    }
  }

  // Re-check after a short delay to get accurate post-force state.
  // `forcedCount` is reinterpreted here to mean "items that successfully moved
  // out of scheduled" — i.e. downloads we actually started — not just "API
  // calls made without throwing". This matches what the user sees in Steam.
  if (forcedCount > 0) {
    const scheduledBefore = pending.filter((u) => u.state === "scheduled").length;
    await new Promise((r) => setTimeout(r, 3000));
    let recheck = await getPendingUpdates();
    let stillScheduled = recheck.filter((u) => u.state === "scheduled");

    // Retry pass: post-Steam-update, the first round of Queue/Resume calls
    // sometimes leaves apps scheduled. Re-issue the calls and wait again.
    if (stillScheduled.length > 0) {
      logWarn(
        `${stillScheduled.length} of ${scheduledBefore} update(s) still scheduled after first pass — retrying: ${stillScheduled.map((u) => u.name).join(", ")}`,
      );
      for (const update of stillScheduled) {
        await forceStartUpdate(update.appId);
      }
      await new Promise((r) => setTimeout(r, 5000));
      recheck = await getPendingUpdates();
      stillScheduled = recheck.filter((u) => u.state === "scheduled");
      if (stillScheduled.length > 0) {
        logWarn(
          `${stillScheduled.length} of ${scheduledBefore} update(s) still scheduled after retry: ${stillScheduled.map((u) => u.name).join(", ")}`,
        );
      } else {
        log("All previously-stuck updates transitioned out of scheduled state on retry");
      }
    }

    // Count what actually transitioned: pending items minus those still scheduled.
    // The 3 already-queued items in `pending` shouldn't count as "started by us".
    const startedCount = pending.length - stillScheduled.length - pending.filter((u) => u.state !== "scheduled").length;
    const alreadyQueuedCount = pending.filter((u) => u.state !== "scheduled").length;
    log(
      `Steam force-start summary: ${pending.length} pending (${scheduledBefore} scheduled, ${alreadyQueuedCount} already queued/downloading), ` +
        `${Math.max(0, startedCount)} transitioned out of scheduled, ${stillScheduled.length} still stuck`,
    );

    return {
      source: "steam",
      timestamp,
      pendingCount: Math.max(pending.length, recheck.length),
      forcedCount: Math.max(0, startedCount),
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
