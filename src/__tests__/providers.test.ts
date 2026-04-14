import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCheckFlatpakUpdates, mockApplyFlatpakUpdates, mockGetFlatpakAvailable } = vi.hoisted(() => ({
  mockCheckFlatpakUpdates: vi.fn(),
  mockApplyFlatpakUpdates: vi.fn(),
  mockGetFlatpakAvailable: vi.fn(),
}));

vi.mock("@decky/api", () => ({
  callable: (name: string) => {
    switch (name) {
      case "check_flatpak_updates":
        return mockCheckFlatpakUpdates;
      case "apply_flatpak_updates":
        return mockApplyFlatpakUpdates;
      case "get_flatpak_available":
        return mockGetFlatpakAvailable;
      default:
        return vi.fn();
    }
  },
}));

vi.mock("../steamClient", () => ({
  forceStartAllUpdates: vi.fn(),
}));

import { checkFlatpakOnly, applyFlatpak, isFlatpakAvailable } from "../providers";
import { FlatpakUpdate } from "../types";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkFlatpakOnly", () => {
  it("returns updates on success", async () => {
    mockCheckFlatpakUpdates.mockResolvedValue({
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
    mockCheckFlatpakUpdates.mockResolvedValue({
      success: false,
      updates: [],
      error: "flatpak not responding",
    });

    const result = await checkFlatpakOnly();
    expect(result.pendingCount).toBe(0);
    expect(result.errors).toEqual(["flatpak not responding"]);
  });

  it("returns empty result with default error when error string is empty", async () => {
    mockCheckFlatpakUpdates.mockResolvedValue({
      success: false,
      updates: [],
      error: "",
    });

    const result = await checkFlatpakOnly();
    expect(result.errors).toEqual(["Failed to check for Flatpak updates"]);
  });

  it("catches exceptions and returns error result", async () => {
    mockCheckFlatpakUpdates.mockRejectedValue(new Error("network timeout"));

    const result = await checkFlatpakOnly();
    expect(result.pendingCount).toBe(0);
    expect(result.errors).toEqual(["network timeout"]);
  });

  it("returns zero updates when backend returns empty list", async () => {
    mockCheckFlatpakUpdates.mockResolvedValue({
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
    mockApplyFlatpakUpdates.mockResolvedValue({
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
    mockApplyFlatpakUpdates.mockResolvedValue({
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
    mockApplyFlatpakUpdates.mockResolvedValue({
      success: false,
      stdout: "",
      stderr: "",
      returncode: 1,
    });

    const result = await applyFlatpak(pending);
    expect(result.errors).toEqual(["Flatpak update failed"]);
  });

  it("catches exceptions", async () => {
    mockApplyFlatpakUpdates.mockRejectedValue(new Error("subprocess crashed"));

    const result = await applyFlatpak(pending);
    expect(result.forcedCount).toBe(0);
    expect(result.errors).toEqual(["subprocess crashed"]);
    expect(result.pendingCount).toBe(2);
  });
});

describe("isFlatpakAvailable", () => {
  it("returns true when backend says available", async () => {
    // Re-import to reset module-level cache
    vi.resetModules();
    const { isFlatpakAvailable: freshCheck } = await import("../providers");
    mockGetFlatpakAvailable.mockResolvedValue(true);
    const result = await freshCheck();
    expect(result).toBe(true);
  });

  it("returns false on exception without caching", async () => {
    vi.resetModules();
    const { isFlatpakAvailable: freshCheck } = await import("../providers");
    mockGetFlatpakAvailable.mockRejectedValue(new Error("ipc error"));
    const result = await freshCheck();
    expect(result).toBe(false);
  });
});
