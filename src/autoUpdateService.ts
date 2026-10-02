/**
 * AutoUpdateService - singleton that runs background scheduling at the plugin level,
 * NOT inside React hooks. This ensures wake detection and scheduled checks work
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
  BatchProgress,
  CheckStateEntry,
  DEFAULT_SETTINGS,
  ALL_SOURCES,
  emptyResult,
} from "./types";
import { waitForSteamClient, registerForResume, registerForAppLifetime, probeSteamClientApi } from "./steamClient";
import type { AppLifetimeNotification } from "./steamClient";
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
  isDebugEnabled,
  setBackendLog,
  flushBackendLog,
  waitForNetwork,
} from "./helpers";

const IPC_TIMEOUT = 10_000;
const getSettings = () => callPluginMethod<Settings>("get_settings", IPC_TIMEOUT);
const saveSettings = (s: Settings) => callPluginMethod<boolean>("save_settings", [s], IPC_TIMEOUT);
const getHistory = () => callPluginMethod<HistoryEntry[]>("get_history", IPC_TIMEOUT);
const addHistoryEntry = (e: HistoryEntry) => callPluginMethod<boolean>("add_history_entry", [e], IPC_TIMEOUT);
const clearHistoryBackend = () => callPluginMethod<boolean>("clear_history", IPC_TIMEOUT);
const getCheckState = () => callPluginMethod<Record<string, unknown>>("get_check_state", IPC_TIMEOUT);
const saveCheckStateBackend = (s: Record<string, CheckStateEntry>) =>
  callPluginMethod<boolean>("save_check_state", [s], IPC_TIMEOUT);

const MINUTE_MS = 60_000;
const STARTUP_DELAY_MS = 10_000;
const WAKE_SETTLE_MS = 8_000;
const WAKE_NETWORK_TIMEOUT_MS = 30_000;
const WAKE_COALESCE_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const WAKE_THRESHOLD_MS = 60_000;
const GAME_CLOSE_DEBOUNCE_MS = 30_000;
const SCHEDULER_MIN_ARM_MS = 1_000;
// Long sleeps are re-evaluated so suspend and clock jumps cannot strand a check.
const SCHEDULER_MAX_ARM_MS = 15 * MINUTE_MS;
const SCHEDULER_LATE_MS = 60_000;
const SCHEDULER_LATE_DEFER_MS = 30_000;
const SCHEDULER_BUSY_RETRY_MS = 60_000;
const GAMEPLAY_RETRY_MS = 5 * MINUTE_MS;
// Sources due within this window run in the same batch instead of a separate one moments later.
const DUE_SLACK_MS = 60_000;
const FAILED_RETRY_MAX_MS = 30 * MINUTE_MS;
const OFFLINE_RETRY_MS = 60_000;
const SETTINGS_SAVE_DEBOUNCE_MS = 400;
const DRIFT_PROBE_INTERVAL_MS = 2_000;
const DRIFT_LOG_THRESHOLD_MS = 250;
const RESUME_GAP_MS = 60_000;

const OFFLINE_ERROR =
  /resolve host|network is unreachable|device is offline|name resolution|cannot connect to host|failed to fetch/i;

type StatusKey = "steamStatus" | "flatpakStatus" | "deckyStatus" | "deckyLoaderStatus" | "steamosStatus";
type LastCheckKey =
  | "steamLastCheck"
  | "flatpakLastCheck"
  | "deckyLastCheck"
  | "deckyLoaderLastCheck"
  | "steamosLastCheck";
type EnabledKey =
  | "steamEnabled"
  | "flatpakEnabled"
  | "deckyPluginUpdatesEnabled"
  | "deckyLoaderUpdateEnabled"
  | "steamosUpdateEnabled";
type IntervalKey =
  | "steamCheckIntervalMinutes"
  | "flatpakCheckIntervalMinutes"
  | "deckyCheckIntervalMinutes"
  | "steamosCheckIntervalMinutes";
type AvailableKey = "steamReady" | "flatpakAvailable" | "deckyAvailable" | "steamosAvailable";

interface SourceFields {
  status: StatusKey;
  lastCheck: LastCheckKey;
  enabled: EnabledKey;
  interval: IntervalKey;
  available: AvailableKey;
}

const SOURCE_FIELDS: Record<UpdateSource, SourceFields> = {
  steam: {
    status: "steamStatus",
    lastCheck: "steamLastCheck",
    enabled: "steamEnabled",
    interval: "steamCheckIntervalMinutes",
    available: "steamReady",
  },
  flatpak: {
    status: "flatpakStatus",
    lastCheck: "flatpakLastCheck",
    enabled: "flatpakEnabled",
    interval: "flatpakCheckIntervalMinutes",
    available: "flatpakAvailable",
  },
  decky: {
    status: "deckyStatus",
    lastCheck: "deckyLastCheck",
    enabled: "deckyPluginUpdatesEnabled",
    interval: "deckyCheckIntervalMinutes",
    available: "deckyAvailable",
  },
  "decky-loader": {
    status: "deckyLoaderStatus",
    lastCheck: "deckyLoaderLastCheck",
    enabled: "deckyLoaderUpdateEnabled",
    interval: "deckyCheckIntervalMinutes",
    available: "deckyAvailable",
  },
  steamos: {
    status: "steamosStatus",
    lastCheck: "steamosLastCheck",
    enabled: "steamosUpdateEnabled",
    interval: "steamosCheckIntervalMinutes",
    available: "steamosAvailable",
  },
};

const SCHEDULE_KEYS: readonly (keyof Settings)[] = [
  ...new Set(Object.values(SOURCE_FIELDS).flatMap((f) => [f.enabled, f.interval])),
];

function isOfflineFailure(result: UpdateCheckResult): boolean {
  return result.errors.some((e) => e.startsWith("Offline:") || OFFLINE_ERROR.test(e));
}

function parseCheckStateEntry(raw: unknown, now: number): CheckStateEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const timestamp = num(e.timestamp);
  if (timestamp === null || timestamp <= 0) return null;
  return {
    timestamp: Math.min(timestamp, now),
    pendingCount: Math.max(0, num(e.pendingCount) ?? 0),
    forcedCount: Math.max(0, num(e.forcedCount) ?? 0),
    errors: Array.isArray(e.errors) ? e.errors.filter((x): x is string => typeof x === "string") : [],
  };
}

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

  batch: BatchProgress | null;
  gameRunning: boolean;
}

type Listener = () => void;
type Timer = ReturnType<typeof setTimeout>;

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
    batch: null,
    gameRunning: false,
  };

  private listeners = new Set<Listener>();
  private started = false;
  // Bumped by stop(); async flows compare it after every await and bail out when it changed.
  private gen = 0;
  private startedAt = 0;
  private startupTimer: Timer | null = null;
  // True from start() until the startup check is handed off; the scheduler stays unarmed meanwhile.
  private startupPending = false;
  private schedulerTimer: Timer | null = null;
  private schedulerFireAt = 0;
  private heartbeatId: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeat = 0;
  private wakeApi = "none";
  private resumeUnregister: (() => void) | null = null;
  private gameUnregister: (() => void) | null = null;
  private runningGames = new Set<number>();
  private gameCloseTimer: Timer | null = null;
  private wakeInFlight = false;
  private lastWakeAt = 0;
  private batchPromise: Promise<UpdateCheckResult[]> | null = null;
  private retryTimers = new Map<UpdateSource, Timer>();
  private sleepers = new Set<{ timer: Timer; resolve: () => void }>();
  private settingsSaveTimer: Timer | null = null;
  private driftProbeId: ReturnType<typeof setInterval> | null = null;
  private lastDriftProbe = 0;

  // ── Public API ─────────────────────────────────────────

  getState(): ServiceState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.startupPending = true;
    const gen = ++this.gen;
    try {
      await this.initialize(gen);
    } catch (e) {
      if (gen === this.gen) this.startupPending = false;
      throw e;
    }
  }

  private async initialize(gen: number) {
    this.startedAt = Date.now();
    setBackendLog((entries) => {
      callPluginMethod("log_frontend_batch", [entries], IPC_TIMEOUT).catch(() => {});
    });
    log(`AutoUpdate v${PLUGIN_VERSION} starting`);

    try {
      const s = await getSettings();
      if (gen !== this.gen) return;
      this.state.settings = { ...DEFAULT_SETTINGS, ...s };
      setDebugEnabled(this.state.settings.debugLogging);
      if (isDebugEnabled()) debug("Settings loaded:", JSON.stringify(this.state.settings));
    } catch (e) {
      if (gen !== this.gen) return;
      logError("Failed to load settings, using defaults:", e);
    }
    this.state.settingsLoaded = true;
    this.notify();

    // Availability checks are independent - run in parallel
    const availT0 = Date.now();
    const [, steamAvailable, , , checkState] = await Promise.all([
      isFlatpakAvailable()
        .then((v) => {
          this.state.flatpakAvailable = v;
          debug("Flatpak available:", v);
        })
        .catch((e) => {
          debug("Flatpak availability check error:", errorMessage(e));
        }),
      waitForSteamClient(30_000).catch(() => false),
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
      getCheckState().catch((e) => {
        logWarn("Failed to load check state:", e);
        return {};
      }),
    ]);
    if (gen !== this.gen) return;
    log(`Availability checks completed in ${Date.now() - availT0}ms`);
    this.state.steamReady = steamAvailable;
    log("SteamClient ready:", steamAvailable);
    if (steamAvailable) {
      probeSteamClientApi();
    }
    this.seedCheckState(checkState);
    this.notify();

    try {
      const history = await getHistory();
      if (gen !== this.gen) return;
      this.state.historyEntries = Array.isArray(history) ? history : [];
      debug("History loaded:", this.state.historyEntries.length, "entries");
    } catch (e) {
      if (gen !== this.gen) return;
      logError("Failed to load history:", e);
    }

    this.registerWakeDetection();
    this.registerGameDetection();
    if (this.state.settings.debugLogging) this.startDriftProbe();

    let deckyVersion = "";
    if (this.state.deckyAvailable) {
      try {
        deckyVersion = await getDeckyVersion();
      } catch (e) {
        log("Failed to fetch Decky Loader version:", errorMessage(e));
      }
      if (gen !== this.gen) return;
    }

    log(
      `Service started. v${PLUGIN_VERSION}`,
      deckyVersion ? `| Decky Loader: ${deckyVersion}` : "",
      `| wake: ${this.wakeApi}`,
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

    // Initial check after a short delay to let Steam settle; the scheduler is armed once it ran.
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      this.startupPending = false;
      void this.handleStartupCheck(gen);
    }, STARTUP_DELAY_MS);
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
    lines.push(`Wake detection: ${this.wakeApi}`);

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
    for (const source of ALL_SOURCES) {
      const result = this.state[SOURCE_FIELDS[source].lastCheck];
      const due = this.nextDueAt(source);
      const dueText = due === null ? "not scheduled" : `next due ${new Date(due).toISOString()}`;
      if (result) {
        lines.push(
          `${source}: pending=${result.pendingCount} forced=${result.forcedCount} errors=${result.errors.length} at ${new Date(result.timestamp).toISOString()} (${dueText})`,
        );
      } else {
        lines.push(`${source}: never checked (${dueText})`);
      }
    }

    lines.push(`History entries: ${this.state.historyEntries.length}`);
    lines.push(`Running games: ${this.runningGames.size}`);
    lines.push(`Batch: ${this.state.batch ? JSON.stringify(this.state.batch) : "none"}`);
    lines.push(`=== End Diagnostics ===`);

    const dump = lines.join("\n");
    log(dump);
    return dump;
  }

  stop() {
    log("Service stopping");
    this.started = false;
    this.gen++;
    if (this.resumeUnregister) {
      this.resumeUnregister();
      this.resumeUnregister = null;
    }
    if (this.gameUnregister) {
      this.gameUnregister();
      this.gameUnregister = null;
    }
    this.runningGames.clear();
    this.state.gameRunning = false;
    this.stopHeartbeat();
    this.stopDriftProbe();
    this.clearScheduler();
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    this.startupPending = false;
    this.clearGameCloseTimer();
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    for (const sleeper of this.sleepers) {
      clearTimeout(sleeper.timer);
      sleeper.resolve();
    }
    this.sleepers.clear();
    this.wakeInFlight = false;
    this.lastWakeAt = 0;
    this.batchPromise = null;
    this.state.batch = null;
    this.flushSettingsSave();
    flushBackendLog();
    setBackendLog(null);
  }

  async updateSettings(partial: Partial<Settings>) {
    const prev = this.state.settings;
    const merged = { ...prev, ...partial };
    this.state.settings = merged;

    if ("debugLogging" in partial && merged.debugLogging !== prev.debugLogging) {
      setDebugEnabled(merged.debugLogging);
      if (merged.debugLogging && this.started) this.startDriftProbe();
      else this.stopDriftProbe();
    }

    debug("Settings updated:", JSON.stringify(partial));
    this.notify();
    this.scheduleSettingsSave();

    if (SCHEDULE_KEYS.some((k) => k in partial && merged[k] !== prev[k])) {
      debug("Schedule-relevant setting changed, re-arming scheduler");
      this.armScheduler();
    }
  }

  triggerCheck(source: UpdateSource, trigger: Trigger = "manual"): Promise<UpdateCheckResult | null> {
    return this.runCheck(source, trigger, false);
  }

  async triggerAll(trigger: Trigger = "manual"): Promise<UpdateCheckResult[]> {
    if (this.state.batch) {
      log(`triggerAll(${trigger}): ignored, a ${this.state.batch.trigger} batch is already running`);
      return [];
    }
    const sources = this.batchSources(trigger);
    if (sources.length === 0) {
      log(`triggerAll(${trigger}): nothing to check`);
      return [];
    }
    const promise = this.runBatch(trigger, sources, true);
    this.batchPromise = promise;
    return promise;
  }

  /** Epoch ms when the source is next due; in the past when overdue; null when not scheduled. */
  nextDueAt(source: UpdateSource): number | null {
    const fields = SOURCE_FIELDS[source];
    if (!this.started || !fields || !this.isActive(source)) return null;
    const last = this.state[fields.lastCheck];
    if (!last) return this.startedAt;
    const interval = this.intervalMs(source);
    return last.timestamp + (last.errors.length > 0 ? Math.min(interval, FAILED_RETRY_MAX_MS) : interval);
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
    let api = "SteamClient";
    const registration = registerForResume((state) => this.onResume(api, state));

    if (registration) {
      api = registration.api;
      this.wakeApi = api;
      this.resumeUnregister = registration.unregister;
      log(`Wake detection: registered ${api}`);
    } else {
      this.wakeApi = "heartbeat";
      log("Wake detection: SteamClient API unavailable, falling back to heartbeat");
      this.startHeartbeat();
    }
  }

  // Steam reports resume progress in stages, so one wake can call this several times.
  private onResume(api: string, state: number | undefined) {
    if (!this.started) return;
    if (this.wakeInFlight || Date.now() - this.lastWakeAt < WAKE_COALESCE_MS) {
      log(`wake coalesced state=${state ?? "none"}`);
      return;
    }
    log(`Wake detected via ${api} state=${state ?? "none"}`);
    this.lastWakeAt = Date.now();
    if (this.state.settings.checkOnWake) this.cancelGameClose("wake");
    void this.handleWake(api);
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
        this.onResume(`heartbeat gap ${Math.round(gap / 1000)}s`, undefined);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatId) {
      clearInterval(this.heartbeatId);
      this.heartbeatId = null;
    }
  }

  private async handleWake(wakeSource: string) {
    const gen = this.gen;
    const wakeT0 = Date.now();
    this.wakeInFlight = true;
    try {
      log(
        `WAKE BEGIN source=${wakeSource} runningGames=${this.runningGames.size}` +
          ` checkOnWake=${this.state.settings.checkOnWake}`,
      );
      if (!this.state.settings.checkOnWake) {
        log(`WAKE END source=${wakeSource} skipped=checkOnWake-off`);
        return;
      }

      const settleT0 = Date.now();
      await this.sleep(WAKE_SETTLE_MS);
      if (gen !== this.gen) return;
      const settleMs = Date.now() - settleT0;
      debug(`Wake: settle wait completed in ${settleMs}ms`);

      const netT0 = Date.now();
      const online = await waitForNetwork(WAKE_NETWORK_TIMEOUT_MS, () => gen !== this.gen);
      if (gen !== this.gen) return;
      const netMs = Date.now() - netT0;
      if (!online) {
        log(`WAKE END source=${wakeSource} skipped=no-network settle=${settleMs}ms network=${netMs}ms`);
        return;
      }

      const checksT0 = Date.now();
      await this.runAllEnabledChecks("wake", gen);
      if (gen !== this.gen) return;
      log(
        `WAKE END source=${wakeSource} settle=${settleMs}ms network=${netMs}ms` +
          ` checks=${Date.now() - checksT0}ms total=${Date.now() - wakeT0}ms`,
      );
    } finally {
      if (gen === this.gen) {
        this.wakeInFlight = false;
        this.lastWakeAt = Date.now();
        this.armScheduler();
      }
    }
  }

  private async handleStartupCheck(gen: number) {
    if (gen !== this.gen) return;
    if (this.isGameplayBlocked()) {
      log("Startup check suppressed: game is running");
    } else {
      log("Running initial startup check");
      await this.runAllEnabledChecks("auto", gen);
    }
    if (gen === this.gen) this.armScheduler();
  }

  // ── Event Loop Drift Probe (debug logging only) ─────────

  private startDriftProbe() {
    this.stopDriftProbe();
    this.lastDriftProbe = Date.now();
    this.driftProbeId = setInterval(() => {
      const now = Date.now();
      const elapsed = now - this.lastDriftProbe;
      const drift = elapsed - DRIFT_PROBE_INTERVAL_MS;
      this.lastDriftProbe = now;

      if (drift > RESUME_GAP_MS) {
        debug(`resume gap: ${Math.round(drift / 1000)}s`);
      } else if (drift > DRIFT_LOG_THRESHOLD_MS) {
        debug(`EventLoop drift: ${drift}ms late (expected ${DRIFT_PROBE_INTERVAL_MS}ms, actual ${elapsed}ms)`);
      }
    }, DRIFT_PROBE_INTERVAL_MS);
  }

  private stopDriftProbe() {
    if (this.driftProbeId) {
      clearInterval(this.driftProbeId);
      this.driftProbeId = null;
    }
  }

  // ── Game Detection ─────────────────────────────────────

  private registerGameDetection() {
    const unregister = registerForAppLifetime((notification) => this.onAppLifetime(notification));

    if (unregister) {
      this.gameUnregister = unregister;
      log("Game detection: registered AppLifetimeNotifications");
    } else {
      log("Game detection: GameSessions API not available");
    }
  }

  private onAppLifetime(notification: AppLifetimeNotification) {
    if (!this.started) return;
    if (notification.bRunning) {
      this.runningGames.add(notification.unAppID);
      debug(`Game started: appId=${notification.unAppID} (${this.runningGames.size} running)`);
      this.cancelGameClose("game started");
    } else {
      this.runningGames.delete(notification.unAppID);
      debug(`Game stopped: appId=${notification.unAppID} (${this.runningGames.size} running)`);
      if (this.runningGames.size === 0) this.scheduleGameClose();
    }
    const running = this.runningGames.size > 0;
    if (running !== this.state.gameRunning) {
      this.state.gameRunning = running;
      this.notify();
    }
  }

  private scheduleGameClose() {
    const s = this.state.settings;
    if (!s.checkOnGameClose) {
      debug("Game close: checkOnGameClose is OFF, skipping");
      return;
    }
    if (s.checkOnWake && this.wakeInFlight) {
      debug("Game close: covered by the wake check in progress");
      return;
    }
    this.clearGameCloseTimer();
    const gen = this.gen;
    log(`Game close: checking in ${GAME_CLOSE_DEBOUNCE_MS / 1000}s unless a game starts`);
    this.gameCloseTimer = setTimeout(() => {
      this.gameCloseTimer = null;
      void this.handleGameClose(gen);
    }, GAME_CLOSE_DEBOUNCE_MS);
  }

  private cancelGameClose(reason: string) {
    if (!this.gameCloseTimer) return;
    this.clearGameCloseTimer();
    log(`Game close check cancelled: ${reason}`);
    this.armScheduler();
  }

  private clearGameCloseTimer() {
    if (this.gameCloseTimer) {
      clearTimeout(this.gameCloseTimer);
      this.gameCloseTimer = null;
    }
  }

  private async handleGameClose(gen: number) {
    if (gen !== this.gen) return;
    if (!this.state.settings.checkOnGameClose) return;
    if (this.isGameplayBlocked()) {
      log("Game close: a game is running again, skipping");
      this.armScheduler();
      return;
    }
    log("Game close: triggering update checks");
    await this.runAllEnabledChecks("game-close", gen);
    if (gen === this.gen) this.armScheduler();
  }

  // ── Shared check runner ─────────────────────────────────

  private isGameplayBlocked(): boolean {
    const blocked = !this.state.settings.checkDuringGameplay && this.runningGames.size > 0;
    if (blocked) debug("Check blocked: game is running and checkDuringGameplay is OFF");
    return blocked;
  }

  private isActive(source: UpdateSource): boolean {
    const fields = SOURCE_FIELDS[source];
    return !!this.state.settings[fields.enabled] && this.state[fields.available];
  }

  /** Enabled + available sources in the configured check order. */
  private activeSources(): UpdateSource[] {
    const configured = this.state.settings.checkOrder;
    const order = Array.isArray(configured) ? configured : DEFAULT_SETTINGS.checkOrder;
    const sources: UpdateSource[] = [];
    for (const source of [...order, ...ALL_SOURCES]) {
      if (SOURCE_FIELDS[source] && !sources.includes(source) && this.isActive(source)) sources.push(source);
    }
    return sources;
  }

  private intervalMs(source: UpdateSource): number {
    const key = SOURCE_FIELDS[source].interval;
    const minutes = Number(this.state.settings[key]);
    return (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_SETTINGS[key]) * MINUTE_MS;
  }

  private isDue(source: UpdateSource, now: number): boolean {
    const due = this.nextDueAt(source);
    return due !== null && due <= now + DUE_SLACK_MS;
  }

  // Manual checks everything; other triggers check Steam (cheap, time-sensitive) plus whatever is due.
  private batchSources(trigger: Trigger): UpdateSource[] {
    const active = this.activeSources();
    if (trigger === "manual") return active;
    const now = Date.now();
    const sources = active.filter((src) => src === "steam" || this.isDue(src, now));
    const notDue = active.filter((src) => !sources.includes(src));
    if (notDue.length > 0) {
      debug(
        `triggerAll(${trigger}): not due: ${notDue.map((src) => `${src}@${new Date(this.nextDueAt(src)!).toISOString()}`).join(", ")}`,
      );
    }
    return sources;
  }

  private async runAllEnabledChecks(trigger: Trigger, gen: number) {
    let waited: Promise<unknown> | null = null;
    while (this.state.batch && this.batchPromise && this.batchPromise !== waited) {
      debug(`${trigger}: waiting for the running ${this.state.batch.trigger} batch`);
      waited = this.batchPromise;
      await waited.catch(() => {});
      if (gen !== this.gen) return;
    }
    const results = await this.triggerAll(trigger);
    if (gen !== this.gen) return;
    this.toastResults(results);
  }

  private toastResults(results: UpdateCheckResult[]) {
    if (results.length === 0) return;
    const body = combinedToastBody(results, this.state.settings.notificationLevel);
    if (!body) return;
    try {
      toaster.toast({ title: "AutoUpdate", body });
      debug("Toast shown:", body);
    } catch {
      /* toast is non-critical */
    }
  }

  private async runBatch(trigger: Trigger, sources: UpdateSource[], toastRetries: boolean) {
    const gen = this.gen;
    const delayMs = Math.max(0, Number(this.state.settings.interCheckDelayMs) || 0);
    const batchT0 = Date.now();
    const results: UpdateCheckResult[] = [];
    const perSourceMs: string[] = [];
    let ranPrevious = false;
    let stoppedBy = "";

    this.setBatch({ trigger, total: sources.length, done: 0, current: null });
    log(`triggerAll(${trigger}): [${sources.join(", ")}] delay=${delayMs}ms`);
    try {
      for (const source of sources) {
        if (this.state[SOURCE_FIELDS[source].status] !== "idle") {
          debug(`triggerAll(${trigger}): ${source} is busy, skipping`);
          this.advanceBatch(null, 1);
          continue;
        }
        if (ranPrevious && delayMs > 0) {
          await this.sleep(delayMs);
          if (gen !== this.gen) {
            stoppedBy = "stop";
            break;
          }
        }
        if (trigger !== "manual" && this.isGameplayBlocked()) {
          stoppedBy = "game running";
          break;
        }

        this.advanceBatch(source, 0);
        const checkT0 = Date.now();
        const result = await this.runCheck(source, trigger, true);
        if (gen !== this.gen) {
          stoppedBy = "stop";
          break;
        }
        this.advanceBatch(null, 1);
        if (!result) continue;
        results.push(result);
        perSourceMs.push(`${source}=${Date.now() - checkT0}ms`);
        ranPrevious = true;
        if (trigger !== "manual" && isOfflineFailure(result)) this.scheduleOfflineRetry(source, trigger, toastRetries);
      }
    } finally {
      if (gen === this.gen) {
        this.setBatch(null);
        this.armScheduler();
      }
    }

    log(
      `triggerAll(${trigger}): ${results.length} of ${sources.length} sources in ${Date.now() - batchT0}ms` +
        ` [${perSourceMs.join(", ")}]` +
        (stoppedBy ? ` stopped early: ${stoppedBy}` : ""),
    );
    return results;
  }

  private setBatch(batch: BatchProgress | null) {
    this.state.batch = batch;
    this.notify();
  }

  private advanceBatch(current: UpdateSource | null, doneDelta: number) {
    const batch = this.state.batch;
    if (!batch) return;
    this.setBatch({ ...batch, current, done: Math.min(batch.total, batch.done + doneDelta) });
  }

  private scheduleOfflineRetry(source: UpdateSource, trigger: Trigger, toast: boolean) {
    if (this.retryTimers.has(source)) return;
    const gen = this.gen;
    log(`${source}: looks offline, retrying once in ${OFFLINE_RETRY_MS / 1000}s`);
    const timer = setTimeout(async () => {
      this.retryTimers.delete(source);
      if (gen !== this.gen) return;
      if (this.isGameplayBlocked()) {
        log(`${source}: offline retry skipped, game is running`);
        return;
      }
      const result = await this.runCheck(source, trigger, false);
      if (gen !== this.gen || !result) return;
      if (toast) this.toastResults([result]);
    }, OFFLINE_RETRY_MS);
    this.retryTimers.set(source, timer);
  }

  // ── Due-time scheduler ─────────────────────────────────

  private earliestDue(): { source: UpdateSource; at: number } | null {
    let next: { source: UpdateSource; at: number } | null = null;
    for (const source of this.activeSources()) {
      const at = this.nextDueAt(source);
      if (at !== null && (!next || at < next.at)) next = { source, at };
    }
    return next;
  }

  private armScheduler(delayOverride?: number) {
    this.clearScheduler();
    if (!this.started || this.startupPending) return;

    let delay: number;
    let reason: string;
    if (delayOverride !== undefined) {
      delay = delayOverride;
      reason = "retry";
    } else {
      const next = this.earliestDue();
      if (!next) {
        debug("Scheduler: no automatic checks enabled");
        return;
      }
      delay = next.at - Date.now();
      reason = `${next.source} due ${new Date(next.at).toISOString()}`;
    }
    delay = Math.min(SCHEDULER_MAX_ARM_MS, Math.max(SCHEDULER_MIN_ARM_MS, delay));
    this.schedulerFireAt = Date.now() + delay;
    this.schedulerTimer = setTimeout(() => {
      this.schedulerTimer = null;
      void this.onSchedulerFire();
    }, delay);
    debug(`Scheduler: next run in ${Math.round(delay / 1000)}s (${reason})`);
  }

  private clearScheduler() {
    if (this.schedulerTimer) {
      clearTimeout(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  private async onSchedulerFire() {
    if (!this.started || this.startupPending) return;
    const late = Date.now() - this.schedulerFireAt;
    if (late > SCHEDULER_LATE_MS) {
      // Most likely just resumed from suspend; give the wake handler the first go.
      debug(`Scheduler: fired ${Math.round(late / 1000)}s late, deferring`);
      this.armScheduler(SCHEDULER_LATE_DEFER_MS);
      return;
    }
    if (this.state.batch || this.wakeInFlight || this.gameCloseTimer) {
      debug("Scheduler: another check is pending, retrying later");
      this.armScheduler(SCHEDULER_BUSY_RETRY_MS);
      return;
    }

    const now = Date.now();
    const due = this.activeSources().filter((src) => this.isDue(src, now));
    const idle = due.filter((src) => this.state[SOURCE_FIELDS[src].status] === "idle");
    if (idle.length === 0) {
      if (due.length > 0) this.armScheduler(SCHEDULER_BUSY_RETRY_MS);
      else this.armScheduler();
      return;
    }
    if (this.isGameplayBlocked()) {
      log(`Scheduled check of ${idle.join(", ")} postponed: game is running`);
      this.armScheduler(GAMEPLAY_RETRY_MS);
      return;
    }

    log(`Scheduled check: ${idle.join(", ")}`);
    const gen = this.gen;
    const promise = this.runBatch("auto", idle, true);
    this.batchPromise = promise;
    const results = await promise;
    if (gen === this.gen) this.toastResults(results);
  }

  // ── Generic check runner ──────────────────────────────

  private async runCheck(source: UpdateSource, trigger: Trigger, inBatch: boolean): Promise<UpdateCheckResult | null> {
    const { status, lastCheck } = SOURCE_FIELDS[source];

    if (this.state[status] !== "idle") {
      debug(`${source}: already ${this.state[status]}, skipping ${trigger} check`);
      return null;
    }

    log(`${source}: starting ${trigger} check`);
    this.state[status] = "checking";
    this.notify();

    const t0 = Date.now();
    let result: UpdateCheckResult;
    try {
      result = await this.getProvider(source)();
      log(
        `${source}: check complete in ${Date.now() - t0}ms - ${result.pendingCount} pending, ${result.forcedCount} applied, ${result.errors.length} errors`,
      );
      if (result.errors.length > 0) {
        logWarn(`${source}: errors:`, result.errors.join(" | "));
      }
    } catch (e) {
      logError(`${source} check failed after ${Date.now() - t0}ms:`, e);
      result = emptyResult(source, [errorMessage(e)]);
    }

    this.state[lastCheck] = result;
    this.state[status] = "idle";
    this.notify();
    this.saveCheckState();
    await this.saveHistory(result, trigger);
    if (!inBatch) this.armScheduler();
    return result;
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

  // ── Persistence ───────────────────────────────────────

  private seedCheckState(raw: unknown) {
    if (!raw || typeof raw !== "object") return;
    const now = Date.now();
    const restored: string[] = [];
    for (const source of ALL_SOURCES) {
      const entry = parseCheckStateEntry((raw as Record<string, unknown>)[source], now);
      if (!entry) continue;
      const key = SOURCE_FIELDS[source].lastCheck;
      const current = this.state[key];
      if (current && current.timestamp >= entry.timestamp) continue;
      this.state[key] = {
        ...emptyResult(source, entry.errors),
        timestamp: entry.timestamp,
        pendingCount: entry.pendingCount,
        forcedCount: entry.forcedCount,
      };
      restored.push(source);
    }
    if (restored.length > 0) log(`Restored last check state: ${restored.join(", ")}`);
  }

  private saveCheckState() {
    const snapshot: Record<string, CheckStateEntry> = {};
    for (const source of ALL_SOURCES) {
      const result = this.state[SOURCE_FIELDS[source].lastCheck];
      if (!result) continue;
      snapshot[source] = {
        timestamp: result.timestamp,
        pendingCount: result.pendingCount,
        forcedCount: result.forcedCount,
        errors: result.errors.slice(0, 3).map((e) => String(e).slice(0, 200)),
      };
    }
    saveCheckStateBackend(snapshot).catch((e) => debug("Failed to save check state:", errorMessage(e)));
  }

  private scheduleSettingsSave() {
    if (this.settingsSaveTimer) clearTimeout(this.settingsSaveTimer);
    this.settingsSaveTimer = setTimeout(() => {
      this.settingsSaveTimer = null;
      this.persistSettings();
    }, SETTINGS_SAVE_DEBOUNCE_MS);
  }

  private flushSettingsSave() {
    if (!this.settingsSaveTimer) return;
    clearTimeout(this.settingsSaveTimer);
    this.settingsSaveTimer = null;
    this.persistSettings();
  }

  private persistSettings() {
    saveSettings(this.state.settings).then(
      () => debug("Settings saved to backend"),
      (e) => logError("Failed to save settings:", e),
    );
  }

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
      this.notify();
      debug("History entry saved:", result.source, trigger);
    } catch (e) {
      logError(`Failed to save ${result.source} history:`, e);
    }
  }

  // ── Utilities ─────────────────────────────────────────

  // Resolved early by stop() so no async flow is left hanging on a cleared timer.
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const sleeper = {
        timer: setTimeout(() => {
          this.sleepers.delete(sleeper);
          resolve();
        }, ms),
        resolve,
      };
      this.sleepers.add(sleeper);
    });
  }

  private notify() {
    this.state = { ...this.state };
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
