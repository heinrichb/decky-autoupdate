import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCallPluginMethod = vi.fn();

vi.mock("../deckyApi", () => ({
  callPluginMethod: (...args: unknown[]) => mockCallPluginMethod(...args),
  isDeckyAvailable: vi.fn(),
  findPluginUpdates: vi.fn(),
  installPluginsAndConfirm: vi.fn(),
  checkDeckyLoaderUpdate: vi.fn(),
  applyDeckyLoaderUpdate: vi.fn(),
}));

vi.mock("../steamClient", () => ({
  forceStartAllUpdates: vi.fn(),
}));

// providers.ts no longer imports from @decky/api, but mock it in case
vi.mock("@decky/api", () => ({}));

import { checkFlatpakOnly, applyFlatpak, isFlatpakAvailable } from "../providers";
import { FlatpakUpdate } from "../types";

beforeEach(() => {
  vi.clearAllMocks();
});

function mockBackendMethod(method: string, response: unknown) {
  mockCallPluginMethod.mockImplementation((name: string) => {
    if (name === method) return Promise.resolve(response);
    return Promise.reject(new Error(`unexpected call: ${name}`));
  });
}

describe("checkFlatpakOnly", () => {
  it("returns updates on success", async () => {
    mockBackendMethod("check_flatpak_updates", {
      success: true,
      updates: [
        { id: "org.mozilla.firefox", name: "Firefox", downloadSize: "50 MB" },
        { id: "com.spotify.Client", name: "Spotify", downloadSize: "30 MB" },
      ],
      error: "",
    });

    const result = await checkFlatpakOnly();
    expect(result.source).toBe("flatpak");
    expect(result.pendingCount).toBe(2);
    expect(result.forcedCount).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.flatpakUpdates).toHaveLength(2);
    expect(result.flatpakUpdates[0].name).toBe("Firefox");
  });

  it("returns empty result with error on backend failure", async () => {
    mockBackendMethod("check_flatpak_updates", {
      success: false,
      updates: [],
      error: "flatpak not responding",
    });

    const result = await checkFlatpakOnly();
    expect(result.pendingCount).toBe(0);
    expect(result.errors).toEqual(["flatpak not responding"]);
  });

  it("returns empty result with default error when error string is empty", async () => {
    mockBackendMethod("check_flatpak_updates", {
      success: false,
      updates: [],
      error: "",
    });

    const result = await checkFlatpakOnly();
    expect(result.errors).toEqual(["Failed to check for Flatpak updates"]);
  });

  it("catches exceptions and returns error result", async () => {
    mockCallPluginMethod.mockRejectedValue(new Error("network timeout"));

    const result = await checkFlatpakOnly();
    expect(result.pendingCount).toBe(0);
    expect(result.errors).toEqual(["network timeout"]);
  });

  it("returns zero updates when backend returns empty list", async () => {
    mockBackendMethod("check_flatpak_updates", {
      success: true,
      updates: [],
      error: "",
    });

    const result = await checkFlatpakOnly();
    expect(result.pendingCount).toBe(0);
    expect(result.flatpakUpdates).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});

describe("applyFlatpak", () => {
  const pending: FlatpakUpdate[] = [
    { id: "org.mozilla.firefox", name: "Firefox", downloadSize: "50 MB" },
    { id: "com.spotify.Client", name: "Spotify", downloadSize: "30 MB" },
  ];

  it("returns forcedCount equal to pending count on success", async () => {
    mockBackendMethod("apply_flatpak_updates", {
      success: true,
      stdout: "ok",
      stderr: "",
      returncode: 0,
    });

    const result = await applyFlatpak(pending);
    expect(result.source).toBe("flatpak");
    expect(result.pendingCount).toBe(2);
    expect(result.forcedCount).toBe(2);
    expect(result.errors).toEqual([]);
    expect(result.flatpakUpdates).toBe(pending);
  });

  it("returns zero forcedCount with error on failure", async () => {
    mockBackendMethod("apply_flatpak_updates", {
      success: false,
      stdout: "",
      stderr: "permission denied",
      returncode: 1,
    });

    const result = await applyFlatpak(pending);
    expect(result.forcedCount).toBe(0);
    expect(result.errors).toEqual(["permission denied"]);
  });

  it("uses default error when stderr is empty", async () => {
    mockBackendMethod("apply_flatpak_updates", {
      success: false,
      stdout: "",
      stderr: "",
      returncode: 1,
    });

    const result = await applyFlatpak(pending);
    expect(result.errors).toEqual(["Flatpak update failed"]);
  });

  it("catches exceptions", async () => {
    mockCallPluginMethod.mockRejectedValue(new Error("subprocess crashed"));

    const result = await applyFlatpak(pending);
    expect(result.forcedCount).toBe(0);
    expect(result.errors).toEqual(["subprocess crashed"]);
    expect(result.pendingCount).toBe(2);
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
