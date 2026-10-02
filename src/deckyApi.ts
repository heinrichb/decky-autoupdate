/**
 * Abstraction layer over Decky Loader.
 *
 * Plugin backend methods go through `call` from @decky/api and loader routes through
 * `window.DeckyBackend`. Both ride Decky's own shared WebSocket router, which reconnects
 * and replays in-flight calls by itself. Decky's /ws endpoint keeps only the newest
 * connection, so a private socket evicts the shared one until it reconnects (~5 s).
 * Private sockets are therefore used only where the shared router cannot be:
 *   - plugin installs: the install prompt event must reach us, not Decky's modal. The
 *     socket closes as soon as the prompt arrives and the confirm goes through
 *     DeckyBackend, so the install's unload/import events reach Decky's own frontend.
 *   - updater/do_update: a replay after the loader restarts would run the update again
 *
 * Wire protocol:
 *   ERROR(-1):            {type: -1, id, error: {name, error, traceback}}  server → client
 *   CALL(0):              {type: 0, route, args, id}                       client → server
 *   REPLY(1):             {type: 1, id, result}                            server → client
 *   DISCARD(2):           {type: 2, id}                                    server → client
 *   RECEIVED_RESPONSE(3): {type: 3, id}         client acknowledges a REPLY/ERROR/DISCARD
 *   FULL_SYNC(4):         {type: 4, messages}   client resends running calls on reconnect
 *   EVENT(5):             {type: 5, event, args}                           server push
 *
 * All Decky Loader interaction is isolated in this file so that API changes
 * only require updating this module.
 */

import { call } from "@decky/api";
import { log, logWarn, logError, debug, trace, errorMessage, isOnline, withTimeout } from "./helpers";

const DECKY_HOST = "http://127.0.0.1:1337";
const DECKY_WS = "ws://127.0.0.1:1337/ws";
const STORE_URL = "https://plugins.deckbrew.xyz/plugins";

const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const INSTALL_PROMPT_TIMEOUT_MS = 30_000;
const INSTALL_CONFIRM_TIMEOUT_MS = 30_000;
const SHARED_CONFIRM_BASE_TIMEOUT_MS = 20_000;
const SHARED_CONFIRM_PER_PLUGIN_MS = 15_000;
const INSTALL_VERIFY_TIMEOUT_MS = 90_000;
const INSTALL_VERIFY_INTERVAL_MS = 2_000;
const INSTALL_REPLY_VERIFY_TIMEOUT_MS = 10_000;
const INSTALL_RETRY_DELAY_MS = 3_000;
const DO_UPDATE_TIMEOUT_MS = 120_000;

const CONFIRM_INSTALL_ROUTE = "utilities/confirm_plugin_install";
const INSTALL_PROMPT_EVENT = "loader/add_multiple_plugins_install_prompt";
const DOWNLOAD_FINISH_EVENT = "loader/plugin_download_finish";
const UPDATER_FINISH_EVENT = "updater/finish_download";

/**
 * Create an AbortSignal that aborts after `ms` milliseconds.
 * Falls back to manual AbortController + setTimeout when
 * timeoutSignal() is not available (older CEF/Chromium).
 */
function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

// Self-exclusion: never update ourselves
const SELF_PLUGIN_NAME = "AutoUpdate";

// ── Transport ───────────────────────────────────────────────

type RouterListener = (...args: unknown[]) => unknown;

interface DeckyBackendRouter {
  call<T = unknown>(route: string, ...args: unknown[]): Promise<T>;
  addEventListener?(event: string, listener: RouterListener): unknown;
  removeEventListener?(event: string, listener: RouterListener): void;
}

declare global {
  // eslint-disable-next-line no-var
  var DeckyBackend: DeckyBackendRouter | undefined;
}

/**
 * Call a method on this plugin's Python backend. No retry: the shared router
 * already replays in-flight calls after a reconnect.
 */
export function callPluginMethod<T = unknown>(method: string, timeoutMs?: number): Promise<T>;
export function callPluginMethod<T = unknown>(method: string, args: unknown[], timeoutMs?: number): Promise<T>;
export function callPluginMethod<T = unknown>(
  method: string,
  argsOrTimeout?: unknown[] | number,
  maybeTimeout?: number,
): Promise<T> {
  const args = Array.isArray(argsOrTimeout) ? argsOrTimeout : [];
  const timeoutMs = (Array.isArray(argsOrTimeout) ? maybeTimeout : argsOrTimeout) ?? DEFAULT_CALL_TIMEOUT_MS;
  trace(`callPluginMethod: ${method} (timeout=${timeoutMs}ms)`);
  return withTimeout(new Promise<T>((resolve) => resolve(call<unknown[], T>(method, ...args))), timeoutMs, method);
}

function sharedRouter(): DeckyBackendRouter | null {
  const backend = globalThis.DeckyBackend;
  return backend && typeof backend.call === "function" ? backend : null;
}

function deckyBackend(): DeckyBackendRouter {
  const backend = sharedRouter();
  if (!backend) {
    throw new Error("Decky Loader's frontend router (window.DeckyBackend) is not available");
  }
  return backend;
}

function callLoaderRoute<T = unknown>(route: string, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<T> {
  trace(`callLoaderRoute: ${route} (timeout=${timeoutMs}ms)`);
  return withTimeout(new Promise<T>((resolve) => resolve(deckyBackend().call<T>(route))), timeoutMs, route);
}

// ── Types ───────────────────────────────────────────────────

export interface InstalledPlugin {
  name: string;
  version: string;
  disabled: boolean;
}

export interface StorePluginVersion {
  name: string; // version string e.g. "1.2.3"
  hash: string;
  artifact: string | null;
}

export interface StorePlugin {
  name: string;
  versions: StorePluginVersion[];
}

export interface PluginInstallRequest {
  name: string;
  artifact: string;
  version: string;
  hash: string;
  install_type: number; // 2 = UPDATE
}

// ── Version comparison ──────────────────────────────────────

/**
 * Compare two semver-like version strings. Returns:
 *   -1 if a < b, 0 if equal, 1 if a > b
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((s) => parseInt(s, 10) || 0);
  const pb = b.split(".").map((s) => parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);

  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

const stripV = (v: string) => v.trim().replace(/^v/i, "");

function isVersionString(v: unknown): v is string {
  return typeof v === "string" && /^v?\d/i.test(v.trim());
}

const preReleaseRank = (v: string): number => {
  const m = /-pre(\d+)$/i.exec(v);
  return m ? parseInt(m[1], 10) : Infinity;
};

function isNewerLoaderTag(current: string, remote: string): boolean {
  const c = stripV(current);
  const r = stripV(remote);
  const cmp = compareVersions(c, r);
  return cmp < 0 || (cmp === 0 && preReleaseRank(c) < preReleaseRank(r));
}

// ── Core API ────────────────────────────────────────────────

/**
 * Check if Decky Loader is reachable on localhost.
 */
export async function isDeckyAvailable(): Promise<boolean> {
  try {
    debug("isDeckyAvailable: fetching auth token...");
    const resp = await fetch(`${DECKY_HOST}/auth/token`, {
      signal: timeoutSignal(3000),
    });
    debug("isDeckyAvailable:", resp.ok ? "available" : `HTTP ${resp.status}`);
    return resp.ok;
  } catch (e) {
    logWarn("Decky availability check failed:", errorMessage(e));
    return false;
  }
}

/**
 * Fetch the CSRF auth token from Decky Loader.
 */
export async function getAuthToken(): Promise<string> {
  const resp = await fetch(`${DECKY_HOST}/auth/token`, {
    signal: timeoutSignal(5000),
  });
  if (!resp.ok) throw new Error(`Auth token request failed: ${resp.status}`);
  return resp.text();
}

async function queryInstalledPlugins(timeoutMs?: number): Promise<InstalledPlugin[]> {
  const plugins = await callLoaderRoute<InstalledPlugin[]>("loader/get_plugins", timeoutMs);
  if (!Array.isArray(plugins)) {
    throw new Error(`loader/get_plugins returned ${plugins === null ? "null" : typeof plugins}, expected a list`);
  }
  debug("getInstalledPlugins: received", plugins.length, "plugins");
  if (plugins.length > 0) {
    const sample = plugins[0];
    if (typeof sample?.name !== "string" || typeof sample?.version !== "string") {
      logWarn("getInstalledPlugins: unexpected plugin shape - keys:", Object.keys(sample ?? {}).join(", "));
    }
  }
  return plugins;
}

/**
 * Get list of installed Decky plugins. Returns [] on failure.
 */
export async function getInstalledPlugins(): Promise<InstalledPlugin[]> {
  try {
    return await queryInstalledPlugins();
  } catch (e) {
    logError("Failed to get installed plugins:", e);
    return [];
  }
}

/**
 * Fetch available plugins from the Decky store.
 */
export async function getStorePlugins(): Promise<StorePlugin[]> {
  try {
    if (!isOnline()) {
      logWarn("getStorePlugins: device appears offline, skipping store fetch");
      throw new Error("Device is offline");
    }
    debug("getStorePlugins: fetching from", STORE_URL);
    const resp = await fetch(STORE_URL, {
      signal: timeoutSignal(15_000),
    });
    debug("getStorePlugins: HTTP", resp.status, resp.statusText);
    if (!resp.ok) throw new Error(`Store request failed: ${resp.status}`);
    const data = await resp.json();
    if (!Array.isArray(data)) {
      logWarn("getStorePlugins: response is not an array, type:", typeof data);
      return [];
    }
    debug("getStorePlugins:", data.length, "plugins in store");
    return data;
  } catch (e) {
    logError("Failed to fetch store plugins:", e);
    throw e;
  }
}

/**
 * Build the artifact download URL for a store plugin version.
 */
export function getArtifactUrl(version: StorePluginVersion): string {
  if (version.artifact) return version.artifact;
  return `https://cdn.tzatzikiweeb.moe/file/steam-deck-homebrew/versions/${version.hash}.zip`;
}

/**
 * Find plugins that have updates available.
 * Excludes ourselves (AutoUpdate) and any blacklisted plugins.
 */
export async function findPluginUpdates(blacklist: string[]): Promise<{
  updates: PluginInstallRequest[];
  details: { name: string; currentVersion: string; newVersion: string }[];
}> {
  debug("findPluginUpdates: fetching installed plugins and store catalog...");
  const [installed, store] = await Promise.all([queryInstalledPlugins(), getStorePlugins()]);
  debug(`findPluginUpdates: ${installed.length} installed, ${store.length} in store`);

  const storeMap = new Map<string, StorePlugin>();
  for (const p of store) {
    storeMap.set(p.name, p);
  }

  const blacklistSet = new Set(blacklist.map((s) => s.toLowerCase()));
  const updates: PluginInstallRequest[] = [];
  const details: { name: string; currentVersion: string; newVersion: string }[] = [];

  for (const plugin of installed) {
    if (plugin.name === SELF_PLUGIN_NAME) continue;
    if (blacklistSet.has(plugin.name.toLowerCase())) continue;
    if (plugin.disabled) continue;

    const storeEntry = storeMap.get(plugin.name);
    if (!storeEntry || storeEntry.versions.length === 0) continue;

    try {
      const latest = storeEntry.versions[0];
      const cmp = compareVersions(plugin.version, latest.name);
      debug(`findPluginUpdates: ${plugin.name} installed=${plugin.version} store=${latest.name} cmp=${cmp}`);
      if (cmp < 0) {
        updates.push({
          name: plugin.name,
          artifact: getArtifactUrl(latest),
          version: latest.name,
          hash: latest.hash,
          install_type: 2, // UPDATE
        });
        details.push({
          name: plugin.name,
          currentVersion: plugin.version,
          newVersion: latest.name,
        });
      }
    } catch (e) {
      logWarn(`findPluginUpdates: version comparison failed for ${plugin.name}:`, errorMessage(e));
    }
  }

  log(
    `findPluginUpdates: ${installed.length} installed, ${store.length} in store, ${updates.length} update(s) found` +
      (blacklist.length > 0 ? ` (blacklist: ${blacklist.join(", ")})` : ""),
  );
  if (updates.length > 0) {
    log("findPluginUpdates:", details.map((d) => `${d.name} ${d.currentVersion}->${d.newVersion}`).join(", "));
  }

  return { updates, details };
}

// ── Decky Loader updater ───────────────────────────────────

interface DeckyVersionInfo {
  current?: unknown;
  remote?: { tag_name?: unknown } | null;
}

let deckyVersion: Promise<string> | null = null;

async function lookupDeckyVersion(): Promise<string> {
  try {
    const v = await callPluginMethod<unknown>("get_decky_version", 5_000);
    if (isVersionString(v)) return v.trim();
  } catch {
    /* fall through to Decky's own version info */
  }
  const info = await callLoaderRoute<DeckyVersionInfo | null>("updater/get_version_info", 10_000);
  const current = info?.current;
  if (isVersionString(current)) return current.trim();
  throw new Error("Decky Loader version is unavailable");
}

/**
 * Get the current Decky Loader version, cached after the first successful lookup.
 *
 * Prefers our own backend (reads `/home/deck/homebrew/services/.loader.version`),
 * then Decky's `updater/get_version_info`.
 */
export function getDeckyVersion(): Promise<string> {
  if (!deckyVersion) {
    const lookup = lookupDeckyVersion();
    deckyVersion = lookup;
    lookup.catch(() => {
      if (deckyVersion === lookup) deckyVersion = null;
    });
  }
  return deckyVersion;
}

/**
 * Check if a Decky Loader update is available. Throws when the check fails.
 */
export async function checkDeckyLoaderUpdate(): Promise<{
  hasUpdate: boolean;
  currentVersion: string;
  remoteVersion: string;
}> {
  debug("checkDeckyLoaderUpdate: checking for updates...");
  let info: DeckyVersionInfo | null;
  try {
    info = await callLoaderRoute<DeckyVersionInfo | null>("updater/check_for_updates");
  } catch (e) {
    logWarn("Decky Loader update check failed:", errorMessage(e));
    throw e;
  }

  const currentVersion = info?.current;
  if (typeof currentVersion !== "string" || currentVersion === "") {
    throw new Error("updater/check_for_updates returned an unexpected reply");
  }
  const tag = info?.remote?.tag_name;
  const remoteVersion = typeof tag === "string" ? tag : "";
  const hasUpdate =
    remoteVersion !== "" && isVersionString(currentVersion) && isNewerLoaderTag(currentVersion, remoteVersion);
  debug("checkDeckyLoaderUpdate: current =", currentVersion, "remote =", remoteVersion, "hasUpdate =", hasUpdate);
  return { hasUpdate, currentVersion, remoteVersion };
}

// ── Private sockets ─────────────────────────────────────────

const MSG_ERROR = -1;
const MSG_CALL = 0;
const MSG_REPLY = 1;
const MSG_RECEIVED_RESPONSE = 3;
const MSG_EVENT = 5;

interface WsMessage {
  type?: number;
  id?: number;
  event?: unknown;
  args?: unknown;
  result?: unknown;
  error?: { name?: string; error?: string; message?: string } | null;
  [key: string]: unknown;
}

// Starts far above the small ids Decky's own router uses, so a reply routed to
// our socket for one of its calls is never mistaken for ours.
let nextId = 1_000_000_000 + Math.floor(Math.random() * 1_000_000_000);

async function openPrivateSocket(): Promise<WebSocket> {
  const token = await getAuthToken();
  return new WebSocket(`${DECKY_WS}?auth=${token}`);
}

function parseMessage(data: unknown): WsMessage | null {
  try {
    const msg = JSON.parse(String(data));
    return msg && typeof msg === "object" ? (msg as WsMessage) : null;
  } catch {
    return null;
  }
}

// Older loaders sent events as type 3; on current ones type 3 is RECEIVED_RESPONSE and carries no event.
function isEventMessage(msg: WsMessage): boolean {
  return msg.type === MSG_EVENT || typeof msg.event === "string";
}

function isReplyOrError(msg: WsMessage): boolean {
  return msg.type === MSG_REPLY || msg.type === MSG_ERROR;
}

function wireError(msg: WsMessage, route: string): Error {
  return new Error(msg.error?.error || msg.error?.message || `Decky error on ${route}`);
}

function sendJson(ws: WebSocket, msg: object) {
  ws.send(JSON.stringify(msg));
}

/**
 * Apply a Decky Loader update. Resolves on the do_update reply or on Decky's
 * `updater/finish_download` event, which reaches the private socket or, once
 * DeckyBackend has reconnected and taken the connection back, the shared router.
 * A close alone proves nothing: DeckyBackend's reconnect closes the private socket.
 */
export async function applyDeckyLoaderUpdate(): Promise<void> {
  log("Applying Decky Loader update");
  const ws = await openPrivateSocket();
  const id = nextId++;
  const router = sharedRouter();

  return new Promise<void>((resolve, reject) => {
    let sent = false;
    let settled = false;
    let closed = false;
    const timer = setTimeout(
      () => finish(new Error(`Decky Loader update not confirmed within ${DO_UPDATE_TIMEOUT_MS / 1000}s`)),
      DO_UPDATE_TIMEOUT_MS,
    );
    const onFinishDownload = () => {
      if (settled) return;
      log("Decky Loader update downloaded; the loader restarts itself");
      finish();
    };
    router?.addEventListener?.(UPDATER_FINISH_EVENT, onFinishDownload);

    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      router?.removeEventListener?.(UPDATER_FINISH_EVENT, onFinishDownload);
      ws.close();
      if (error) reject(error);
      else resolve();
    }

    function onClosed() {
      if (settled || closed) return;
      closed = true;
      if (!sent) {
        finish(new Error("Decky closed the connection before the update request was sent"));
        return;
      }
      log("Decky closed the update connection; waiting for Decky Loader to confirm the update");
    }

    ws.onopen = () => {
      sendJson(ws, { type: MSG_CALL, route: "updater/do_update", args: [], id });
      sent = true;
    };

    ws.onmessage = (event) => {
      const msg = parseMessage(event.data);
      if (!msg || settled) return;
      if (isEventMessage(msg)) {
        if (msg.event === UPDATER_FINISH_EVENT) onFinishDownload();
        return;
      }
      if (msg.id !== id || !isReplyOrError(msg)) return;
      sendJson(ws, { type: MSG_RECEIVED_RESPONSE, id });
      if (msg.type === MSG_ERROR) {
        finish(wireError(msg, "updater/do_update"));
      } else {
        log("Decky Loader update applied; the loader restarts itself");
        finish();
      }
    };

    ws.onerror = onClosed;
    ws.onclose = onClosed;
  });
}

class InstallClosedBeforePromptError extends Error {}

/**
 * Install plugin updates and auto-confirm the prompt.
 *
 * Decky's install flow:
 * 1. Call utilities/install_plugins on a private socket → Decky emits the
 *    install prompt event there instead of to its own modal
 * 2. Take the request_id from the prompt event and close the private socket
 * 3. Call utilities/confirm_plugin_install through DeckyBackend, so the
 *    install's unload/import events reach Decky's own frontend
 * 4. Decky downloads and installs, then replies to the confirm call. Without a
 *    reply in time, the installed versions decide.
 *
 * Without DeckyBackend the confirm goes over the private socket instead.
 * The install request is re-sent at most once, and only when the socket
 * closed before any prompt arrived.
 */
export async function installPluginsAndConfirm(requests: PluginInstallRequest[]): Promise<void> {
  if (requests.length === 0) return;
  try {
    await installPluginsAndConfirmOnce(requests);
  } catch (e) {
    if (!(e instanceof InstallClosedBeforePromptError)) throw e;
    log(`Install connection closed before the prompt arrived; retrying once in ${INSTALL_RETRY_DELAY_MS / 1000}s`);
    await new Promise((r) => setTimeout(r, INSTALL_RETRY_DELAY_MS));
    await installPluginsAndConfirmOnce(requests);
  }
}

/**
 * Pull the install `request_id` out of Decky's prompt event payload.
 *
 * Decky has changed the shape across versions. We try, in order:
 *   1. msg.args[0].request_id     (older builds)
 *   2. msg.args.request_id        (newer builds where args is an object)
 *   3. msg.data.request_id        (alternate envelope)
 *   4. msg.params[0].request_id   (some forks)
 *   5. msg.args[0]                (if args[0] is a string/number request_id directly)
 *
 * Returns the request_id (string or number), or null if none of the shapes match.
 */
function extractRequestId(msg: Record<string, unknown>): string | number | null {
  const tryGet = (v: unknown): string | number | null => {
    if (v == null) return null;
    if (typeof v === "string" || typeof v === "number") return v;
    if (typeof v === "object") {
      const r = (v as Record<string, unknown>).request_id;
      if (typeof r === "string" || typeof r === "number") return r;
    }
    return null;
  };

  const args = msg.args as unknown;
  if (Array.isArray(args)) {
    const fromArgs0 = tryGet(args[0]);
    if (fromArgs0 != null) return fromArgs0;
  }
  const fromArgsObj = tryGet(args);
  if (fromArgsObj != null) return fromArgsObj;

  const fromData = tryGet(msg.data);
  if (fromData != null) return fromData;

  const params = msg.params as unknown;
  if (Array.isArray(params)) {
    const fromParams0 = tryGet(params[0]);
    if (fromParams0 != null) return fromParams0;
  }

  return null;
}

/**
 * True unless the prompt lists plugins that are not exactly the ones we asked
 * for, i.e. it belongs to another install request (e.g. one started from the store).
 */
function promptMatchesRequest(msg: WsMessage, names: string[]): boolean {
  const listed = Array.isArray(msg.args) ? msg.args[1] : undefined;
  if (!Array.isArray(listed)) return true;
  const promptNames = listed.map((r) => (r && typeof r === "object" ? (r as { name?: unknown }).name : undefined));
  if (!promptNames.every((n) => typeof n === "string")) return true;
  return promptNames.length === names.length && names.every((n) => promptNames.includes(n));
}

function isInstalledAtLeast(installed: InstalledPlugin[], requests: PluginInstallRequest[]): boolean {
  return requests.every((r) => {
    const p = installed.find((i) => i.name === r.name);
    return !!p && typeof p.version === "string" && compareVersions(stripV(p.version), stripV(r.version)) >= 0;
  });
}

async function waitForPluginsInstalled(
  requests: PluginInstallRequest[],
  stopped: () => boolean,
  timeoutMs = INSTALL_VERIFY_TIMEOUT_MS,
): Promise<PluginInstallRequest[]> {
  const deadline = Date.now() + timeoutMs;
  let missing = requests;
  while (!stopped() && Date.now() < deadline) {
    try {
      const installed = await queryInstalledPlugins(Math.min(DEFAULT_CALL_TIMEOUT_MS, deadline - Date.now()));
      missing = requests.filter((r) => !isInstalledAtLeast(installed, [r]));
      if (missing.length === 0) return missing;
    } catch (e) {
      debug("installPluginsAndConfirm: installed-plugins check failed:", errorMessage(e));
    }
    await new Promise((r) => setTimeout(r, INSTALL_VERIFY_INTERVAL_MS));
  }
  return missing;
}

async function installPluginsAndConfirmOnce(requests: PluginInstallRequest[]): Promise<void> {
  debug("installPluginsAndConfirm: getting auth token...");
  const ws = await openPrivateSocket();
  const names = requests.map((r) => r.name);
  const installId = nextId++;

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let handedOff = false;
    let promptSeen = false;
    let confirmId: number | null = null;
    const seenRequestIds = new Set<string | number>();
    const downloaded = new Set<string>();
    let timer = setTimeout(onPromptTimeout, INSTALL_PROMPT_TIMEOUT_MS);

    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (error) reject(error);
      else resolve();
    }

    function onPromptTimeout() {
      for (const requestId of seenRequestIds) {
        logWarn(`Cancelling unconfirmed install request ${requestId}`);
        try {
          sendJson(ws, { type: MSG_CALL, route: "utilities/cancel_plugin_install", args: [requestId], id: nextId++ });
        } catch (e) {
          logWarn(`Could not cancel install request ${requestId}:`, errorMessage(e));
        }
      }
      finish(new Error(`Install timed out waiting for Decky's install prompt (${names.join(", ")})`));
    }

    function endWithoutConfirmReply(reason: string) {
      if (names.every((n) => downloaded.has(n))) {
        log(`Install of ${names.join(", ")} finished downloading; ${reason} before Decky's confirm reply`);
        finish();
      } else {
        finish(new Error(`Install of ${names.join(", ")}: ${reason} before Decky confirmed it; it may still complete`));
      }
    }

    function confirmThroughRouter(router: DeckyBackendRouter, requestId: string | number) {
      handedOff = true;
      clearTimeout(timer);
      ws.close();
      const timeoutMs = SHARED_CONFIRM_BASE_TIMEOUT_MS + SHARED_CONFIRM_PER_PLUGIN_MS * requests.length;
      let replied = false;
      const reply = new Promise<unknown>((r) => r(router.call(CONFIRM_INSTALL_ROUTE, requestId))).finally(() => {
        replied = true;
      });
      log(`Auto-confirmed install request ${requestId} for ${names.join(", ")}`);
      const onConfirmed = () => {
        if (settled) return;
        void verifyAfterReply();
      };
      withTimeout(reply, timeoutMs, CONFIRM_INSTALL_ROUTE).then(onConfirmed, (e) => {
        if (replied) {
          debug(`installPluginsAndConfirm: ${CONFIRM_INSTALL_ROUTE} failed:`, errorMessage(e));
          finish(e instanceof Error ? e : new Error(errorMessage(e)));
          return;
        }
        reply.then(onConfirmed, () => {});
        void verifyInstalled(`confirmation timed out after ${timeoutMs / 1000}s`);
      });
    }

    async function verifyAfterReply() {
      const missing = await waitForPluginsInstalled(requests, () => settled, INSTALL_REPLY_VERIFY_TIMEOUT_MS);
      if (settled) return;
      if (missing.length === 0) {
        log(`Decky finished installing ${names.join(", ")}`);
        finish();
      } else {
        finish(
          new Error(
            `Decky replied to the install of ${names.join(", ")}, but ${missing.map((r) => `${r.name} ${r.version}`).join(", ")} is not installed`,
          ),
        );
      }
    }

    async function verifyInstalled(reason: string) {
      logWarn(`Install of ${names.join(", ")}: ${reason}; checking the installed versions`);
      if ((await waitForPluginsInstalled(requests, () => settled)).length === 0) {
        log(`Install of ${names.join(", ")} confirmed by the installed versions`);
        finish();
      } else {
        finish(new Error(`Install of ${names.join(", ")}: ${reason} before Decky confirmed it; it may still complete`));
      }
    }

    function confirmOnSocket(requestId: string | number) {
      confirmId = nextId++;
      sendJson(ws, { type: MSG_CALL, route: CONFIRM_INSTALL_ROUTE, args: [requestId], id: confirmId });
      seenRequestIds.delete(requestId);
      clearTimeout(timer);
      timer = setTimeout(
        () => endWithoutConfirmReply(`confirmation timed out after ${INSTALL_CONFIRM_TIMEOUT_MS / 1000}s`),
        INSTALL_CONFIRM_TIMEOUT_MS,
      );
      log(`Auto-confirmed install request ${requestId} for ${names.join(", ")}`);
    }

    function onEvent(msg: WsMessage) {
      const args = Array.isArray(msg.args) ? msg.args : [];
      trace("installPluginsAndConfirm: event", msg.event);
      if (msg.event === DOWNLOAD_FINISH_EVENT) {
        if (typeof args[0] === "string") downloaded.add(args[0]);
        return;
      }
      if (msg.event !== INSTALL_PROMPT_EVENT) return;
      promptSeen = true;
      if (!promptMatchesRequest(msg, names)) {
        logWarn("Ignoring an install prompt for another request:", JSON.stringify(args[1]));
        return;
      }
      const requestId = extractRequestId(msg);
      if (requestId == null) {
        logWarn(
          `Install prompt arrived but request_id could not be extracted. Payload:`,
          JSON.stringify({ args: msg.args, data: msg.data, params: msg.params }),
        );
        return;
      }
      if (confirmId !== null) {
        logWarn(`Ignoring a second install prompt (${requestId}) after confirming`);
        return;
      }
      const router = sharedRouter();
      if (router) confirmThroughRouter(router, requestId);
      else confirmOnSocket(requestId);
    }

    function onClosed() {
      if (settled || handedOff) return;
      if (confirmId !== null) {
        endWithoutConfirmReply("Decky closed the connection");
      } else if (promptSeen) {
        finish(new Error("Decky closed the install connection before the prompt could be confirmed"));
      } else {
        finish(new InstallClosedBeforePromptError("Decky closed the install connection before the prompt arrived"));
      }
    }

    ws.onopen = () => {
      sendJson(ws, { type: MSG_CALL, route: "utilities/install_plugins", args: [requests], id: installId });
      log(`Sending install request for ${requests.length} plugin(s)`);
      debug("installPluginsAndConfirm: plugins:", requests.map((r) => `${r.name}@${r.version}`).join(", "));
    };

    ws.onmessage = (event) => {
      const msg = parseMessage(event.data);
      if (!msg || settled || handedOff) return;
      if (isEventMessage(msg)) {
        onEvent(msg);
        return;
      }
      if (!isReplyOrError(msg) || (msg.id !== installId && msg.id !== confirmId)) return;

      sendJson(ws, { type: MSG_RECEIVED_RESPONSE, id: msg.id });
      const route = msg.id === installId ? "utilities/install_plugins" : CONFIRM_INSTALL_ROUTE;
      if (msg.type === MSG_ERROR) {
        debug(`installPluginsAndConfirm: ${route} failed:`, msg.error);
        finish(wireError(msg, route));
      } else if (msg.id === confirmId) {
        log(`Decky finished installing ${names.join(", ")}`);
        finish();
      } else if (confirmId === null && (typeof msg.result === "string" || typeof msg.result === "number")) {
        seenRequestIds.add(msg.result);
      }
    };

    ws.onerror = onClosed;
    ws.onclose = onClosed;
  });
}
