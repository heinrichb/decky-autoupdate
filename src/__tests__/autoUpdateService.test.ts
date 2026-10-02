/**
 * Tests for AutoUpdateService - the core background service.
 *
 * Tests the logic that has caused real bugs:
 * - Settings defaults not propagating (checkOnWake undefined)
 * - Wake handler running once per resume-progress callback
 * - Concurrency guards on check runners and batches
 * - Long-interval sources never firing because timers were reset on every wake
 * - Timer cleanup on stop()
 * - Subscribe/notify pattern
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const MIN = 60_000;
const HOUR = 60 * MIN;

function mockResult(source: string, overrides: Record<string, any> = {}) {
  return {
    source,
    timestamp: Date.now(),
    pendingCount: 0,
    forcedCount: 0,
    errors: [],
    updates: [],
    flatpakUpdates: [],
    deckyPluginUpdates: [],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// Mock all external dependencies before importing the service
vi.mock("@decky/api", () => ({
  toaster: { toast: vi.fn() },
}));

vi.mock("../deckyApi", () => ({
  callPluginMethod: vi.fn().mockResolvedValue({}),
  getDeckyVersion: vi.fn().mockResolvedValue("v0.0.0"),
}));

vi.mock("../steamClient", () => ({
  waitForSteamClient: vi.fn().mockResolvedValue(true),
  isSteamClientAvailable: vi.fn().mockReturnValue(true),
  registerForResume: vi.fn().mockReturnValue(null),
  registerForAppLifetime: vi.fn().mockReturnValue(null),
  probeSteamClientApi: vi.fn(),
}));

vi.mock("../providers", () => ({
  checkSteam: vi.fn().mockResolvedValue(mockResult("steam")),
  checkAndApplyFlatpak: vi.fn().mockResolvedValue(mockResult("flatpak")),
  isFlatpakAvailable: vi.fn().mockResolvedValue(true),
  isDeckyApiAvailable: vi.fn().mockResolvedValue(true),
  applyDeckyPluginUpdates: vi.fn().mockResolvedValue(mockResult("decky")),
  checkAndApplyDeckyLoaderUpdate: vi.fn().mockResolvedValue(mockResult("decky-loader")),
  isSteamosAvailable: vi.fn().mockResolvedValue(false),
  checkAndApplySteamos: vi.fn().mockResolvedValue(mockResult("steamos")),
}));

// Captured callbacks so tests can simulate Steam events
let capturedGameCallback: ((n: { unAppID: number; nInstanceID: number; bRunning: boolean }) => void) | null = null;
let capturedResumeCallback: ((state: number | undefined) => void) | null = null;

interface ServiceOptions {
  settings?: Record<string, any>;
  checkState?: Record<string, any>;
  providers?: Record<string, any>;
  history?: Promise<any>;
}

// We need fresh module state for each test
async function getService(settingsOverrides: Record<string, any> = {}, opts: Omit<ServiceOptions, "settings"> = {}) {
  capturedGameCallback = null;
  capturedResumeCallback = null;

  // Reset modules to get a fresh singleton
  vi.resetModules();

  const baseSettings = {
    showNotifications: true,
    logHistory: false,
    maxHistoryEntries: 100,
    steamEnabled: true,
    steamCheckIntervalMinutes: 30,
    flatpakEnabled: true,
    flatpakCheckIntervalMinutes: 720,
    flatpakAutoApply: true,
    checkOnWake: true,
    checkOnGameClose: true,
    checkDuringGameplay: false,
    deckyPluginUpdatesEnabled: false,
    deckyCheckIntervalMinutes: 1440,
    deckyPluginBlacklist: [],
    interCheckDelayMs: 0,
    ...settingsOverrides,
  };

  const callPluginMethod = vi.fn().mockImplementation((method: string) => {
    const mocks: Record<string, any> = {
      get_settings: baseSettings,
      save_settings: true,
      get_history: [],
      add_history_entry: true,
      clear_history: true,
      get_check_state: opts.checkState ?? {},
      save_check_state: true,
      log_frontend_batch: 0,
    };
    if (method === "get_history" && opts.history) return opts.history;
    return Promise.resolve(mocks[method] ?? {});
  });

  // Re-mock before re-importing
  const toast = vi.fn();
  vi.doMock("@decky/api", () => ({
    toaster: { toast },
  }));

  vi.doMock("../deckyApi", () => ({
    callPluginMethod,
    getDeckyVersion: vi.fn().mockResolvedValue("v0.0.0"),
  }));

  const registerForResume = vi.fn().mockImplementation((cb: (state: number | undefined) => void) => {
    capturedResumeCallback = cb;
    return {
      api: "User.RegisterForResumeSuspendedGamesProgress",
      unregister: () => {
        capturedResumeCallback = null;
      },
    };
  });

  vi.doMock("../steamClient", () => ({
    waitForSteamClient: vi.fn().mockResolvedValue(true),
    isSteamClientAvailable: vi.fn().mockReturnValue(true),
    registerForResume,
    registerForAppLifetime: vi.fn().mockImplementation((cb: any) => {
      capturedGameCallback = cb;
      return () => {
        capturedGameCallback = null;
      };
    }),
    probeSteamClientApi: vi.fn(),
  }));

  const providers = {
    checkSteam: vi.fn().mockImplementation(() => Promise.resolve(mockResult("steam"))),
    checkAndApplyFlatpak: vi.fn().mockImplementation(() => Promise.resolve(mockResult("flatpak"))),
    isFlatpakAvailable: vi.fn().mockResolvedValue(true),
    isDeckyApiAvailable: vi.fn().mockResolvedValue(true),
    applyDeckyPluginUpdates: vi.fn().mockImplementation(() => Promise.resolve(mockResult("decky"))),
    checkAndApplyDeckyLoaderUpdate: vi.fn().mockImplementation(() => Promise.resolve(mockResult("decky-loader"))),
    isSteamosAvailable: vi.fn().mockResolvedValue(false),
    checkAndApplySteamos: vi.fn().mockImplementation(() => Promise.resolve(mockResult("steamos"))),
    ...opts.providers,
  };
  vi.doMock("../providers", () => providers);

  const mod = await import("../autoUpdateService");
  return Object.assign(mod.service, { _mocks: { callPluginMethod, registerForResume, providers, toast } });
}

const calls = (fn: any) => fn.mock.calls.length;
const methodCalls = (callPluginMethod: any, method: string) =>
  callPluginMethod.mock.calls.filter((c: any[]) => c[0] === method);

// Startup check runs 10 s after start(); this moves past it.
async function pastStartup() {
  await vi.advanceTimersByTimeAsync(10_500);
}

describe("AutoUpdateService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 30, 12, 0, 0));
    vi.stubGlobal("navigator", { onLine: true });
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("subscribe/notify", () => {
    it("calls listeners when state changes", async () => {
      const service = await getService();
      const listener = vi.fn();
      service.subscribe(listener);
      await service.start();
      // start() calls notify() multiple times during initialization
      expect(listener.mock.calls.length).toBeGreaterThan(0);
      service.stop();
    });

    it("unsubscribe prevents future calls", async () => {
      const service = await getService();
      const listener = vi.fn();
      const unsub = service.subscribe(listener);
      unsub();
      await service.start();
      expect(listener).not.toHaveBeenCalled();
      service.stop();
    });

    it("notifies status and batch progress while a batch is running", async () => {
      const flatpakDone = deferred<any>();
      const service = await getService({}, { providers: { checkAndApplyFlatpak: vi.fn(() => flatpakDone.promise) } });
      await service.start();
      const seen: { batch: any; flatpak: string; steam: string }[] = [];
      service.subscribe(() => {
        const s = service.getState();
        seen.push({ batch: s.batch, flatpak: s.flatpakStatus, steam: s.steamStatus });
      });

      const run = service.triggerAll("manual");
      await vi.advanceTimersByTimeAsync(0);

      const mid = service.getState();
      expect(mid.batch).toMatchObject({ trigger: "manual", total: 2, done: 1, current: "flatpak" });
      expect(mid.flatpakStatus).not.toBe("idle");
      expect(seen.some((s) => s.steam === "checking" && s.batch?.current === "steam")).toBe(true);
      expect(seen.some((s) => s.flatpak !== "idle")).toBe(true);

      flatpakDone.resolve(mockResult("flatpak", { pendingCount: 1 }));
      const results = await run;
      expect(results.map((r) => r.source)).toEqual(["steam", "flatpak"]);
      expect(service.getState().batch).toBeNull();
      expect(seen[seen.length - 1].batch).toBeNull();
      service.stop();
    });
  });

  describe("start/stop lifecycle", () => {
    it("marks settingsLoaded after start", async () => {
      const service = await getService();
      expect(service.getState().settingsLoaded).toBe(false);
      await service.start();
      expect(service.getState().settingsLoaded).toBe(true);
      service.stop();
    });

    it("double start is a no-op", async () => {
      const service = await getService();
      await service.start();
      const listener = vi.fn();
      service.subscribe(listener);
      await service.start(); // should not re-initialize
      expect(listener).not.toHaveBeenCalled();
      service.stop();
    });

    it("stop allows restart", async () => {
      const service = await getService();
      await service.start();
      service.stop();
      // After stop, started flag is reset - can start again
      await service.start();
      expect(service.getState().settingsLoaded).toBe(true);
      service.stop();
    });

    it("stop flushes buffered log lines through log_frontend_batch", async () => {
      const service = await getService();
      await service.start();
      const { callPluginMethod } = service._mocks;
      callPluginMethod.mockClear();
      service.stop();
      const batches = methodCalls(callPluginMethod, "log_frontend_batch");
      expect(batches.length).toBe(1);
      const entries = batches[0][1][0] as [string, string, number][];
      expect(entries.some((e) => e[1].includes("Service stopping"))).toBe(true);
    });

    it("no checks run after stop(), even when timers were pending", async () => {
      const service = await getService();
      await service.start();
      const { providers } = service._mocks;
      service.stop();
      await vi.advanceTimersByTimeAsync(24 * HOUR);
      expect(calls(providers.checkSteam)).toBe(0);
      expect(calls(providers.checkAndApplyFlatpak)).toBe(0);
    });
  });

  describe("settings", () => {
    it("merges defaults for missing fields", async () => {
      const service = await getService();
      await service.start();
      const state = service.getState();
      // checkOnWake should be true from defaults even if backend omits it
      expect(state.settings.checkOnWake).toBe(true);
      service.stop();
    });

    it("updateSettings persists and notifies", async () => {
      const service = await getService();
      await service.start();
      const listener = vi.fn();
      service.subscribe(listener);
      await service.updateSettings({ steamCheckIntervalMinutes: 60 });
      expect(service.getState().settings.steamCheckIntervalMinutes).toBe(60);
      expect(listener).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(400);
      const saves = methodCalls(service._mocks.callPluginMethod, "save_settings");
      expect(saves[saves.length - 1][1][0].steamCheckIntervalMinutes).toBe(60);
      service.stop();
    });

    it("debounces save_settings to one trailing call", async () => {
      const service = await getService();
      await service.start();
      const { callPluginMethod } = service._mocks;
      for (const m of [35, 40, 45, 50]) {
        service.updateSettings({ steamCheckIntervalMinutes: m });
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(methodCalls(callPluginMethod, "save_settings").length).toBe(0);
      await vi.advanceTimersByTimeAsync(400);
      const saves = methodCalls(callPluginMethod, "save_settings");
      expect(saves.length).toBe(1);
      expect(saves[0][1][0].steamCheckIntervalMinutes).toBe(50);
      service.stop();
    });

    it("stop flushes a pending settings save", async () => {
      const service = await getService();
      await service.start();
      service.updateSettings({ notificationLevel: "all" });
      service.stop();
      const saves = methodCalls(service._mocks.callPluginMethod, "save_settings");
      expect(saves.length).toBe(1);
      expect(saves[0][1][0].notificationLevel).toBe("all");
    });

    it("changing an interval keeps the elapsed time", async () => {
      const service = await getService({ flatpakEnabled: false });
      await service.start();
      await pastStartup();
      const { checkSteam } = service._mocks.providers;
      expect(calls(checkSteam)).toBe(1);
      const checkedAt = service.getState().steamLastCheck!.timestamp;

      await vi.advanceTimersByTimeAsync(20 * MIN);
      service.updateSettings({ steamCheckIntervalMinutes: 60 });
      expect(service.nextDueAt("steam")).toBe(checkedAt + 60 * MIN);

      await vi.advanceTimersByTimeAsync(38 * MIN);
      expect(calls(checkSteam)).toBe(1);
      await vi.advanceTimersByTimeAsync(3 * MIN);
      expect(calls(checkSteam)).toBe(2);
      service.stop();
    });

    it("non-timer settings do not shift the schedule", async () => {
      const service = await getService({ flatpakEnabled: false });
      await service.start();
      await pastStartup();
      const { checkSteam } = service._mocks.providers;
      await vi.advanceTimersByTimeAsync(25 * MIN);
      service.updateSettings({ notificationLevel: "all" });
      await vi.advanceTimersByTimeAsync(6 * MIN);
      expect(calls(checkSteam)).toBe(2);
      service.stop();
    });
  });

  describe("persisted check state", () => {
    it("seeds lastCheck from get_check_state", async () => {
      const ts = Date.now() - 2 * HOUR;
      const service = await getService(
        {},
        {
          checkState: {
            steam: { timestamp: ts, pendingCount: 2, forcedCount: 1, errors: [] },
            flatpak: { timestamp: ts, pendingCount: 0, forcedCount: 0, errors: ["Offline: no network"] },
            bogus: { timestamp: ts },
          },
        },
      );
      await service.start();
      const s = service.getState();
      expect(s.steamLastCheck).toMatchObject({ source: "steam", timestamp: ts, pendingCount: 2, forcedCount: 1 });
      expect(s.steamLastCheck!.updates).toEqual([]);
      expect(s.flatpakLastCheck!.errors).toEqual(["Offline: no network"]);
      expect(s.deckyLastCheck).toBeNull();
      service.stop();
    });

    it("saves a summary after each completed check", async () => {
      const service = await getService(
        {},
        { providers: { checkSteam: vi.fn(async () => mockResult("steam", { pendingCount: 3 })) } },
      );
      await service.start();
      await service.triggerCheck("steam", "manual");
      const saves = methodCalls(service._mocks.callPluginMethod, "save_check_state");
      expect(saves.length).toBeGreaterThan(0);
      const state = saves[saves.length - 1][1][0];
      expect(state.steam).toMatchObject({ pendingCount: 3, forcedCount: 0, errors: [] });
      expect(typeof state.steam.timestamp).toBe("number");
      service.stop();
    });

    it("startup checks steam and only the sources that are due", async () => {
      const now = Date.now();
      const service = await getService(
        { deckyPluginUpdatesEnabled: true },
        {
          checkState: {
            flatpak: { timestamp: now - HOUR, pendingCount: 0, forcedCount: 0, errors: [] },
            decky: { timestamp: now - 25 * HOUR, pendingCount: 0, forcedCount: 0, errors: [] },
            steam: { timestamp: now - 5 * MIN, pendingCount: 0, forcedCount: 0, errors: [] },
          },
        },
      );
      await service.start();
      await pastStartup();
      const { providers } = service._mocks;
      expect(calls(providers.checkSteam)).toBe(1);
      expect(calls(providers.applyDeckyPluginUpdates)).toBe(1);
      expect(calls(providers.checkAndApplyFlatpak)).toBe(0);
      service.stop();
    });

    it("a failed check is due again within 30 minutes", async () => {
      const ts = Date.now() - HOUR;
      const service = await getService(
        {},
        {
          checkState: {
            flatpak: { timestamp: ts, pendingCount: 0, forcedCount: 0, errors: ["remote-ls failed"] },
            steam: { timestamp: ts, pendingCount: 0, forcedCount: 0, errors: [] },
          },
        },
      );
      await service.start();
      expect(service.nextDueAt("flatpak")).toBe(ts + 30 * MIN);
      expect(service.nextDueAt("steam")).toBe(ts + 30 * MIN);
      service.stop();
    });
  });

  describe("nextDueAt", () => {
    it("is null for disabled or unavailable sources", async () => {
      const service = await getService({ flatpakEnabled: false });
      await service.start();
      expect(service.nextDueAt("flatpak")).toBeNull();
      expect(service.nextDueAt("steamos")).toBeNull();
      expect(service.nextDueAt("steam")).not.toBeNull();
      service.stop();
    });

    it("uses the shared decky interval for decky and decky-loader", async () => {
      const ts = Date.now() - HOUR;
      const entry = { timestamp: ts, pendingCount: 0, forcedCount: 0, errors: [] };
      const service = await getService(
        { deckyPluginUpdatesEnabled: true, deckyLoaderUpdateEnabled: true, deckyCheckIntervalMinutes: 120 },
        { checkState: { decky: entry, "decky-loader": entry } },
      );
      await service.start();
      expect(service.nextDueAt("decky")).toBe(ts + 120 * MIN);
      expect(service.nextDueAt("decky-loader")).toBe(ts + 120 * MIN);
      service.stop();
    });
  });

  describe("triggerCheck", () => {
    it("returns a steam result", async () => {
      const service = await getService();
      await service.start();
      const result = await service.triggerCheck("steam", "manual");
      expect(result).toBeDefined();
      expect(result!.source).toBe("steam");
      service.stop();
    });

    it("updates state.steamLastCheck", async () => {
      const service = await getService();
      await service.start();
      expect(service.getState().steamLastCheck).toBeNull();
      await service.triggerCheck("steam", "manual");
      expect(service.getState().steamLastCheck).not.toBeNull();
      service.stop();
    });

    it("returns a flatpak result", async () => {
      const service = await getService();
      await service.start();
      const result = await service.triggerCheck("flatpak", "manual");
      expect(result).toBeDefined();
      expect(result!.source).toBe("flatpak");
      service.stop();
    });

    it("returns null (not the stale last result) when the source is already busy", async () => {
      const done = deferred<any>();
      const flatpak = vi.fn(() => done.promise);
      const stale = { timestamp: Date.now() - HOUR, pendingCount: 7, forcedCount: 0, errors: [] };
      const service = await getService(
        {},
        { providers: { checkAndApplyFlatpak: flatpak }, checkState: { flatpak: stale } },
      );
      await service.start();
      expect(service.getState().flatpakLastCheck!.pendingCount).toBe(7);
      const first = service.triggerCheck("flatpak", "manual");
      const second = await service.triggerCheck("flatpak", "manual");
      expect(second).toBeNull();
      done.resolve(mockResult("flatpak", { pendingCount: 2 }));
      expect((await first)!.pendingCount).toBe(2);
      expect(flatpak).toHaveBeenCalledTimes(1);
      service.stop();
    });
  });

  describe("triggerAll", () => {
    it("is single-flight: a second call while a batch runs returns []", async () => {
      const done = deferred<any>();
      const steam = vi.fn(() => done.promise);
      const service = await getService({}, { providers: { checkSteam: steam } });
      await service.start();
      const first = service.triggerAll("manual");
      await vi.advanceTimersByTimeAsync(0);
      expect(await service.triggerAll("manual")).toEqual([]);
      done.resolve(mockResult("steam"));
      expect((await first).length).toBe(2);
      expect(steam).toHaveBeenCalledTimes(1);
      service.stop();
    });

    it("manual runs every enabled source in checkOrder, even when not due", async () => {
      const now = Date.now();
      const fresh = { timestamp: now - MIN, pendingCount: 0, forcedCount: 0, errors: [] };
      const service = await getService(
        { deckyPluginUpdatesEnabled: true, checkOrder: ["flatpak", "decky", "steam"] },
        { checkState: { steam: fresh, flatpak: fresh, decky: fresh } },
      );
      await service.start();
      const results = await service.triggerAll("manual");
      expect(results.map((r) => r.source)).toEqual(["flatpak", "decky", "steam"]);
      service.stop();
    });

    it("excludes busy sources and does not delay after them", async () => {
      const done = deferred<any>();
      const service = await getService(
        { interCheckDelayMs: 2000, checkOrder: ["flatpak", "steam"] },
        { providers: { checkAndApplyFlatpak: vi.fn(() => done.promise) } },
      );
      await service.start();
      const single = service.triggerCheck("flatpak", "manual");
      const batch = service.triggerAll("manual");
      await vi.advanceTimersByTimeAsync(0);
      expect(calls(service._mocks.providers.checkSteam)).toBe(1);
      const results = await batch;
      expect(results.map((r) => r.source)).toEqual(["steam"]);
      done.resolve(mockResult("flatpak"));
      await single;
      service.stop();
    });

    it("waits interCheckDelayMs only between sources that ran", async () => {
      const service = await getService({ interCheckDelayMs: 2000 });
      await service.start();
      const { providers } = service._mocks;
      const batch = service.triggerAll("manual");
      await vi.advanceTimersByTimeAsync(0);
      expect(calls(providers.checkSteam)).toBe(1);
      expect(calls(providers.checkAndApplyFlatpak)).toBe(0);
      await vi.advanceTimersByTimeAsync(2000);
      expect(calls(providers.checkAndApplyFlatpak)).toBe(1);
      await batch;
      service.stop();
    });
  });

  describe("scheduler", () => {
    it("fires a due source and re-arms for the next interval", async () => {
      const service = await getService({ flatpakEnabled: false });
      await service.start();
      await pastStartup();
      const { checkSteam } = service._mocks.providers;
      expect(calls(checkSteam)).toBe(1);
      const first = service.getState().steamLastCheck!.timestamp;
      expect(service.nextDueAt("steam")).toBe(first + 30 * MIN);

      await vi.advanceTimersByTimeAsync(30 * MIN);
      expect(calls(checkSteam)).toBe(2);
      await vi.advanceTimersByTimeAsync(30 * MIN);
      expect(calls(checkSteam)).toBe(3);
      service.stop();
    });

    it("runs a long-interval source once it is due, without a wake resetting it", async () => {
      const now = Date.now();
      const service = await getService(
        { flatpakCheckIntervalMinutes: 720 },
        { checkState: { flatpak: { timestamp: now - 11 * HOUR, pendingCount: 0, forcedCount: 0, errors: [] } } },
      );
      await service.start();
      await pastStartup();
      const { checkAndApplyFlatpak } = service._mocks.providers;
      expect(calls(checkAndApplyFlatpak)).toBe(0);

      await vi.advanceTimersByTimeAsync(30 * MIN);
      capturedResumeCallback!(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls(checkAndApplyFlatpak)).toBe(0);

      await vi.advanceTimersByTimeAsync(31 * MIN);
      expect(calls(checkAndApplyFlatpak)).toBe(1);
      service.stop();
    });

    it.each([
      ["updates-only", 2, 2, 1],
      ["updates-only", 0, 0, 0],
      ["all", 0, 0, 1],
      ["off", 2, 2, 0],
    ] as const)(
      "toasts a scheduled check under notificationLevel %s (pending %i, applied %i)",
      async (level, pendingCount, forcedCount, toasts) => {
        const service = await getService(
          { steamEnabled: false, flatpakCheckIntervalMinutes: 360, notificationLevel: level },
          {
            checkState: { flatpak: { timestamp: Date.now() - 5 * HOUR, pendingCount: 0, forcedCount: 0, errors: [] } },
            providers: {
              checkAndApplyFlatpak: vi.fn(async () => mockResult("flatpak", { pendingCount, forcedCount })),
            },
          },
        );
        await service.start();
        await pastStartup();
        const { providers, toast } = service._mocks;
        expect(calls(providers.checkAndApplyFlatpak)).toBe(0);

        await vi.advanceTimersByTimeAsync(61 * MIN);
        expect(calls(providers.checkAndApplyFlatpak)).toBe(1);
        expect(toast).toHaveBeenCalledTimes(toasts);
        service.stop();
      },
    );

    it("does not arm before the startup check, even after a manual check or a schedule change", async () => {
      const history = deferred<any>();
      const service = await getService({}, { history: history.promise });
      const starting = service.start();
      await vi.advanceTimersByTimeAsync(0);
      const { providers } = service._mocks;

      await service.triggerCheck("steam", "manual");
      service.updateSettings({ flatpakCheckIntervalMinutes: 360 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls(providers.checkAndApplyFlatpak)).toBe(0);

      history.resolve([]);
      await starting;
      await pastStartup();
      expect(calls(providers.checkAndApplyFlatpak)).toBe(1);
      service.stop();
    });

    it("still arms after start() throws", async () => {
      const service = await getService();
      service._mocks.registerForResume.mockImplementation(() => {
        throw new Error("boom");
      });
      await expect(service.start()).rejects.toThrow("boom");
      const { providers } = service._mocks;

      await service.triggerCheck("steam", "manual");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(calls(providers.checkAndApplyFlatpak)).toBe(1);
      service.stop();
    });

    it("retries in 5 minutes when blocked by gameplay", async () => {
      const service = await getService({ flatpakEnabled: false, checkOnGameClose: false });
      await service.start();
      await pastStartup();
      const { checkSteam } = service._mocks.providers;
      capturedGameCallback!({ unAppID: 1, nInstanceID: 1, bRunning: true });
      await vi.advanceTimersByTimeAsync(31 * MIN);
      expect(calls(checkSteam)).toBe(1);
      capturedGameCallback!({ unAppID: 1, nInstanceID: 1, bRunning: false });
      await vi.advanceTimersByTimeAsync(5 * MIN);
      expect(calls(checkSteam)).toBeGreaterThan(1);
      service.stop();
    });
  });

  describe("offline retry", () => {
    it("retries a non-manual offline failure once after 60 s", async () => {
      const flatpak = vi.fn(async () => mockResult("flatpak", { errors: ["Offline: Could not resolve hostname"] }));
      const service = await getService({}, { providers: { checkAndApplyFlatpak: flatpak } });
      await service.start();
      await pastStartup();
      expect(flatpak).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(flatpak).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(flatpak).toHaveBeenCalledTimes(2);
      service.stop();
    });

    it.each([
      ["decky", "Device is offline", 2],
      ["decky", "Failed to fetch", 2],
      [
        "decky-loader",
        "Cannot connect to host api.github.com:443 ssl:default [Temporary failure in name resolution]",
        2,
      ],
      ["decky-loader", "Cannot connect to host api.github.com:443 ssl:default [Connect call failed]", 2],
      ["decky", "Plugin store returned HTTP 500", 1],
    ] as const)("%s failing with '%s' is checked %i times within 60 s", async (source, message, expected) => {
      const provider = vi.fn(async () => mockResult(source, { errors: [message] }));
      const service = await getService(
        {
          steamEnabled: false,
          flatpakEnabled: false,
          deckyPluginUpdatesEnabled: source === "decky",
          deckyLoaderUpdateEnabled: source === "decky-loader",
        },
        {
          providers:
            source === "decky" ? { applyDeckyPluginUpdates: provider } : { checkAndApplyDeckyLoaderUpdate: provider },
        },
      );
      await service.start();
      await pastStartup();
      expect(provider).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(provider).toHaveBeenCalledTimes(expected);
      service.stop();
    });

    it("toasts the retry of a scheduled check under notificationLevel", async () => {
      let n = 0;
      const flatpak = vi.fn(async () =>
        ++n === 1
          ? mockResult("flatpak", { errors: ["Offline: Could not resolve hostname"] })
          : mockResult("flatpak", { pendingCount: 2, forcedCount: 2 }),
      );
      const service = await getService(
        { steamEnabled: false, flatpakCheckIntervalMinutes: 360 },
        {
          checkState: { flatpak: { timestamp: Date.now() - 5 * HOUR, pendingCount: 0, forcedCount: 0, errors: [] } },
          providers: { checkAndApplyFlatpak: flatpak },
        },
      );
      await service.start();
      await pastStartup();
      const { toast } = service._mocks;

      await vi.advanceTimersByTimeAsync(60 * MIN);
      expect(flatpak).toHaveBeenCalledTimes(1);
      expect(toast).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(flatpak).toHaveBeenCalledTimes(2);
      expect(toast).toHaveBeenCalledTimes(1);
      service.stop();
    });

    it("does not retry manual checks", async () => {
      const flatpak = vi.fn(async () => mockResult("flatpak", { errors: ["Network is unreachable"] }));
      const service = await getService({ steamEnabled: false }, { providers: { checkAndApplyFlatpak: flatpak } });
      await service.start();
      await service.triggerCheck("flatpak", "manual");
      expect(flatpak).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(flatpak).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(flatpak).toHaveBeenCalledTimes(1);
      service.stop();
    });
  });

  describe("clearHistory", () => {
    it("empties the history entries", async () => {
      const service = await getService();
      await service.start();
      await service.clearHistory();
      expect(service.getState().historyEntries).toEqual([]);
      service.stop();
    });
  });

  describe("wake detection", () => {
    it("registers the resume API and unregisters on stop", async () => {
      const service = await getService();
      await service.start();
      expect(capturedResumeCallback).not.toBeNull();
      service.stop();
      expect(capturedResumeCallback).toBeNull();
    });

    it("coalesces 3 resume callbacks within 5 s into one batch", async () => {
      const service = await getService();
      await service.start();
      await pastStartup();
      const { checkSteam } = service._mocks.providers;
      const before = calls(checkSteam);

      capturedResumeCallback!(3);
      await vi.advanceTimersByTimeAsync(2_000);
      capturedResumeCallback!(5);
      await vi.advanceTimersByTimeAsync(3_000);
      capturedResumeCallback!(1);
      await vi.advanceTimersByTimeAsync(15_000);

      expect(calls(checkSteam)).toBe(before + 1);
      service.stop();
    });

    it("ignores resume callbacks within 60 s of the last wake, then accepts a new one", async () => {
      const service = await getService();
      await service.start();
      await pastStartup();
      const { checkSteam } = service._mocks.providers;
      const before = calls(checkSteam);

      capturedResumeCallback!(1);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(calls(checkSteam)).toBe(before + 1);
      capturedResumeCallback!(1);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(calls(checkSteam)).toBe(before + 1);

      await vi.advanceTimersByTimeAsync(60_000);
      capturedResumeCallback!(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls(checkSteam)).toBe(before + 2);
      service.stop();
    });

    it("wake runs steam plus only the sources that are due", async () => {
      const now = Date.now();
      const service = await getService(
        { deckyPluginUpdatesEnabled: true },
        {
          checkState: {
            flatpak: { timestamp: now - HOUR, pendingCount: 0, forcedCount: 0, errors: [] },
            decky: { timestamp: now - 25 * HOUR, pendingCount: 0, forcedCount: 0, errors: [] },
            steam: { timestamp: now - MIN, pendingCount: 0, forcedCount: 0, errors: [] },
          },
        },
      );
      await service.start();
      const { providers } = service._mocks;
      capturedResumeCallback!(1);
      await vi.advanceTimersByTimeAsync(9_000);
      expect(calls(providers.checkSteam)).toBe(1);
      expect(calls(providers.applyDeckyPluginUpdates)).toBe(1);
      expect(calls(providers.checkAndApplyFlatpak)).toBe(0);
      service.stop();
    });

    it("skips checks when checkOnWake is off", async () => {
      const service = await getService({ checkOnWake: false });
      await service.start();
      await pastStartup();
      const { checkSteam } = service._mocks.providers;
      const before = calls(checkSteam);
      capturedResumeCallback!(1);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(calls(checkSteam)).toBe(before);
      service.stop();
    });

    it("stop() during the settle wait prevents the wake checks", async () => {
      const service = await getService();
      await service.start();
      await pastStartup();
      const { checkSteam } = service._mocks.providers;
      const before = calls(checkSteam);
      capturedResumeCallback!(1);
      await vi.advanceTimersByTimeAsync(3_000);
      service.stop();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(calls(checkSteam)).toBe(before);
    });
  });

  describe("game detection", () => {
    it("registers game detection on start", async () => {
      const service = await getService();
      await service.start();
      expect(capturedGameCallback).not.toBeNull();
      service.stop();
    });

    it("cleans up game detection on stop", async () => {
      const service = await getService();
      await service.start();
      expect(capturedGameCallback).not.toBeNull();
      service.stop();
      expect(capturedGameCallback).toBeNull();
    });

    it("tracks gameRunning in state", async () => {
      const service = await getService();
      await service.start();
      expect(service.getState().gameRunning).toBe(false);
      capturedGameCallback!({ unAppID: 123, nInstanceID: 1, bRunning: true });
      expect(service.getState().gameRunning).toBe(true);
      capturedGameCallback!({ unAppID: 123, nInstanceID: 1, bRunning: false });
      expect(service.getState().gameRunning).toBe(false);
      service.stop();
    });

    it("triggers check 30 s after the last game closes when checkOnGameClose is ON", async () => {
      const service = await getService();
      await service.start();
      await pastStartup();

      const { checkSteam } = service._mocks.providers;
      const callsBefore = calls(checkSteam);

      // Simulate game start
      capturedGameCallback!({ unAppID: 123, nInstanceID: 1, bRunning: true });

      // Simulate game stop - should trigger check after the debounce
      capturedGameCallback!({ unAppID: 123, nInstanceID: 1, bRunning: false });

      await vi.advanceTimersByTimeAsync(29_000);
      expect(calls(checkSteam)).toBe(callsBefore);

      await vi.advanceTimersByTimeAsync(1_500);
      expect(calls(checkSteam)).toBe(callsBefore + 1);
      service.stop();
    });

    it("does NOT trigger check when checkOnGameClose is OFF", async () => {
      const service = await getService({ checkOnGameClose: false });
      await service.start();
      await pastStartup();

      const { checkSteam } = service._mocks.providers;
      const callsBefore = calls(checkSteam);

      capturedGameCallback!({ unAppID: 123, nInstanceID: 1, bRunning: true });
      capturedGameCallback!({ unAppID: 123, nInstanceID: 1, bRunning: false });

      await vi.advanceTimersByTimeAsync(60_000);

      expect(calls(checkSteam)).toBe(callsBefore);
      service.stop();
    });

    it("does NOT trigger check when other games still running", async () => {
      const service = await getService();
      await service.start();
      await pastStartup();

      const { checkSteam } = service._mocks.providers;
      const callsBefore = calls(checkSteam);

      // Start two games
      capturedGameCallback!({ unAppID: 100, nInstanceID: 1, bRunning: true });
      capturedGameCallback!({ unAppID: 200, nInstanceID: 2, bRunning: true });

      // Stop one - other still running
      capturedGameCallback!({ unAppID: 100, nInstanceID: 1, bRunning: false });

      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls(checkSteam)).toBe(callsBefore);

      // Stop the second - now check should trigger
      capturedGameCallback!({ unAppID: 200, nInstanceID: 2, bRunning: false });

      await vi.advanceTimersByTimeAsync(31_000);
      expect(calls(checkSteam)).toBeGreaterThan(callsBefore);

      service.stop();
    });

    it("cancels the game-close check when a game starts during the debounce", async () => {
      const service = await getService();
      await service.start();
      await pastStartup();
      const { checkSteam } = service._mocks.providers;
      const callsBefore = calls(checkSteam);

      capturedGameCallback!({ unAppID: 1, nInstanceID: 1, bRunning: true });
      capturedGameCallback!({ unAppID: 1, nInstanceID: 1, bRunning: false });
      await vi.advanceTimersByTimeAsync(10_000);
      capturedGameCallback!({ unAppID: 2, nInstanceID: 2, bRunning: true });
      await vi.advanceTimersByTimeAsync(60_000);

      expect(calls(checkSteam)).toBe(callsBefore);
      service.stop();
    });

    it("a resume during the debounce replaces the game-close check when checkOnWake is ON", async () => {
      const service = await getService();
      await service.start();
      await pastStartup();
      const { checkSteam } = service._mocks.providers;
      const before = calls(checkSteam);

      capturedGameCallback!({ unAppID: 1, nInstanceID: 1, bRunning: true });
      capturedGameCallback!({ unAppID: 1, nInstanceID: 1, bRunning: false });
      await vi.advanceTimersByTimeAsync(5_000);
      capturedResumeCallback!(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls(checkSteam)).toBe(before + 1);
      service.stop();
    });

    it("a resume during the debounce keeps the game-close check when checkOnWake is OFF", async () => {
      const service = await getService({ checkOnWake: false });
      await service.start();
      await pastStartup();
      const { checkSteam } = service._mocks.providers;
      const before = calls(checkSteam);

      capturedGameCallback!({ unAppID: 1, nInstanceID: 1, bRunning: true });
      capturedGameCallback!({ unAppID: 1, nInstanceID: 1, bRunning: false });
      await vi.advanceTimersByTimeAsync(5_000);
      capturedResumeCallback!(1);
      await vi.advanceTimersByTimeAsync(26_000);
      expect(calls(checkSteam)).toBe(before + 1);
      service.stop();
    });

    it("checks after the game closes even when the preceding wake was blocked by gameplay", async () => {
      const service = await getService();
      await service.start();
      await pastStartup();
      const { checkSteam } = service._mocks.providers;
      const before = calls(checkSteam);

      capturedGameCallback!({ unAppID: 1, nInstanceID: 1, bRunning: true });
      capturedResumeCallback!(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls(checkSteam)).toBe(before);

      capturedGameCallback!({ unAppID: 1, nInstanceID: 1, bRunning: false });
      await vi.advanceTimersByTimeAsync(31_000);
      expect(calls(checkSteam)).toBe(before + 1);
      service.stop();
    });

    it("stops a game-close batch early when a game starts between sources", async () => {
      const steamDone = deferred<any>();
      const steam = vi.fn(() => steamDone.promise);
      const service = await getService({ checkOrder: ["steam", "flatpak"] }, { providers: { checkSteam: steam } });
      await service.start();
      const { providers } = service._mocks;

      // A game is running at startup, so the startup check is suppressed.
      capturedGameCallback!({ unAppID: 1, nInstanceID: 1, bRunning: true });
      await pastStartup();
      expect(steam).not.toHaveBeenCalled();

      capturedGameCallback!({ unAppID: 1, nInstanceID: 1, bRunning: false });
      await vi.advanceTimersByTimeAsync(30_500);
      expect(steam).toHaveBeenCalledTimes(1);
      expect(service.getState().batch).toMatchObject({ trigger: "game-close", total: 2, current: "steam" });

      capturedGameCallback!({ unAppID: 2, nInstanceID: 2, bRunning: true });
      steamDone.resolve(mockResult("steam"));
      await vi.advanceTimersByTimeAsync(1_000);

      expect(calls(providers.checkAndApplyFlatpak)).toBe(0);
      expect(service.getState().batch).toBeNull();
      service.stop();
    });

    it("suppresses periodic checks during gameplay when checkDuringGameplay is OFF", async () => {
      const service = await getService({ steamCheckIntervalMinutes: 1 });
      await service.start();

      const { checkSteam } = service._mocks.providers;
      const callsBefore = calls(checkSteam);

      // Start a game
      capturedGameCallback!({ unAppID: 123, nInstanceID: 1, bRunning: true });

      // Advance past the periodic interval (1 minute)
      await vi.advanceTimersByTimeAsync(60_000);

      // checkSteam should NOT have been called by the scheduler
      expect(calls(checkSteam)).toBe(callsBefore);

      service.stop();
    });

    it("allows periodic checks during gameplay when checkDuringGameplay is ON", async () => {
      const service = await getService({ steamCheckIntervalMinutes: 1, checkDuringGameplay: true });
      await service.start();

      const { checkSteam } = service._mocks.providers;
      const callsBefore = calls(checkSteam);

      // Start a game
      capturedGameCallback!({ unAppID: 123, nInstanceID: 1, bRunning: true });

      // Advance past the periodic interval (1 minute)
      await vi.advanceTimersByTimeAsync(60_000);

      // checkSteam SHOULD have been called
      expect(calls(checkSteam)).toBeGreaterThan(callsBefore);

      service.stop();
    });
  });
});
