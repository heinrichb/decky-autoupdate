/**
 * Abstraction layer over Decky Loader's internal WebSocket API.
 *
 * Decky Loader runs an aiohttp server on 127.0.0.1:1337 with a JSON-based
 * WebSocket protocol. All plugin management (listing, installing, updating)
 * goes through this WebSocket, not REST endpoints.
 *
 * Protocol:
 *   CALL(0):  {type: 0, route: "...", args: [...], id: N}  → client sends
 *   REPLY(1): {type: 1, result: ..., id: N}                → server replies
 *   ERROR(-1):{type: -1, error: {name, message}, id: N}    → server error
 *   EVENT(3): {type: 3, event: "...", args: [...]}          → server push
 *
 * All Decky Loader interaction is isolated in this file so that API changes
 * only require updating this module.
 */

import { log, logWarn, logError, debug, errorMessage } from "./helpers";

const DECKY_HOST = "http://127.0.0.1:1337";
const DECKY_WS = "ws://127.0.0.1:1337/ws";
const STORE_URL = "https://plugins.deckbrew.xyz/plugins";

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

// ── Plugin backend calls ───────────────────────────────────
//
// The @decky/api `call`/`callable` mechanism captures an IPC connection
// at module load time that frequently goes stale (especially in Big Picture
// mode). Instead, we route plugin method calls through the Decky Loader
// WebSocket API using the "loader/call_plugin_method" route, which opens
// a fresh connection each time and is reliable.

/**
 * Call a method on this plugin's Python backend via Decky's WS API.
 * This bypasses @decky/api's built-in call/callable which are unreliable.
 *
 * Calls are serialized — only one WS call is in flight at a time. Decky
 * Loader closes WebSocket connections when concurrent plugin method calls
 * arrive, so we queue them.
 */

let _pluginMethodQueue: Promise<unknown> = Promise.resolve();

export function callPluginMethod<T = unknown>(method: string, timeoutMs?: number): Promise<T>;
export function callPluginMethod<T = unknown>(method: string, args: unknown[], timeoutMs?: number): Promise<T>;
export function callPluginMethod<T = unknown>(method: string, argsOrTimeout?: unknown[] | number, maybeTimeout?: number): Promise<T> {
  let wsArgs: unknown[];
  let timeoutMs: number;

  if (Array.isArray(argsOrTimeout)) {
    wsArgs = [SELF_PLUGIN_NAME, method, ...argsOrTimeout];
    timeoutMs = maybeTimeout ?? 30_000;
  } else {
    wsArgs = [SELF_PLUGIN_NAME, method];
    timeoutMs = argsOrTimeout ?? 30_000;
  }

  // Serialize: wait for any previous call to finish before starting ours
  const result = _pluginMethodQueue.then(
    () => callDeckyMethod<T>("loader/call_plugin_method", wsArgs, timeoutMs),
    () => callDeckyMethod<T>("loader/call_plugin_method", wsArgs, timeoutMs),
  );

  // Update the queue to track this call (swallow rejections so the queue continues)
  _pluginMethodQueue = result.catch(() => {});

  return result;
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

// WS message types
const MSG_CALL = 0;
const MSG_REPLY = 1;
const MSG_ERROR = -1;
const MSG_EVENT = 3;

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

// ── Core API ────────────────────────────────────────────────

let nextId = 1;

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

/**
 * Open a WebSocket to Decky Loader, call a route, and return the result.
 * Opens a fresh connection per call for simplicity.
 */
function callDeckyMethod<T = unknown>(route: string, args: unknown[] = [], timeoutMs = 30_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const callId = nextId++;
    let ws: WebSocket | null = null;
    let settled = false;

    debug(`callDeckyMethod: ${route} (id=${callId}, timeout=${timeoutMs}ms)`);
    const t0 = Date.now();

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws?.close();
        reject(new Error(`Decky WS call timed out: ${route}`));
      }
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      ws?.close();
    };

    getAuthToken()
      .then((token) => {
        if (settled) return;
        debug(`callDeckyMethod: ${route} — got auth token, opening WS...`);

        ws = new WebSocket(`${DECKY_WS}?auth=${token}`);

        ws.onopen = () => {
          debug(`callDeckyMethod: ${route} — WS open, sending call`);
          ws!.send(JSON.stringify({ type: MSG_CALL, route, args, id: callId }));
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.id !== callId) {
              debug(`callDeckyMethod: ${route} — ignoring msg with id=${msg.id} (expected ${callId})`);
              return;
            }

            if (msg.type === MSG_REPLY) {
              settled = true;
              cleanup();
              debug(`callDeckyMethod: ${route} — reply received in ${Date.now() - t0}ms`);
              resolve(msg.result as T);
            } else if (msg.type === MSG_ERROR) {
              settled = true;
              cleanup();
              debug(`callDeckyMethod: ${route} — error response:`, msg.error);
              reject(new Error(msg.error?.message || `Decky error on ${route}`));
            }
          } catch {
            // ignore malformed messages
          }
        };

        ws.onerror = () => {
          if (!settled) {
            settled = true;
            cleanup();
            debug(`callDeckyMethod: ${route} — WebSocket error`);
            reject(new Error(`WebSocket error calling ${route}`));
          }
        };

        ws.onclose = () => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            debug(`callDeckyMethod: ${route} — WebSocket closed unexpectedly`);
            reject(new Error(`WebSocket closed before reply for ${route}`));
          }
        };
      })
      .catch((e) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          debug(`callDeckyMethod: ${route} — auth token error:`, errorMessage(e));
          reject(e);
        }
      });
  });
}

/**
 * Get list of installed Decky plugins.
 */
export async function getInstalledPlugins(): Promise<InstalledPlugin[]> {
  try {
    const result = await callDeckyMethod<InstalledPlugin[]>("loader/get_plugins");
    return result || [];
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
    const resp = await fetch(STORE_URL, {
      signal: timeoutSignal(15_000),
    });
    if (!resp.ok) throw new Error(`Store request failed: ${resp.status}`);
    return resp.json();
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
  const [installed, store] = await Promise.all([getInstalledPlugins(), getStorePlugins()]);
  debug(`findPluginUpdates: ${installed.length} installed, ${store.length} in store`);

  const storeMap = new Map<string, StorePlugin>();
  for (const p of store) {
    storeMap.set(p.name, p);
  }

  const blacklistSet = new Set(blacklist.map((s) => s.toLowerCase()));
  const updates: PluginInstallRequest[] = [];
  const details: { name: string; currentVersion: string; newVersion: string }[] = [];

  for (const plugin of installed) {
    // Skip ourselves
    if (plugin.name === SELF_PLUGIN_NAME) continue;

    // Skip blacklisted
    if (blacklistSet.has(plugin.name.toLowerCase())) continue;

    // Skip disabled plugins
    if (plugin.disabled) continue;

    const storeEntry = storeMap.get(plugin.name);
    if (!storeEntry || storeEntry.versions.length === 0) continue;

    const latest = storeEntry.versions[0];
    if (compareVersions(plugin.version, latest.name) < 0) {
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
  }

  return { updates, details };
}

// ── Decky Loader updater ───────────────────────────────────

/**
 * Get the current Decky Loader version.
 */
export async function getDeckyVersion(): Promise<string> {
  return callDeckyMethod<string>("updater/get_version");
}

/**
 * Check if a Decky Loader update is available.
 */
export async function checkDeckyLoaderUpdate(): Promise<{
  hasUpdate: boolean;
  currentVersion: string;
  remoteVersion: string;
}> {
  try {
    debug("checkDeckyLoaderUpdate: fetching version and checking for updates...");
    const [currentVersion, result] = await Promise.all([
      getDeckyVersion(),
      callDeckyMethod<{ hasUpdate: boolean; remoteVer?: string }>("updater/check_for_updates", [], 30_000),
    ]);
    // The API may return a boolean or an object — handle both
    const hasUpdate = typeof result === "boolean" ? result : (result?.hasUpdate ?? false);
    const remoteVersion = typeof result === "object" ? (result?.remoteVer ?? "") : "";
    debug("checkDeckyLoaderUpdate: current =", currentVersion, "hasUpdate =", hasUpdate, "remote =", remoteVersion);
    return { hasUpdate, currentVersion, remoteVersion };
  } catch (e) {
    logWarn("Decky Loader update check failed:", errorMessage(e));
    return { hasUpdate: false, currentVersion: "", remoteVersion: "" };
  }
}

/**
 * Apply a Decky Loader update. Decky restarts itself after updating.
 */
export async function applyDeckyLoaderUpdate(): Promise<void> {
  log("Applying Decky Loader update");
  await callDeckyMethod<void>("updater/do_update", [], 120_000);
}

/**
 * Install plugin updates and auto-confirm the prompt.
 *
 * Decky's install flow:
 * 1. Call utilities/install_plugins → triggers a confirmation prompt event
 * 2. Listen for the prompt event to get the request_id
 * 3. Call utilities/confirm_plugin_install with that request_id
 * 4. Actual installation happens
 */
export async function installPluginsAndConfirm(requests: PluginInstallRequest[]): Promise<void> {
  if (requests.length === 0) return;

  debug("installPluginsAndConfirm: getting auth token...");
  const token = await getAuthToken();
  const callId = nextId++;

  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(`${DECKY_WS}?auth=${token}`);

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.close();
        reject(new Error("Install timed out waiting for confirmation prompt"));
      }
    }, 120_000); // 2 minutes for downloads

    ws.onopen = () => {
      log(`Sending install request for ${requests.length} plugin(s)`);
      debug("installPluginsAndConfirm: plugins:", requests.map((r) => `${r.name}@${r.version}`).join(", "));
      ws.send(
        JSON.stringify({
          type: MSG_CALL,
          route: "utilities/install_plugins",
          args: [requests],
          id: callId,
        }),
      );
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        debug("installPluginsAndConfirm: WS message type:", msg.type, "event:", msg.event, "id:", msg.id);

        // Listen for the confirmation prompt event
        if (msg.type === MSG_EVENT) {
          const eventName = msg.event || "";
          if (
            eventName === "loader/add_multiple_plugins_install_prompt" ||
            eventName === "loader/add_plugin_install_prompt"
          ) {
            const requestId = msg.args?.[0]?.request_id;
            if (requestId != null) {
              log(`Auto-confirming install request ${requestId}`);
              const confirmId = nextId++;
              ws.send(
                JSON.stringify({
                  type: MSG_CALL,
                  route: "utilities/confirm_plugin_install",
                  args: [requestId],
                  id: confirmId,
                }),
              );
              // Resolve after confirm is sent — the actual install happens asynchronously
              settled = true;
              clearTimeout(timeout);
              // Give it a moment for the confirm to be sent before closing
              setTimeout(() => {
                ws.close();
                debug("installPluginsAndConfirm: confirmed and closed WS");
                resolve();
              }, 1000);
            }
          }
        }

        // Handle errors on the initial call
        if (msg.id === callId && msg.type === MSG_ERROR) {
          settled = true;
          clearTimeout(timeout);
          ws.close();
          debug("installPluginsAndConfirm: error from server:", msg.error);
          reject(new Error(msg.error?.message || "Install failed"));
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.onerror = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        ws.close();
        debug("installPluginsAndConfirm: WebSocket error");
        reject(new Error("WebSocket error during install"));
      }
    };

    ws.onclose = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        debug("installPluginsAndConfirm: WebSocket closed unexpectedly");
        reject(new Error("WebSocket closed during install"));
      }
    };
  });
}
