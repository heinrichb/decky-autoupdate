/**
 * "off"          - no toasts at all
 * "updates-only" - toast only when updates are found or applied
 * "all"          - toast after every check, even when nothing is found
 */
export type NotificationLevel = "off" | "updates-only" | "all";

export interface Settings {
  notificationLevel: NotificationLevel;
  debugLogging: boolean;
  logHistory: boolean;
  maxHistoryEntries: number;
  steamEnabled: boolean;
  steamCheckIntervalMinutes: number;
  flatpakEnabled: boolean;
  flatpakCheckIntervalMinutes: number;
  flatpakAutoApply: boolean;
  checkOnWake: boolean;
  checkOnGameClose: boolean;
  checkDuringGameplay: boolean;
  deckyPluginUpdatesEnabled: boolean;
  deckyCheckIntervalMinutes: number;
  deckyPluginBlacklist: string[];
  deckyLoaderUpdateEnabled: boolean;
  steamosUpdateEnabled: boolean;
  steamosCheckIntervalMinutes: number;
}

export type UpdateSource = "steam" | "flatpak" | "decky" | "decky-loader" | "steamos";
export type Trigger = "auto" | "manual" | "wake" | "game-close";
export type SourceStatus = "idle" | "checking" | "applying";

export interface PendingUpdate {
  appId: number;
  name: string;
  bytesToDownload: number;
  bytesDownloaded: number;
  state: "queued" | "scheduled" | "downloading" | "paused" | "unknown";
}

export interface FlatpakUpdate {
  id: string;
  name: string;
  downloadSize: string;
  scope?: "user" | "system";
}

export interface DeckyPluginUpdate {
  name: string;
  currentVersion: string;
  newVersion: string;
}

export interface UpdateCheckResult {
  source: UpdateSource;
  timestamp: number;
  pendingCount: number;
  forcedCount: number;
  errors: string[];
  updates: PendingUpdate[];
  flatpakUpdates: FlatpakUpdate[];
  deckyPluginUpdates: DeckyPluginUpdate[];
}

export interface HistoryEntry {
  source: UpdateSource;
  timestamp: number;
  pendingCount: number;
  forcedCount: number;
  trigger: Trigger;
}

export function emptyResult(source: UpdateSource, errors: string[] = []): UpdateCheckResult {
  return {
    source,
    timestamp: Date.now(),
    pendingCount: 0,
    forcedCount: 0,
    errors,
    updates: [],
    flatpakUpdates: [],
    deckyPluginUpdates: [],
  };
}

export const DEFAULT_SETTINGS: Settings = {
  notificationLevel: "updates-only",
  debugLogging: false,
  logHistory: true,
  maxHistoryEntries: 100,
  steamEnabled: true,
  steamCheckIntervalMinutes: 30,
  flatpakEnabled: true,
  flatpakCheckIntervalMinutes: 360,
  flatpakAutoApply: true,
  checkOnWake: true,
  checkOnGameClose: true,
  checkDuringGameplay: false,
  deckyPluginUpdatesEnabled: false,
  deckyCheckIntervalMinutes: 1440,
  deckyPluginBlacklist: [],
  deckyLoaderUpdateEnabled: false,
  steamosUpdateEnabled: false,
  steamosCheckIntervalMinutes: 1440,
};

// ── SteamClient download item shape (from CEF discovery) ──

export interface DownloadItemProgress {
  bytes_in_progress: number;
  bytes_total: number;
  estimated_time_remaining_sec: number;
}

export interface DownloadItemUpdateTypeInfo {
  has_update: boolean;
  completed_update: boolean;
  estimated_time_remaining_sec: number;
  progress: DownloadItemProgress[];
  overall_percent_complete: number;
  overall_estimated_time_remaining_sec: number;
}

export interface DownloadItem {
  appid: number;
  active: boolean;
  paused: boolean;
  completed: boolean;
  deferred_time: number;
  queue_index: number;
  update_result: number;
  update_error: string;
  completed_time: number;
  buildid: number;
  target_buildid: number;
  launch_on_completion: boolean;
  update_type_info: DownloadItemUpdateTypeInfo[];
}
