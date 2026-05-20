import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCallPluginMethod = vi.fn();

vi.mock("../deckyApi", () => ({
  callPluginMethod: (...args: unknown[]) => mockCallPluginMethod(...args),
  isDeckyAvailable: vi.fn(),
  findPluginUpdates: (...args: unknown[]) => mockFindPluginUpdates(...args),
  installPluginsAndConfirm: (...args: unknown[]) => mockInstallPluginsAndConfirm(...args),
  checkDeckyLoaderUpdate: (...args: unknown[]) => mockCheckDeckyLoaderUpdate(...args),
  applyDeckyLoaderUpdate: (...args: unknown[]) => mockApplyDeckyLoaderUpdate(...args),
}));

vi.mock("../steamClient", () => ({
  forceStartAllUpdates: vi.fn(),
}));

// providers.ts no longer imports from @decky/api, but mock it in case
vi.mock("@decky/api", () => ({}));

import {
  checkAndApplyFlatpak,
  isFlatpakAvailable,
  applyDeckyPluginUpdates,
  checkAndApplyDeckyLoaderUpdate,
  checkAndApplySteamos,
} from "../providers";

const mockFindPluginUpdates = vi.fn();
const mockInstallPluginsAndConfirm = vi.fn();
const mockCheckDeckyLoaderUpdate = vi.fn();
const mockApplyDeckyLoaderUpdate = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

function mockBackendMethod(method: string, response: unknown) {
  mockCallPluginMethod.mockImplementation((name: string) => {
    if (name === method) return Promise.resolve(response);
    return Promise.reject(new Error(`unexpected call: ${name}`));
  });
}

describe("checkAndApplyFlatpak", () => {
  it("returns updates when check-only (no auto-apply)", async () => {
    mockBackendMethod("check_and_apply_flatpak", {
      success: true,
      updates: [
        { id: "org.mozilla.firefox", name: "Firefox", downloadSize: "50 MB" },
        { id: "com.spotify.Client", name: "Spotify", downloadSize: "30 MB" },
      ],
      error: "",
      applied: false,
      applyError: "",
    });

    const result = await checkAndApplyFlatpak(false);
    expect(result.source).toBe("flatpak");
    expect(result.pendingCount).toBe(2);
    expect(result.forcedCount).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.flatpakUpdates).toHaveLength(2);
    expect(result.flatpakUpdates[0].name).toBe("Firefox");
  });

  it("returns forcedCount when auto-apply succeeds", async () => {
    mockBackendMethod("check_and_apply_flatpak", {
      success: true,
      updates: [{ id: "org.mozilla.firefox", name: "Firefox", downloadSize: "50 MB" }],
      error: "",
      applied: true,
      applyError: "",
    });

    const result = await checkAndApplyFlatpak(true);
    expect(result.pendingCount).toBe(1);
    expect(result.forcedCount).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it("returns check error on backend failure", async () => {
    mockBackendMethod("check_and_apply_flatpak", {
      success: false,
      updates: [],
      error: "flatpak not responding",
      applied: false,
      applyError: "",
    });

    const result = await checkAndApplyFlatpak(true);
    expect(result.pendingCount).toBe(0);
    expect(result.errors).toEqual(["flatpak not responding"]);
  });

  it("returns apply error when apply fails", async () => {
    mockBackendMethod("check_and_apply_flatpak", {
      success: true,
      updates: [{ id: "org.mozilla.firefox", name: "Firefox", downloadSize: "50 MB" }],
      error: "",
      applied: false,
      applyError: "permission denied",
    });

    const result = await checkAndApplyFlatpak(true);
    expect(result.forcedCount).toBe(0);
    expect(result.errors).toEqual(["permission denied"]);
  });

  it("returns default error when check error string is empty", async () => {
    mockBackendMethod("check_and_apply_flatpak", {
      success: false,
      updates: [],
      error: "",
      applied: false,
      applyError: "",
    });

    const result = await checkAndApplyFlatpak(true);
    expect(result.errors).toEqual(["Failed to check for Flatpak updates"]);
  });

  it("catches exceptions", async () => {
    mockCallPluginMethod.mockRejectedValue(new Error("network timeout"));

    const result = await checkAndApplyFlatpak(true);
    expect(result.pendingCount).toBe(0);
    expect(result.errors).toEqual(["network timeout"]);
  });

  it("returns zero updates when backend returns empty list", async () => {
    mockBackendMethod("check_and_apply_flatpak", {
      success: true,
      updates: [],
      error: "",
      applied: false,
      applyError: "",
    });

    const result = await checkAndApplyFlatpak(false);
    expect(result.pendingCount).toBe(0);
    expect(result.flatpakUpdates).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});

describe("isFlatpakAvailable", () => {
  it("returns true when backend says available", async () => {
    vi.resetModules();
    // Re-mock after resetModules
    vi.doMock("../deckyApi", () => ({
      callPluginMethod: () => Promise.resolve(true),
      isDeckyAvailable: vi.fn(),
      findPluginUpdates: vi.fn(),
      installPluginsAndConfirm: vi.fn(),
      checkDeckyLoaderUpdate: vi.fn(),
      applyDeckyLoaderUpdate: vi.fn(),
    }));
    vi.doMock("../steamClient", () => ({ forceStartAllUpdates: vi.fn() }));
    vi.doMock("@decky/api", () => ({}));
    const { isFlatpakAvailable: freshCheck } = await import("../providers");
    const result = await freshCheck();
    expect(result).toBe(true);
  });

  it("returns false on exception without caching", async () => {
    vi.resetModules();
    vi.doMock("../deckyApi", () => ({
      callPluginMethod: () => Promise.reject(new Error("ipc error")),
      isDeckyAvailable: vi.fn(),
      findPluginUpdates: vi.fn(),
      installPluginsAndConfirm: vi.fn(),
      checkDeckyLoaderUpdate: vi.fn(),
      applyDeckyLoaderUpdate: vi.fn(),
    }));
    vi.doMock("../steamClient", () => ({ forceStartAllUpdates: vi.fn() }));
    vi.doMock("@decky/api", () => ({}));
    const { isFlatpakAvailable: freshCheck } = await import("../providers");
    const result = await freshCheck();
    expect(result).toBe(false);
  });
});

// ── Decky plugin updates ──────────────────────────────────

describe("applyDeckyPluginUpdates", () => {
  it("returns empty result when no updates available", async () => {
    mockFindPluginUpdates.mockResolvedValue({ updates: [], details: [] });

    const result = await applyDeckyPluginUpdates([]);
    expect(result.source).toBe("decky");
    expect(result.pendingCount).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("installs updates and returns counts", async () => {
    mockFindPluginUpdates.mockResolvedValue({
      updates: [{ name: "PluginA", artifact: "url", version: "2.0", hash: "abc", install_type: 2 }],
      details: [{ name: "PluginA", currentVersion: "1.0", newVersion: "2.0" }],
    });
    mockInstallPluginsAndConfirm.mockResolvedValue(undefined);

    const result = await applyDeckyPluginUpdates([]);
    expect(result.pendingCount).toBe(1);
    expect(result.forcedCount).toBe(1);
    expect(result.deckyPluginUpdates[0].name).toBe("PluginA");
  });

  it("returns error when install fails", async () => {
    mockFindPluginUpdates.mockRejectedValue(new Error("store unreachable"));

    const result = await applyDeckyPluginUpdates([]);
    expect(result.errors).toEqual(["store unreachable"]);
    expect(result.pendingCount).toBe(0);
  });
});

// ── Decky Loader updates ──────────────────────────────────

describe("checkAndApplyDeckyLoaderUpdate", () => {
  it("returns empty result when no update available", async () => {
    mockCheckDeckyLoaderUpdate.mockResolvedValue({
      hasUpdate: false,
      currentVersion: "3.0.0",
      remoteVersion: "",
    });

    const result = await checkAndApplyDeckyLoaderUpdate();
    expect(result.source).toBe("decky-loader");
    expect(result.pendingCount).toBe(0);
  });

  it("applies update when available", async () => {
    mockCheckDeckyLoaderUpdate.mockResolvedValue({
      hasUpdate: true,
      currentVersion: "3.0.0",
      remoteVersion: "3.1.0",
    });
    mockApplyDeckyLoaderUpdate.mockResolvedValue(undefined);

    const result = await checkAndApplyDeckyLoaderUpdate();
    expect(result.pendingCount).toBe(1);
    expect(result.forcedCount).toBe(1);
    expect(result.deckyPluginUpdates[0].newVersion).toBe("3.1.0");
  });

  it("returns error when update fails", async () => {
    mockCheckDeckyLoaderUpdate.mockRejectedValue(new Error("WS timeout"));

    const result = await checkAndApplyDeckyLoaderUpdate();
    expect(result.errors).toEqual(["WS timeout"]);
  });
});

// ── SteamOS updates ───────────────────────────────────────

describe("checkAndApplySteamos", () => {
  it("returns empty result when no update available", async () => {
    mockCallPluginMethod.mockImplementation((method: string) => {
      if (method === "check_steamos_updates")
        return Promise.resolve({ success: true, hasUpdate: false, buildId: "", needsReboot: false, error: "" });
      return Promise.resolve({});
    });

    const result = await checkAndApplySteamos();
    expect(result.source).toBe("steamos");
    expect(result.pendingCount).toBe(0);
  });

  it("returns staged result when reboot needed", async () => {
    mockCallPluginMethod.mockImplementation((method: string) => {
      if (method === "check_steamos_updates")
        return Promise.resolve({ success: true, hasUpdate: false, buildId: "", needsReboot: true, error: "" });
      return Promise.resolve({});
    });

    const result = await checkAndApplySteamos();
    expect(result.pendingCount).toBe(1);
    expect(result.forcedCount).toBe(1);
  });

  it("returns error when check fails", async () => {
    mockCallPluginMethod.mockImplementation((method: string) => {
      if (method === "check_steamos_updates")
        return Promise.resolve({
          success: false,
          hasUpdate: false,
          buildId: "",
          needsReboot: false,
          error: "not found",
        });
      return Promise.resolve({});
    });

    const result = await checkAndApplySteamos();
    expect(result.errors).toEqual(["not found"]);
  });

  it("returns error when IPC fails entirely", async () => {
    mockCallPluginMethod.mockRejectedValue(new Error("WS closed"));

    const result = await checkAndApplySteamos();
    expect(result.errors).toEqual(["WS closed"]);
  });
});
