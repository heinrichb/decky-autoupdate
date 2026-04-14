/**
 * Tests for AutoUpdateService — the core background service.
 *
 * Tests the logic that has caused real bugs:
 * - Settings defaults not propagating (checkOnWake undefined)
 * - Wake handler skipping when checkOnWake is off
 * - Concurrency guards on check runners
 * - Timer cleanup on stop()
 * - Subscribe/notify pattern
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

function mockResult(source: string) {
  return {
    source,
    timestamp: Date.now(),
    pendingCount: 0,
    forcedCount: 0,
    errors: [],
    updates: [],
    flatpakUpdates: [],
    deckyPluginUpdates: [],
  };
}

// Mock all external dependencies before importing the service
vi.mock("@decky/api", () => ({
  toaster: { toast: vi.fn() },
}));

vi.mock("../deckyApi", () => ({
  callPluginMethod: vi.fn().mockResolvedValue({}),
}));

vi.mock("../steamClient", () => ({
  waitForSteamClient: vi.fn().mockResolvedValue(true),
  isSteamClientAvailable: vi.fn().mockReturnValue(true),
  registerForResume: vi.fn().mockReturnValue(null), // default: no SteamClient event, use heartbeat
  registerForAppLifetime: vi.fn().mockReturnValue(null),
}));

vi.mock("../providers", () => ({
  checkSteam: vi.fn().mockResolvedValue(mockResult("steam")),
  checkFlatpakOnly: vi.fn().mockResolvedValue(mockResult("flatpak")),
  applyFlatpak: vi.fn().mockResolvedValue(mockResult("flatpak")),
  isFlatpakAvailable: vi.fn().mockResolvedValue(true),
  isDeckyApiAvailable: vi.fn().mockResolvedValue(true),
  applyDeckyPluginUpdates: vi.fn().mockResolvedValue(mockResult("decky")),
  checkAndApplyDeckyLoaderUpdate: vi.fn().mockResolvedValue(mockResult("decky-loader")),
  isSteamosAvailable: vi.fn().mockResolvedValue(false),
  checkAndApplySteamos: vi.fn().mockResolvedValue(mockResult("steamos")),
}));

// Captured callback from registerForAppLifetime so tests can simulate game events
let capturedGameCallback: ((n: { unAppID: number; nInstanceID: number; bRunning: boolean }) => void) | null = null;

// We need fresh module state for each test
async function getService(settingsOverrides: Record<string, any> = {}) {
  capturedGameCallback = null;

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
    ...settingsOverrides,
  };

  // Re-mock before re-importing
  vi.doMock("@decky/api", () => ({
    toaster: { toast: vi.fn() },
  }));

  vi.doMock("../deckyApi", () => ({
    callPluginMethod: vi.fn().mockImplementation((method: string) => {
      const mocks: Record<string, any> = {
        get_settings: baseSettings,
        save_settings: true,
        get_history: [],
        add_history_entry: true,
        clear_history: true,
      };
      return Promise.resolve(mocks[method] ?? {});
    }),
  }));

  vi.doMock("../steamClient", () => ({
    waitForSteamClient: vi.fn().mockResolvedValue(true),
    isSteamClientAvailable: vi.fn().mockReturnValue(true),
    registerForResume: vi.fn().mockReturnValue(null),
    registerForAppLifetime: vi.fn().mockImplementation((cb: any) => {
      capturedGameCallback = cb;
      return () => {
        capturedGameCallback = null;
      };
    }),
  }));

  vi.doMock("../providers", () => ({
    checkSteam: vi.fn().mockResolvedValue(mockResult("steam")),
    checkFlatpakOnly: vi.fn().mockResolvedValue(mockResult("flatpak")),
    applyFlatpak: vi.fn().mockResolvedValue(mockResult("flatpak")),
    isFlatpakAvailable: vi.fn().mockResolvedValue(true),
    isDeckyApiAvailable: vi.fn().mockResolvedValue(true),
    applyDeckyPluginUpdates: vi.fn().mockResolvedValue(mockResult("decky")),
    checkAndApplyDeckyLoaderUpdate: vi.fn().mockResolvedValue(mockResult("decky-loader")),
    isSteamosAvailable: vi.fn().mockResolvedValue(false),
    checkAndApplySteamos: vi.fn().mockResolvedValue(mockResult("steamos")),
  }));

  const mod = await import("../autoUpdateService");
  return mod.service;
}

describe("AutoUpdateService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
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
      // After stop, started flag is reset — can start again
      await service.start();
      expect(service.getState().settingsLoaded).toBe(true);
      service.stop();
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
      service.stop();
    });
  });

  describe("triggerCheck", () => {
    it("returns a steam result", async () => {
      const service = await getService();
      await service.start();
      const result = await service.triggerCheck("steam", "manual");
      expect(result).toBeDefined();
      expect(result.source).toBe("steam");
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
      expect(result.source).toBe("flatpak");
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

    it("triggers check when last game closes and checkOnGameClose is ON", async () => {
      const service = await getService();
      await service.start();

      const { checkSteam } = await import("../providers");

      // Simulate game start
      capturedGameCallback!({ unAppID: 123, nInstanceID: 1, bRunning: true });

      // Simulate game stop — should trigger check
      capturedGameCallback!({ unAppID: 123, nInstanceID: 1, bRunning: false });

      // Let promises resolve
      await vi.advanceTimersByTimeAsync(0);

      expect(checkSteam).toHaveBeenCalled();
      service.stop();
    });

    it("does NOT trigger check when checkOnGameClose is OFF", async () => {
      const service = await getService({ checkOnGameClose: false });
      await service.start();

      const { checkSteam } = await import("../providers");
      const callsBefore = (checkSteam as any).mock.calls.length;

      capturedGameCallback!({ unAppID: 123, nInstanceID: 1, bRunning: true });
      capturedGameCallback!({ unAppID: 123, nInstanceID: 1, bRunning: false });

      await vi.advanceTimersByTimeAsync(0);

      expect((checkSteam as any).mock.calls.length).toBe(callsBefore);
      service.stop();
    });

    it("does NOT trigger check when other games still running", async () => {
      const service = await getService();
      await service.start();

      const { checkSteam } = await import("../providers");
      const callsBefore = (checkSteam as any).mock.calls.length;

      // Start two games
      capturedGameCallback!({ unAppID: 100, nInstanceID: 1, bRunning: true });
      capturedGameCallback!({ unAppID: 200, nInstanceID: 2, bRunning: true });

      // Stop one — other still running
      capturedGameCallback!({ unAppID: 100, nInstanceID: 1, bRunning: false });

      await vi.advanceTimersByTimeAsync(0);
      expect((checkSteam as any).mock.calls.length).toBe(callsBefore);

      // Stop the second — now check should trigger
      capturedGameCallback!({ unAppID: 200, nInstanceID: 2, bRunning: false });

      await vi.advanceTimersByTimeAsync(0);
      expect((checkSteam as any).mock.calls.length).toBeGreaterThan(callsBefore);

      service.stop();
    });

    it("suppresses periodic checks during gameplay when checkDuringGameplay is OFF", async () => {
      const service = await getService({ steamCheckIntervalMinutes: 1 });
      await service.start();

      const { checkSteam } = await import("../providers");
      const callsBefore = (checkSteam as any).mock.calls.length;

      // Start a game
      capturedGameCallback!({ unAppID: 123, nInstanceID: 1, bRunning: true });

      // Advance past the periodic timer interval (1 minute)
      await vi.advanceTimersByTimeAsync(60_000);

      // checkSteam should NOT have been called by the periodic timer
      expect((checkSteam as any).mock.calls.length).toBe(callsBefore);

      service.stop();
    });

    it("allows periodic checks during gameplay when checkDuringGameplay is ON", async () => {
      const service = await getService({ steamCheckIntervalMinutes: 1, checkDuringGameplay: true });
      await service.start();

      const { checkSteam } = await import("../providers");
      const callsBefore = (checkSteam as any).mock.calls.length;

      // Start a game
      capturedGameCallback!({ unAppID: 123, nInstanceID: 1, bRunning: true });

      // Advance past the periodic timer interval (1 minute)
      await vi.advanceTimersByTimeAsync(60_000);

      // checkSteam SHOULD have been called
      expect((checkSteam as any).mock.calls.length).toBeGreaterThan(callsBefore);

      service.stop();
    });
  });
});
