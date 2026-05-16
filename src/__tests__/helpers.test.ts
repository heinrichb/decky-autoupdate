/**
 * Tests for pure UI helper functions.
 */

import { describe, it, expect } from "vitest";
import {
  formatBytes,
  statusColor,
  flatpakStatusLabel,
  deckyStatusLabel,
  triggerLabel,
  sourceLabel,
  shouldToastResult,
  combinedToastBody,
  compactStatusText,
  formatUpdateSummary,
} from "../helpers";
import { UpdateCheckResult, emptyResult } from "../types";

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
    expect(sourceLabel("steam")).toBe("🎮 Steam Apps");
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
    expect(deckyStatusLabel("idle")).toBe("Check Plugins");
  });
});

// ── shouldToastResult ─────────────────────────────────────

describe("shouldToastResult", () => {
  it("returns false when level is off, regardless of result", () => {
    expect(shouldToastResult("off", { pendingCount: 5, forcedCount: 3 })).toBe(false);
  });

  it("returns true when level is all, even with no updates", () => {
    expect(shouldToastResult("all", { pendingCount: 0, forcedCount: 0 })).toBe(true);
  });

  it("returns true for updates-only when updates are pending", () => {
    expect(shouldToastResult("updates-only", { pendingCount: 3, forcedCount: 0 })).toBe(true);
  });

  it("returns true for updates-only when updates were applied", () => {
    expect(shouldToastResult("updates-only", { pendingCount: 0, forcedCount: 2 })).toBe(true);
  });

  it("returns false for updates-only when nothing found", () => {
    expect(shouldToastResult("updates-only", { pendingCount: 0, forcedCount: 0 })).toBe(false);
  });
});

// ── combinedToastBody ─────────────────────────────────────

describe("combinedToastBody", () => {
  const withUpdates: UpdateCheckResult = {
    ...emptyResult("flatpak"),
    pendingCount: 3,
  };
  const noUpdates: UpdateCheckResult = emptyResult("steam");

  it("returns null when level is off", () => {
    expect(combinedToastBody([withUpdates], "off")).toBeNull();
  });

  it("returns null for updates-only when no source has updates", () => {
    expect(combinedToastBody([noUpdates], "updates-only")).toBeNull();
  });

  it("returns body for updates-only when a source has updates", () => {
    const body = combinedToastBody([noUpdates, withUpdates], "updates-only");
    expect(body).not.toBeNull();
    expect(body).toContain("Flatpak");
    expect(body).not.toContain("Steam Apps");
  });

  it("includes all sources when level is all", () => {
    const body = combinedToastBody([noUpdates, withUpdates], "all");
    expect(body).toContain("Steam Apps");
    expect(body).toContain("Flatpak");
  });

  it("returns null for empty results array", () => {
    expect(combinedToastBody([], "all")).toBeNull();
  });
});

// ── compactStatusText ─────────────────────────────────────

describe("compactStatusText", () => {
  it("returns 'Never checked' when lastCheck is null", () => {
    expect(compactStatusText("steam", null)).toBe("Never checked");
  });

  it("returns error message when errors exist", () => {
    const result = { ...emptyResult("flatpak"), errors: ["connection refused"] };
    expect(compactStatusText("flatpak", result)).toBe("connection refused");
  });

  it("truncates long error messages to 50 chars", () => {
    const longError = "a".repeat(60);
    const result = { ...emptyResult("flatpak"), errors: [longError] };
    const text = compactStatusText("flatpak", result);
    expect(text.length).toBeLessThanOrEqual(50);
    expect(text).toContain("...");
  });

  it("does not truncate errors under 50 chars", () => {
    const shortError = "timeout after 30s";
    const result = { ...emptyResult("flatpak"), errors: [shortError] };
    expect(compactStatusText("flatpak", result)).toBe(shortError);
  });

  it("returns 'Up to date' when no updates and no errors", () => {
    expect(compactStatusText("steam", emptyResult("steam"))).toBe("Up to date");
  });

  it("returns pending count when updates available", () => {
    const result = { ...emptyResult("flatpak"), pendingCount: 5 };
    expect(compactStatusText("flatpak", result)).toContain("5");
    expect(compactStatusText("flatpak", result)).toContain("available");
  });

  it("returns applied count when updates were applied", () => {
    const result = { ...emptyResult("decky"), pendingCount: 3, forcedCount: 3 };
    expect(compactStatusText("decky", result)).toContain("3 of 3");
    expect(compactStatusText("decky", result)).toContain("applied");
  });

  it("returns staged message for SteamOS when forcedCount > 0", () => {
    const result = { ...emptyResult("steamos"), pendingCount: 1, forcedCount: 1 };
    expect(compactStatusText("steamos", result)).toContain("Staged");
    expect(compactStatusText("steamos", result)).toContain("reboot");
  });

  it("does NOT return staged message for non-SteamOS sources with forcedCount", () => {
    const result = { ...emptyResult("flatpak"), pendingCount: 2, forcedCount: 2 };
    expect(compactStatusText("flatpak", result)).not.toContain("Staged");
  });
});

// ── formatUpdateSummary ───────────────────────────────────

describe("formatUpdateSummary", () => {
  it("shows 'checked, no updates' when nothing found", () => {
    expect(formatUpdateSummary({ source: "steam", pendingCount: 0, forcedCount: 0 })).toContain("no updates");
  });

  it("shows available count when updates pending", () => {
    const text = formatUpdateSummary({ source: "flatpak", pendingCount: 4, forcedCount: 0 });
    expect(text).toContain("4");
    expect(text).toContain("available");
  });

  it("shows applied count when updates were applied", () => {
    const text = formatUpdateSummary({ source: "decky", pendingCount: 2, forcedCount: 2 });
    expect(text).toContain("2 of 2");
    expect(text).toContain("applied");
  });

  it("uses 'started' verb for steam, not 'applied', because Steam downloads asynchronously", () => {
    const text = formatUpdateSummary({ source: "steam", pendingCount: 5, forcedCount: 3 });
    expect(text).toContain("3 of 5");
    expect(text).toContain("started");
    expect(text).not.toContain("applied");
    // Steam uses "download" noun instead of "update" since we're triggering downloads, not installs.
    expect(text).toContain("download");
  });

  it("uses 'staged' verb for steamos because the update needs a reboot to activate", () => {
    const text = formatUpdateSummary({ source: "steamos", pendingCount: 1, forcedCount: 1 });
    expect(text).toContain("staged");
    expect(text).not.toContain("applied");
  });

  it("uses singular 'update' for count of 1", () => {
    const text = formatUpdateSummary({ source: "steam", pendingCount: 1, forcedCount: 0 });
    expect(text).toContain("1 update available");
    expect(text).not.toContain("updates");
  });

  it("includes source label", () => {
    const text = formatUpdateSummary({ source: "flatpak", pendingCount: 1, forcedCount: 0 });
    expect(text).toContain("Flatpak");
  });
});
