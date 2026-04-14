/**
 * AutoUpdateService — singleton that runs background timers at the plugin level,
 * NOT inside React hooks. This ensures wake detection and periodic checks work
 * even when the QAM panel is closed.
 *
 * Lifecycle:
 *   definePlugin() → service.start()
 *   onDismount()   → service.stop()
 *
 * The React UI subscribes to state changes via service.subscribe().
 */

import { toaster } from "@decky/api";
import {
  Settings,
  UpdateSource,
  UpdateCheckResult,
  HistoryEntry,
  SourceStatus,
  Trigger,
  DEFAULT_SETTINGS,
  emptyResult,
} from "./types";
import { waitForSteamClient, registerForResume, registerForAppLifetime } from "./steamClient";
import {
  checkSteam,
  checkFlatpakOnly,
  applyFlatpak,
  isFlatpakAvailable,
  isDeckyApiAvailable,
  applyDeckyPluginUpdates,
  checkAndApplyDeckyLoaderUpdate,
  isSteamosAvailable,
  checkAndApplySteamos,
} from "./providers";
import { callPluginMethod } from "./deckyApi";
import { combinedToastBody, log, logError, debug, errorMessage, setDebugEnabled } from "./helpers";

const IPC_TIMEOUT = 10_000;
const getSettings = () => callPluginMethod<Settings>("get_settings", IPC_TIMEOUT);
const saveSettings = (s: Settings) => callPluginMethod<boolean>("save_settings", [s], IPC_TIMEOUT);
const getHistory = () => callPluginMethod<HistoryEntry[]>("get_history", IPC_TIMEOUT);
const addHistoryEntry = (e: HistoryEntry) => callPluginMethod<boolean>("add_history_entry", [e], IPC_TIMEOUT);
const clearHistoryBackend = () => callPluginMethod<boolean>("clear_history", IPC_TIMEOUT);

const HEARTBEAT_INTERVAL_MS = 30_000;
const WAKE_THRESHOLD_MS = 60_000;

type StatusKey = "steamStatus" | "flatpakStatus" | "deckyStatus" | "deckyLoaderStatus" | "steamosStatus";
type LastCheckKey =
  | "steamLastCheck"
  | "flatpakLastCheck"
  | "deckyLastCheck"
  | "deckyLoaderLastCheck"
  | "steamosLastCheck";

const SOURCE_FIELDS: Record<UpdateSource, { status: StatusKey; lastCheck: LastCheckKey }> = {
  steam: { status: "steamStatus", lastCheck: "steamLastCheck" },
  flatpak: { status: "flatpakStatus", lastCheck: "flatpakLastCheck" },
  decky: { status: "deckyStatus", lastCheck: "deckyLastCheck" },
  "decky-loader": { status: "deckyLoaderStatus", lastCheck: "deckyLoaderLastCheck" },
  steamos: { status: "steamosStatus", lastCheck: "steamosLastCheck" },
};

export interface ServiceState {
  settings: Settings;
  settingsLoaded: boolean;
  steamReady: boolean;
  flatpakAvailable: boolean;
  deckyAvailable: boolean;

  steamStatus: SourceStatus;
  steamLastCheck: UpdateCheckResult | null;
  flatpakStatus: SourceStatus;
  flatpakLastCheck: UpdateCheckResult | null;
  deckyStatus: SourceStatus;
  deckyLastCheck: UpdateCheckResult | null;
  deckyLoaderStatus: SourceStatus;
  deckyLoaderLastCheck: UpdateCheckResult | null;

  steamosAvailable: boolean;
  steamosStatus: SourceStatus;
  steamosLastCheck: UpdateCheckResult | null;

  historyEntries: HistoryEntry[];
}

type Listener = () => void;

class AutoUpdateService {
  private state: ServiceState = {
    settings: { ...DEFAULT_SETTINGS },
    settingsLoaded: false,
    steamReady: false,
    flatpakAvailable: false,
    deckyAvailable: false,
    steamStatus: "idle",
    steamLastCheck: null,
    flatpakStatus: "idle",
    flatpakLastCheck: null,
    deckyStatus: "idle",
    deckyLastCheck: null,
    deckyLoaderStatus: "idle",
    deckyLoaderLastCheck: null,
    steamosAvailable: false,
    steamosStatus: "idle",
    steamosLastCheck: null,
    historyEntries: [],
  };

  private listeners = new Set<Listener>();
  private heartbeatId: ReturnType<typeof setInterval> | null = null;
  private steamTimerId: ReturnType<typeof setInterval> | null = null;
  private flatpakTimerId: ReturnType<typeof setInterval> | null = null;
  private deckyTimerId: ReturnType<typeof setInterval> | null = null;
  private deckyLoaderTimerId: ReturnType<typeof setInterval> | null = null;
  private steamosTimerId: ReturnType<typeof setInterval> | null = null;
  private resumeUnregister: (() => void) | null = null;
  private gameUnregister: (() => void) | null = null;
  private runningGames = new Set<number>();
  private lastHeartbeat = 0;
  private started = false;

  // ── Public API ─────────────────────────────────────────

  getState(): ServiceState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async start() {
    if (this.started) return;
    this.started = true;
    log("Service starting");

    try {
      debug("Loading settings via IPC...");
      const s = await getSettings();
      this.state.settings = { ...DEFAULT_SETTINGS, ...s };
      setDebugEnabled(this.state.settings.debugLogging);
      this.state.settingsLoaded = true;
      debug("Settings loaded:", JSON.stringify(this.state.settings));
    } catch (e) {
      logError("Failed to load settings, using defaults:", e);
      this.state.settingsLoaded = true;
    }
    this.notify();

    // Availability checks are independent — run in parallel
    debug("Running availability checks...");
    const [, steamAvailable] = await Promise.all([
      isFlatpakAvailable()
        .then((v) => {
          this.state.flatpakAvailable = v;
          debug("Flatpak available:", v);
        })
        .catch((e) => {
          debug("Flatpak availability check error:", errorMessage(e));
        }),
      waitForSteamClient(30_000),
      isDeckyApiAvailable()
        .then((v) => {
          this.state.deckyAvailable = v;
          log("Decky Loader available:", v);
        })
        .catch((e) => {
          debug("Decky availability check error:", errorMessage(e));
        }),
      isSteamosAvailable()
        .then((v) => {
          this.state.steamosAvailable = v;
          log("SteamOS updater available:", v);
        })
        .catch((e) => {
          debug("SteamOS availability check error:", errorMessage(e));
        }),
    ]);
    this.state.steamReady = steamAvailable;
    log("SteamClient ready:", steamAvailable);
    this.notify();

    try {
      debug("Loading history...");
      this.state.historyEntries = await getHistory();
      debug("History loaded:", this.state.historyEntries.length, "entries");
    } catch (e) {
      logError("Failed to load history:", e);
    }

    this.registerWakeDetection();
    this.registerGameDetection();
    this.rebuildPeriodicTimers();

    log(
      "Service started —",
      "checkOnWake:",
      this.state.settings.checkOnWake,
      "| flatpak:",
      this.state.flatpakAvailable,
      "| decky:",
      this.state.deckyAvailable,
      "| steamos:",
      this.state.steamosAvailable,
    );
    this.notify();

    // Run an initial check after a short delay to let Steam settle
    setTimeout(() => {
      if (!this.started) return;
      log("Running initial startup check");
      this.handleStartupCheck();
    }, 10_000);
  }

  stop() {
    log("Service stopping");
    this.started = false;
    if (this.resumeUnregister) {
      this.resumeUnregister();
      this.resumeUnregister = null;
    }
    if (this.gameUnregister) {
      this.gameUnregister();
      this.gameUnregister = null;
    }
    this.runningGames.clear();
    this.stopHeartbeat();
    this.clearTimer("steamTimerId");
    this.clearTimer("flatpakTimerId");
    this.clearTimer("deckyTimerId");
    this.clearTimer("deckyLoaderTimerId");
    this.clearTimer("steamosTimerId");
  }

  async updateSettings(partial: Partial<Settings>) {
    const merged = { ...this.state.settings, ...partial };
    this.state.settings = merged;

    // Update debug flag immediately when the setting changes
    if ("debugLogging" in partial) {
      setDebugEnabled(merged.debugLogging);
    }

    debug("Settings updated:", JSON.stringify(partial));
    this.notify();

    try {
      await saveSettings(merged);
      debug("Settings saved to backend");
    } catch (e) {
      logError("Failed to save settings:", e);
    }

    this.rebuildPeriodicTimers();
  }

  async triggerCheck(source: UpdateSource, trigger: Trigger = "manual"): Promise<UpdateCheckResult> {
    return this.runCheck(source, trigger);
  }

  async triggerAll(trigger: Trigger = "manual"): Promise<UpdateCheckResult[]> {
    const s = this.state.settings;
    const checks: { source: UpdateSource; promise: Promise<UpdateCheckResult> }[] = [];

    if (s.steamEnabled && this.state.steamReady)
      checks.push({ source: "steam", promise: this.runCheck("steam", trigger) });
    if (s.flatpakEnabled && this.state.flatpakAvailable)
      checks.push({ source: "flatpak", promise: this.runCheck("flatpak", trigger) });
    if (s.deckyPluginUpdatesEnabled && this.state.deckyAvailable)
      checks.push({ source: "decky", promise: this.runCheck("decky", trigger) });
    if (s.deckyLoaderUpdateEnabled && this.state.deckyAvailable)
      checks.push({ source: "decky-loader", promise: this.runCheck("decky-loader", trigger) });
    if (s.steamosUpdateEnabled && this.state.steamosAvailable)
      checks.push({ source: "steamos", promise: this.runCheck("steamos", trigger) });

    debug(`triggerAll(${trigger}): [${checks.map((c) => c.source).join(", ")}]`);
    return Promise.all(checks.map((c) => c.promise));
  }

  async clearHistory() {
    try {
      await clearHistoryBackend();
      this.state.historyEntries = [];
      this.notify();
    } catch (e) {
      logError("Failed to clear history:", e);
    }
  }

  async refreshHistory() {
    try {
      this.state.historyEntries = await getHistory();
      this.notify();
    } catch (e) {
      logError("Failed to refresh history:", e);
    }
  }

  // ── Wake Detection ─────────────────────────────────────

  private registerWakeDetection() {
    const unregister = registerForResume(() => {
      log("Wake detected (SteamClient event)");
      this.handleWake();
    });

    if (unregister) {
      this.resumeUnregister = unregister;
      debug("Wake detection: registered SteamClient.System.RegisterForOnResumeFromSuspend");
    } else {
      debug("Wake detection: SteamClient API unavailable, falling back to heartbeat");
      this.startHeartbeat();
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.lastHeartbeat = Date.now();
    debug("Heartbeat started (interval:", HEARTBEAT_INTERVAL_MS, "ms, threshold:", WAKE_THRESHOLD_MS, "ms)");

    this.heartbeatId = setInterval(() => {
      const now = Date.now();
      const gap = now - this.lastHeartbeat;
      this.lastHeartbeat = now;

      if (gap > WAKE_THRESHOLD_MS) {
        log(`Wake detected (heartbeat gap: ${Math.round(gap / 1000)}s)`);
        this.handleWake();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatId) {
      clearInterval(this.heartbeatId);
      this.heartbeatId = null;
    }
  }

  private async handleWake() {
    if (!this.state.settings.checkOnWake) {
      debug("Wake: checkOnWake is OFF, skipping");
      return;
    }

    await this.runAllEnabledChecks("wake");

    // Reset periodic timers so next check fires one full interval from now,
    // not from the stale pre-sleep time
    this.rebuildPeriodicTimers();
  }

  private async handleStartupCheck() {
    if (this.isGameplayBlocked()) {
      log("Startup check suppressed: game is running");
      return;
    }

    await this.runAllEnabledChecks("auto");
  }

  // ── Game Detection ─────────────────────────────────────

  private registerGameDetection() {
    const unregister = registerForAppLifetime((notification) => {
      if (notification.bRunning) {
        this.runningGames.add(notification.unAppID);
        debug(`Game started: appId=${notification.unAppID} (${this.runningGames.size} running)`);
      } else {
        this.runningGames.delete(notification.unAppID);
        debug(`Game stopped: appId=${notification.unAppID} (${this.runningGames.size} running)`);
        if (this.runningGames.size === 0) {
          this.handleGameClose();
        }
      }
    });

    if (unregister) {
      this.gameUnregister = unregister;
      debug("Game detection: registered AppLifetimeNotifications");
    } else {
      debug("Game detection: GameSessions API not available");
    }
  }

  private async handleGameClose() {
    if (!this.state.settings.checkOnGameClose) {
      debug("Game close: checkOnGameClose is OFF, skipping");
      return;
    }

    log("Game close: triggering update checks");
    await this.runAllEnabledChecks("game-close");
  }

  // ── Shared check runner ─────────────────────────────────

  private isGameplayBlocked(): boolean {
    const blocked = !this.state.settings.checkDuringGameplay && this.runningGames.size > 0;
    if (blocked) debug("Check blocked: game is running and checkDuringGameplay is OFF");
    return blocked;
  }

  private async runAllEnabledChecks(trigger: Trigger) {
    const results = await this.triggerAll(trigger);

    if (results.length > 0) {
      const body = combinedToastBody(results, this.state.settings.notificationLevel);
      if (body) {
        try {
          toaster.toast({ title: "AutoUpdate", body });
          debug("Toast shown:", body);
        } catch {
          /* toast is non-critical */
        }
      }
    }
  }

  // ── Periodic Timers ────────────────────────────────────

  private rebuildPeriodicTimers() {
    const s = this.state.settings;
    debug("Rebuilding periodic timers");

    this.clearTimer("steamTimerId");
    if (s.steamEnabled && s.steamCheckIntervalMinutes > 0) {
      const ms = s.steamCheckIntervalMinutes * 60 * 1000;
      this.steamTimerId = setInterval(() => {
        if (!this.state.steamReady || this.isGameplayBlocked()) return;
        this.runCheck("steam", "auto");
      }, ms);
      debug("Steam timer: every", s.steamCheckIntervalMinutes, "min");
    }

    this.clearTimer("flatpakTimerId");
    if (s.flatpakEnabled && s.flatpakCheckIntervalMinutes > 0) {
      const ms = s.flatpakCheckIntervalMinutes * 60 * 1000;
      this.flatpakTimerId = setInterval(() => {
        if (this.isGameplayBlocked()) return;
        this.runCheck("flatpak", "auto");
      }, ms);
      debug("Flatpak timer: every", s.flatpakCheckIntervalMinutes, "min");
    }

    this.clearTimer("deckyTimerId");
    if (s.deckyPluginUpdatesEnabled && this.state.deckyAvailable && s.deckyCheckIntervalMinutes > 0) {
      const ms = s.deckyCheckIntervalMinutes * 60 * 1000;
      this.deckyTimerId = setInterval(() => {
        if (this.isGameplayBlocked()) return;
        this.runCheck("decky", "auto");
      }, ms);
      debug("Decky timer: every", s.deckyCheckIntervalMinutes, "min");
    }

    this.clearTimer("deckyLoaderTimerId");
    if (s.deckyLoaderUpdateEnabled && this.state.deckyAvailable && s.deckyCheckIntervalMinutes > 0) {
      const ms = s.deckyCheckIntervalMinutes * 60 * 1000;
      this.deckyLoaderTimerId = setInterval(() => {
        if (this.isGameplayBlocked()) return;
        this.runCheck("decky-loader", "auto");
      }, ms);
      debug("Decky Loader timer: every", s.deckyCheckIntervalMinutes, "min");
    }

    this.clearTimer("steamosTimerId");
    if (s.steamosUpdateEnabled && this.state.steamosAvailable && s.steamosCheckIntervalMinutes > 0) {
      const ms = s.steamosCheckIntervalMinutes * 60 * 1000;
      this.steamosTimerId = setInterval(() => {
        if (this.isGameplayBlocked()) return;
        this.runCheck("steamos", "auto");
      }, ms);
      debug("SteamOS timer: every", s.steamosCheckIntervalMinutes, "min");
    }
  }

  private clearTimer(
    field: "steamTimerId" | "flatpakTimerId" | "deckyTimerId" | "deckyLoaderTimerId" | "steamosTimerId",
  ) {
    if (this[field]) {
      clearInterval(this[field]);
      this[field] = null;
    }
  }

  // ── Generic check runner ──────────────────────────────

  private async runCheck(source: UpdateSource, trigger: Trigger): Promise<UpdateCheckResult> {
    const { status, lastCheck } = SOURCE_FIELDS[source];

    if (this.state[status] !== "idle") {
      debug(`${source}: already busy (${this.state[status]}), skipping ${trigger} check`);
      return this.state[lastCheck] ?? emptyResult(source);
    }

    log(`${source}: starting ${trigger} check`);
    this.state[status] = "checking";
    this.notify();

    const t0 = Date.now();
    try {
      debug(`${source}: calling provider...`);
      const result = await this.getProvider(source)();
      const elapsed = Date.now() - t0;
      log(
        `${source}: check complete in ${elapsed}ms — ${result.pendingCount} pending, ${result.forcedCount} applied, ${result.errors.length} errors`,
      );
      if (result.errors.length > 0) {
        debug(`${source}: errors:`, result.errors);
      }
      this.state[lastCheck] = result;
      await this.saveHistory(result, trigger);
      return result;
    } catch (e) {
      const elapsed = Date.now() - t0;
      logError(`${source} check failed after ${elapsed}ms:`, e);
      const errResult = emptyResult(source, [errorMessage(e)]);
      this.state[lastCheck] = errResult;
      return errResult;
    } finally {
      debug(`${source}: resetting status to idle`);
      this.state[status] = "idle";
      this.notify();
    }
  }

  private getProvider(source: UpdateSource): () => Promise<UpdateCheckResult> {
    switch (source) {
      case "steam":
        return checkSteam;
      case "flatpak":
        return () => this.flatpakProvider();
      case "decky":
        return () => this.deckyProvider();
      case "decky-loader":
        return checkAndApplyDeckyLoaderUpdate;
      case "steamos":
        return checkAndApplySteamos;
    }
  }

  private async flatpakProvider(): Promise<UpdateCheckResult> {
    debug("flatpakProvider: checking for updates...");
    const checkResult = await checkFlatpakOnly();
    if (checkResult.errors.length > 0 || checkResult.pendingCount === 0) {
      debug(
        "flatpakProvider: returning early —",
        checkResult.pendingCount,
        "pending,",
        checkResult.errors.length,
        "errors",
      );
      return checkResult;
    }
    if (this.state.settings.flatpakAutoApply) {
      log("flatpakProvider: auto-applying", checkResult.pendingCount, "update(s)");
      this.state.flatpakStatus = "applying";
      this.notify();
      return applyFlatpak(checkResult.flatpakUpdates);
    }
    debug("flatpakProvider: auto-apply disabled, returning check result");
    return checkResult;
  }

  private deckyProvider(): Promise<UpdateCheckResult> {
    debug("deckyProvider: checking and applying plugin updates...");
    return applyDeckyPluginUpdates(this.state.settings.deckyPluginBlacklist);
  }

  // ── History ───────────────────────────────────────────

  private async saveHistory(result: UpdateCheckResult, trigger: Trigger) {
    if (!this.state.settings.logHistory) return;
    if (result.pendingCount === 0 && result.forcedCount === 0) return;
    const entry: HistoryEntry = {
      source: result.source,
      timestamp: result.timestamp,
      pendingCount: result.pendingCount,
      forcedCount: result.forcedCount,
      trigger,
    };
    try {
      await addHistoryEntry(entry);
      const max = this.state.settings.maxHistoryEntries;
      this.state.historyEntries = [entry, ...this.state.historyEntries].slice(0, max);
      debug("History entry saved:", result.source, trigger);
    } catch (e) {
      logError(`Failed to save ${result.source} history:`, e);
    }
  }

  private notify() {
    this.listeners.forEach((fn) => {
      try {
        fn();
      } catch {
        /* ignore */
      }
    });
  }
}

export const service = new AutoUpdateService();
