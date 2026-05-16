import { definePlugin, toaster } from "@decky/api";
import { ButtonItem, DropdownItem, PanelSection, PanelSectionRow, SliderField, ToggleField } from "@decky/ui";
import { useState, useEffect, useCallback, useRef, ReactNode } from "react";
import { MdUpdate } from "react-icons/md";
import { SourceStatus } from "./types";
import { service, ServiceState } from "./autoUpdateService";
import { PLUGIN_VERSION } from "./version";
import { getInstalledPlugins, InstalledPlugin } from "./deckyApi";
import type { NotificationLevel, UpdateSource, UpdateCheckResult } from "./types";
import {
  statusColor,
  compactStatusText,
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
  COLOR_WARNING,
  COLOR_SUCCESS,
} from "./helpers";

function useServiceState(): ServiceState {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const unsub = service.subscribe(() => forceUpdate((n) => n + 1));
    return unsub;
  }, []);

  return service.getState();
}

const SPINNER_STYLE: React.CSSProperties = {
  display: "inline-block",
  width: 14,
  height: 14,
  border: "2px solid currentColor",
  borderTopColor: "transparent",
  borderRadius: "50%",
  marginRight: 6,
  verticalAlign: "middle",
};

function Spinner() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    ref.current?.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], {
      duration: 800,
      iterations: Infinity,
    });
  }, []);
  return <span ref={ref} style={SPINNER_STYLE} />;
}

function StatusButton({ status, label }: { status: SourceStatus; label: (s: SourceStatus) => string }) {
  const busy = status !== "idle";
  return (
    <span>
      {busy && <Spinner />}
      {label(status)}
    </span>
  );
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

  const statusDesc = (source: UpdateSource, lastCheck: UpdateCheckResult | null, warning?: string): ReactNode => {
    const text = warning || compactStatusText(source, lastCheck);
    const color = warning ? COLOR_WARNING : statusColor(lastCheck);
    const time = lastCheck ? new Date(lastCheck.timestamp).toLocaleTimeString() : "";
    return (
      <span style={{ color }}>
        {text}
        {time ? (
          <span style={{ opacity: 0.5 }}>
            {" "}
            {"\u00b7"} {time}
          </span>
        ) : null}
      </span>
    );
  };

  const handleCheck = async (source: UpdateSource) => {
    const result = await service.triggerCheck(source, "manual");
    if (shouldToastResult(settings.notificationLevel, result)) {
      toaster.toast({ title: `${sourceLabel(source)} Updates`, body: formatUpdateSummary(result) });
    }
  };

  return (
    <>
      {/* ── Status ─────────────────────────────── */}
      <PanelSection title="Status">
        {enabledSourceCount >= 2 && (
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              disabled={anyChecking}
              onClick={async () => {
                const results = await service.triggerAll("manual");
                if (settings.notificationLevel !== "off") {
                  const body = combinedToastBody(results, settings.notificationLevel);
                  if (body) toaster.toast({ title: "AutoUpdate", body });
                }
              }}
            >
              {anyChecking ? (
                <span>
                  <Spinner />
                  Checking...
                </span>
              ) : (
                "Check All"
              )}
            </ButtonItem>
          </PanelSectionRow>
        )}

        {settings.steamEnabled && (
          <>
            <PanelSectionRow>
              <ButtonItem
                label="Steam Apps"
                description={statusDesc(
                  "steam",
                  state.steamLastCheck,
                  !state.steamReady ? "SteamClient unavailable" : undefined,
                )}
                layout="inline"
                disabled={steamBusy}
                onClick={() => handleCheck("steam")}
              >
                <StatusButton status={state.steamStatus} label={steamStatusLabel} />
              </ButtonItem>
            </PanelSectionRow>
          </>
        )}

        {state.flatpakAvailable && settings.flatpakEnabled && (
          <>
            <PanelSectionRow>
              <ButtonItem
                label="Flatpak"
                description={statusDesc("flatpak", state.flatpakLastCheck)}
                layout="inline"
                disabled={flatpakBusy}
                onClick={() => handleCheck("flatpak")}
              >
                <StatusButton status={state.flatpakStatus} label={flatpakStatusLabel} />
              </ButtonItem>
            </PanelSectionRow>
          </>
        )}

        {state.deckyAvailable && settings.deckyPluginUpdatesEnabled && (
          <>
            <PanelSectionRow>
              <ButtonItem
                label="Decky Plugins"
                description={statusDesc("decky", state.deckyLastCheck)}
                layout="inline"
                disabled={deckyBusy}
                onClick={() => handleCheck("decky")}
              >
                <StatusButton status={state.deckyStatus} label={deckyStatusLabel} />
              </ButtonItem>
            </PanelSectionRow>
          </>
        )}

        {state.deckyAvailable && settings.deckyLoaderUpdateEnabled && (
          <PanelSectionRow>
            <ButtonItem
              label="Decky Loader"
              description={statusDesc("decky-loader", state.deckyLoaderLastCheck)}
              layout="inline"
              disabled={deckyLoaderBusy}
              onClick={() => handleCheck("decky-loader")}
            >
              <StatusButton status={state.deckyLoaderStatus} label={deckyLoaderStatusLabel} />
            </ButtonItem>
          </PanelSectionRow>
        )}

        {state.steamosAvailable && settings.steamosUpdateEnabled && (
          <PanelSectionRow>
            <ButtonItem
              label="SteamOS"
              description={statusDesc("steamos", state.steamosLastCheck)}
              layout="inline"
              disabled={steamosBusy}
              onClick={() => handleCheck("steamos")}
            >
              <StatusButton status={state.steamosStatus} label={steamosStatusLabel} />
            </ButtonItem>
          </PanelSectionRow>
        )}
      </PanelSection>

      {/* ── Update Sources ─────────────────────── */}
      <PanelSection title="Update Sources">
        <PanelSectionRow>
          <ToggleField
            label="Steam game updates"
            description="Unpauses and force-starts scheduled game downloads"
            checked={settings.steamEnabled}
            onChange={(val) => update({ steamEnabled: val })}
          />
        </PanelSectionRow>

        {settings.steamEnabled && (
          <PanelSectionRow>
            <SliderField
              label="Check every (minutes)"
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
                label="Flatpak app updates"
                description="Check for updates to Flatpak apps (e.g. Firefox, Discord)"
                checked={settings.flatpakEnabled}
                onChange={(val) => update({ flatpakEnabled: val })}
              />
            </PanelSectionRow>

            {settings.flatpakEnabled && (
              <>
                <PanelSectionRow>
                  <SliderField
                    label="Check every (hours)"
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
                    label="Auto-install Flatpak updates"
                    description="Install immediately when found. When off, only checks and reports."
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
                description="Auto-update installed Decky plugins from the store"
                checked={settings.deckyPluginUpdatesEnabled}
                onChange={(val) => update({ deckyPluginUpdatesEnabled: val })}
              />
            </PanelSectionRow>

            {settings.deckyPluginUpdatesEnabled && (
              <>
                <PanelSectionRow>
                  <SliderField
                    label="Check every (hours)"
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
                    {showBlacklist ? "Hide skip list" : "Skip list"}
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
                      const isSkipped = settings.deckyPluginBlacklist.some(
                        (b) => b.toLowerCase() === plugin.name.toLowerCase(),
                      );
                      return (
                        <PanelSectionRow key={plugin.name}>
                          <ToggleField
                            label={plugin.name}
                            description={isSkipped ? "Skipped" : `v${plugin.version}`}
                            checked={isSkipped}
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
                description="Keep Decky Loader itself up to date"
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
                description="Download and stage system updates (won't reboot automatically)"
                checked={settings.steamosUpdateEnabled}
                onChange={(val) => update({ steamosUpdateEnabled: val })}
              />
            </PanelSectionRow>

            {settings.steamosUpdateEnabled && (
              <PanelSectionRow>
                <SliderField
                  label="Check every (hours)"
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

      {/* ── Automatic Checks ───────────────────── */}
      <PanelSection title="Automatic Checks">
        <PanelSectionRow>
          <ToggleField
            label="After waking from sleep"
            checked={settings.checkOnWake}
            onChange={(val) => update({ checkOnWake: val })}
          />
        </PanelSectionRow>

        <PanelSectionRow>
          <ToggleField
            label="After closing a game"
            checked={settings.checkOnGameClose}
            onChange={(val) => update({ checkOnGameClose: val })}
          />
        </PanelSectionRow>

        <PanelSectionRow>
          <ToggleField
            label="During gameplay"
            description="Run scheduled checks even while a game is running"
            checked={settings.checkDuringGameplay}
            onChange={(val) => update({ checkDuringGameplay: val })}
          />
        </PanelSectionRow>
      </PanelSection>

      {/* ── Advanced ───────────────────────────── */}
      <PanelSection title="Advanced">
        <PanelSectionRow>
          <DropdownItem
            label="Notifications"
            description={
              settings.notificationLevel === "off"
                ? "No toast notifications"
                : settings.notificationLevel === "updates-only"
                  ? "Toast when updates are found or applied"
                  : "Toast after every check, even if nothing found"
            }
            rgOptions={NOTIFICATION_OPTIONS}
            selectedOption={settings.notificationLevel}
            onChange={(opt) => update({ notificationLevel: opt.data })}
          />
        </PanelSectionRow>

        <PanelSectionRow>
          <ToggleField
            label="Update history"
            description="Keep a log of past update activity"
            checked={settings.logHistory}
            onChange={(val) => update({ logHistory: val })}
          />
        </PanelSectionRow>

        <PanelSectionRow>
          <ToggleField
            label="Debug logging"
            description="Verbose diagnostics in browser console and plugin log"
            checked={settings.debugLogging}
            onChange={(val) => update({ debugLogging: val })}
          />
        </PanelSectionRow>

        <PanelSectionRow>
          <ButtonItem
            layout="below"
            onClick={async () => {
              const dump = await service.dumpDiagnostics();
              try {
                await navigator.clipboard.writeText(dump);
                toaster.toast({ title: "AutoUpdate", body: "Diagnostics copied to clipboard" });
              } catch {
                toaster.toast({ title: "AutoUpdate", body: "Diagnostics written to log" });
              }
            }}
          >
            Dump diagnostics
          </ButtonItem>
        </PanelSectionRow>

        <PanelSectionRow>
          <div style={{ fontSize: "0.75em", opacity: 0.4, textAlign: "center", padding: "4px 0" }}>
            AutoUpdate v{PLUGIN_VERSION}
          </div>
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
                {state.historyEntries.map((entry) => (
                  <PanelSectionRow key={`${entry.source}-${entry.timestamp}`}>
                    <div style={{ fontSize: "0.8em", padding: "4px 0" }}>
                      <div
                        style={{
                          color: entry.forcedCount > 0 ? COLOR_SUCCESS : COLOR_WARNING,
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
