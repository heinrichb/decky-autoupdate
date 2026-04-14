/**
 * Tests for deckyApi.ts — version comparison, artifact URL building, and plugin filtering.
 *
 * Network-dependent functions (WebSocket, fetch) are not tested here as they
 * require a live Decky Loader instance. These tests cover the pure logic.
 */

import { describe, it, expect } from "vitest";

import { compareVersions, getArtifactUrl } from "../deckyApi";
import type { StorePluginVersion } from "../deckyApi";

describe("compareVersions", () => {
  it("returns 0 for equal versions", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("returns -1 when a < b", () => {
    expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
    expect(compareVersions("1.0.0", "1.1.0")).toBe(-1);
    expect(compareVersions("1.0.0", "2.0.0")).toBe(-1);
  });

  it("returns 1 when a > b", () => {
    expect(compareVersions("1.0.1", "1.0.0")).toBe(1);
    expect(compareVersions("1.1.0", "1.0.0")).toBe(1);
    expect(compareVersions("2.0.0", "1.0.0")).toBe(1);
  });

  it("handles different length versions", () => {
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0", "1.0.1")).toBe(-1);
    expect(compareVersions("1.0.1", "1.0")).toBe(1);
  });

  it("handles single-segment versions", () => {
    expect(compareVersions("1", "2")).toBe(-1);
    expect(compareVersions("2", "1")).toBe(1);
    expect(compareVersions("1", "1")).toBe(0);
  });

  it("handles non-numeric segments as 0", () => {
    expect(compareVersions("1.0.beta", "1.0.0")).toBe(0);
  });
});

describe("getArtifactUrl", () => {
  it("returns artifact URL directly when present", () => {
    const version: StorePluginVersion = {
      name: "1.0.0",
      hash: "abc123",
      artifact: "https://example.com/plugin.zip",
    };
    expect(getArtifactUrl(version)).toBe("https://example.com/plugin.zip");
  });

  it("builds CDN URL from hash when artifact is null", () => {
    const version: StorePluginVersion = {
      name: "1.0.0",
      hash: "abc123",
      artifact: null,
    };
    expect(getArtifactUrl(version)).toBe("https://cdn.tzatzikiweeb.moe/file/steam-deck-homebrew/versions/abc123.zip");
  });
});
