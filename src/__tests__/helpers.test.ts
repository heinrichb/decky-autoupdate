/**
 * Tests for pure UI helper functions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  COLOR_SUCCESS,
  COLOR_WARNING,
  COLOR_ERROR,
  COLOR_MUTED,
  sourceName,
  formatClock,
  formatDayLabel,
  formatWhen,
  shortStatusText,
  groupHistory,
  shortHistorySummary,
  log,
  logWarn,
  logError,
  debug,
  trace,
  setBackendLog,
  flushBackendLog,
  setDebugEnabled,
  isDebugEnabled,
  isOnline,
  waitForNetwork,
} from "../helpers";
import { UpdateCheckResult, HistoryEntry, UpdateSource, ALL_SOURCES, emptyResult } from "../types";

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

describe("palette", () => {
  it("uses the accessible palette values", () => {
    expect(COLOR_SUCCESS).toBe("#4cc9b0");
    expect(COLOR_WARNING).toBe("#fca311");
    expect(COLOR_ERROR).toBe("#ff949c");
    expect(COLOR_MUTED).toBe("#b8bcbf");
  });

  function luminance(hex: string): number {
    const n = parseInt(hex.slice(1), 16);
    const channel = (c: number) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
  }

  function contrast(a: string, b: string): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }

  for (const color of [COLOR_SUCCESS, COLOR_WARNING, COLOR_ERROR, COLOR_MUTED]) {
    for (const bg of ["#0e141b", "#32373d"]) {
      it(`${color} reaches 4.5:1 on ${bg}`, () => {
        expect(contrast(color, bg)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

describe("statusColor", () => {
  it("returns muted for null", () => {
    expect(statusColor(null)).toBe(COLOR_MUTED);
  });

  it("returns error color when errors present", () => {
    expect(statusColor({ errors: ["something broke"], pendingCount: 0, forcedCount: 0 })).toBe(COLOR_ERROR);
  });

  it("returns warning when pending updates exist and none were acted on", () => {
    expect(statusColor({ errors: [], pendingCount: 3, forcedCount: 0 })).toBe(COLOR_WARNING);
  });

  it("returns success when pending updates were all successfully started/applied", () => {
    expect(statusColor({ errors: [], pendingCount: 5, forcedCount: 5 })).toBe(COLOR_SUCCESS);
  });

  it("returns success when no pending updates (up to date)", () => {
    expect(statusColor({ errors: [], pendingCount: 0, forcedCount: 0 })).toBe(COLOR_SUCCESS);
  });

  it("returns success on partial success (some forced, no errors)", () => {
    expect(statusColor({ errors: [], pendingCount: 5, forcedCount: 3 })).toBe(COLOR_SUCCESS);
  });

  it("prioritizes errors over pending", () => {
    expect(statusColor({ errors: ["err"], pendingCount: 5, forcedCount: 0 })).toBe(COLOR_ERROR);
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

  it("reports a failed check instead of 'no updates'", () => {
    const failed = { ...emptyResult("steam"), errors: ["Steam did not report download state; could not check"] };
    const text = formatUpdateSummary(failed);
    expect(text).toContain("check failed");
    expect(text).not.toContain("no updates");
    expect(combinedToastBody([failed], "all")).toContain("check failed");
    expect(combinedToastBody([failed], "updates-only")).toBeNull();
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

// ── sourceName ────────────────────────────────────────────

describe("sourceName", () => {
  it("returns plain names without emoji", () => {
    expect(sourceName("steam")).toBe("Steam Apps");
    expect(sourceName("flatpak")).toBe("Flatpak");
    expect(sourceName("decky")).toBe("Decky Plugins");
    expect(sourceName("decky-loader")).toBe("Decky Loader");
    expect(sourceName("steamos")).toBe("SteamOS");
  });
});

// ── formatClock / formatDayLabel ──────────────────────────

describe("formatClock", () => {
  it("formats hours and minutes without seconds", () => {
    const ts = new Date(2026, 8, 30, 14, 5, 37).getTime();
    expect(formatClock(ts)).toBe(new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
    expect(formatClock(ts)).toContain("05");
    expect(formatClock(ts)).not.toContain("37");
  });
});

describe("formatDayLabel", () => {
  const now = new Date(2026, 8, 30, 12, 0).getTime();

  it("returns Today for the same calendar day", () => {
    expect(formatDayLabel(new Date(2026, 8, 30, 0, 5).getTime(), now)).toBe("Today");
    expect(formatDayLabel(new Date(2026, 8, 30, 23, 59).getTime(), now)).toBe("Today");
  });

  it("returns Yesterday for the previous calendar day", () => {
    expect(formatDayLabel(new Date(2026, 8, 29, 23, 59).getTime(), now)).toBe("Yesterday");
    expect(formatDayLabel(new Date(2026, 8, 29, 0, 1).getTime(), now)).toBe("Yesterday");
  });

  it("returns weekday, month and day for older entries", () => {
    const ts = new Date(2026, 8, 28, 10, 0).getTime();
    const label = formatDayLabel(ts, now);
    expect(label).toBe(new Date(ts).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }));
    expect(label).toContain("28");
  });

  it("handles month boundaries", () => {
    const firstOfMonth = new Date(2026, 9, 1, 8, 0).getTime();
    expect(formatDayLabel(new Date(2026, 8, 30, 22, 0).getTime(), firstOfMonth)).toBe("Yesterday");
  });

  it("returns Tomorrow for the next calendar day, across month and year boundaries", () => {
    expect(formatDayLabel(new Date(2026, 9, 1, 0, 5).getTime(), now)).toBe("Tomorrow");
    expect(formatDayLabel(new Date(2026, 9, 1, 23, 59).getTime(), now)).toBe("Tomorrow");
    const newYearsEve = new Date(2026, 11, 31, 23, 0).getTime();
    expect(formatDayLabel(new Date(2027, 0, 1, 6, 0).getTime(), newYearsEve)).toBe("Tomorrow");
  });

  it("returns weekday, month and day two or more days ahead", () => {
    const ts = new Date(2026, 9, 2, 9, 0).getTime();
    expect(formatDayLabel(ts, now)).toBe(
      new Date(ts).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }),
    );
  });
});

describe("formatWhen", () => {
  const now = new Date(2026, 8, 30, 12, 0).getTime();

  it("is just the clock time on the same calendar day", () => {
    const ts = new Date(2026, 8, 30, 23, 45).getTime();
    expect(formatWhen(ts, now)).toBe(formatClock(ts));
  });

  it("prefixes the day label on other days", () => {
    const yesterday = new Date(2026, 8, 29, 18, 30).getTime();
    const tomorrow = new Date(2026, 9, 1, 0, 15).getTime();
    const older = new Date(2026, 8, 27, 9, 0).getTime();
    expect(formatWhen(yesterday, now)).toBe(`Yesterday ${formatClock(yesterday)}`);
    expect(formatWhen(tomorrow, now)).toBe(`Tomorrow ${formatClock(tomorrow)}`);
    expect(formatWhen(older, now)).toBe(`${formatDayLabel(older, now)} ${formatClock(older)}`);
  });
});

// ── shortStatusText ───────────────────────────────────────

describe("shortStatusText", () => {
  it("returns 'Not checked yet' with no result", () => {
    expect(shortStatusText("steam", null)).toBe("Not checked yet");
  });

  it("returns 'Up to date' when nothing is pending", () => {
    expect(shortStatusText("flatpak", emptyResult("flatpak"))).toBe("Up to date");
  });

  it("returns the available count", () => {
    expect(shortStatusText("flatpak", { ...emptyResult("flatpak"), pendingCount: 5 })).toBe("5 available");
  });

  it("uses the per-source verb when updates were acted on", () => {
    expect(shortStatusText("steam", { ...emptyResult("steam"), pendingCount: 5, forcedCount: 3 })).toBe(
      "3 of 5 started",
    );
    expect(shortStatusText("decky", { ...emptyResult("decky"), pendingCount: 2, forcedCount: 2 })).toBe(
      "2 of 2 applied",
    );
  });

  it("returns the staged message for SteamOS", () => {
    expect(shortStatusText("steamos", { ...emptyResult("steamos"), pendingCount: 1, forcedCount: 1 })).toBe(
      "Staged, reboot to apply",
    );
  });

  it("returns a short error unchanged", () => {
    expect(shortStatusText("flatpak", { ...emptyResult("flatpak"), errors: ["timeout after 30s"] })).toBe(
      "timeout after 30s",
    );
  });

  it("clamps long errors to 32 chars", () => {
    const text = shortStatusText("flatpak", {
      ...emptyResult("flatpak"),
      errors: ["Could not resolve hostname dl.flathub.org: Temporary failure"],
    });
    expect(text.length).toBeLessThanOrEqual(32);
    expect(text.startsWith("Could not resolve")).toBe(true);
  });

  it("never exceeds 32 chars", () => {
    const cases: Partial<UpdateCheckResult>[] = [
      {},
      { pendingCount: 999 },
      { pendingCount: 9999, forcedCount: 9999 },
      { pendingCount: 1, forcedCount: 1 },
      { errors: ["x".repeat(200)] },
    ];
    for (const source of ALL_SOURCES) {
      for (const c of cases) {
        expect(shortStatusText(source, { ...emptyResult(source), ...c }).length).toBeLessThanOrEqual(32);
      }
    }
  });
});

// ── shortHistorySummary / groupHistory ────────────────────

function hist(source: UpdateSource, ts: number, pendingCount: number, forcedCount: number): HistoryEntry {
  return { source, timestamp: ts, pendingCount, forcedCount, trigger: "auto" };
}

describe("shortHistorySummary", () => {
  it("summarizes acted-on updates with the source verb", () => {
    expect(shortHistorySummary(hist("steam", 0, 3, 3))).toBe("3 of 3 started");
    expect(shortHistorySummary(hist("decky", 0, 2, 2))).toBe("2 of 2 applied");
  });

  it("summarizes pending-only entries", () => {
    expect(shortHistorySummary(hist("flatpak", 0, 1, 0))).toBe("1 available");
  });

  it("summarizes staged SteamOS updates", () => {
    expect(shortHistorySummary(hist("steamos", 0, 1, 1))).toBe("Staged");
  });
});

describe("groupHistory", () => {
  const now = new Date(2026, 8, 30, 12, 0).getTime();
  const at = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m).getTime();
  const e1 = hist("steam", at(30, 11), 3, 3);
  const e2 = hist("steam", at(30, 10, 30), 3, 3);
  const e3 = hist("flatpak", at(30, 10), 1, 1);
  const e4 = hist("steam", at(30, 9), 3, 3);
  const e5 = hist("steam", at(29, 23), 3, 3);
  const e6 = hist("decky", at(27, 8), 1, 1);

  it("groups newest first by day and collapses consecutive identical entries", () => {
    const groups = groupHistory([e4, e1, e6, e3, e5, e2], 50, now);
    expect(groups.map((g) => g.day)).toEqual(["Today", "Yesterday", formatDayLabel(e6.timestamp, now)]);
    expect(groups[0].rows).toEqual([
      { entry: e1, count: 2 },
      { entry: e3, count: 1 },
      { entry: e4, count: 1 },
    ]);
    expect(groups[1].rows).toEqual([{ entry: e5, count: 1 }]);
    expect(groups[2].rows).toEqual([{ entry: e6, count: 1 }]);
  });

  it("does not collapse identical entries across days", () => {
    const groups = groupHistory([e4, e5], 50, now);
    expect(groups).toHaveLength(2);
  });

  it("does not collapse entries whose counts differ", () => {
    const groups = groupHistory([hist("steam", at(30, 11), 3, 3), hist("steam", at(30, 10), 3, 2)], 50, now);
    expect(groups[0].rows.map((r) => r.count)).toEqual([1, 1]);
  });

  it("limits the number of rows", () => {
    const groups = groupHistory([e1, e2, e3, e4, e5, e6], 2, now);
    expect(groups).toEqual([
      {
        day: "Today",
        rows: [
          { entry: e1, count: 2 },
          { entry: e3, count: 1 },
        ],
      },
    ]);
  });

  it("returns an empty list for no entries", () => {
    expect(groupHistory([], 10, now)).toEqual([]);
  });
});

// ── Backend log buffering ─────────────────────────────────

describe("backend log buffering", () => {
  let sink: ReturnType<typeof vi.fn>;
  const T0 = new Date(2026, 8, 30, 12, 0, 0).getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    setBackendLog(null);
    sink = vi.fn();
    setBackendLog(sink);
  });

  afterEach(() => {
    setDebugEnabled(false);
    setBackendLog(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const sent = () => sink.mock.calls.flatMap((c) => c[0] as [string, string, number][]);

  it("buffers info lines and sends them as one batch within 1 s", async () => {
    log("first");
    vi.setSystemTime(T0 + 5);
    log("second", 2, true);
    expect(sink).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(990);
    expect(sink).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toEqual([
      ["info", "first", T0],
      ["info", "second 2 true", T0 + 5],
    ]);
  });

  it("flushes warn and error lines on the next microtask", async () => {
    log("context");
    logWarn("careful");
    expect(sink).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sent().map((e) => [e[0], e[1]])).toEqual([
      ["info", "context"],
      ["warn", "careful"],
    ]);
    logError("broken");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent().map((e) => e[1])).toContain("broken");
  });

  it("flushBackendLog sends pending lines immediately", () => {
    log("pending");
    flushBackendLog();
    expect(sink).toHaveBeenCalledTimes(1);
    flushBackendLog();
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("serializes Error arguments as stack or message", () => {
    const err = new Error("store unreachable");
    logError("Failed to apply Decky plugin updates:", err);
    const bare = new Error("no stack here");
    bare.stack = undefined;
    logError("Bare:", bare);
    flushBackendLog();
    const [first, second] = sent();
    expect(first[1]).toContain("Failed to apply Decky plugin updates:");
    expect(first[1]).toContain("store unreachable");
    expect(first[1]).not.toContain("{}");
    expect(second[1]).toBe("Bare: no stack here");
  });

  it("stringifies objects and survives circular references", () => {
    const o: Record<string, unknown> = { a: 1 };
    o.self = o;
    expect(() => log("obj", o, undefined, null)).not.toThrow();
    log("nested", { err: new Error("inner failure") });
    flushBackendLog();
    const [circ, nested] = sent();
    expect(circ[1]).toContain('"a":1');
    expect(circ[1]).toContain("[Circular]");
    expect(circ[1]).toContain("undefined null");
    expect(nested[1]).toContain("inner failure");
  });

  it("sends debug only when enabled and never sends trace", () => {
    expect(isDebugEnabled()).toBe(false);
    debug("hidden debug");
    trace("hidden trace");
    setDebugEnabled(true);
    expect(isDebugEnabled()).toBe(true);
    debug("shown debug");
    trace("still hidden");
    flushBackendLog();
    const messages = sent().map((e) => e[1]);
    expect(messages).toContain("shown debug");
    expect(messages).not.toContain("hidden debug");
    expect(messages.some((m) => m.includes("trace") || m.includes("still hidden"))).toBe(false);
    expect(sent().find((e) => e[1] === "shown debug")![0]).toBe("debug");
  });

  it("caps the buffer at 300 entries, dropping the oldest debug line first", () => {
    setDebugEnabled(true);
    flushBackendLog();
    sink.mockClear();
    debug("old debug");
    for (let i = 0; i < 300; i++) log(`line ${i}`);
    flushBackendLog();
    const batch = sink.mock.calls[0][0] as [string, string, number][];
    expect(batch).toHaveLength(300);
    expect(batch.some((e) => e[1] === "old debug")).toBe(false);
    expect(batch[0][1]).toBe("line 0");
  });

  it("drops the oldest line when the full buffer has no debug lines", () => {
    for (let i = 0; i < 301; i++) log(`line ${i}`);
    flushBackendLog();
    const batch = sink.mock.calls[0][0] as [string, string, number][];
    expect(batch).toHaveLength(300);
    expect(batch[0][1]).toBe("line 1");
  });

  it("keeps lines logged before a sink is set", () => {
    setBackendLog(null);
    log("early line");
    setBackendLog(sink);
    flushBackendLog();
    expect(sent().map((e) => e[1])).toContain("early line");
  });

  it("caps message length", () => {
    log("x".repeat(5000));
    flushBackendLog();
    expect(sent()[0][1].length).toBeLessThanOrEqual(2000);
  });

  it("never throws when the sink throws", () => {
    setBackendLog(() => {
      throw new Error("sink failure");
    });
    log("line");
    expect(() => flushBackendLog()).not.toThrow();
  });
});

// ── Network helpers ───────────────────────────────────────

describe("isOnline / waitForNetwork", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("treats a navigator without onLine as online", () => {
    vi.stubGlobal("navigator", {});
    expect(isOnline()).toBe(true);
  });

  it("reports offline when navigator.onLine is false", () => {
    vi.stubGlobal("navigator", { onLine: false });
    expect(isOnline()).toBe(false);
  });

  it("stops waiting when cancelled", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { onLine: false });
    let cancelled = false;
    let settled: boolean | null = null;
    waitForNetwork(30_000, () => cancelled).then((v) => (settled = v));
    await vi.advanceTimersByTimeAsync(2000);
    expect(settled).toBeNull();
    cancelled = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(settled).toBe(false);
  });
});
