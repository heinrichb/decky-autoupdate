/**
 * Tests for deckyApi.ts against the real module: plugin calls through @decky/api,
 * loader routes through window.DeckyBackend, and the private-socket install and
 * Decky Loader update flows against a fake WebSocket.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockCall = vi.hoisted(() => vi.fn());
vi.mock("@decky/api", () => ({ call: (...args: unknown[]) => mockCall(...args) }));

import type * as DeckyApi from "../deckyApi";
import type { PluginInstallRequest, StorePluginVersion } from "../deckyApi";

interface WireMessage {
  type: number;
  id?: number;
  route?: string;
  args?: unknown[];
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static autoOpen = true;
  url: string;
  sent: WireMessage[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    if (!FakeWebSocket.autoOpen) return;
    setTimeout(() => {
      if (!this.closed) this.onopen?.();
    }, 0);
  }

  send(raw: string) {
    if (this.closed) throw new Error("send on closed socket");
    this.sent.push(JSON.parse(raw));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    setTimeout(() => this.onclose?.(), 0);
  }

  receive(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  serverClose() {
    this.closed = true;
    this.onclose?.();
  }

  calls(route: string): WireMessage[] {
    return this.sent.filter((m) => m.type === 0 && m.route === route);
  }

  acks(): (number | undefined)[] {
    return this.sent.filter((m) => m.type === 3).map((m) => m.id);
  }
}

const REQ_A: PluginInstallRequest = {
  name: "HLTB for Deck",
  artifact: "https://example.com/hltb.zip",
  version: "2.0.10",
  hash: "h1",
  install_type: 2,
};
const REQ_B: PluginInstallRequest = {
  name: "CSS Loader",
  artifact: "https://example.com/css.zip",
  version: "2.1.2",
  hash: "h2",
  install_type: 2,
};
const PROMPT_ID = "1789000000.1";

function prompt(requestId: string, requests: PluginInstallRequest[], type = 5) {
  return { type, event: "loader/add_multiple_plugins_install_prompt", args: [requestId, requests] };
}

let api: typeof DeckyApi;
let backendCall: ReturnType<typeof vi.fn>;
let routerListeners: Map<string, Set<(...args: unknown[]) => unknown>>;
let storePlugins: unknown;

function emitRouterEvent(event: string, ...args: unknown[]) {
  for (const listener of routerListeners.get(event) ?? []) listener(...args);
}

function routeCalls(route: string): unknown[][] {
  return backendCall.mock.calls.filter((c) => c[0] === route);
}

beforeEach(async () => {
  vi.resetModules();
  mockCall.mockReset();
  FakeWebSocket.instances = [];
  FakeWebSocket.autoOpen = true;
  storePlugins = [];
  backendCall = vi.fn();
  routerListeners = new Map();
  vi.stubGlobal("DeckyBackend", {
    call: backendCall,
    addEventListener: (event: string, listener: (...args: unknown[]) => unknown) => {
      if (!routerListeners.has(event)) routerListeners.set(event, new Set());
      routerListeners.get(event)!.add(listener);
      return listener;
    },
    removeEventListener: (event: string, listener: (...args: unknown[]) => unknown) => {
      routerListeners.get(event)?.delete(listener);
    },
  });
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/auth/token")) return { ok: true, status: 200, text: async () => "tok" };
      return { ok: true, status: 200, statusText: "OK", json: async () => storePlugins };
    }),
  );
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
  api = await import("../deckyApi");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function trackSettled(p: Promise<unknown>) {
  const state = { settled: false };
  p.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  return state;
}

describe("compareVersions", () => {
  it("returns 0 for equal versions", () => {
    expect(api.compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("returns -1 when a < b", () => {
    expect(api.compareVersions("1.0.0", "1.0.1")).toBe(-1);
    expect(api.compareVersions("1.0.0", "1.1.0")).toBe(-1);
    expect(api.compareVersions("1.0.0", "2.0.0")).toBe(-1);
  });

  it("returns 1 when a > b", () => {
    expect(api.compareVersions("1.0.1", "1.0.0")).toBe(1);
    expect(api.compareVersions("1.1.0", "1.0.0")).toBe(1);
    expect(api.compareVersions("2.0.0", "1.0.0")).toBe(1);
  });

  it("handles different length versions", () => {
    expect(api.compareVersions("1.0", "1.0.0")).toBe(0);
    expect(api.compareVersions("1.0", "1.0.1")).toBe(-1);
    expect(api.compareVersions("1.0.1", "1.0")).toBe(1);
  });

  it("handles single-segment versions", () => {
    expect(api.compareVersions("1", "2")).toBe(-1);
    expect(api.compareVersions("2", "1")).toBe(1);
    expect(api.compareVersions("1", "1")).toBe(0);
  });

  it("handles non-numeric segments as 0", () => {
    expect(api.compareVersions("1.0.beta", "1.0.0")).toBe(0);
  });
});

describe("getArtifactUrl", () => {
  it("returns artifact URL directly when present", () => {
    const version: StorePluginVersion = { name: "1.0.0", hash: "abc123", artifact: "https://example.com/plugin.zip" };
    expect(api.getArtifactUrl(version)).toBe("https://example.com/plugin.zip");
  });

  it("builds CDN URL from hash when artifact is null", () => {
    const version: StorePluginVersion = { name: "1.0.0", hash: "abc123", artifact: null };
    expect(api.getArtifactUrl(version)).toBe(
      "https://cdn.tzatzikiweeb.moe/file/steam-deck-homebrew/versions/abc123.zip",
    );
  });
});

describe("callPluginMethod", () => {
  it("calls the plugin method through @decky/api with its arguments", async () => {
    mockCall.mockResolvedValue({ ok: true });
    await expect(api.callPluginMethod("save_settings", [{ a: 1 }, 2], 1_000)).resolves.toEqual({ ok: true });
    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(mockCall).toHaveBeenCalledWith("save_settings", { a: 1 }, 2);
  });

  it("accepts a timeout without arguments", async () => {
    mockCall.mockResolvedValue("x");
    await api.callPluginMethod("get_settings", 1_000);
    expect(mockCall).toHaveBeenCalledWith("get_settings");
  });

  it("rejects when the call does not settle within 30 s by default", async () => {
    vi.useFakeTimers();
    mockCall.mockReturnValue(new Promise(() => {}));
    const p = api.callPluginMethod("get_history");
    const state = trackSettled(p);
    const assertion = expect(p).rejects.toThrow(/get_history timed out/);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });

  it("honours a custom timeout", async () => {
    vi.useFakeTimers();
    mockCall.mockReturnValue(new Promise(() => {}));
    const p = api.callPluginMethod("get_app_state_flags_batch", [[1]], 8_000);
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(8_000);
    await assertion;
  });

  it("starts concurrent calls immediately instead of queueing them", () => {
    mockCall.mockReturnValue(new Promise(() => {}));
    void api.callPluginMethod("get_settings", 1_000);
    void api.callPluginMethod("get_history", 1_000);
    void api.callPluginMethod("log_frontend_batch", [[]], 1_000);
    expect(mockCall.mock.calls.map((c) => c[0])).toEqual(["get_settings", "get_history", "log_frontend_batch"]);
  });

  it("does not retry a failed call", async () => {
    mockCall.mockRejectedValue(new Error("boom"));
    await expect(api.callPluginMethod("check_and_apply_flatpak", [true])).rejects.toThrow("boom");
    expect(mockCall).toHaveBeenCalledTimes(1);
  });

  it("turns a synchronous throw from @decky/api into a rejection", async () => {
    mockCall.mockImplementation(() => {
      throw new Error("loader API missing");
    });
    let p: Promise<unknown> | undefined;
    expect(() => (p = api.callPluginMethod("get_settings"))).not.toThrow();
    await expect(p).rejects.toThrow("loader API missing");
  });

  it("never opens a socket or fetches an auth token", async () => {
    mockCall.mockResolvedValue(true);
    await api.callPluginMethod("ping");
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("installed plugins and plugin updates", () => {
  const installed = [
    { name: "AutoUpdate", version: "0.1.0", disabled: false },
    { name: "HLTB for Deck", version: "2.0.9", disabled: false },
    { name: "CSS Loader", version: "2.1.1", disabled: false },
    { name: "PowerTools", version: "1.0.0", disabled: true },
    { name: "Storage Cleaner", version: "1.2.0", disabled: false },
    { name: "Not In Store", version: "1.0.0", disabled: false },
  ];
  const store = [
    { name: "AutoUpdate", versions: [{ name: "9.9.9", hash: "self", artifact: null }] },
    { name: "HLTB for Deck", versions: [{ name: "2.0.10", hash: "hltb", artifact: "https://example.com/hltb.zip" }] },
    { name: "CSS Loader", versions: [{ name: "2.1.2", hash: "css", artifact: null }] },
    { name: "PowerTools", versions: [{ name: "2.0.0", hash: "pt", artifact: null }] },
    { name: "Storage Cleaner", versions: [{ name: "1.2.0", hash: "sc", artifact: null }] },
  ];

  it("getInstalledPlugins asks the loader through DeckyBackend", async () => {
    backendCall.mockResolvedValue(installed);
    await expect(api.getInstalledPlugins()).resolves.toEqual(installed);
    expect(backendCall).toHaveBeenCalledWith("loader/get_plugins");
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("getInstalledPlugins returns [] when the loader call fails", async () => {
    backendCall.mockRejectedValue(new Error("router down"));
    await expect(api.getInstalledPlugins()).resolves.toEqual([]);
  });

  it("getInstalledPlugins returns [] when DeckyBackend is missing", async () => {
    vi.stubGlobal("DeckyBackend", undefined);
    await expect(api.getInstalledPlugins()).resolves.toEqual([]);
  });

  it("findPluginUpdates rejects when the installed-plugins query fails", async () => {
    backendCall.mockRejectedValue(new Error("router down"));
    storePlugins = store;
    await expect(api.findPluginUpdates([])).rejects.toThrow("router down");
  });

  it("findPluginUpdates names DeckyBackend when it is missing", async () => {
    vi.stubGlobal("DeckyBackend", undefined);
    storePlugins = store;
    await expect(api.findPluginUpdates([])).rejects.toThrow(/DeckyBackend/);
  });

  it("findPluginUpdates rejects when the loader times out", async () => {
    vi.useFakeTimers();
    backendCall.mockReturnValue(new Promise(() => {}));
    storePlugins = store;
    const p = api.findPluginUpdates([]);
    const assertion = expect(p).rejects.toThrow(/loader\/get_plugins timed out/);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it("findPluginUpdates skips itself, blacklisted, disabled and current plugins", async () => {
    backendCall.mockResolvedValue(installed);
    storePlugins = store;
    const result = await api.findPluginUpdates(["css loader"]);
    expect(result.details).toEqual([{ name: "HLTB for Deck", currentVersion: "2.0.9", newVersion: "2.0.10" }]);
    expect(result.updates).toEqual([
      {
        name: "HLTB for Deck",
        artifact: "https://example.com/hltb.zip",
        version: "2.0.10",
        hash: "hltb",
        install_type: 2,
      },
    ]);
  });
});

describe("checkDeckyLoaderUpdate", () => {
  it("reports an update from one updater/check_for_updates call", async () => {
    backendCall.mockResolvedValue({ current: "v3.2.9", remote: { tag_name: "v3.2.10" }, all: [], updatable: true });
    await expect(api.checkDeckyLoaderUpdate()).resolves.toEqual({
      hasUpdate: true,
      currentVersion: "v3.2.9",
      remoteVersion: "v3.2.10",
    });
    expect(backendCall).toHaveBeenCalledTimes(1);
    expect(backendCall).toHaveBeenCalledWith("updater/check_for_updates");
    expect(mockCall).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("reports up to date when the remote tag matches", async () => {
    backendCall.mockResolvedValue({ current: "v3.2.9", remote: { tag_name: "v3.2.9" }, all: [], updatable: true });
    await expect(api.checkDeckyLoaderUpdate()).resolves.toEqual({
      hasUpdate: false,
      currentVersion: "v3.2.9",
      remoteVersion: "v3.2.9",
    });
  });

  it("does not report a downgrade as an update", async () => {
    backendCall.mockResolvedValue({ current: "v3.3.0", remote: { tag_name: "v3.2.9" } });
    await expect(api.checkDeckyLoaderUpdate()).resolves.toMatchObject({ hasUpdate: false });
  });

  it.each([
    ["v3.3.0-pre1", "v3.3.0-pre2", true],
    ["v3.3.0-pre9", "v3.3.0-pre10", true],
    ["v3.3.0-pre2", "v3.3.0", true],
    ["v3.3.0", "v3.3.0-pre3", false],
  ])("orders pre-release tags: %s -> %s gives hasUpdate %s", async (current, remote, hasUpdate) => {
    backendCall.mockResolvedValue({ current, remote: { tag_name: remote } });
    await expect(api.checkDeckyLoaderUpdate()).resolves.toEqual({
      hasUpdate,
      currentVersion: current,
      remoteVersion: remote,
    });
  });

  it("reports no update when there is no remote release", async () => {
    backendCall.mockResolvedValue({ current: "v3.2.9", remote: null });
    await expect(api.checkDeckyLoaderUpdate()).resolves.toEqual({
      hasUpdate: false,
      currentVersion: "v3.2.9",
      remoteVersion: "",
    });
  });

  it("reports no update when the installed version is not a version number", async () => {
    backendCall.mockResolvedValue({ current: "unknown", remote: { tag_name: "v3.2.9" }, updatable: false });
    await expect(api.checkDeckyLoaderUpdate()).resolves.toMatchObject({ hasUpdate: false });
  });

  it("throws when the check fails instead of reporting up to date", async () => {
    backendCall.mockRejectedValue(new Error("Temporary failure in name resolution"));
    await expect(api.checkDeckyLoaderUpdate()).rejects.toThrow("Temporary failure in name resolution");
  });

  it("throws on an unexpected reply", async () => {
    backendCall.mockResolvedValue(null);
    await expect(api.checkDeckyLoaderUpdate()).rejects.toThrow(/check_for_updates/);
  });

  it("throws when the check times out", async () => {
    vi.useFakeTimers();
    backendCall.mockReturnValue(new Promise(() => {}));
    const p = api.checkDeckyLoaderUpdate();
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });
});

describe("getDeckyVersion", () => {
  it("prefers the plugin backend and caches the first answer", async () => {
    mockCall.mockResolvedValue("v3.2.9");
    await expect(api.getDeckyVersion()).resolves.toBe("v3.2.9");
    await expect(api.getDeckyVersion()).resolves.toBe("v3.2.9");
    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(mockCall).toHaveBeenCalledWith("get_decky_version");
    expect(backendCall).not.toHaveBeenCalled();
  });

  it("falls back to updater/get_version_info when the backend has no version", async () => {
    mockCall.mockResolvedValue("");
    backendCall.mockResolvedValue({ current: "v3.2.9", remote: null });
    await expect(api.getDeckyVersion()).resolves.toBe("v3.2.9");
    expect(backendCall).toHaveBeenCalledWith("updater/get_version_info");
  });

  it("ignores a backend answer that is not a version", async () => {
    mockCall.mockResolvedValue({ errors: { unknownGames: ["2529100552"] }, games: {} });
    backendCall.mockResolvedValue({ current: "v3.2.9" });
    await expect(api.getDeckyVersion()).resolves.toBe("v3.2.9");
  });

  it("does not cache a failed lookup", async () => {
    mockCall.mockRejectedValueOnce(new Error("ipc down")).mockResolvedValue("v3.2.9");
    backendCall.mockRejectedValueOnce(new Error("router down"));
    await expect(api.getDeckyVersion()).rejects.toThrow();
    await expect(api.getDeckyVersion()).resolves.toBe("v3.2.9");
  });
});

describe("installPluginsAndConfirm", () => {
  let confirmReply: { resolve: (v: unknown) => void; reject: (e: Error) => void };
  let installedNow: { name: string; version: string; disabled: boolean }[] | Error;
  // A confirm reply normally means Decky installed the requested versions; tests turn this off to model the
  // failures Decky still answers with a plain reply (CDN error, hash mismatch).
  let installOnReply: boolean;

  const applyRequestedVersions = () => {
    if (installedNow instanceof Error) return;
    const requested = new Map([REQ_A, REQ_B].map((r) => [r.name, r.version]));
    installedNow = installedNow.map((p) => ({ ...p, version: requested.get(p.name) ?? p.version }));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    installOnReply = true;
    installedNow = [
      { name: REQ_A.name, version: "2.0.9", disabled: false },
      { name: REQ_B.name, version: "2.1.1", disabled: false },
    ];
    backendCall.mockImplementation((route: string) => {
      if (route === "utilities/confirm_plugin_install") {
        return new Promise((resolve, reject) => {
          confirmReply = {
            resolve: (v) => {
              if (installOnReply) applyRequestedVersions();
              resolve(v);
            },
            reject,
          };
        });
      }
      if (route === "loader/get_plugins") {
        return installedNow instanceof Error ? Promise.reject(installedNow) : Promise.resolve(installedNow);
      }
      return Promise.reject(new Error(`unexpected route ${route}`));
    });
  });

  async function startInstall(requests: PluginInstallRequest[] = [REQ_A]) {
    const p = api.installPluginsAndConfirm(requests);
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    return { p, ws, state: trackSettled(p) };
  }

  it("does nothing for an empty request list", async () => {
    await api.installPluginsAndConfirm([]);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("closes the private socket on a type-5 prompt and confirms it through DeckyBackend", async () => {
    const { p, ws, state } = await startInstall();
    expect(ws.url).toBe("ws://127.0.0.1:1337/ws?auth=tok");
    const [install] = ws.calls("utilities/install_plugins");
    expect(install.args).toEqual([[REQ_A]]);

    ws.receive({ type: 1, id: install.id, result: PROMPT_ID });
    ws.receive(prompt(PROMPT_ID, [REQ_A]));
    expect(ws.acks()).toEqual([install.id]);
    expect(ws.closed).toBe(true);
    expect(ws.calls("utilities/confirm_plugin_install")).toHaveLength(0);
    expect(routeCalls("utilities/confirm_plugin_install")).toEqual([["utilities/confirm_plugin_install", PROMPT_ID]]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.settled).toBe(false);

    confirmReply.resolve(null);
    await expect(p).resolves.toBeUndefined();
    expect(routeCalls("loader/get_plugins")).toHaveLength(1);
    expect(ws.calls("utilities/install_plugins")).toHaveLength(1);
  });

  it("ignores the private socket once the prompt was handed to DeckyBackend", async () => {
    const { p, ws, state } = await startInstall();
    const [install] = ws.calls("utilities/install_plugins");
    ws.receive(prompt(PROMPT_ID, [REQ_A]));
    ws.receive({ type: 1, id: install.id, result: PROMPT_ID });
    ws.serverClose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.settled).toBe(false);
    expect(ws.acks()).toEqual([]);
    confirmReply.resolve(null);
    await expect(p).resolves.toBeUndefined();
  });

  it("accepts a type-3 prompt that carries an event name (older loaders)", async () => {
    const { p, ws } = await startInstall();
    ws.receive({ type: 3, id: 12345 });
    expect(routeCalls("utilities/confirm_plugin_install")).toHaveLength(0);
    ws.receive(prompt(PROMPT_ID, [REQ_A], 3));
    expect(routeCalls("utilities/confirm_plugin_install")).toEqual([["utilities/confirm_plugin_install", PROMPT_ID]]);
    confirmReply.resolve(null);
    await expect(p).resolves.toBeUndefined();
  });

  it("does not acknowledge replies that belong to other callers", async () => {
    const { ws } = await startInstall();
    ws.receive({ type: 1, id: 7, result: "someone else's" });
    ws.receive({ type: -1, id: 8, error: { name: "x", error: "y" } });
    expect(ws.acks()).toEqual([]);
  });

  it("does not confirm another request's single-plugin prompt", async () => {
    const { ws } = await startInstall();
    ws.receive({
      type: 5,
      event: "loader/add_plugin_install_prompt",
      args: ["Other Plugin", "1.0.0", "1789000000.9", "hash", 0],
    });
    ws.receive(prompt("1789000000.8", [{ ...REQ_B, name: "Other Plugin" }]));
    expect(routeCalls("utilities/confirm_plugin_install")).toHaveLength(0);
    expect(ws.calls("utilities/confirm_plugin_install")).toHaveLength(0);
    expect(ws.closed).toBe(false);
  });

  it("does not re-send the install after a prompt for another request was seen", async () => {
    const { p, ws } = await startInstall();
    ws.receive(prompt("1789000000.8", [{ ...REQ_B, name: "Other Plugin" }]));
    ws.serverClose();
    await expect(p).rejects.toThrow(/closed/i);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("rejects with Decky's error when the confirm fails, without checking installed versions", async () => {
    const { p, ws } = await startInstall();
    ws.receive(prompt(PROMPT_ID, [REQ_A]));
    confirmReply.reject(new Error("'1789000000.1'"));
    await expect(p).rejects.toThrow("'1789000000.1'");
    expect(routeCalls("loader/get_plugins")).toHaveLength(0);
  });

  it("rejects when the install request itself fails, without retrying", async () => {
    const { p, ws } = await startInstall();
    const [install] = ws.calls("utilities/install_plugins");
    ws.receive({ type: -1, id: install.id, error: { name: "Exception", error: "bad request" } });
    await expect(p).rejects.toThrow("bad request");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("never re-sends the install or the confirm after a prompt was seen", async () => {
    const { p, ws } = await startInstall();
    ws.receive(prompt(PROMPT_ID, [REQ_A]));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(ws.calls("utilities/install_plugins")).toHaveLength(1);
    expect(routeCalls("utilities/confirm_plugin_install")).toHaveLength(1);
    confirmReply.resolve(null);
    await expect(p).resolves.toBeUndefined();
  });

  it("allows 20 s plus 15 s per plugin for the confirm reply", async () => {
    const { ws, state } = await startInstall([REQ_A, REQ_B]);
    ws.receive(prompt(PROMPT_ID, [REQ_A, REQ_B]));
    await vi.advanceTimersByTimeAsync(49_999);
    expect(state.settled).toBe(false);
    expect(routeCalls("loader/get_plugins")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(routeCalls("loader/get_plugins")).toHaveLength(1);
  });

  it("resolves from the installed versions when the confirm reply is lost", async () => {
    const { p, ws, state } = await startInstall([REQ_A, REQ_B]);
    ws.receive(prompt(PROMPT_ID, [REQ_A, REQ_B]));
    installedNow = new Error("router reconnecting");
    await vi.advanceTimersByTimeAsync(50_000);
    expect(routeCalls("loader/get_plugins")).toHaveLength(1);

    installedNow = [{ name: REQ_A.name, version: "2.0.10", disabled: false }];
    await vi.advanceTimersByTimeAsync(2_000);
    expect(state.settled).toBe(false);

    installedNow = [
      { name: REQ_A.name, version: "2.0.10", disabled: false },
      { name: REQ_B.name, version: "v2.1.2", disabled: false },
    ];
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(p).resolves.toBeUndefined();
    expect(routeCalls("loader/get_plugins")).toHaveLength(3);
  });

  it("rejects when Decky replies but the plugin kept its old version", async () => {
    installOnReply = false;
    const { p, ws } = await startInstall();
    ws.receive(prompt(PROMPT_ID, [REQ_A]));
    const assertion = expect(p).rejects.toThrow(/HLTB for Deck 2\.0\.10 is not installed/);
    await vi.advanceTimersByTimeAsync(0);
    confirmReply.resolve(null);
    await vi.advanceTimersByTimeAsync(12_000);
    await assertion;
  });

  it("rejects when Decky replies but the plugin is gone", async () => {
    installOnReply = false;
    installedNow = [];
    const { p, ws } = await startInstall();
    ws.receive(prompt(PROMPT_ID, [REQ_A]));
    const assertion = expect(p).rejects.toThrow(/is not installed/);
    await vi.advanceTimersByTimeAsync(0);
    confirmReply.resolve(null);
    await vi.advanceTimersByTimeAsync(12_000);
    await assertion;
  });

  it("resolves on a confirm reply that arrives while it checks installed versions", async () => {
    const { p, ws } = await startInstall();
    ws.receive(prompt(PROMPT_ID, [REQ_A]));
    await vi.advanceTimersByTimeAsync(35_000);
    expect(routeCalls("loader/get_plugins")).toHaveLength(1);
    confirmReply.resolve(null);
    await expect(p).resolves.toBeUndefined();
  });

  it("rejects when neither the confirm reply nor the new versions arrive within 90 s", async () => {
    const { p, ws, state } = await startInstall();
    ws.receive(prompt(PROMPT_ID, [REQ_A]));
    const assertion = expect(p).rejects.toThrow(/timed out.*may still complete/);
    await vi.advanceTimersByTimeAsync(35_000 + 89_000);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(routeCalls("loader/get_plugins")).toHaveLength(45);
  });

  it("retries once when the socket closes before any prompt arrived", async () => {
    const { p, ws } = await startInstall();
    ws.serverClose();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const ws2 = FakeWebSocket.instances[1];
    expect(ws2.calls("utilities/install_plugins")).toHaveLength(1);
    ws2.receive(prompt(PROMPT_ID, [REQ_A]));
    expect(routeCalls("utilities/confirm_plugin_install")).toEqual([["utilities/confirm_plugin_install", PROMPT_ID]]);
    confirmReply.resolve(null);
    await expect(p).resolves.toBeUndefined();
  });

  it("gives up after the retry also closes before a prompt", async () => {
    const { p, ws } = await startInstall();
    ws.serverClose();
    await vi.advanceTimersByTimeAsync(3_000);
    FakeWebSocket.instances[1].serverClose();
    await expect(p).rejects.toThrow(/closed/i);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("cancels any request id it saw and rejects when no prompt arrives", async () => {
    const { p, ws } = await startInstall();
    const [install] = ws.calls("utilities/install_plugins");
    ws.receive({ type: 1, id: install.id, result: "1789000000.2" });
    const assertion = expect(p).rejects.toThrow(/prompt/);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    const cancels = ws.calls("utilities/cancel_plugin_install");
    expect(cancels.map((c) => c.args)).toEqual([["1789000000.2"]]);
    expect(ws.calls("utilities/confirm_plugin_install")).toHaveLength(0);
    expect(routeCalls("utilities/confirm_plugin_install")).toHaveLength(0);
  });

  describe("without DeckyBackend", () => {
    beforeEach(() => {
      vi.stubGlobal("DeckyBackend", undefined);
    });

    it("confirms on the private socket and resolves after the confirm reply", async () => {
      const { p, ws, state } = await startInstall();
      const [install] = ws.calls("utilities/install_plugins");
      ws.receive(prompt(PROMPT_ID, [REQ_A]));
      ws.receive({ type: 1, id: install.id, result: null });
      const [confirm] = ws.calls("utilities/confirm_plugin_install");
      expect(confirm.args).toEqual([PROMPT_ID]);
      expect(confirm.id).not.toBe(install.id);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(state.settled).toBe(false);
      ws.receive({ type: 1, id: confirm.id, result: null });
      await expect(p).resolves.toBeUndefined();
      expect(ws.acks()).toEqual([install.id, confirm.id]);
    });

    it("resolves when the socket closes after every plugin reported its download finished", async () => {
      const { p, ws } = await startInstall([REQ_A, REQ_B]);
      ws.receive(prompt(PROMPT_ID, [REQ_A, REQ_B]));
      ws.receive({ type: 5, event: "loader/plugin_download_finish", args: [REQ_A.name] });
      ws.receive({ type: 5, event: "loader/plugin_download_finish", args: [REQ_B.name] });
      ws.serverClose();
      await expect(p).resolves.toBeUndefined();
    });

    it("rejects without re-sending when the socket closes before the downloads finished", async () => {
      const { p, ws } = await startInstall();
      ws.receive(prompt(PROMPT_ID, [REQ_A]));
      ws.serverClose();
      await expect(p).rejects.toThrow(/closed.*may still complete/i);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(ws.calls("utilities/install_plugins")).toHaveLength(1);
    });
  });
});

describe("applyDeckyLoaderUpdate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  async function startUpdate() {
    const p = api.applyDeckyLoaderUpdate();
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    return { p, ws: FakeWebSocket.instances[0], state: trackSettled(p) };
  }

  it("sends updater/do_update on a private socket, not through DeckyBackend", async () => {
    const { ws } = await startUpdate();
    expect(ws.calls("updater/do_update")).toHaveLength(1);
    expect(backendCall).not.toHaveBeenCalled();
    expect(mockCall).not.toHaveBeenCalled();
  });

  it("keeps waiting after the socket closes and resolves on DeckyBackend's finish_download event", async () => {
    const { p, ws, state } = await startUpdate();
    ws.serverClose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.settled).toBe(false);
    emitRouterEvent("updater/finish_download");
    await expect(p).resolves.toBeUndefined();
    expect(routerListeners.get("updater/finish_download")?.size ?? 0).toBe(0);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("resolves on a finish_download event on the private socket", async () => {
    const { p, ws } = await startUpdate();
    ws.receive({ type: 5, event: "updater/finish_download", args: [] });
    await expect(p).resolves.toBeUndefined();
    expect(routerListeners.get("updater/finish_download")?.size ?? 0).toBe(0);
  });

  it("rejects as not confirmed when neither a reply nor finish_download arrives", async () => {
    const { p, ws, state } = await startUpdate();
    ws.serverClose();
    const assertion = expect(p).rejects.toThrow(/not confirmed/);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(routerListeners.get("updater/finish_download")?.size ?? 0).toBe(0);
  });

  it("resolves and acknowledges on a reply", async () => {
    const { p, ws } = await startUpdate();
    const [call] = ws.calls("updater/do_update");
    ws.receive({ type: 1, id: call.id, result: null });
    await expect(p).resolves.toBeUndefined();
    expect(ws.acks()).toEqual([call.id]);
  });

  it("resolves on a reply when DeckyBackend is missing", async () => {
    vi.stubGlobal("DeckyBackend", undefined);
    const { p, ws } = await startUpdate();
    const [call] = ws.calls("updater/do_update");
    ws.receive({ type: 1, id: call.id, result: null });
    await expect(p).resolves.toBeUndefined();
  });

  it("rejects on an error reply", async () => {
    const { p, ws } = await startUpdate();
    const [call] = ws.calls("updater/do_update");
    ws.receive({ type: -1, id: call.id, error: { name: "Exception", error: "download failed" } });
    await expect(p).rejects.toThrow("download failed");
  });

  it("rejects without retrying when the socket closes before the request was sent", async () => {
    FakeWebSocket.autoOpen = false;
    const { p, ws } = await startUpdate();
    ws.serverClose();
    await expect(p).rejects.toThrow(/before/);
    expect(ws.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
