/**
 * Tests for steamClient.ts pure functions and SteamClient interaction logic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { callPluginMethod, debugMock, logMock, logWarnMock, logErrorMock, debugState } = vi.hoisted(() => ({
  callPluginMethod: vi.fn(),
  debugMock: vi.fn(),
  logMock: vi.fn(),
  logWarnMock: vi.fn(),
  logErrorMock: vi.fn(),
  debugState: { enabled: false },
}));

vi.mock("../deckyApi", () => ({ callPluginMethod }));
vi.mock("../helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../helpers")>()),
  log: logMock,
  logWarn: logWarnMock,
  logError: logErrorMock,
  debug: debugMock,
  isDebugEnabled: () => debugState.enabled,
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
  forceStartAllUpdates,
  probeSteamClientApi,
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

const SCHEDULED_AT = 1_790_000_000;

function scheduledItem(appid: number, overrides: Partial<DownloadItem> = {}): DownloadItem {
  return makeDownloadItem({ appid, deferred_time: SCHEDULED_AT, queue_index: -1, ...overrides });
}

function seaOfThieves(): DownloadItem {
  return scheduledItem(1172620, {
    buildid: 0,
    target_buildid: 0,
    deferred_time: 1_791_020_702,
    update_type_info: [{ ...makeDownloadItem().update_type_info[0], progress: [] }],
  });
}

function downloadingItem(appid: number, overrides: Partial<DownloadItem> = {}): DownloadItem {
  return makeDownloadItem({ appid, active: true, deferred_time: 0, queue_index: 0, ...overrides });
}

function installSteamClient(
  initialItems: DownloadItem[],
  opts: { onResume?: (appId: number, state: { items: DownloadItem[] }) => void } = {},
) {
  const state = { items: initialItems };
  const downloads = {
    RegisterForDownloadItems: vi.fn((cb: (isDownloading: boolean, items: unknown[]) => void) => {
      Promise.resolve().then(() => cb(false, state.items));
      return { unregister: vi.fn() };
    }),
    ResumeAppUpdate: vi.fn((appId: number) => opts.onResume?.(appId, state)),
    QueueAppUpdate: vi.fn(),
    EnableAllDownloads: vi.fn(),
    SuspendDownloadThrottling: vi.fn(),
  };
  const apps = { SetAppAutoUpdateBehavior: vi.fn() };
  (globalThis as any).SteamClient = { Apps: apps, User: {}, System: {}, Downloads: downloads };
  return { state, downloads, apps };
}

function breakReads(
  downloads: ReturnType<typeof installSteamClient>["downloads"],
  mode: (call: number) => "hang" | "throw" | null,
) {
  const working = downloads.RegisterForDownloadItems.getMockImplementation()!;
  let call = 0;
  downloads.RegisterForDownloadItems.mockImplementation((cb: (isDownloading: boolean, items: unknown[]) => void) => {
    const broken = mode(++call);
    if (broken === "throw") throw new Error("steam gone");
    return broken === "hang" ? { unregister: vi.fn() } : working(cb);
  });
}

function flagsFor(flags: Record<string, number> | number) {
  callPluginMethod.mockImplementation(async (method: string, args: unknown[]) => {
    if (method !== "get_app_state_flags_batch") return undefined;
    const ids = (args as number[][])[0];
    return Object.fromEntries(
      ids.map((id) => [String(id), typeof flags === "number" ? flags : (flags[String(id)] ?? -1)]),
    );
  });
}

function backendCalls(method: string) {
  return callPluginMethod.mock.calls.filter((c) => c[0] === method);
}

beforeEach(() => {
  callPluginMethod.mockReset();
  debugMock.mockReset();
  logMock.mockReset();
  logWarnMock.mockReset();
  logErrorMock.mockReset();
  debugState.enabled = false;
  flagsFor(6);
});

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

  it("does not log on every call", () => {
    (globalThis as any).SteamClient = { Apps: {}, Downloads: {}, User: {}, System: {} };
    debugState.enabled = true;
    isSteamClientAvailable();
    isSteamClientAvailable();
    expect(debugMock).not.toHaveBeenCalled();
    expect(logMock).not.toHaveBeenCalled();
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

  it("returns null when no resume API exists", () => {
    (globalThis as any).SteamClient = { Apps: {}, Downloads: {}, User: {}, System: {} };
    const result = registerForResume(() => {});
    expect(result).toBeNull();
  });

  it("registers with the legacy System API and reports it", () => {
    const unregisterMock = vi.fn();
    const registerMock = vi.fn((_cb: () => void) => ({ unregister: unregisterMock }));
    (globalThis as any).SteamClient = {
      Apps: {},
      Downloads: {},
      User: {},
      System: { RegisterForOnResumeFromSuspend: registerMock },
    };

    const callback = vi.fn();
    const registration = registerForResume(callback);
    expect(registration).not.toBeNull();
    expect(registration!.api).toBe("System.RegisterForOnResumeFromSuspend");
    expect(registerMock).toHaveBeenCalledTimes(1);

    registerMock.mock.calls[0][0]();
    expect(callback).toHaveBeenCalledWith(undefined);

    registration!.unregister();
    expect(unregisterMock).toHaveBeenCalled();
  });

  it("passes the progress payload's state to the callback and reports the registered API", () => {
    const unregisterMock = vi.fn();
    const registerMock = vi.fn((_cb: (payload?: { state?: number }) => void) => ({ unregister: unregisterMock }));
    (globalThis as any).SteamClient = {
      Apps: {},
      Downloads: {},
      System: {},
      User: { RegisterForResumeSuspendedGamesProgress: registerMock },
    };

    const callback = vi.fn();
    const registration = registerForResume(callback);
    expect(registration).not.toBeNull();
    expect(registration!.api).toBe("User.RegisterForResumeSuspendedGamesProgress");

    const steamCallback = registerMock.mock.calls[0][0];
    steamCallback({ state: 5 });
    steamCallback({ state: 1 });
    expect(callback.mock.calls).toEqual([[5], [1]]);

    registration!.unregister();
    expect(unregisterMock).toHaveBeenCalled();
  });

  it("passes undefined when the progress payload has no numeric state", () => {
    const registerMock = vi.fn((_cb: (payload?: unknown) => void) => ({ unregister: vi.fn() }));
    (globalThis as any).SteamClient = {
      Apps: {},
      Downloads: {},
      System: {},
      User: { RegisterForResumeSuspendedGamesProgress: registerMock },
    };

    const callback = vi.fn();
    registerForResume(callback);
    const steamCallback = registerMock.mock.calls[0][0];
    steamCallback(undefined);
    steamCallback({});
    steamCallback({ state: "1" });
    expect(callback.mock.calls).toEqual([[undefined], [undefined], [undefined]]);
  });

  it("prefers the legacy System API when both exist", () => {
    const legacy = vi.fn(() => ({ unregister: vi.fn() }));
    const progress = vi.fn(() => ({ unregister: vi.fn() }));
    (globalThis as any).SteamClient = {
      Apps: {},
      Downloads: {},
      System: { RegisterForOnResumeFromSuspend: legacy },
      User: { RegisterForResumeSuspendedGamesProgress: progress },
    };

    const registration = registerForResume(() => {});
    expect(registration!.api).toBe("System.RegisterForOnResumeFromSuspend");
    expect(progress).not.toHaveBeenCalled();
  });

  it("falls back to the progress API when the legacy registration throws", () => {
    (globalThis as any).SteamClient = {
      Apps: {},
      Downloads: {},
      System: {
        RegisterForOnResumeFromSuspend: () => {
          throw new Error("boom");
        },
      },
      User: { RegisterForResumeSuspendedGamesProgress: vi.fn(() => ({ unregister: vi.fn() })) },
    };

    const registration = registerForResume(() => {});
    expect(registration!.api).toBe("User.RegisterForResumeSuspendedGamesProgress");
  });

  it("returns null if every registration throws", () => {
    const boom = () => {
      throw new Error("boom");
    };
    (globalThis as any).SteamClient = {
      Apps: {},
      Downloads: {},
      System: { RegisterForOnResumeFromSuspend: boom },
      User: { RegisterForResumeSuspendedGamesProgress: boom },
    };
    expect(registerForResume(() => {})).toBeNull();
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
    (globalThis as any).appStore = {
      GetAppOverviewByAppID: () => ({ display_name: "Game" }),
      m_mapApps: new Map(),
    };
    installSteamClient([
      makeDownloadItem({ appid: 1, completed: true }),
      makeDownloadItem({ appid: 2, completed: false }),
    ]);

    const result = await getPendingUpdates();
    expect(result.length).toBe(1);
    expect(result[0].appId).toBe(2);
    expect(backendCalls("get_app_state_flags_batch")).toEqual([["get_app_state_flags_batch", [[2]], 8_000]]);
  });

  it("filters out items without has_update", async () => {
    const item = makeDownloadItem({ appid: 1 });
    item.update_type_info[0].has_update = false;
    installSteamClient([item]);

    const result = await getPendingUpdates();
    expect(result).toEqual([]);
  });

  it("keeps only manifests with FullyInstalled and UpdateRequired set", async () => {
    flagsFor({ "1": -1, "2": 4, "3": 6, "4": 70 });
    installSteamClient([1, 2, 3, 4].map((appid) => makeDownloadItem({ appid })));

    const result = await getPendingUpdates();
    expect(result.map((u) => u.appId)).toEqual([3, 4]);
  });

  it("falls back to the loose filter when the backend lookup rejects", async () => {
    callPluginMethod.mockRejectedValue(new Error("ipc down"));
    installSteamClient([makeDownloadItem({ appid: 1 }), makeDownloadItem({ appid: 2, completed: true })]);

    const result = await getPendingUpdates();
    expect(result.map((u) => u.appId)).toEqual([1]);
    expect(logWarnMock).toHaveBeenCalled();
  });

  it("makes no backend call when there are no candidates", async () => {
    installSteamClient([makeDownloadItem({ appid: 1, completed: true })]);
    expect(await getPendingUpdates()).toEqual([]);

    installSteamClient([]);
    expect(await getPendingUpdates()).toEqual([]);

    expect(callPluginMethod).not.toHaveBeenCalled();
  });

  describe("duplicate appids", () => {
    const older = () =>
      scheduledItem(1493710, { buildid: 25262136, target_buildid: 25406101, deferred_time: 1_791_028_299 });
    const newer = () => scheduledItem(1493710, { buildid: 25406101, target_buildid: 25502719 });

    it("keeps the entry with the highest target_buildid and counts the app once", async () => {
      installSteamClient([older(), makeDownloadItem({ appid: 7 }), newer()]);

      const result = await getPendingUpdates();
      expect(result.map((u) => u.appId)).toEqual([1493710, 7]);
      expect(backendCalls("get_app_state_flags_batch")[0][1]).toEqual([[1493710, 7]]);
    });

    it("picks the newest build regardless of order", async () => {
      installSteamClient([newer(), older()]);

      const result = await getPendingUpdates();
      expect(result).toHaveLength(1);
      expect(result[0].state).toBe("scheduled");
      expect(debugMock).toHaveBeenCalledWith(expect.stringContaining("ignored 1 superseded duplicate items"));
    });

    it("logs a single debug line only when duplicates were dropped", async () => {
      installSteamClient([makeDownloadItem({ appid: 1 }), makeDownloadItem({ appid: 2 })]);
      await getPendingUpdates();
      expect(debugMock).not.toHaveBeenCalledWith(expect.stringContaining("superseded duplicate"));

      installSteamClient([older(), newer(), scheduledItem(1493710, { target_buildid: 1 })]);
      debugMock.mockClear();
      await getPendingUpdates();
      const lines = debugMock.mock.calls.filter((c) => String(c[0]).includes("superseded duplicate"));
      expect(lines).toHaveLength(1);
      expect(lines[0][0]).toContain("ignored 2 superseded duplicate items");
    });

    it("on equal target_buildid prefers active, then queued, then not deferred", async () => {
      const deferred = scheduledItem(5, { target_buildid: 300 });
      const queued = makeDownloadItem({ appid: 5, target_buildid: 300, queue_index: 2, deferred_time: SCHEDULED_AT });
      const idle = makeDownloadItem({ appid: 5, target_buildid: 300, queue_index: -1, deferred_time: 0 });
      const active = downloadingItem(5, { target_buildid: 300, queue_index: -1 });

      installSteamClient([deferred, active, queued]);
      expect((await getPendingUpdates())[0].state).toBe("downloading");

      installSteamClient([deferred, queued, idle]);
      expect((await getPendingUpdates())[0].state).toBe("scheduled");

      installSteamClient([deferred, idle]);
      expect((await getPendingUpdates())[0].state).toBe("queued");
    });
  });

  describe("no-op items", () => {
    const noop = () =>
      scheduledItem(3830, {
        buildid: 5757472,
        target_buildid: 5757472,
        update_type_info: [{ ...makeDownloadItem().update_type_info[0], progress: [] }],
      });

    it("excludes items with buildid == target_buildid and zero bytes", async () => {
      installSteamClient([noop(), makeDownloadItem({ appid: 2 })]);

      const result = await getPendingUpdates();
      expect(result.map((u) => u.appId)).toEqual([2]);
      expect(backendCalls("get_app_state_flags_batch")[0][1]).toEqual([[2]]);
    });

    it("makes no backend call when only no-op items are present", async () => {
      installSteamClient([noop()]);

      expect(await getPendingUpdates()).toEqual([]);
      expect(callPluginMethod).not.toHaveBeenCalled();
    });

    it("keeps same-build items that still have bytes to download", async () => {
      installSteamClient([scheduledItem(9, { buildid: 200, target_buildid: 200 })]);

      const result = await getPendingUpdates();
      expect(result.map((u) => u.appId)).toEqual([9]);
    });

    it("keeps scheduled items Steam reports as build 0 -> 0 with no bytes yet", async () => {
      installSteamClient([seaOfThieves()]);

      const result = await getPendingUpdates();
      expect(result.map((u) => [u.appId, u.state])).toEqual([[1172620, "scheduled"]]);
    });

    it("keeps items with no build information", async () => {
      installSteamClient([scheduledItem(9, { buildid: undefined as any, target_buildid: undefined as any })]);

      const result = await getPendingUpdates();
      expect(result.map((u) => u.appId)).toEqual([9]);
    });

    it("keeps zero-byte items whose build changed", async () => {
      installSteamClient([
        scheduledItem(9, {
          buildid: 100,
          target_buildid: 200,
          update_type_info: [{ ...makeDownloadItem().update_type_info[0], progress: [] }],
        }),
      ]);

      const result = await getPendingUpdates();
      expect(result.map((u) => u.appId)).toEqual([9]);
    });
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

  it("calls ResumeAppUpdate with appId and LOCAL_CLIENT_ID and returns true", async () => {
    const resumeMock = vi.fn();
    (globalThis as any).SteamClient = {
      Apps: {},
      User: {},
      System: {},
      Downloads: { ResumeAppUpdate: resumeMock },
    };

    const result = await forceStartUpdate(12345);
    expect(result).toBe(true);
    // SteamClient.Downloads.* methods take (appId, remoteClientId). "0" identifies
    // the local Steam client; calls without it silently no-op on current builds.
    expect(resumeMock).toHaveBeenCalledWith(12345, "0");
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

describe("forceStartAllUpdates", () => {
  const startOnResume = (appId: number, state: { items: DownloadItem[] }) => {
    state.items = state.items.map((it) => (it.appid === appId ? downloadingItem(appId) : it));
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    (globalThis as any).SteamClient = undefined;
  });

  async function run(maxMs = 30_000) {
    const promise = forceStartAllUpdates();
    await vi.advanceTimersByTimeAsync(maxMs);
    return promise;
  }

  it("leaves global download settings alone when nothing is scheduled", async () => {
    const { downloads, apps } = installSteamClient([downloadingItem(1), makeDownloadItem({ appid: 2 })]);

    const result = await run();

    expect(downloads.EnableAllDownloads).not.toHaveBeenCalled();
    expect(downloads.SuspendDownloadThrottling).not.toHaveBeenCalled();
    expect(downloads.ResumeAppUpdate).not.toHaveBeenCalled();
    expect(apps.SetAppAutoUpdateBehavior).not.toHaveBeenCalled();
    expect(result).toMatchObject({ source: "steam", pendingCount: 0, forcedCount: 0, errors: [], updates: [] });
  });

  it("makes no backend call when Steam reports nothing", async () => {
    installSteamClient([]);
    await run();
    expect(callPluginMethod).not.toHaveBeenCalled();
  });

  it("enables downloads and runs the force-start recipe for each scheduled app", async () => {
    const { downloads, apps } = installSteamClient([scheduledItem(1), scheduledItem(2), downloadingItem(3)], {
      onResume: startOnResume,
    });

    const result = await run();

    expect(downloads.EnableAllDownloads).toHaveBeenCalledWith(true, "0");
    expect(downloads.SuspendDownloadThrottling).toHaveBeenCalledWith(true, "0");
    for (const appId of [1, 2]) {
      expect(apps.SetAppAutoUpdateBehavior).toHaveBeenCalledWith(appId, 0);
      expect(downloads.QueueAppUpdate).toHaveBeenCalledWith(appId, "0");
      expect(downloads.ResumeAppUpdate).toHaveBeenCalledWith(appId, "0");
    }
    expect(downloads.ResumeAppUpdate).not.toHaveBeenCalledWith(3, "0");
    expect(result.pendingCount).toBe(2);
    expect(result.forcedCount).toBe(2);
    expect(result.updates.map((u) => u.appId)).toEqual([1, 2]);
  });

  it("stops polling as soon as the forced items leave the scheduled state", async () => {
    const { downloads } = installSteamClient([scheduledItem(1)], { onResume: startOnResume });

    const promise = forceStartAllUpdates();
    await vi.advanceTimersByTimeAsync(400);
    expect(downloads.RegisterForDownloadItems).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(downloads.RegisterForDownloadItems).toHaveBeenCalledTimes(2);

    const result = await promise;
    expect(result.forcedCount).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(downloads.RegisterForDownloadItems).toHaveBeenCalledTimes(2);
    expect(backendCalls("force_steam_app_update")).toHaveLength(0);
  });

  it("only dumps the post-force item when debug is enabled", async () => {
    debugState.enabled = false;
    let steam = installSteamClient([scheduledItem(1)], { onResume: startOnResume });
    await run();
    expect(steam.downloads.RegisterForDownloadItems).toHaveBeenCalledTimes(2);

    debugState.enabled = true;
    steam = installSteamClient([scheduledItem(1)], { onResume: startOnResume });
    await run();
    expect(steam.downloads.RegisterForDownloadItems).toHaveBeenCalledTimes(3);
    expect(debugMock).toHaveBeenCalledWith(expect.stringContaining("POST-FORCE"), expect.anything());
  });

  it("polls every 500 ms for up to 4 s, then falls back to the backend without a retry pass", async () => {
    const { downloads, apps } = installSteamClient([scheduledItem(1)]);
    callPluginMethod.mockImplementation(async (method: string, args: unknown[]) => {
      if (method === "force_steam_app_update")
        return { success: true, manifest_modified: false, url_invoked: true, error: "" };
      return Object.fromEntries((args as number[][])[0].map((id) => [String(id), 6]));
    });

    const promise = forceStartAllUpdates();
    await vi.advanceTimersByTimeAsync(3_900);
    expect(backendCalls("force_steam_app_update")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(backendCalls("force_steam_app_update")).toEqual([["force_steam_app_update", [1], 15_000]]);

    const result = await (async () => {
      await vi.advanceTimersByTimeAsync(20_000);
      return promise;
    })();

    expect(apps.SetAppAutoUpdateBehavior).toHaveBeenCalledTimes(1);
    expect(downloads.QueueAppUpdate).toHaveBeenCalledTimes(1);
    expect(downloads.ResumeAppUpdate).toHaveBeenCalledTimes(1);
    expect(backendCalls("force_steam_app_update")).toHaveLength(1);
    expect(result).toMatchObject({ pendingCount: 1, forcedCount: 0 });
  });

  it("counts unique appids that left scheduled and falls back only for the stuck ones", async () => {
    installSteamClient([scheduledItem(1), scheduledItem(2)], {
      onResume: (appId, state) => {
        if (appId === 1) startOnResume(appId, state);
      },
    });

    const result = await run();

    expect(backendCalls("force_steam_app_update").map((c) => c[1])).toEqual([[2]]);
    expect(result).toMatchObject({ pendingCount: 2, forcedCount: 1 });
  });

  it("force-starts and counts a duplicated appid once", async () => {
    const { downloads } = installSteamClient(
      [
        scheduledItem(1493710, { buildid: 25262136, target_buildid: 25406101 }),
        scheduledItem(1493710, { buildid: 25406101, target_buildid: 25502719 }),
        scheduledItem(2),
      ],
      { onResume: startOnResume },
    );

    const result = await run();

    expect(downloads.ResumeAppUpdate.mock.calls.filter((c) => c[0] === 1493710)).toHaveLength(1);
    expect(result).toMatchObject({ pendingCount: 2, forcedCount: 2 });
    expect(backendCalls("force_steam_app_update")).toHaveLength(0);
  });

  it("force-starts a scheduled item Steam reports as build 0 -> 0 with no bytes yet", async () => {
    const { downloads } = installSteamClient([seaOfThieves()], { onResume: startOnResume });

    const result = await run();

    expect(downloads.QueueAppUpdate).toHaveBeenCalledWith(1172620, "0");
    expect(downloads.ResumeAppUpdate).toHaveBeenCalledWith(1172620, "0");
    expect(result).toMatchObject({ pendingCount: 1, forcedCount: 1, errors: [] });
    expect(result.updates.map((u) => u.appId)).toEqual([1172620]);
  });

  it("ignores no-op items entirely", async () => {
    const noop = scheduledItem(3830, {
      buildid: 5757472,
      target_buildid: 5757472,
      update_type_info: [{ ...makeDownloadItem().update_type_info[0], progress: [] }],
    });
    const { downloads } = installSteamClient([noop]);

    const result = await run();

    expect(downloads.EnableAllDownloads).not.toHaveBeenCalled();
    expect(downloads.ResumeAppUpdate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ pendingCount: 0, forcedCount: 0, updates: [] });
  });

  describe("when Steam does not report the download state", () => {
    const UNKNOWN = "Steam did not report download state";

    it("reports an error instead of 'up to date' when the first read times out", async () => {
      const downloads = installSteamClient([scheduledItem(1)]).downloads;
      breakReads(downloads, () => "hang");

      const result = await run();

      expect(result.pendingCount).toBe(0);
      expect(result.forcedCount).toBe(0);
      expect(result.errors).toEqual([expect.stringContaining(UNKNOWN)]);
      expect(downloads.EnableAllDownloads).not.toHaveBeenCalled();
      expect(downloads.ResumeAppUpdate).not.toHaveBeenCalled();
      expect(backendCalls("force_steam_app_update")).toHaveLength(0);
    });

    it("reports an error when the first read throws", async () => {
      const downloads = installSteamClient([scheduledItem(1)]).downloads;
      breakReads(downloads, () => "throw");

      const result = await run();

      expect(result.forcedCount).toBe(0);
      expect(result.errors).toEqual([expect.stringContaining(UNKNOWN)]);
    });

    it("reports an error when SteamClient is missing", async () => {
      (globalThis as any).SteamClient = undefined;

      const result = await run();

      expect(result).toMatchObject({ pendingCount: 0, forcedCount: 0 });
      expect(result.errors).toEqual([expect.stringContaining(UNKNOWN)]);
    });

    it("does not count apps as started when every re-check read fails", async () => {
      const downloads = installSteamClient([scheduledItem(1), scheduledItem(2)], { onResume: startOnResume }).downloads;
      breakReads(downloads, (call) => (call > 1 ? "hang" : null));

      const result = await run();

      expect(result.pendingCount).toBe(2);
      expect(result.forcedCount).toBe(0);
      expect(result.errors).toEqual([expect.stringContaining("could not confirm 2 update(s) started")]);
      expect(result.errors[0]).toContain(UNKNOWN);
      expect(backendCalls("force_steam_app_update")).toHaveLength(0);
    });

    it("counts only apps confirmed out of the scheduled state", async () => {
      const downloads = installSteamClient([scheduledItem(1), scheduledItem(2)], {
        onResume: (appId, state) => {
          if (appId === 1) startOnResume(appId, state);
        },
      }).downloads;
      breakReads(downloads, (call) => (call > 2 ? "hang" : null));

      const result = await run();

      expect(result).toMatchObject({ pendingCount: 2, forcedCount: 1 });
      expect(result.errors).toEqual([expect.stringContaining("could not confirm 1 update(s) started")]);
      expect(backendCalls("force_steam_app_update")).toHaveLength(0);
    });

    it("keeps polling past a failed read and trusts the next good one", async () => {
      const downloads = installSteamClient([scheduledItem(1)], { onResume: startOnResume }).downloads;
      breakReads(downloads, (call) => (call === 2 ? "throw" : null));

      const promise = forceStartAllUpdates();
      await vi.advanceTimersByTimeAsync(500);
      expect(downloads.RegisterForDownloadItems).toHaveBeenCalledTimes(2);
      const result = await (async () => {
        await vi.advanceTimersByTimeAsync(500);
        return promise;
      })();

      expect(downloads.RegisterForDownloadItems).toHaveBeenCalledTimes(3);
      expect(result).toMatchObject({ pendingCount: 1, forcedCount: 1, errors: [] });
      expect(backendCalls("force_steam_app_update")).toHaveLength(0);
    });

    it("still falls back to the backend when the reads work but the apps stay scheduled", async () => {
      installSteamClient([scheduledItem(1)]);
      callPluginMethod.mockImplementation(async (method: string, args: unknown[]) => {
        if (method === "force_steam_app_update")
          return { success: true, manifest_modified: true, url_invoked: true, error: "" };
        return Object.fromEntries((args as number[][])[0].map((id) => [String(id), 6]));
      });

      const result = await run();

      expect(backendCalls("force_steam_app_update")).toHaveLength(1);
      expect(result).toMatchObject({ pendingCount: 1, forcedCount: 0, errors: [] });
    });

    it("does not count the backend fallback as started when the reads then fail", async () => {
      const downloads = installSteamClient([scheduledItem(1)]).downloads;
      breakReads(downloads, () => (backendCalls("force_steam_app_update").length > 0 ? "hang" : null));
      callPluginMethod.mockImplementation(async (method: string, args: unknown[]) => {
        if (method === "force_steam_app_update")
          return { success: true, manifest_modified: true, url_invoked: true, error: "" };
        return Object.fromEntries((args as number[][])[0].map((id) => [String(id), 6]));
      });

      const result = await run();

      expect(backendCalls("force_steam_app_update")).toHaveLength(1);
      expect(result.forcedCount).toBe(0);
      expect(result.errors).toEqual([expect.stringContaining("could not confirm 1 update(s) started")]);
    });
  });
});

describe("getPendingUpdates when Steam does not answer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    (globalThis as any).SteamClient = undefined;
  });

  it("still resolves an empty list after the read times out", async () => {
    breakReads(installSteamClient([scheduledItem(1)]).downloads, () => "hang");

    const promise = getPendingUpdates();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await promise).toEqual([]);
    expect(logWarnMock).toHaveBeenCalledWith(expect.stringContaining("timed out"));
  });

  it("still resolves an empty list when the registration throws", async () => {
    breakReads(installSteamClient([scheduledItem(1)]).downloads, () => "throw");

    expect(await getPendingUpdates()).toEqual([]);
  });
});

describe("probeSteamClientApi", () => {
  const probeClient = () => ({
    Apps: { SetAppAutoUpdateBehavior: vi.fn(), InstallApp: vi.fn() },
    User: {},
    System: {},
    Downloads: { RegisterForDownloadItems: vi.fn(), ResumeAppUpdate: vi.fn(), EnableAllDownloads: vi.fn() },
  });

  afterEach(() => {
    (globalThis as any).SteamClient = undefined;
  });

  it("does not log dumps at info level", () => {
    (globalThis as any).SteamClient = probeClient();
    probeSteamClientApi();
    expect(logMock).not.toHaveBeenCalled();
    expect(debugMock).not.toHaveBeenCalled();
  });

  it("emits dumps through debug when debug is enabled", () => {
    (globalThis as any).SteamClient = probeClient();
    debugState.enabled = true;
    probeSteamClientApi();
    expect(logMock).not.toHaveBeenCalled();
    expect(debugMock).toHaveBeenCalledWith(
      "SteamClient.Downloads methods:",
      expect.stringContaining("ResumeAppUpdate"),
    );
  });

  it("still reports a missing Downloads namespace and missing methods as errors", () => {
    (globalThis as any).SteamClient = { Apps: {}, User: {}, System: {} };
    probeSteamClientApi();
    expect(logErrorMock).toHaveBeenCalledWith("SteamClient.Downloads is missing!");

    logErrorMock.mockClear();
    (globalThis as any).SteamClient = { ...probeClient(), Downloads: { ResumeAppUpdate: vi.fn() } };
    probeSteamClientApi();
    expect(logErrorMock).toHaveBeenCalledWith(
      "SteamClient.Downloads MISSING expected methods:",
      "RegisterForDownloadItems, EnableAllDownloads",
    );
  });
});
