/**
 * Tests for pure UI helper functions.
 */

import { describe, it, expect } from "vitest";
import { formatBytes, statusColor, flatpakStatusLabel, deckyStatusLabel, triggerLabel, sourceLabel } from "../helpers";

describe("formatBytes", () => {
  it("returns em dash for 0", () => {
    expect(formatBytes(0)).toBe("\u2014");
  });

  it("returns em dash for negative", () => {
    expect(formatBytes(-100)).toBe("\u2014");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(512 * 1024)).toBe("512 KB");
  });

  it("formats megabytes", () => {
    expect(formatBytes(150 * 1024 * 1024)).toBe("150 MB");
  });

  it("formats gigabytes", () => {
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.5 GB");
  });

  it("handles boundary: just under 1 MB", () => {
    const result = formatBytes(1024 * 1024 - 1);
    expect(result).toContain("KB");
  });

  it("handles boundary: exactly 1 MB", () => {
    const result = formatBytes(1024 * 1024);
    expect(result).toBe("1 MB");
  });

  it("handles boundary: exactly 1 GB", () => {
    const result = formatBytes(1024 * 1024 * 1024);
    expect(result).toBe("1.0 GB");
  });

  it("handles small values (1 byte)", () => {
    expect(formatBytes(1)).toBe("0 KB");
  });
});

describe("statusColor", () => {
  it("returns gray for null", () => {
    expect(statusColor(null)).toBe("#888");
  });

  it("returns red when errors present", () => {
    expect(statusColor({ errors: ["something broke"], pendingCount: 0 })).toBe("#e63946");
  });

  it("returns yellow when pending updates exist", () => {
    expect(statusColor({ errors: [], pendingCount: 3 })).toBe("#fca311");
  });

  it("returns green when clean", () => {
    expect(statusColor({ errors: [], pendingCount: 0 })).toBe("#2a9d8f");
  });

  it("prioritizes errors over pending", () => {
    expect(statusColor({ errors: ["err"], pendingCount: 5 })).toBe("#e63946");
  });
});

describe("triggerLabel", () => {
  it("returns correct label for manual", () => {
    expect(triggerLabel("manual")).toBe("Manual check");
  });

  it("returns correct label for wake", () => {
    expect(triggerLabel("wake")).toBe("After sleep");
  });

  it("returns correct label for auto", () => {
    expect(triggerLabel("auto")).toBe("Scheduled");
  });

  it("returns correct label for game-close", () => {
    expect(triggerLabel("game-close")).toBe("After game");
  });
});

describe("sourceLabel", () => {
  it("returns steam label", () => {
    expect(sourceLabel("steam")).toBe("🎮 Steam");
  });

  it("returns flatpak label", () => {
    expect(sourceLabel("flatpak")).toBe("📦 Flatpak");
  });

  it("returns decky label", () => {
    expect(sourceLabel("decky")).toBe("🔌 Decky plugins");
  });
});

describe("flatpakStatusLabel", () => {
  it("returns checking label", () => {
    expect(flatpakStatusLabel("checking")).toBe("Checking for updates...");
  });

  it("returns applying label", () => {
    expect(flatpakStatusLabel("applying")).toBe("Installing updates...");
  });

  it("returns default label for idle", () => {
    expect(flatpakStatusLabel("idle")).toBe("Check Flatpak");
  });
});

describe("deckyStatusLabel", () => {
  it("returns checking label", () => {
    expect(deckyStatusLabel("checking")).toBe("Checking for updates...");
  });

  it("returns applying label", () => {
    expect(deckyStatusLabel("applying")).toBe("Updating plugins...");
  });

  it("returns default label for idle", () => {
    expect(deckyStatusLabel("idle")).toBe("Check Decky");
  });
});
