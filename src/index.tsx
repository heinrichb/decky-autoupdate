import { definePlugin, toaster } from "@decky/api";
import { ButtonItem, DropdownItem, PanelSection, PanelSectionRow, SliderField, ToggleField } from "@decky/ui";
import { useState, useEffect, useCallback } from "react";
import { MdUpdate } from "react-icons/md";
import { service, ServiceState } from "./autoUpdateService";
import { getInstalledPlugins, InstalledPlugin } from "./deckyApi";
import type { NotificationLevel } from "./types";
import {
  formatBytes,
  statusColor,
  steamStatusLabel,
  flatpakStatusLabel,
  deckyStatusLabel,
  deckyLoaderStatusLabel,
  steamosStatusLabel,
  formatUpdateSummary,
  combinedToastBody,
  shouldToastResult,
  triggerLabel,
  sourceLabel,
  logError,
} from "./helpers";

function useServiceState(): ServiceState {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const unsub = service.subscribe(() => forceUpdate((n) => n + 1));
    return unsub;
  }, []);

  return service.getState();
}

const NOTIFICATION_OPTIONS = [
  { data: "off" as NotificationLevel, label: "Off" },
  { data: "updates-only" as NotificationLevel, label: "Updates only" },
  { data: "all" as NotificationLevel, label: "All checks" },
];

function AutoUpdatePanel() {
  const state = useServiceState();
  const { settings } = state;

  const update = useCallback(async (partial: Partial<typeof settings>) => {
    await service.updateSettings(partial);
  }, []);

  const [expanded, setExpanded] = useState(false);
  const [showSteamUpdates, setShowSteamUpdates] = useState(false);
  const [showFlatpakUpdates, setShowFlatpakUpdates] = useState(false);
  const [showDeckyUpdates, setShowDeckyUpdates] = useState(false);
  const [showBlacklist, setShowBlacklist] = useState(false);
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPlugin[]>([]);

  if (!state.settingsLoaded) {
    return (
      <PanelSection title="AutoUpdate">
        <PanelSectionRow>
          <span>Loading...</span>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  const steamBusy = state.steamStatus !== "idle";
  const flatpakBusy = state.flatpakStatus !== "idle";
  const deckyBusy = state.deckyStatus !== "idle";
  const deckyLoaderBusy = state.deckyLoaderStatus !== "idle";
  const steamosBusy = state.steamosStatus !== "idle";
  const anyChecking = steamBusy || flatpakBusy || deckyBusy || deckyLoaderBusy || steamosBusy;

  const enabledSourceCount = [
    settings.steamEnabled,
    settings.flatpakEnabled && state.flatpakAvailable,
    settings.deckyPluginUpdatesEnabled && state.deckyAvailable,
    settings.deckyLoaderUpdateEnabled && state.deckyAvailable,
    settings.steamosUpdateEnabled && state.steamosAvailable,
  ].filter(Boolean).length;

  return (
    <>
      {/* ── Check All ──────────────────────────── */}
      {enabledSourceCount >= 2 && (
        <PanelSection>
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              disabled={anyChecking}
              onClick={async () => {
                const results = await service.triggerAll("manual");
                if (settings.notificationLevel !== "off") {
                  const body = combinedToastBody(results, settings.notificationLevel);
                  if (body) {
                    toaster.toast({ title: "AutoUpdate", body });
                  }
                }
              }}
            >
              {anyChecking ? "Checking..." : "Check All"}
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>
      )}

      {/* ── Steam Status ───────────────────────── */}
      {settings.steamEnabled && (
        <PanelSection title="Steam Updates">
          <PanelSectionRow>
            <div style={{ fontSize: "0.85em", opacity: 0.8 }}>
              {!state.steamReady && <div style={{ color: "#fca311", marginBottom: 4 }}>SteamClient not available</div>}
              <div>
                Last check:{" "}
                {state.steamLastCheck ? new Date(state.steamLastCheck.timestamp).toLocaleTimeString() : "Never"}
              </div>
              {state.steamLastCheck && (
                <div style={{ color: statusColor(state.steamLastCheck) }}>
                  {state.steamLastCheck.pendingCount === 0
                    ? "All games up to date"
                    : `${state.steamLastCheck.pendingCount} pending, ${state.steamLastCheck.forcedCount} forced`}
                </div>
              )}
              {state.steamLastCheck?.errors.length ? (
                <div style={{ color: "#e63946", marginTop: 2 }}>{state.steamLastCheck.errors[0]}</div>
              ) : null}
            </div>
          </PanelSectionRow>

          {state.steamLastCheck && state.steamLastCheck.updates.length > 0 && (
            <PanelSectionRow>
              <ButtonItem layout="below" onClick={() => setShowSteamUpdates(!showSteamUpdates)}>
                {showSteamUpdates ? "Hide details" : `Show ${state.steamLastCheck.updates.length} updates`}
              </ButtonItem>
            </PanelSectionRow>
          )}

          {showSteamUpdates && state.steamLastCheck && state.steamLastCheck.updates.length > 0 && (
            <PanelSectionRow>
              <div style={{ fontSize: "0.8em", opacity: 0.7, maxHeight: 200, overflowY: "auto" }}>
                {state.steamLastCheck.updates.map((u) => (
                  <div key={u.appId} style={{ marginBottom: 4 }}>
                    <div>{u.name}</div>
                    <div style={{ opacity: 0.6 }}>
                      {u.state} {"\u2014"} {formatBytes(u.bytesToDownload)}
                    </div>
                  </div>
                ))}
              </div>
            </PanelSectionRow>
          )}

          <PanelSectionRow>
            <ButtonItem
              layout="below"
              disabled={steamBusy}
              onClick={async () => {
                const result = await service.triggerCheck("steam", "manual");
                if (shouldToastResult(settings.notificationLevel, result)) {
                  toaster.toast({
                    title: `${sourceLabel("steam")} Updates`,
                    body: formatUpdateSummary(result),
                  });
                }
              }}
            >
              {steamStatusLabel(state.steamStatus)}
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>
      )}

      {/* ── Flatpak Status ─────────────────────── */}
      {state.flatpakAvailable && settings.flatpakEnabled && (
        <PanelSection title="Flatpak Updates">
          <PanelSectionRow>
            <div style={{ fontSize: "0.85em", opacity: 0.8 }}>
              <div>
                Last check:{" "}
                {state.flatpakLastCheck ? new Date(state.flatpakLastCheck.timestamp).toLocaleTimeString() : "Never"}
              </div>
              {state.flatpakLastCheck && (
                <div style={{ color: statusColor(state.flatpakLastCheck) }}>
                  {state.flatpakLastCheck.errors.length > 0
                    ? "Check failed"
                    : state.flatpakLastCheck.pendingCount === 0
                      ? "All apps up to date"
                      : `${state.flatpakLastCheck.pendingCount} available, ${state.flatpakLastCheck.forcedCount} applied`}
                </div>
              )}
              {state.flatpakLastCheck?.errors.length ? (
                <div style={{ color: "#e63946", marginTop: 2 }}>{state.flatpakLastCheck.errors[0]}</div>
              ) : null}
            </div>
          </PanelSectionRow>

          {state.flatpakLastCheck && state.flatpakLastCheck.flatpakUpdates.length > 0 && (
            <PanelSectionRow>
              <ButtonItem layout="below" onClick={() => setShowFlatpakUpdates(!showFlatpakUpdates)}>
                {showFlatpakUpdates ? "Hide details" : `Show ${state.flatpakLastCheck.flatpakUpdates.length} updates`}
              </ButtonItem>
            </PanelSectionRow>
          )}

          {showFlatpakUpdates && state.flatpakLastCheck && state.flatpakLastCheck.flatpakUpdates.length > 0 && (
            <PanelSectionRow>
              <div style={{ fontSize: "0.8em", opacity: 0.7, maxHeight: 200, overflowY: "auto" }}>
                {state.flatpakLastCheck.flatpakUpdates.map((u) => (
                  <div key={u.id} style={{ marginBottom: 4 }}>
                    <div>{u.name}</div>
                    <div style={{ opacity: 0.6 }}>{u.downloadSize}</div>
                  </div>
                ))}
              </div>
            </PanelSectionRow>
          )}

          <PanelSectionRow>
            <ButtonItem
              layout="below"
              disabled={flatpakBusy}
              onClick={async () => {
                const result = await service.triggerCheck("flatpak", "manual");
                if (shouldToastResult(settings.notificationLevel, result)) {
                  toaster.toast({
                    title: `${sourceLabel("flatpak")} Updates`,
                    body: formatUpdateSummary(result),
                  });
                }
              }}
            >
              {flatpakStatusLabel(state.flatpakStatus)}
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>
      )}

      {/* ── Decky Plugin Status ────────────────── */}
      {state.deckyAvailable && settings.deckyPluginUpdatesEnabled && (
        <PanelSection title="Decky Plugins">
          <PanelSectionRow>
            <div style={{ fontSize: "0.85em", opacity: 0.8 }}>
              <div>
                Last check:{" "}
                {state.deckyLastCheck ? new Date(state.deckyLastCheck.timestamp).toLocaleTimeString() : "Never"}
              </div>
              {state.deckyLastCheck && (
                <div style={{ color: statusColor(state.deckyLastCheck) }}>
                  {state.deckyLastCheck.pendingCount === 0
                    ? "All plugins up to date"
                    : `${state.deckyLastCheck.forcedCount} of ${state.deckyLastCheck.pendingCount} updated`}
                </div>
              )}
              {state.deckyLastCheck?.errors.length ? (
                <div style={{ color: "#e63946", marginTop: 2 }}>{state.deckyLastCheck.errors[0]}</div>
              ) : null}
            </div>
          </PanelSectionRow>

          {state.deckyLastCheck && state.deckyLastCheck.deckyPluginUpdates.length > 0 && (
            <PanelSectionRow>
              <ButtonItem layout="below" onClick={() => setShowDeckyUpdates(!showDeckyUpdates)}>
                {showDeckyUpdates ? "Hide details" : `Show ${state.deckyLastCheck.deckyPluginUpdates.length} updates`}
              </ButtonItem>
            </PanelSectionRow>
          )}

          {showDeckyUpdates && state.deckyLastCheck && state.deckyLastCheck.deckyPluginUpdates.length > 0 && (
            <PanelSectionRow>
              <div style={{ fontSize: "0.8em", opacity: 0.7, maxHeight: 200, overflowY: "auto" }}>
                {state.deckyLastCheck.deckyPluginUpdates.map((u) => (
                  <div key={u.name} style={{ marginBottom: 4 }}>
                    <div>{u.name}</div>
                    <div style={{ opacity: 0.6 }}>
                      {u.currentVersion} {"\u2192"} {u.newVersion}
                    </div>
                  </div>
                ))}
              </div>
            </PanelSectionRow>
          )}

          <PanelSectionRow>
            <ButtonItem
              layout="below"
              disabled={deckyBusy}
              onClick={async () => {
                const result = await service.triggerCheck("decky", "manual");
                if (shouldToastResult(settings.notificationLevel, result)) {
                  toaster.toast({
                    title: `${sourceLabel("decky")} Updates`,
                    body: formatUpdateSummary(result),
                  });
                }
              }}
            >
              {deckyStatusLabel(state.deckyStatus)}
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>
      )}

      {/* ── Decky Loader Status ──────────────── */}
      {state.deckyAvailable && settings.deckyLoaderUpdateEnabled && (
        <PanelSection title="Decky Loader">
          <PanelSectionRow>
            <div style={{ fontSize: "0.85em", opacity: 0.8 }}>
              <div>
                Last check:{" "}
                {state.deckyLoaderLastCheck
                  ? new Date(state.deckyLoaderLastCheck.timestamp).toLocaleTimeString()
                  : "Never"}
              </div>
              {state.deckyLoaderLastCheck && (
                <div style={{ color: statusColor(state.deckyLoaderLastCheck) }}>
                  {state.deckyLoaderLastCheck.forcedCount > 0
                    ? "Decky Loader updated"
                    : state.deckyLoaderLastCheck.pendingCount === 0
                      ? "Up to date"
                      : "Update available"}
                </div>
              )}
              {state.deckyLoaderLastCheck?.errors.length ? (
                <div style={{ color: "#e63946", marginTop: 2 }}>{state.deckyLoaderLastCheck.errors[0]}</div>
              ) : null}
            </div>
          </PanelSectionRow>

          <PanelSectionRow>
            <ButtonItem
              layout="below"
              disabled={deckyLoaderBusy}
              onClick={async () => {
                const result = await service.triggerCheck("decky-loader", "manual");
                if (shouldToastResult(settings.notificationLevel, result)) {
                  toaster.toast({
                    title: `${sourceLabel("decky-loader")} Update`,
                    body: formatUpdateSummary(result),
                  });
                }
              }}
            >
              {deckyLoaderStatusLabel(state.deckyLoaderStatus)}
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>
      )}

      {/* ── SteamOS Status ────────────────────── */}
      {state.steamosAvailable && settings.steamosUpdateEnabled && (
        <PanelSection title="SteamOS Updates">
          <PanelSectionRow>
            <div style={{ fontSize: "0.85em", opacity: 0.8 }}>
              <div>
                Last check:{" "}
                {state.steamosLastCheck ? new Date(state.steamosLastCheck.timestamp).toLocaleTimeString() : "Never"}
              </div>
              {state.steamosLastCheck && (
                <div style={{ color: statusColor(state.steamosLastCheck) }}>
                  {state.steamosLastCheck.errors.length > 0
                    ? "Check failed"
                    : state.steamosLastCheck.forcedCount > 0
                      ? "Update staged \u2014 reboot when ready"
                      : state.steamosLastCheck.pendingCount === 0
                        ? "Up to date"
                        : "Update available"}
                </div>
              )}
              {state.steamosLastCheck?.errors.length ? (
                <div style={{ color: "#e63946", marginTop: 2 }}>{state.steamosLastCheck.errors[0]}</div>
              ) : null}
            </div>
          </PanelSectionRow>

          <PanelSectionRow>
            <ButtonItem
              layout="below"
              disabled={steamosBusy}
              onClick={async () => {
                const result = await service.triggerCheck("steamos", "manual");
                if (shouldToastResult(settings.notificationLevel, result)) {
                  toaster.toast({
                    title: `${sourceLabel("steamos")} Update`,
                    body: formatUpdateSummary(result),
                  });
                }
              }}
            >
              {steamosStatusLabel(state.steamosStatus)}
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>
      )}

      {/* ── Update Sources ─────────────────────── */}
      <PanelSection title="Update Sources">
        <PanelSectionRow>
          <ToggleField
            label="Steam updates"
            description="Periodically force-start pending game updates"
            checked={settings.steamEnabled}
            onChange={(val) => update({ steamEnabled: val })}
          />
        </PanelSectionRow>

        {settings.steamEnabled && (
          <PanelSectionRow>
            <SliderField
              label="Steam interval (minutes)"
              value={settings.steamCheckIntervalMinutes}
              min={5}
              max={120}
              step={5}
              showValue
              onChange={(val) => update({ steamCheckIntervalMinutes: val })}
            />
          </PanelSectionRow>
        )}

        {state.flatpakAvailable && (
          <>
            <PanelSectionRow>
              <ToggleField
                label="Flatpak updates"
                description="Periodically check and apply Flatpak updates"
                checked={settings.flatpakEnabled}
                onChange={(val) => update({ flatpakEnabled: val })}
              />
            </PanelSectionRow>

            {settings.flatpakEnabled && (
              <>
                <PanelSectionRow>
                  <SliderField
                    label="Flatpak interval (hours)"
                    value={settings.flatpakCheckIntervalMinutes / 60}
                    min={1}
                    max={24}
                    step={1}
                    showValue
                    onChange={(val) => update({ flatpakCheckIntervalMinutes: val * 60 })}
                  />
                </PanelSectionRow>

                <PanelSectionRow>
                  <ToggleField
                    label="Auto-apply Flatpak updates"
                    description="Automatically install updates when found"
                    checked={settings.flatpakAutoApply}
                    onChange={(val) => update({ flatpakAutoApply: val })}
                  />
                </PanelSectionRow>
              </>
            )}
          </>
        )}

        {state.deckyAvailable && (
          <>
            <PanelSectionRow>
              <ToggleField
                label="Decky plugin updates"
                description="Auto-update third-party Decky plugins"
                checked={settings.deckyPluginUpdatesEnabled}
                onChange={(val) => update({ deckyPluginUpdatesEnabled: val })}
              />
            </PanelSectionRow>

            {settings.deckyPluginUpdatesEnabled && (
              <>
                <PanelSectionRow>
                  <SliderField
                    label="Decky interval (hours)"
                    value={settings.deckyCheckIntervalMinutes / 60}
                    min={1}
                    max={48}
                    step={1}
                    showValue
                    onChange={(val) => update({ deckyCheckIntervalMinutes: val * 60 })}
                  />
                </PanelSectionRow>

                <PanelSectionRow>
                  <ButtonItem
                    layout="below"
                    onClick={async () => {
                      if (showBlacklist) {
                        setShowBlacklist(false);
                      } else {
                        const plugins = await getInstalledPlugins();
                        setInstalledPlugins(plugins.filter((p) => p.name !== "AutoUpdate"));
                        setShowBlacklist(true);
                      }
                    }}
                  >
                    {showBlacklist ? "Hide excluded plugins" : "Excluded plugins"}
                  </ButtonItem>
                </PanelSectionRow>

                {showBlacklist && (
                  <div style={{ maxHeight: 250, overflowY: "auto" }}>
                    {installedPlugins.length === 0 && (
                      <PanelSectionRow>
                        <div style={{ fontSize: "0.85em", opacity: 0.6 }}>No other plugins installed</div>
                      </PanelSectionRow>
                    )}
                    {installedPlugins.map((plugin) => {
                      const isBlacklisted = settings.deckyPluginBlacklist.some(
                        (b) => b.toLowerCase() === plugin.name.toLowerCase(),
                      );
                      return (
                        <PanelSectionRow key={plugin.name}>
                          <ToggleField
                            label={plugin.name}
                            description={isBlacklisted ? "Excluded from auto-updates" : `v${plugin.version}`}
                            checked={isBlacklisted}
                            onChange={(val) => {
                              const current = settings.deckyPluginBlacklist;
                              if (val) {
                                update({ deckyPluginBlacklist: [...current, plugin.name] });
                              } else {
                                update({
                                  deckyPluginBlacklist: current.filter(
                                    (b) => b.toLowerCase() !== plugin.name.toLowerCase(),
                                  ),
                                });
                              }
                            }}
                          />
                        </PanelSectionRow>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            <PanelSectionRow>
              <ToggleField
                label="Decky Loader updates"
                description="Auto-update Decky Loader itself"
                checked={settings.deckyLoaderUpdateEnabled}
                onChange={(val) => update({ deckyLoaderUpdateEnabled: val })}
              />
            </PanelSectionRow>
          </>
        )}

        {state.steamosAvailable && (
          <>
            <PanelSectionRow>
              <ToggleField
                label="SteamOS updates"
                description="Auto-download and stage SteamOS updates"
                checked={settings.steamosUpdateEnabled}
                onChange={(val) => update({ steamosUpdateEnabled: val })}
              />
            </PanelSectionRow>

            {settings.steamosUpdateEnabled && (
              <PanelSectionRow>
                <SliderField
                  label="SteamOS interval (hours)"
                  value={settings.steamosCheckIntervalMinutes / 60}
                  min={1}
                  max={48}
                  step={1}
                  showValue
                  onChange={(val) => update({ steamosCheckIntervalMinutes: val * 60 })}
                />
              </PanelSectionRow>
            )}
          </>
        )}
      </PanelSection>

      {/* ── Check Schedule ─────────────────────── */}
      <PanelSection title="Check Schedule">
        <PanelSectionRow>
          <ToggleField
            label="Check on wake"
            description="Check for updates when the device wakes from sleep"
            checked={settings.checkOnWake}
            onChange={(val) => update({ checkOnWake: val })}
          />
        </PanelSectionRow>

        <PanelSectionRow>
          <ToggleField
            label="Check after game closes"
            description="Check for updates when all games have exited"
            checked={settings.checkOnGameClose}
            onChange={(val) => update({ checkOnGameClose: val })}
          />
        </PanelSectionRow>

        <PanelSectionRow>
          <ToggleField
            label="Check during gameplay"
            description="Allow scheduled checks while a game is running"
            checked={settings.checkDuringGameplay}
            onChange={(val) => update({ checkDuringGameplay: val })}
          />
        </PanelSectionRow>
      </PanelSection>

      {/* ── Notifications ──────────────────────── */}
      <PanelSection title="Notifications">
        <PanelSectionRow>
          <DropdownItem
            label="Toast notifications"
            description={
              settings.notificationLevel === "off"
                ? "No toast notifications"
                : settings.notificationLevel === "updates-only"
                  ? "Toast when updates are found or applied"
                  : "Toast after every check"
            }
            rgOptions={NOTIFICATION_OPTIONS}
            selectedOption={settings.notificationLevel}
            onChange={(opt) => update({ notificationLevel: opt.data })}
          />
        </PanelSectionRow>
      </PanelSection>

      {/* ── Advanced ───────────────────────────── */}
      <PanelSection title="Advanced">
        <PanelSectionRow>
          <ToggleField
            label="Log history"
            description="Keep a record of past update checks"
            checked={settings.logHistory}
            onChange={(val) => update({ logHistory: val })}
          />
        </PanelSectionRow>

        <PanelSectionRow>
          <ToggleField
            label="Debug logging"
            description="Write detailed diagnostic info to the browser console and plugin log"
            checked={settings.debugLogging}
            onChange={(val) => update({ debugLogging: val })}
          />
        </PanelSectionRow>
      </PanelSection>

      {/* ── History ────────────────────────────── */}
      {settings.logHistory && (
        <PanelSection title="History">
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              onClick={() => {
                const next = !expanded;
                setExpanded(next);
                if (next) service.refreshHistory();
              }}
            >
              {expanded ? "Hide history" : `Show history (${state.historyEntries.length})`}
            </ButtonItem>
          </PanelSectionRow>

          {expanded && (
            <>
              <div style={{ maxHeight: 300, overflowY: "auto" }}>
                {state.historyEntries.map((entry, i) => (
                  <PanelSectionRow key={i}>
                    <div style={{ fontSize: "0.8em", padding: "4px 0" }}>
                      <div
                        style={{
                          color: entry.forcedCount > 0 ? "#2a9d8f" : "#fca311",
                          fontWeight: 500,
                        }}
                      >
                        {formatUpdateSummary(entry)}
                      </div>
                      <div style={{ opacity: 0.5, fontSize: "0.9em", marginTop: 2 }}>
                        {triggerLabel(entry.trigger)} {"\u00b7"} {new Date(entry.timestamp).toLocaleString()}
                      </div>
                    </div>
                  </PanelSectionRow>
                ))}
              </div>
              {state.historyEntries.length > 0 && (
                <PanelSectionRow>
                  <ButtonItem layout="below" onClick={() => service.clearHistory()}>
                    Clear history
                  </ButtonItem>
                </PanelSectionRow>
              )}
            </>
          )}
        </PanelSection>
      )}
    </>
  );
}

export default definePlugin(() => {
  service.start().catch((e) => {
    logError("Service failed to start:", e);
  });

  return {
    name: "AutoUpdate",
    title: "AutoUpdate",
    content: <AutoUpdatePanel />,
    icon: <MdUpdate />,
    alwaysRender: true,
    onDismount() {
      service.stop();
    },
  };
});
