/**
 * Tests for steamClient.ts pure functions and SteamClient interaction logic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock @decky/api before importing steamClient
vi.mock("@decky/api", () => ({
  callable: () => vi.fn(),
  toaster: { toast: vi.fn() },
}));

import {
  isSteamClientAvailable,
  waitForSteamClient,
  registerForResume,
  registerForAppLifetime,
  getAppName,
  determineState,
  getDownloadBytes,
  getPendingUpdates,
  forceStartUpdate,
} from "../steamClient";
import type { DownloadItem } from "../types";

// ── Helpers for building mock objects ────────────────────

function makeDownloadItem(overrides: Partial<DownloadItem> = {}): DownloadItem {
  return {
    appid: 12345,
    active: false,
    paused: false,
    completed: false,
    deferred_time: 0,
    queue_index: 0,
    update_result: 0,
    update_error: "",
    completed_time: 0,
    buildid: 100,
    target_buildid: 200,
    launch_on_completion: false,
    update_type_info: [
      {
        has_update: true,
        completed_update: false,
        estimated_time_remaining_sec: 0,
        progress: [
          { bytes_in_progress: 0, bytes_total: 0, estimated_time_remaining_sec: 0 },
          { bytes_in_progress: 0, bytes_total: 0, estimated_time_remaining_sec: 0 },
          { bytes_in_progress: 500, bytes_total: 1000, estimated_time_remaining_sec: 60 },
        ],
        overall_percent_complete: 50,
        overall_estimated_time_remaining_sec: 60,
      },
    ],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────

describe("isSteamClientAvailable", () => {
  afterEach(() => {
    (globalThis as any).SteamClient = undefined;
  });

  it("returns false when SteamClient is undefined", () => {
    (globalThis as any).SteamClient = undefined;
    expect(isSteamClientAvailable()).toBe(false);
  });

  it("returns false when SteamClient is null", () => {
    (globalThis as any).SteamClient = null;
    expect(isSteamClientAvailable()).toBe(false);
  });

  it("returns true when SteamClient exists", () => {
    (globalThis as any).SteamClient = { Apps: {}, Downloads: {}, User: {}, System: {} };
    expect(isSteamClientAvailable()).toBe(true);
  });
});

describe("waitForSteamClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as any).SteamClient = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
    (globalThis as any).SteamClient = undefined;
  });

  it("resolves immediately if SteamClient already available", async () => {
    (globalThis as any).SteamClient = { Apps: {}, Downloads: {}, User: {}, System: {} };
    const result = await waitForSteamClient(5000);
    expect(result).toBe(true);
  });

  it("resolves true when SteamClient becomes available during polling", async () => {
    const promise = waitForSteamClient(10_000);

    // SteamClient not available yet, advance past first poll
    vi.advanceTimersByTime(2000);

    // Now make it available
    (globalThis as any).SteamClient = { Apps: {}, Downloads: {}, User: {}, System: {} };
    vi.advanceTimersByTime(2000);

    const result = await promise;
    expect(result).toBe(true);
  });

  it("resolves false on timeout", async () => {
    const promise = waitForSteamClient(5000);
    vi.advanceTimersByTime(6000);
    const result = await promise;
    expect(result).toBe(false);
  });
});

describe("registerForResume", () => {
  afterEach(() => {
    (globalThis as any).SteamClient = undefined;
  });

  it("returns null when SteamClient is unavailable", () => {
    (globalThis as any).SteamClient = undefined;
    const result = registerForResume(() => {});
    expect(result).toBeNull();
  });

  it("returns null when System.RegisterForOnResumeFromSuspend is missing", () => {
    (globalThis as any).SteamClient = { Apps: {}, Downloads: {}, User: {}, System: {} };
    const result = registerForResume(() => {});
    expect(result).toBeNull();
  });

  it("registers callback and returns unregister function", () => {
    const unregisterMock = vi.fn();
    (globalThis as any).SteamClient = {
      Apps: {},
      Downloads: {},
      User: {},
      System: {
        RegisterForOnResumeFromSuspend: vi.fn(() => ({ unregister: unregisterMock })),
      },
    };

    const unregister = registerForResume(() => {});
    expect(unregister).not.toBeNull();
    expect((globalThis as any).SteamClient.System.RegisterForOnResumeFromSuspend).toHaveBeenCalled();

    // Call unregister
    unregister!();
    expect(unregisterMock).toHaveBeenCalled();
  });

  it("returns null if RegisterForOnResumeFromSuspend throws", () => {
    (globalThis as any).SteamClient = {
      Apps: {},
      Downloads: {},
      User: {},
      System: {
        RegisterForOnResumeFromSuspend: () => {
          throw new Error("boom");
        },
      },
    };
    const result = registerForResume(() => {});
    expect(result).toBeNull();
  });
});

describe("registerForAppLifetime", () => {
  afterEach(() => {
    (globalThis as any).SteamClient = undefined;
  });

  it("returns null when SteamClient is unavailable", () => {
    (globalThis as any).SteamClient = undefined;
    const result = registerForAppLifetime(() => {});
    expect(result).toBeNull();
  });

  it("returns null when GameSessions is missing", () => {
    (globalThis as any).SteamClient = { Apps: {}, Downloads: {}, User: {}, System: {} };
    const result = registerForAppLifetime(() => {});
    expect(result).toBeNull();
  });

  it("returns null when RegisterForAppLifetimeNotifications is missing", () => {
    (globalThis as any).SteamClient = {
      Apps: {},
      Downloads: {},
      GameSessions: {},
      User: {},
      System: {},
    };
    const result = registerForAppLifetime(() => {});
    expect(result).toBeNull();
  });

  it("registers callback and returns unregister function", () => {
    const unregisterMock = vi.fn();
    const registerMock = vi.fn(() => ({ unregister: unregisterMock }));
    (globalThis as any).SteamClient = {
      Apps: {},
      Downloads: {},
      GameSessions: { RegisterForAppLifetimeNotifications: registerMock },
      User: {},
      System: {},
    };

    const cb = vi.fn();
    const unregister = registerForAppLifetime(cb);
    expect(unregister).not.toBeNull();
    expect(registerMock).toHaveBeenCalledWith(cb);

    unregister!();
    expect(unregisterMock).toHaveBeenCalled();
  });

  it("returns null if RegisterForAppLifetimeNotifications throws", () => {
    (globalThis as any).SteamClient = {
      Apps: {},
      Downloads: {},
      GameSessions: {
        RegisterForAppLifetimeNotifications: () => {
          throw new Error("boom");
        },
      },
      User: {},
      System: {},
    };
    const result = registerForAppLifetime(() => {});
    expect(result).toBeNull();
  });
});

describe("determineState", () => {
  it("returns 'downloading' when active", () => {
    expect(determineState(makeDownloadItem({ active: true }))).toBe("downloading");
  });

  it("returns 'paused' when paused", () => {
    expect(determineState(makeDownloadItem({ paused: true }))).toBe("paused");
  });

  it("returns 'scheduled' when deferred_time > 0", () => {
    expect(determineState(makeDownloadItem({ deferred_time: 123 }))).toBe("scheduled");
  });

  it("returns 'queued' as default", () => {
    expect(determineState(makeDownloadItem())).toBe("queued");
  });

  it("prioritizes active over paused", () => {
    expect(determineState(makeDownloadItem({ active: true, paused: true }))).toBe("downloading");
  });
});

describe("getDownloadBytes", () => {
  it("extracts bytes from progress[2]", () => {
    const item = makeDownloadItem();
    const result = getDownloadBytes(item);
    expect(result.downloaded).toBe(500);
    expect(result.total).toBe(1000);
  });

  it("returns zeros when update_type_info is empty", () => {
    const item = makeDownloadItem({ update_type_info: [] });
    const result = getDownloadBytes(item);
    expect(result.downloaded).toBe(0);
    expect(result.total).toBe(0);
  });

  it("returns zeros when progress is missing", () => {
    const item = makeDownloadItem({
      update_type_info: [
        {
          has_update: true,
          completed_update: false,
          estimated_time_remaining_sec: 0,
          progress: [],
          overall_percent_complete: 0,
          overall_estimated_time_remaining_sec: 0,
        },
      ],
    });
    const result = getDownloadBytes(item);
    expect(result.downloaded).toBe(0);
    expect(result.total).toBe(0);
  });

  it("returns zeros when progress[2] is undefined", () => {
    const item = makeDownloadItem({
      update_type_info: [
        {
          has_update: true,
          completed_update: false,
          estimated_time_remaining_sec: 0,
          progress: [{ bytes_in_progress: 0, bytes_total: 0, estimated_time_remaining_sec: 0 }],
          overall_percent_complete: 0,
          overall_estimated_time_remaining_sec: 0,
        },
      ],
    });
    const result = getDownloadBytes(item);
    expect(result.downloaded).toBe(0);
    expect(result.total).toBe(0);
  });
});

describe("getAppName", () => {
  afterEach(() => {
    (globalThis as any).appStore = undefined;
  });

  it("returns display_name when available", () => {
    (globalThis as any).appStore = {
      GetAppOverviewByAppID: () => ({ display_name: "Half-Life 3" }),
      m_mapApps: new Map(),
    };
    expect(getAppName(12345)).toBe("Half-Life 3");
  });

  it("falls back to app_name", () => {
    (globalThis as any).appStore = {
      GetAppOverviewByAppID: () => ({ app_name: "HL3" }),
      m_mapApps: new Map(),
    };
    expect(getAppName(12345)).toBe("HL3");
  });

  it("returns fallback when appStore is undefined", () => {
    (globalThis as any).appStore = undefined;
    expect(getAppName(12345)).toBe("App 12345");
  });

  it("returns fallback when overview is null", () => {
    (globalThis as any).appStore = {
      GetAppOverviewByAppID: () => null,
      m_mapApps: new Map(),
    };
    expect(getAppName(12345)).toBe("App 12345");
  });

  it("returns fallback when GetAppOverviewByAppID throws", () => {
    (globalThis as any).appStore = {
      GetAppOverviewByAppID: () => {
        throw new Error("nope");
      },
      m_mapApps: new Map(),
    };
    expect(getAppName(12345)).toBe("App 12345");
  });
});

describe("getPendingUpdates", () => {
  afterEach(() => {
    (globalThis as any).SteamClient = undefined;
    (globalThis as any).appStore = undefined;
  });

  it("returns empty array when SteamClient unavailable", async () => {
    (globalThis as any).SteamClient = undefined;
    const result = await getPendingUpdates();
    expect(result).toEqual([]);
  });

  it("filters out completed items", async () => {
    const items = [makeDownloadItem({ appid: 1, completed: true }), makeDownloadItem({ appid: 2, completed: false })];

    (globalThis as any).appStore = {
      GetAppOverviewByAppID: () => ({ display_name: "Game" }),
      m_mapApps: new Map(),
    };
    (globalThis as any).SteamClient = {
      Apps: {},
      User: {},
      System: {},
      Downloads: {
        RegisterForDownloadItems: (cb: any) => {
          // Steam calls the callback async (next microtask), so simulate that
          const handle = { unregister: vi.fn() };
          Promise.resolve().then(() => cb(false, items));
          return handle;
        },
      },
    };

    const result = await getPendingUpdates();
    expect(result.length).toBe(1);
    expect(result[0].appId).toBe(2);
  });

  it("filters out items without has_update", async () => {
    const item = makeDownloadItem({ appid: 1 });
    item.update_type_info[0].has_update = false;

    (globalThis as any).SteamClient = {
      Apps: {},
      User: {},
      System: {},
      Downloads: {
        RegisterForDownloadItems: (cb: any) => {
          const handle = { unregister: vi.fn() };
          Promise.resolve().then(() => cb(false, [item]));
          return handle;
        },
      },
    };

    const result = await getPendingUpdates();
    expect(result).toEqual([]);
  });
});

describe("forceStartUpdate", () => {
  afterEach(() => {
    (globalThis as any).SteamClient = undefined;
  });

  it("returns false when SteamClient unavailable", async () => {
    (globalThis as any).SteamClient = undefined;
    const result = await forceStartUpdate(12345);
    expect(result).toBe(false);
  });

  it("calls ResumeAppUpdate and returns true", async () => {
    const resumeMock = vi.fn();
    (globalThis as any).SteamClient = {
      Apps: {},
      User: {},
      System: {},
      Downloads: { ResumeAppUpdate: resumeMock },
    };

    const result = await forceStartUpdate(12345);
    expect(result).toBe(true);
    expect(resumeMock).toHaveBeenCalledWith(12345);
  });

  it("returns false when ResumeAppUpdate throws", async () => {
    (globalThis as any).SteamClient = {
      Apps: {},
      User: {},
      System: {},
      Downloads: {
        ResumeAppUpdate: () => {
          throw new Error("network error");
        },
      },
    };

    const result = await forceStartUpdate(12345);
    expect(result).toBe(false);
  });
});
