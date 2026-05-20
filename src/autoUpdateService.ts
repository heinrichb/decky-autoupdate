/**
 * AutoUpdateService - singleton that runs background timers at the plugin level,
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
  ALL_SOURCES,
  emptyResult,
} from "./types";
import { waitForSteamClient, registerForResume, registerForAppLifetime, probeSteamClientApi } from "./steamClient";
import {
  checkSteam,
  checkAndApplyFlatpak,
  isFlatpakAvailable,
  isDeckyApiAvailable,
  applyDeckyPluginUpdates,
  checkAndApplyDeckyLoaderUpdate,
  isSteamosAvailable,
  checkAndApplySteamos,
} from "./providers";
import { callPluginMethod, getDeckyVersion } from "./deckyApi";
import { PLUGIN_VERSION } from "./version";
import {
  combinedToastBody,
  log,
  logWarn,
  logError,
  debug,
  errorMessage,
  setDebugEnabled,
  setBackendLog,
  waitForNetwork,
} from "./helpers";

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
  private _batchMode = false;
  private _batchDirty = false;
  private _driftProbeId: ReturnType<typeof setInterval> | null = null;
  private _lastDriftProbe = 0;

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
    log(`AutoUpdate v${PLUGIN_VERSION} starting`);

    try {
      debug("Loading settings via IPC...");
      const s = await getSettings();
      this.state.settings = { ...DEFAULT_SETTINGS, ...s };
      setDebugEnabled(this.state.settings.debugLogging);
      setBackendLog((level: string, message: string) => {
        callPluginMethod("log_frontend_message", [level, message], 5_000).catch(() => {});
      });
      this.state.settingsLoaded = true;
      debug("Settings loaded:", JSON.stringify(this.state.settings));
    } catch (e) {
      logError("Failed to load settings, using defaults:", e);
      this.state.settingsLoaded = true;
    }
    this.notify();

    // Availability checks are independent - run in parallel
    debug("Running availability checks...");
    const availT0 = Date.now();
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
    log(`Availability checks completed in ${Date.now() - availT0}ms`);
    this.state.steamReady = steamAvailable;
    log("SteamClient ready:", steamAvailable);
    if (steamAvailable) {
      probeSteamClientApi();
    }
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
    this.startDriftProbe();

    let deckyVersion = "";
    if (this.state.deckyAvailable) {
      try {
        deckyVersion = await getDeckyVersion();
      } catch (e) {
        log("Failed to fetch Decky Loader version:", errorMessage(e));
      }
    }

    log(
      `Service started. v${PLUGIN_VERSION}`,
      deckyVersion ? `| Decky Loader: ${deckyVersion}` : "",
      "| checkOnWake:",
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

  async dumpDiagnostics(): Promise<string> {
    const lines: string[] = [];
    lines.push(`=== AutoUpdate Diagnostics ===`);
    lines.push(`Plugin version: ${PLUGIN_VERSION}`);
    lines.push(`Debug logging: ${this.state.settings.debugLogging ? "ON" : "OFF"}`);
    lines.push(`Settings loaded: ${this.state.settingsLoaded}`);
    lines.push(`Steam ready: ${this.state.steamReady}`);
    lines.push(`Flatpak available: ${this.state.flatpakAvailable}`);
    lines.push(`Decky available: ${this.state.deckyAvailable}`);
    lines.push(`SteamOS available: ${this.state.steamosAvailable}`);

    if (this.state.deckyAvailable) {
      try {
        const deckyVer = await getDeckyVersion();
        lines.push(`Decky Loader version: ${deckyVer}`);
      } catch {
        lines.push(`Decky Loader version: (unavailable)`);
      }
    }

    lines.push(`--- Settings ---`);
    lines.push(JSON.stringify(this.state.settings, null, 2));

    lines.push(`--- Last Check Results ---`);
    const sources = ALL_SOURCES;
    for (const source of sources) {
      const { lastCheck } = SOURCE_FIELDS[source];
      const result = this.state[lastCheck];
      if (result) {
        lines.push(
          `${source}: pending=${result.pendingCount} forced=${result.forcedCount} errors=${result.errors.length} at ${new Date(result.timestamp).toISOString()}`,
        );
      } else {
        lines.push(`${source}: never checked`);
      }
    }

    lines.push(`History entries: ${this.state.historyEntries.length}`);
    lines.push(`Running games: ${this.runningGames.size}`);
    lines.push(`=== End Diagnostics ===`);

    const dump = lines.join("\n");
    log(dump);
    return dump;
  }

  stop() {
    log("Service stopping");
    setBackendLog(null);
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
    this.stopDriftProbe();
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

    // Build the set of enabled + available sources
    const enabledSet = new Set<UpdateSource>();
    if (s.steamEnabled && this.state.steamReady) enabledSet.add("steam");
    if (s.flatpakEnabled && this.state.flatpakAvailable) enabledSet.add("flatpak");
    if (s.deckyPluginUpdatesEnabled && this.state.deckyAvailable) enabledSet.add("decky");
    if (s.deckyLoaderUpdateEnabled && this.state.deckyAvailable) enabledSet.add("decky-loader");
    if (s.steamosUpdateEnabled && this.state.steamosAvailable) enabledSet.add("steamos");

    // Use configured order, filtering to only enabled+available sources
    const sources = s.checkOrder.filter((src) => enabledSet.has(src));
    // Append any enabled sources not in checkOrder (defensive, handles new sources)
    for (const src of enabledSet) {
      if (!sources.includes(src)) sources.push(src);
    }

    const delayMs = s.interCheckDelayMs;
    debug(`triggerAll(${trigger}): [${sources.join(", ")}] delay=${delayMs}ms`);

    // Run sequentially - Decky Loader closes WebSocket connections when
    // concurrent plugin method calls arrive on separate sockets.
    // Batch mode suppresses per-check notify() to reduce React re-renders.
    const batchT0 = Date.now();
    const results: UpdateCheckResult[] = [];
    const perSourceMs: string[] = [];
    this._batchMode = true;
    this._batchDirty = false;
    try {
      for (let i = 0; i < sources.length; i++) {
        const checkT0 = Date.now();
        results.push(await this.runCheck(sources[i], trigger));
        perSourceMs.push(`${sources[i]}=${Date.now() - checkT0}ms`);

        // Yield to UI thread between checks so Steam stays responsive
        if (i < sources.length - 1 && delayMs > 0) {
          const delayT0 = Date.now();
          await new Promise((r) => setTimeout(r, delayMs));
          const actualDelay = Date.now() - delayT0;
          const drift = actualDelay - delayMs;
          if (drift > 250) {
            logWarn(
              `Inter-check delay drift after ${sources[i]}: expected ${delayMs}ms, actual ${actualDelay}ms (${drift}ms late)`,
            );
          }
        }
      }
    } finally {
      const wasBatched = this._batchDirty;
      this._batchMode = false;
      if (wasBatched) this.notify();
    }

    const batchElapsed = Date.now() - batchT0;
    log(
      `triggerAll(${trigger}): ${sources.length} sources in ${batchElapsed}ms` +
        ` [${perSourceMs.join(", ")}]`,
    );
    return results;
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
      this.handleWake("steamclient-event");
    });

    if (unregister) {
      this.resumeUnregister = unregister;
      log("Wake detection: registered SteamClient.System.RegisterForOnResumeFromSuspend");
    } else {
      log("Wake detection: SteamClient API unavailable, falling back to heartbeat");
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
        const gapSec = Math.round(gap / 1000);
        log(`Wake detected (heartbeat gap: ${gapSec}s)`);
        this.handleWake(`heartbeat-gap-${gapSec}s`);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatId) {
      clearInterval(this.heartbeatId);
      this.heartbeatId = null;
    }
  }

  // ── Event Loop Drift Probe ──────────────────────────────
  // A lightweight 2-second interval that detects when the JS event loop is
  // blocked (the actual symptom behind UI lag). Fires at INFO for severe
  // drift (>500ms) and DEBUG for moderate drift (>250ms).

  private static readonly DRIFT_PROBE_INTERVAL_MS = 2000;
  private static readonly DRIFT_WARN_THRESHOLD_MS = 500;
  private static readonly DRIFT_DEBUG_THRESHOLD_MS = 250;

  private startDriftProbe() {
    this.stopDriftProbe();
    this._lastDriftProbe = Date.now();
    this._driftProbeId = setInterval(() => {
      const now = Date.now();
      const elapsed = now - this._lastDriftProbe;
      const drift = elapsed - AutoUpdateService.DRIFT_PROBE_INTERVAL_MS;
      this._lastDriftProbe = now;

      if (drift > AutoUpdateService.DRIFT_WARN_THRESHOLD_MS) {
        logWarn(
          `EventLoop drift: ${drift}ms late (expected ${AutoUpdateService.DRIFT_PROBE_INTERVAL_MS}ms, actual ${elapsed}ms)`,
        );
      } else if (drift > AutoUpdateService.DRIFT_DEBUG_THRESHOLD_MS) {
        debug(
          `EventLoop drift: ${drift}ms late (expected ${AutoUpdateService.DRIFT_PROBE_INTERVAL_MS}ms, actual ${elapsed}ms)`,
        );
      }
    }, AutoUpdateService.DRIFT_PROBE_INTERVAL_MS);
  }

  private stopDriftProbe() {
    if (this._driftProbeId) {
      clearInterval(this._driftProbeId);
      this._driftProbeId = null;
    }
  }

  private async handleWake(wakeSource: string = "unknown") {
    const wakeT0 = Date.now();
    log(
      `WAKE BEGIN source=${wakeSource} runningGames=${this.runningGames.size}` +
        ` checkOnWake=${this.state.settings.checkOnWake}` +
        ` interCheckDelayMs=${this.state.settings.interCheckDelayMs}` +
        ` order=[${this.state.settings.checkOrder.join(",")}]`,
    );

    if (!this.state.settings.checkOnWake) {
      log(`WAKE END source=${wakeSource} skipped=checkOnWake-off elapsed=${Date.now() - wakeT0}ms`);
      return;
    }

    // Phase 1: settle wait — if this takes materially longer than 8s the
    // event loop was already contended during the wait itself
    const settleT0 = Date.now();
    await new Promise((r) => setTimeout(r, 8000));
    const settleMs = Date.now() - settleT0;
    if (settleMs > 8500) {
      logWarn(`Wake settle drift: expected ~8000ms, actual ${settleMs}ms (event loop contended)`);
    } else {
      debug(`Wake: settle wait completed in ${settleMs}ms`);
    }

    // Phase 2: network wait
    const netT0 = Date.now();
    const online = await waitForNetwork(30_000);
    const netMs = Date.now() - netT0;
    if (!online) {
      log(
        `WAKE END source=${wakeSource} skipped=no-network` +
          ` settle=${settleMs}ms network=${netMs}ms total=${Date.now() - wakeT0}ms`,
      );
      return;
    }
    log(`Wake: network ready in ${netMs}ms`);

    // Phase 3: run all enabled checks
    const checksT0 = Date.now();
    await this.runAllEnabledChecks("wake");
    const checksMs = Date.now() - checksT0;

    // Reset periodic timers so next check fires one full interval from now,
    // not from the stale pre-sleep time
    this.rebuildPeriodicTimers();

    log(
      `WAKE END source=${wakeSource} settle=${settleMs}ms network=${netMs}ms` +
        ` checks=${checksMs}ms total=${Date.now() - wakeT0}ms`,
    );
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
      log("Game detection: registered AppLifetimeNotifications");
    } else {
      log("Game detection: GameSessions API not available");
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
        `${source}: check complete in ${elapsed}ms - ${result.pendingCount} pending, ${result.forcedCount} applied, ${result.errors.length} errors`,
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
    const autoApply = this.state.settings.flatpakAutoApply;
    debug("flatpakProvider: autoApply =", autoApply);
    if (autoApply) {
      this.state.flatpakStatus = "applying";
      this.notify();
    }
    return checkAndApplyFlatpak(autoApply);
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
    if (this._batchMode) {
      this._batchDirty = true;
      return;
    }
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
