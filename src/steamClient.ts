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
import { log, logWarn, logError, debug, isDebugEnabled, errorMessage } from "./helpers";
import { callPluginMethod } from "./deckyApi";

interface ForceUpdateResult {
  success: boolean;
  manifest_path: string;
  manifest_modified: boolean;
  url_invoked: boolean;
  error: string;
}

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

/**
 * All SteamClient.Downloads methods take a `remoteClientId: string` second
 * argument identifying which Steam client owns the download (local Steam vs
 * a remote-play paired client). Calls made with the second arg omitted are
 * silent no-ops on current Steam builds — this was the root cause of the
 * "force-start does nothing" symptom that confused us for ages.
 *
 * For local Steam (no remote-play active) pass `LOCAL_CLIENT_ID` = `"0"`.
 */
interface SteamClientDownloads {
  RegisterForDownloadItems(callback: (isDownloading: boolean, items: DownloadItem[]) => void): Unregisterable;
  RegisterForDownloadOverview(callback: (overview: unknown) => void): Unregisterable;
  ResumeAppUpdate(appId: number, remoteClientId: string): void;
  PauseAppUpdate?(appId: number, remoteClientId: string): void;
  QueueAppUpdate?(appId: number, remoteClientId: string): void;
  MoveAppUpdateUp?(appId: number, remoteClientId: string): void;
  MoveAppUpdateDown?(appId: number, remoteClientId: string): void;
  SetQueueIndex?(appId: number, index: number, remoteClientId: string): void;
  RemoveFromDownloadList?(appId: number, remoteClientId: string): void;
  EnableAllDownloads(enable: boolean, remoteClientId: string): void;
  SuspendDownloadThrottling?(suspend: boolean, remoteClientId: string): void;
  SuspendLanPeerContent?(suspend: boolean, remoteClientId: string): void;
  [key: string]: unknown;
}

/** Local-Steam-self client ID used by all Downloads.* methods. Found in Steam UI bundle as `n.O = "0"`. */
const LOCAL_CLIENT_ID = "0";

interface ResumeProgress {
  state?: number;
}

interface SteamClientUser {
  RegisterForResumeSuspendedGamesProgress?(callback: (progress?: ResumeProgress) => void): Unregisterable;
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
  return typeof SteamClient !== "undefined" && SteamClient !== null;
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

export interface ResumeRegistration {
  unregister: () => void;
  api: string;
}

/**
 * Register a callback for when the device resumes from sleep. The callback
 * receives the `state` of Steam's resume progress payload (Complete = 1) when
 * the registered API provides one.
 * Returns the registration, or null if no resume API is available.
 */
export function registerForResume(callback: (state: number | undefined) => void): ResumeRegistration | null {
  // Original API (SteamOS < May 2026)
  try {
    const oldRegister = SteamClient?.System?.RegisterForOnResumeFromSuspend;
    if (typeof oldRegister === "function") {
      const handle = oldRegister.call(SteamClient!.System, () => callback(undefined));
      const api = "System.RegisterForOnResumeFromSuspend";
      log(`Wake detection: using ${api}`);
      return { unregister: () => handle.unregister(), api };
    }
  } catch {
    /* continue to fallback */
  }

  // New API (SteamOS May 2026+)
  try {
    const newRegister = SteamClient?.User?.RegisterForResumeSuspendedGamesProgress;
    if (typeof newRegister === "function") {
      const handle = newRegister.call(SteamClient!.User, (progress) =>
        callback(typeof progress?.state === "number" ? progress.state : undefined),
      );
      const api = "User.RegisterForResumeSuspendedGamesProgress";
      log(`Wake detection: using ${api}`);
      return { unregister: () => handle.unregister(), api };
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
 * Probe the shape of SteamClient APIs at startup. Missing pieces are always
 * reported; the full namespace dumps are debug-only.
 * Creates a diagnostic trail when Valve changes the internal API.
 */
export function probeSteamClientApi(): void {
  if (!isSteamClientAvailable()) {
    logWarn("probeSteamClientApi: SteamClient not available");
    return;
  }

  const dl = SteamClient!.Downloads;
  if (!dl) {
    logError("SteamClient.Downloads is missing!");
    return;
  }
  const dlRecord = dl as Record<string, unknown>;
  const expected = ["RegisterForDownloadItems", "ResumeAppUpdate", "EnableAllDownloads"];
  const missing = expected.filter((m) => typeof dlRecord[m] !== "function");
  if (missing.length > 0) {
    logError("SteamClient.Downloads MISSING expected methods:", missing.join(", "));
  }

  if (!isDebugEnabled()) return;

  const sc = SteamClient as Record<string, unknown>;
  const namespaces = Object.keys(sc).filter((k) => typeof sc[k] === "object" && sc[k] !== null);
  debug("SteamClient namespaces:", namespaces.join(", "));
  debug(
    "SteamClient.Downloads methods:",
    Object.keys(dlRecord)
      .filter((k) => typeof dlRecord[k] === "function")
      .join(", "),
  );

  // Updates namespace: relevant for forcing scheduled-state apps to start
  const updates = sc.Updates as Record<string, unknown> | undefined;
  if (updates && typeof updates === "object") {
    const updateMethods = Object.keys(updates).filter((k) => typeof updates[k] === "function");
    debug("SteamClient.Updates methods:", updateMethods.join(", ") || "(none)");
  } else {
    debug("SteamClient.Updates namespace not present");
  }

  const apps = sc.Apps as Record<string, unknown> | undefined;
  if (apps && typeof apps === "object") {
    const appMethods = Object.keys(apps)
      .filter((k) => typeof apps[k] === "function")
      .filter((k) => /update|install|download|queue|resume/i.test(k));
    if (appMethods.length > 0) {
      debug("SteamClient.Apps update-related methods:", appMethods.join(", "));
    }
  }

  // Settings namespace: download-schedule-related methods (scheduled-download
  // time / restricted-download-hours toggles).
  const settings = sc.Settings as Record<string, unknown> | undefined;
  if (settings && typeof settings === "object") {
    const settingMethods = Object.keys(settings)
      .filter((k) => typeof settings[k] === "function")
      .filter((k) => /download|schedule|throttle|restrict/i.test(k));
    if (settingMethods.length > 0) {
      debug("SteamClient.Settings download-related methods:", settingMethods.join(", "));
    }
  }

  const installs = sc.Installs as Record<string, unknown> | undefined;
  if (installs && typeof installs === "object") {
    const installMethods = Object.keys(installs).filter((k) => typeof installs[k] === "function");
    if (installMethods.length > 0) {
      debug("SteamClient.Installs methods:", installMethods.join(", "));
    }
  }

  // Wide net: scan ALL namespaces for any method name containing download/
  // update/schedule/defer/start, in case the Steam UI's "Update Now" backing
  // call lives somewhere unexpected.
  const seen: string[] = [];
  for (const ns of namespaces) {
    const obj = sc[ns] as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      if (typeof obj[k] !== "function") continue;
      if (/start|defer|schedule|forcestart|forceupdate|updatenow|downloadnow/i.test(k)) {
        seen.push(`${ns}.${k}`);
      }
    }
  }
  if (seen.length > 0) {
    debug("SteamClient methods matching start/defer/schedule:", seen.join(", "));
  }

  // The Library "Update Now" handler lives in one of the MobX stores exposed
  // on window; list the download-related globals and their callable members.
  try {
    const w = window as unknown as Record<string, unknown>;
    const downloadGlobals = Object.keys(w).filter((k) =>
      /download|update|library|app(s|details|info)?store|queue/i.test(k),
    );
    if (downloadGlobals.length > 0) {
      debug("Global download/update-related window keys:", downloadGlobals.join(", "));
    }

    for (const name of downloadGlobals) {
      const v = w[name];
      if (v && typeof v === "object") {
        const methods = Object.keys(v as Record<string, unknown>).filter(
          (k) => typeof (v as Record<string, unknown>)[k] === "function",
        );
        const filtered = methods.filter((m) => /update|queue|download|start|schedule|defer|resume/i.test(m));
        if (filtered.length > 0) {
          debug(`window.${name} matching methods:`, filtered.slice(0, 30).join(", "));
        }
      }
    }
  } catch (e) {
    debug("Global probe failed:", errorMessage(e));
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

const STATE_FLAGS_FULLY_INSTALLED = 4;
const STATE_FLAGS_UPDATE_REQUIRED = 2;
const STATE_FLAGS_QUEUE_MASK = STATE_FLAGS_FULLY_INSTALLED | STATE_FLAGS_UPDATE_REQUIRED;

function maxProgressBytes(item: DownloadItem): number {
  const progress = item.update_type_info?.[0]?.progress ?? [];
  return progress.reduce((m, p) => Math.max(m, p?.bytes_total ?? 0), 0);
}

/**
 * Same known build and nothing to download: Steam keeps re-scheduling these, but there is no update to start.
 * Build 0 -> 0 is not a known build: Steam reports real scheduled updates that way until they begin.
 */
function isNoOpItem(item: DownloadItem): boolean {
  return item.buildid > 0 && item.buildid === item.target_buildid && maxProgressBytes(item) === 0;
}

function isBetterEntry(candidate: DownloadItem, current: DownloadItem): boolean {
  const candidateTarget = Number(candidate.target_buildid) || 0;
  const currentTarget = Number(current.target_buildid) || 0;
  if (candidateTarget !== currentTarget) return candidateTarget > currentTarget;
  if (!!candidate.active !== !!current.active) return !!candidate.active;
  const candidateQueued = candidate.queue_index >= 0;
  const currentQueued = current.queue_index >= 0;
  if (candidateQueued !== currentQueued) return candidateQueued;
  const candidateDeferred = candidate.deferred_time > 0;
  const currentDeferred = current.deferred_time > 0;
  if (candidateDeferred !== currentDeferred) return !candidateDeferred;
  return false;
}

/** Steam can list several entries for one app; only the newest build's entry is actionable. */
function dedupeByAppId(items: DownloadItem[]): DownloadItem[] {
  const byApp = new Map<number, DownloadItem>();
  for (const item of items) {
    const current = byApp.get(item.appid);
    if (!current || isBetterEntry(item, current)) byApp.set(item.appid, item);
  }
  const ignored = items.length - byApp.size;
  if (ignored > 0) debug(`getPendingUpdates: ignored ${ignored} superseded duplicate items`);
  return [...byApp.values()];
}

function toPendingUpdate(item: DownloadItem): PendingUpdate {
  const bytes = getDownloadBytes(item);
  return {
    appId: item.appid,
    name: getAppName(item.appid),
    bytesToDownload: bytes.total,
    bytesDownloaded: bytes.downloaded,
    state: determineState(item),
  };
}

function logDownloadItems(items: DownloadItem[]): void {
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
  // Format per item:
  //   appid|name|active|paused|completed|deferred_time|queue_index|
  //     has_update[0..2]|maxBytes|update_result|build->target
  const compact = items.map((it) => {
    const hasUpdateFlags = (it.update_type_info ?? []).map((u) => (u?.has_update ? "1" : "0")).join("");
    return (
      `${it.appid}|${getAppName(it.appid)}|` +
      `a=${it.active ? 1 : 0}|p=${it.paused ? 1 : 0}|c=${it.completed ? 1 : 0}|` +
      `def=${it.deferred_time ?? 0}|qi=${it.queue_index ?? -99}|` +
      `hu=${hasUpdateFlags}|maxB=${maxProgressBytes(it)}|` +
      `rc=${it.update_result ?? "?"}|b=${it.buildid}->${it.target_buildid}`
    );
  });
  debug("getPendingUpdates: ALL items compact dump:\n  " + compact.join("\n  "));
}

async function buildPendingUpdates(rawItems: unknown[], isDownloading: boolean): Promise<PendingUpdate[]> {
  const items = extractDownloadItems(rawItems);
  debug(
    "getPendingUpdates: received",
    rawItems.length,
    "raw items, extracted",
    items.length,
    "download items, isDownloading:",
    isDownloading,
  );

  if (items.length > 0 && isDebugEnabled()) {
    try {
      logDownloadItems(items);
    } catch (e) {
      logWarn("getPendingUpdates: failed to log sample item:", errorMessage(e));
    }
  }

  const candidates = dedupeByAppId(items).filter(
    (item) => !item.completed && item.update_type_info?.[0]?.has_update && !isNoOpItem(item),
  );
  if (candidates.length === 0) return [];

  // Steam's queue UI only shows items where StateFlags & 6 == 6
  // (FullyInstalled + UpdateRequired). The DownloadItem API doesn't
  // expose StateFlags, so ask the backend to read each app's manifest.
  const appIds = candidates.map((c) => c.appid);
  try {
    const flagsByAppId = await callPluginMethod<Record<string, number>>("get_app_state_flags_batch", [appIds], 8_000);
    const filtered = candidates.filter((item) => {
      const flags = flagsByAppId[String(item.appid)];
      if (flags == null || flags < 0) {
        // No local manifest (uninstalled/owned app): Steam doesn't queue these.
        debug(`getPendingUpdates: excluding ${item.appid} (${getAppName(item.appid)}) — no manifest`);
        return false;
      }
      if ((flags & STATE_FLAGS_QUEUE_MASK) !== STATE_FLAGS_QUEUE_MASK) {
        debug(
          `getPendingUpdates: excluding ${item.appid} (${getAppName(item.appid)}) — ` +
            `StateFlags=${flags} doesn't match queue mask (${STATE_FLAGS_QUEUE_MASK})`,
        );
        return false;
      }
      return true;
    });
    log(`getPendingUpdates: ${candidates.length} candidates -> ${filtered.length} after StateFlags filter`);
    return filtered.map(toPendingUpdate);
  } catch (e) {
    // Degrade to the looser filter rather than reporting zero updates.
    logWarn("getPendingUpdates: StateFlags lookup failed, falling back to loose filter:", errorMessage(e));
    return candidates.map(toPendingUpdate);
  }
}

/**
 * Read the Steam download queue via RegisterForDownloadItems. The callback fires
 * immediately with the current state, so we wrap it in a Promise that resolves on
 * the first invocation and then unregisters.
 *
 * Resolves null when Steam did not report its state (no SteamClient, timeout, or
 * an exception), which callers must not mistake for "nothing is pending".
 */
function readPendingUpdates(): Promise<PendingUpdate[] | null> {
  if (!isSteamClientAvailable()) {
    logWarn("SteamClient not available");
    return Promise.resolve(null);
  }

  debug("getPendingUpdates: registering for download items...");
  return new Promise((resolve) => {
    let unsub: { unregister: () => void } | null = null;
    let fired = false;

    const timeout = setTimeout(() => {
      logWarn("getPendingUpdates timed out - callback never fired");
      unsub?.unregister();
      resolve(null);
    }, 10_000);

    try {
      unsub = SteamClient!.Downloads.RegisterForDownloadItems((isDownloading: boolean, rawItems: unknown[]) => {
        fired = true;
        clearTimeout(timeout);
        unsub?.unregister();
        resolve(
          buildPendingUpdates(rawItems || [], isDownloading).catch((e) => {
            logError("getPendingUpdates failed:", errorMessage(e));
            return null;
          }),
        );
      });
      if (fired) unsub?.unregister();
    } catch (e) {
      clearTimeout(timeout);
      logError("Failed to enumerate downloads:", e);
      resolve(null);
    }
  });
}

/** Enumerate all games that have pending or scheduled updates; empty when Steam did not report. */
export async function getPendingUpdates(): Promise<PendingUpdate[]> {
  return (await readPendingUpdates()) ?? [];
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
  // ALL SteamClient.Downloads.* methods take a remoteClientId as their last
  // argument. We pass LOCAL_CLIENT_ID = "0" (verified in Steam's UI bundle).
  // Before adding the second arg these calls silently no-op'd — that was the
  // root cause of force-start doing nothing on current Steam builds.
  //
  // Sequence mirrors what Steam Library's "Update Now" button does:
  //   1. SetAppAutoUpdateBehavior(appId, 0) — "Always keep up to date"
  //   2. QueueAppUpdate(appId, LOCAL) — re-enqueue (clears scheduled state)
  //   3. ResumeAppUpdate(appId, LOCAL) — start the download
  if (typeof apps.SetAppAutoUpdateBehavior === "function") {
    try {
      apps.SetAppAutoUpdateBehavior(appId, 0);
      debug(`SetAppAutoUpdateBehavior(${appId}, 0)`);
      calledSomething = true;
    } catch (e) {
      debug(`SetAppAutoUpdateBehavior(${appId}, 0) failed: ${errorMessage(e)}`);
    }
  }

  if (typeof downloads.QueueAppUpdate === "function") {
    try {
      downloads.QueueAppUpdate(appId, LOCAL_CLIENT_ID);
      debug(`QueueAppUpdate(${appId}, "${LOCAL_CLIENT_ID}")`);
      calledSomething = true;
    } catch (e) {
      debug(`QueueAppUpdate(${appId}, "${LOCAL_CLIENT_ID}") failed: ${errorMessage(e)}`);
    }
  }

  try {
    downloads.ResumeAppUpdate(appId, LOCAL_CLIENT_ID);
    debug(`ResumeAppUpdate(${appId}, "${LOCAL_CLIENT_ID}")`);
    calledSomething = true;
  } catch (e) {
    logError(`Failed to resume update for ${appId}:`, e);
  }

  return calledSomething;
}

const RECHECK_INTERVAL_MS = 500;
const RECHECK_TIMEOUT_MS = 4_000;
const BACKEND_RECHECK_TIMEOUT_MS = 6_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface LeftScheduledResult {
  stillScheduled: PendingUpdate[];
  /** True when the last read failed, so `stillScheduled` is only what the last good read showed. */
  unknown: boolean;
}

/**
 * Poll the download queue until none of `targets` is scheduled any more, or
 * `timeoutMs` has passed. A failed read is unknown, not empty: keep polling and
 * fall back to the last good read (or `targets` when none succeeded).
 */
async function waitForLeftScheduled(targets: PendingUpdate[], timeoutMs: number): Promise<LeftScheduledResult> {
  const appIds = new Set(targets.map((u) => u.appId));
  const deadline = Date.now() + timeoutMs;
  let stillScheduled = targets;
  for (;;) {
    await sleep(RECHECK_INTERVAL_MS);
    const read = await readPendingUpdates();
    if (read) {
      stillScheduled = read.filter((u) => u.state === "scheduled" && appIds.has(u.appId));
      if (stillScheduled.length === 0) return { stillScheduled, unknown: false };
    }
    if (Date.now() >= deadline) return { stillScheduled, unknown: read === null };
  }
}

const UNKNOWN_STATE_ERROR = "Steam did not report download state";

/**
 * Force-start all pending updates. Returns a summary of what happened.
 * Skips forcing if the system appears to be offline.
 */
export async function forceStartAllUpdates(): Promise<UpdateCheckResult> {
  const steamT0 = Date.now();
  const timestamp = steamT0;
  const errors: string[] = [];

  debug("forceStartAllUpdates: navigator.onLine =", typeof navigator !== "undefined" ? navigator.onLine : "N/A");

  const pendingT0 = Date.now();
  const pending = await readPendingUpdates();
  if (!pending) {
    logWarn("forceStartAllUpdates: Steam did not report the download queue, nothing was started");
    return {
      source: "steam",
      timestamp,
      pendingCount: 0,
      forcedCount: 0,
      errors: [`${UNKNOWN_STATE_ERROR}; could not check for updates`],
      updates: [],
      flatpakUpdates: [],
      deckyPluginUpdates: [],
    };
  }
  log(
    `forceStartAllUpdates - getPendingUpdates in ${Date.now() - pendingT0}ms, found ${pending.length}: ${pending.map((u) => `${u.name}(${u.appId})[${u.state}]`).join(", ") || "none"}`,
  );

  // Only act on items the plugin actually has work for: those stuck in the
  // "scheduled" state. Items already in `queued` or `downloading` are Steam's
  // problem now.
  const scheduledPending = pending.filter((u) => u.state === "scheduled");
  const scheduledBefore = scheduledPending.length;
  const scheduledIds = new Set(scheduledPending.map((u) => u.appId));

  if (scheduledBefore > 0) {
    // Globally unpause/unschedule the download queue before per-app forcing.
    //   - EnableAllDownloads(true): downloads-paused master switch
    //   - SuspendDownloadThrottling(true): off-peak/scheduled-hours throttle
    try {
      SteamClient!.Downloads.EnableAllDownloads(true, LOCAL_CLIENT_ID);
      debug(`EnableAllDownloads(true, "${LOCAL_CLIENT_ID}")`);
    } catch (e) {
      logError("EnableAllDownloads failed:", e);
    }
    if (typeof SteamClient!.Downloads.SuspendDownloadThrottling === "function") {
      try {
        SteamClient!.Downloads.SuspendDownloadThrottling(true, LOCAL_CLIENT_ID);
        debug(`SuspendDownloadThrottling(true, "${LOCAL_CLIENT_ID}")`);
      } catch (e) {
        logError("SuspendDownloadThrottling failed:", e);
      }
    }
  }

  let calledCount = 0;
  const forceLoopT0 = Date.now();
  for (const update of scheduledPending) {
    try {
      const appT0 = Date.now();
      const ok = await forceStartUpdate(update.appId);
      debug(`forceStartUpdate(${update.appId} ${update.name}): ${ok ? "ok" : "no-op"} in ${Date.now() - appT0}ms`);
      if (ok) calledCount++;
    } catch (e) {
      errors.push(`${update.name} (${update.appId}): ${errorMessage(e)}`);
    }
  }
  if (scheduledBefore > 0) {
    log(`Force-start loop: ${scheduledBefore} apps in ${Date.now() - forceLoopT0}ms, ${calledCount} calls made`);
  }

  if (calledCount === 0) {
    if (scheduledBefore === 0) {
      log(`Steam check: no scheduled items to force-start | total=${Date.now() - steamT0}ms`);
    } else {
      logWarn(`Steam force-start: no SteamClient call succeeded for ${scheduledBefore} scheduled app(s)`);
    }
    return {
      source: "steam",
      timestamp,
      pendingCount: scheduledBefore,
      forcedCount: 0,
      errors,
      updates: scheduledPending,
      flatpakUpdates: [],
      deckyPluginUpdates: [],
    };
  }

  // Diagnostic: dump the raw DownloadItem of the first scheduled app shortly
  // after forcing to see which fields (deferred_time, queue_index, paused)
  // actually changed. Compare with the pre-force dump in getPendingUpdates.
  if (isDebugEnabled()) {
    try {
      const firstScheduledId = scheduledPending[0].appId;
      await sleep(RECHECK_INTERVAL_MS);
      const post = (await getRawDownloadItems()).find((it) => it.appid === firstScheduledId);
      debug(
        `POST-FORCE raw DownloadItem for appid=${firstScheduledId}:`,
        post ? JSON.stringify(post) : "(no longer in download list)",
      );
    } catch (e) {
      debug("Post-force dump failed:", errorMessage(e));
    }
  }

  // forcedCount means "apps that actually left the scheduled state" — downloads
  // we started — not "API calls made without throwing".
  const recheckT0 = Date.now();
  let { stillScheduled, unknown } = await waitForLeftScheduled(scheduledPending, RECHECK_TIMEOUT_MS);
  debug(
    `Steam: re-check settled in ${Date.now() - recheckT0}ms, ${stillScheduled.length} still scheduled${unknown ? " (state unknown)" : ""}`,
  );

  // Last-resort pass for the case where Steam ships another API regression and
  // the SteamClient calls stop working: edit the manifest and invoke the steam URL.
  if (stillScheduled.length > 0 && !unknown) {
    logWarn(
      `${stillScheduled.length} of ${scheduledBefore} update(s) still scheduled after SteamClient API calls — falling back to backend manifest edit + steam URL: ${stillScheduled.map((u) => u.name).join(", ")}`,
    );
    for (const update of stillScheduled) {
      try {
        const res = await callPluginMethod<ForceUpdateResult>("force_steam_app_update", [update.appId], 15_000);
        log(
          `force_steam_app_update(${update.appId}): success=${res.success}, manifest_modified=${res.manifest_modified}, url_invoked=${res.url_invoked}${res.error ? ", error=" + res.error : ""}`,
        );
      } catch (e) {
        logError(`force_steam_app_update(${update.appId}) IPC failed:`, errorMessage(e));
      }
    }
    // Steam needs a moment to re-read manifests + process the URL
    ({ stillScheduled, unknown } = await waitForLeftScheduled(stillScheduled, BACKEND_RECHECK_TIMEOUT_MS));
    if (stillScheduled.length === 0) {
      log("Backend manifest edit + steam URL cleared all remaining scheduled items");
    } else if (!unknown) {
      logWarn(
        `${stillScheduled.length} of ${scheduledBefore} update(s) STILL scheduled after backend manifest edit: ${stillScheduled.map((u) => u.name).join(", ")}`,
      );
    }
  }

  // pendingCount reflects only items the plugin had work for — scheduled apps
  // at the start of this check:
  //   - "X of X started" when every scheduled app transitioned (green)
  //   - "Y of X" when some stayed stuck (yellow via statusColor)
  //   - "Up to date" when nothing was scheduled (green)
  const stuckIds = new Set(stillScheduled.map((u) => u.appId));
  const forcedCount = [...scheduledIds].filter((id) => !stuckIds.has(id)).length;
  if (unknown) {
    const message = `${UNKNOWN_STATE_ERROR}; could not confirm ${stillScheduled.length} update(s) started`;
    logWarn(`${message}: ${stillScheduled.map((u) => u.name).join(", ")}`);
    errors.push(message);
  }
  const alreadyQueuedCount = pending.length - scheduledBefore;
  log(
    `Steam force-start summary: ${scheduledBefore} scheduled (${alreadyQueuedCount} already queued/downloading were ignored), ` +
      `${forcedCount} transitioned out of scheduled, ${stuckIds.size} still stuck` +
      ` | total=${Date.now() - steamT0}ms`,
  );

  return {
    source: "steam",
    timestamp,
    pendingCount: scheduledBefore,
    forcedCount,
    errors,
    updates: scheduledPending,
    flatpakUpdates: [],
    deckyPluginUpdates: [],
  };
}
