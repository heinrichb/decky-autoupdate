import { definePlugin, toaster } from "@decky/api";
import {
  ButtonItem,
  ConfirmModal,
  Dropdown,
  DropdownItem,
  Field,
  PanelSection,
  PanelSectionRow,
  SliderField,
  ToggleField,
  showModal,
} from "@decky/ui";
import { useState, useEffect, useRef, ReactNode } from "react";
import { MdUpdate, MdRefresh, MdExpandMore, MdExpandLess } from "react-icons/md";
import { LIGHTEST_FIRST_ORDER, LEGACY_ORDER } from "./types";
import type { NotificationLevel, Settings, SourceStatus, UpdateSource, UpdateCheckResult } from "./types";
import { service, ServiceState } from "./autoUpdateService";
import { PLUGIN_VERSION } from "./version";
import { getInstalledPlugins, InstalledPlugin } from "./deckyApi";
import {
  statusColor,
  shortStatusText,
  shortHistorySummary,
  sourceName,
  sourceLabel,
  formatClock,
  formatWhen,
  groupHistory,
  formatUpdateSummary,
  combinedToastBody,
  shouldToastResult,
  triggerLabel,
  logError,
  COLOR_MUTED,
  COLOR_WARNING,
} from "./helpers";

function useServiceState(): ServiceState {
  const [state, setState] = useState(() => service.getState());

  useEffect(() => {
    const unsub = service.subscribe(() => setState(service.getState()));
    // Catch a notify that fired between the first render and this subscription.
    setState(service.getState());
    return unsub;
  }, []);

  return state;
}

// Survives the panel unmounting when the QAM closes.
const uiOpen = new Map<string, boolean>();

function useOpenState(id: string): [boolean, () => void] {
  const [open, setOpen] = useState(() => uiOpen.get(id) ?? false);
  const toggle = () =>
    setOpen((o) => {
      uiOpen.set(id, !o);
      return !o;
    });
  return [open, toggle];
}

const SPINNER_STYLE: React.CSSProperties = {
  display: "inline-block",
  width: 14,
  height: 14,
  border: "2px solid currentColor",
  borderTopColor: "transparent",
  borderRadius: "50%",
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

const ONE_LINE: React.CSSProperties = {
  display: "block",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const HINT_STYLE: React.CSSProperties = { ...ONE_LINE, fontSize: 12, lineHeight: "16px", color: COLOR_MUTED };

const BUSY_TEXT: Record<UpdateSource, string> = {
  steam: "Starting downloads...",
  flatpak: "Installing updates...",
  decky: "Updating plugins...",
  "decky-loader": "Updating Decky...",
  steamos: "Downloading update...",
};

const NOTIFICATION_OPTIONS = [
  { data: "off" as NotificationLevel, label: "Off" },
  { data: "updates-only" as NotificationLevel, label: "When updates are found" },
  { data: "all" as NotificationLevel, label: "After every check" },
];

const CHECK_ORDER_OPTIONS = [
  { data: "lightest", label: "Fastest first" },
  { data: "legacy", label: "Legacy order" },
];

const STEAM_INTERVALS = [5, 10, 15, 30, 60, 120];
const FLATPAK_INTERVALS = [60, 120, 180, 360, 720, 1440];
const LONG_INTERVALS = [60, 180, 360, 720, 1440, 2880];

function intervalLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
}

function intervalOptions(values: number[], current: number) {
  const all = values.includes(current) ? values : [...values, current].sort((a, b) => a - b);
  return all.map((m) => ({ data: m, label: intervalLabel(m) }));
}

function IntervalItem({
  minutes,
  values,
  onChange,
}: {
  minutes: number;
  values: number[];
  onChange: (minutes: number) => void;
}) {
  return (
    <PanelSectionRow>
      <DropdownItem
        label="Check every"
        indentLevel={1}
        rgOptions={intervalOptions(values, minutes)}
        selectedOption={minutes}
        onChange={(opt) => onChange(opt.data)}
      />
    </PanelSectionRow>
  );
}

function BelowDropdown<T>({
  label,
  description,
  options,
  selected,
  onChange,
}: {
  label: string;
  description?: ReactNode;
  options: { data: T; label: string }[];
  selected: T;
  onChange: (value: T) => void;
}) {
  return (
    <PanelSectionRow>
      <Field label={label} description={description} childrenLayout="below" childrenContainerWidth="max">
        <Dropdown rgOptions={options} selectedOption={selected} onChange={(opt) => onChange(opt.data)} />
      </Field>
    </PanelSectionRow>
  );
}

function ExpandRow({
  label,
  description,
  open,
  onToggle,
  indentLevel,
}: {
  label: string;
  description?: ReactNode;
  open: boolean;
  onToggle: () => void;
  indentLevel?: number;
}) {
  return (
    <PanelSectionRow>
      <Field
        label={label}
        description={description}
        indentLevel={indentLevel}
        focusable
        onClick={onToggle}
        onOKActionDescription={open ? "Collapse" : "Expand"}
      >
        {open ? <MdExpandLess /> : <MdExpandMore />}
      </Field>
    </PanelSectionRow>
  );
}

// ── Status ─────────────────────────────────────────────

function StatusRow({
  source,
  status,
  lastCheck,
  warning,
  onCheck,
}: {
  source: UpdateSource;
  status: SourceStatus;
  lastCheck: UpdateCheckResult | null;
  warning?: string;
  onCheck: (source: UpdateSource) => void;
}) {
  const busy = status !== "idle";
  let text: string;
  let color: string;
  if (busy) {
    text = status === "applying" ? BUSY_TEXT[source] : "Checking...";
    color = COLOR_MUTED;
  } else if (warning) {
    text = warning;
    color = COLOR_WARNING;
  } else {
    text = shortStatusText(source, lastCheck);
    color = statusColor(lastCheck);
  }
  const time = !busy && !warning && lastCheck ? formatWhen(lastCheck.timestamp, Date.now()) : "";

  return (
    <PanelSectionRow>
      <Field
        label={sourceName(source)}
        description={
          <span style={ONE_LINE}>
            <span style={{ color }}>{text}</span>
            {time ? <span style={{ color: COLOR_MUTED }}>{` · ${time}`}</span> : null}
          </span>
        }
        focusable
        onClick={() => {
          if (!busy) onCheck(source);
        }}
        onOKActionDescription={busy ? undefined : "Check now"}
      >
        {busy ? <Spinner /> : <MdRefresh />}
      </Field>
    </PanelSectionRow>
  );
}

function enabledSources(state: ServiceState): UpdateSource[] {
  const s = state.settings;
  const out: UpdateSource[] = [];
  if (s.steamEnabled) out.push("steam");
  if (s.flatpakEnabled && state.flatpakAvailable) out.push("flatpak");
  if (s.deckyPluginUpdatesEnabled && state.deckyAvailable) out.push("decky");
  if (s.deckyLoaderUpdateEnabled && state.deckyAvailable) out.push("decky-loader");
  if (s.steamosUpdateEnabled && state.steamosAvailable) out.push("steamos");
  return out;
}

const STATUS_FIELDS: Record<UpdateSource, { status: keyof ServiceState; lastCheck: keyof ServiceState }> = {
  steam: { status: "steamStatus", lastCheck: "steamLastCheck" },
  flatpak: { status: "flatpakStatus", lastCheck: "flatpakLastCheck" },
  decky: { status: "deckyStatus", lastCheck: "deckyLastCheck" },
  "decky-loader": { status: "deckyLoaderStatus", lastCheck: "deckyLoaderLastCheck" },
  steamos: { status: "steamosStatus", lastCheck: "steamosLastCheck" },
};

function nextCheckHint(state: ServiceState, sources: UpdateSource[]): string {
  if (state.gameRunning && !state.settings.checkDuringGameplay) return "Automatic checks paused while a game runs";
  let next: { source: UpdateSource; at: number } | null = null;
  for (const source of sources) {
    const at = service.nextDueAt(source);
    if (at != null && (!next || at < next.at)) next = { source, at };
  }
  if (!next) return "No automatic checks scheduled";
  const now = Date.now();
  const when = next.at <= now ? "soon" : formatWhen(next.at, now);
  return `Next check ${when} · ${sourceName(next.source)}`;
}

function StatusSection({ state }: { state: ServiceState }) {
  const { settings, batch } = state;
  const sources = enabledSources(state);
  const anyBusy = sources.some((src) => state[STATUS_FIELDS[src].status] !== "idle");

  const checkOne = async (source: UpdateSource) => {
    const result = await service.triggerCheck(source, "manual");
    if (result && shouldToastResult(settings.notificationLevel, result)) {
      toaster.toast({ title: `${sourceLabel(source)} Updates`, body: formatUpdateSummary(result) });
    }
  };

  const checkAll = async () => {
    const results = await service.triggerAll("manual");
    if (results.length === 0 || settings.notificationLevel === "off") return;
    const body = combinedToastBody(results, settings.notificationLevel);
    if (body) toaster.toast({ title: "AutoUpdate", body });
  };

  let checkAllLabel: ReactNode = "Check all now";
  if (batch) {
    checkAllLabel = (
      <span>
        <Spinner /> {`Checking ${Math.min(batch.done + 1, batch.total)} of ${batch.total}...`}
      </span>
    );
  }

  return (
    <PanelSection title="Status">
      {sources.length >= 2 && (
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={!!batch || anyBusy} onClick={checkAll}>
            {checkAllLabel}
          </ButtonItem>
        </PanelSectionRow>
      )}

      {sources.map((source) => (
        <StatusRow
          key={source}
          source={source}
          status={state[STATUS_FIELDS[source].status] as SourceStatus}
          lastCheck={state[STATUS_FIELDS[source].lastCheck] as UpdateCheckResult | null}
          warning={source === "steam" && !state.steamReady ? "SteamClient unavailable" : undefined}
          onCheck={checkOne}
        />
      ))}

      {sources.length === 0 ? (
        <PanelSectionRow>
          <div style={HINT_STYLE}>No update sources enabled</div>
        </PanelSectionRow>
      ) : (
        <PanelSectionRow>
          <div style={{ ...HINT_STYLE, padding: "8px 0" }}>{nextCheckHint(state, sources)}</div>
        </PanelSectionRow>
      )}
    </PanelSection>
  );
}

// ── Sources ────────────────────────────────────────────

type UpdateFn = (partial: Partial<Settings>) => void;

function SkipList({ settings, update }: { settings: Settings; update: UpdateFn }) {
  const [open, toggle] = useOpenState("skip-list");
  const [plugins, setPlugins] = useState<InstalledPlugin[] | null>(null);

  useEffect(() => {
    if (!open) setPlugins(null);
  }, [open]);

  useEffect(() => {
    if (!open || plugins) return;
    let cancelled = false;
    getInstalledPlugins()
      .then((list) => {
        if (!cancelled) setPlugins(list.filter((p) => p.name !== "AutoUpdate"));
      })
      .catch((e) => {
        logError("Failed to load installed plugins:", e);
        if (!cancelled) setPlugins([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, plugins]);

  const skipped = settings.deckyPluginBlacklist;
  const isSkipped = (name: string) => skipped.some((b) => b.toLowerCase() === name.toLowerCase());

  return (
    <>
      <ExpandRow
        label="Skipped plugins"
        description={skipped.length === 0 ? "None skipped" : `${skipped.length} skipped`}
        open={open}
        onToggle={toggle}
        indentLevel={1}
      />
      {open && plugins === null && (
        <PanelSectionRow>
          <div style={{ ...HINT_STYLE, padding: "8px 0" }}>
            <Spinner /> Loading plugins...
          </div>
        </PanelSectionRow>
      )}
      {open && plugins?.length === 0 && (
        <PanelSectionRow>
          <div style={{ ...HINT_STYLE, padding: "8px 0" }}>No other plugins installed</div>
        </PanelSectionRow>
      )}
      {open &&
        plugins?.map((plugin) => (
          <PanelSectionRow key={plugin.name}>
            <ToggleField
              label={plugin.name}
              description={isSkipped(plugin.name) ? "Skipped" : `v${plugin.version}`}
              indentLevel={2}
              checked={isSkipped(plugin.name)}
              onChange={(val) =>
                update({
                  deckyPluginBlacklist: val
                    ? [...skipped, plugin.name]
                    : skipped.filter((b) => b.toLowerCase() !== plugin.name.toLowerCase()),
                })
              }
            />
          </PanelSectionRow>
        ))}
    </>
  );
}

function SourcesSection({ state, update }: { state: ServiceState; update: UpdateFn }) {
  const { settings } = state;
  const deckyAny = settings.deckyPluginUpdatesEnabled || settings.deckyLoaderUpdateEnabled;

  return (
    <PanelSection title="Update Sources">
      <PanelSectionRow>
        <ToggleField
          label="Steam Apps"
          description="Start scheduled game downloads"
          checked={settings.steamEnabled}
          onChange={(val) => update({ steamEnabled: val })}
        />
      </PanelSectionRow>
      {settings.steamEnabled && (
        <IntervalItem
          minutes={settings.steamCheckIntervalMinutes}
          values={STEAM_INTERVALS}
          onChange={(m) => update({ steamCheckIntervalMinutes: m })}
        />
      )}

      {state.flatpakAvailable && (
        <>
          <PanelSectionRow>
            <ToggleField
              label="Flatpak"
              description="Desktop apps such as browsers"
              checked={settings.flatpakEnabled}
              onChange={(val) => update({ flatpakEnabled: val })}
            />
          </PanelSectionRow>
          {settings.flatpakEnabled && (
            <>
              <IntervalItem
                minutes={settings.flatpakCheckIntervalMinutes}
                values={FLATPAK_INTERVALS}
                onChange={(m) => update({ flatpakCheckIntervalMinutes: m })}
              />
              <PanelSectionRow>
                <ToggleField
                  label="Install automatically"
                  description="Off: only check and report"
                  indentLevel={1}
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
              label="Decky Plugins"
              description="Update plugins from the Decky store"
              checked={settings.deckyPluginUpdatesEnabled}
              onChange={(val) => update({ deckyPluginUpdatesEnabled: val })}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <ToggleField
              label="Decky Loader"
              description="Keep Decky Loader itself up to date"
              checked={settings.deckyLoaderUpdateEnabled}
              onChange={(val) => update({ deckyLoaderUpdateEnabled: val })}
            />
          </PanelSectionRow>
          {deckyAny && (
            <IntervalItem
              minutes={settings.deckyCheckIntervalMinutes}
              values={LONG_INTERVALS}
              onChange={(m) => update({ deckyCheckIntervalMinutes: m })}
            />
          )}
          {settings.deckyPluginUpdatesEnabled && <SkipList settings={settings} update={update} />}
        </>
      )}

      {state.steamosAvailable && (
        <>
          <PanelSectionRow>
            <ToggleField
              label="SteamOS"
              description="Download and stage; never reboots"
              checked={settings.steamosUpdateEnabled}
              onChange={(val) => update({ steamosUpdateEnabled: val })}
            />
          </PanelSectionRow>
          {settings.steamosUpdateEnabled && (
            <IntervalItem
              minutes={settings.steamosCheckIntervalMinutes}
              values={LONG_INTERVALS}
              onChange={(m) => update({ steamosCheckIntervalMinutes: m })}
            />
          )}
        </>
      )}
    </PanelSection>
  );
}

// ── Automatic checks ───────────────────────────────────

const NOTIFICATION_HINT: Record<NotificationLevel, string> = {
  off: "No toast notifications",
  "updates-only": "Toast when updates are found or applied",
  all: "Toast after every check",
};

function AutomaticSection({ settings, update }: { settings: Settings; update: UpdateFn }) {
  return (
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
          description="Allow checks while a game is running"
          checked={settings.checkDuringGameplay}
          onChange={(val) => update({ checkDuringGameplay: val })}
        />
      </PanelSectionRow>
      <BelowDropdown
        label="Notifications"
        description={NOTIFICATION_HINT[settings.notificationLevel]}
        options={NOTIFICATION_OPTIONS}
        selected={settings.notificationLevel}
        onChange={(level) => update({ notificationLevel: level })}
      />
    </PanelSection>
  );
}

// ── Advanced ───────────────────────────────────────────

function AdvancedSection({ settings, update }: { settings: Settings; update: UpdateFn }) {
  const [open, toggle] = useOpenState("advanced");
  const isLegacy =
    settings.checkOrder.length === LEGACY_ORDER.length && settings.checkOrder.every((s, i) => s === LEGACY_ORDER[i]);

  return (
    <PanelSection title="Advanced">
      <ExpandRow
        label="Advanced settings"
        description={open ? undefined : "History, check order, diagnostics"}
        open={open}
        onToggle={toggle}
      />
      {open && (
        <>
          <PanelSectionRow>
            <ToggleField
              label="Update history"
              description="Keep a log of past update activity"
              checked={settings.logHistory}
              onChange={(val) => update({ logHistory: val })}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <SliderField
              label="Pause between sources"
              description="Gives Steam room to breathe during a batch"
              value={settings.interCheckDelayMs / 1000}
              min={0}
              max={10}
              step={0.5}
              showValue
              valueSuffix="s"
              onChange={(val) => update({ interCheckDelayMs: Math.round(val * 1000) })}
            />
          </PanelSectionRow>
          <BelowDropdown
            label="Check order"
            options={CHECK_ORDER_OPTIONS}
            selected={isLegacy ? "legacy" : "lightest"}
            onChange={(value) =>
              update({ checkOrder: value === "legacy" ? [...LEGACY_ORDER] : [...LIGHTEST_FIRST_ORDER] })
            }
          />
          <PanelSectionRow>
            <ToggleField
              label="Debug logging"
              description="Verbose plugin log for troubleshooting"
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
            <Field label="Version" bottomSeparator="none">
              <span style={{ color: COLOR_MUTED }}>{PLUGIN_VERSION}</span>
            </Field>
          </PanelSectionRow>
        </>
      )}
    </PanelSection>
  );
}

// ── History ────────────────────────────────────────────

const HISTORY_PAGE = 30;

function HistorySection({ state }: { state: ServiceState }) {
  const [open, toggle] = useOpenState("history");
  const [limit, setLimit] = useState(HISTORY_PAGE);
  const entries = state.historyEntries;
  const now = Date.now();
  const groups = open ? groupHistory(entries, limit, now) : [];
  const shown = groups.reduce((n, g) => n + g.rows.reduce((m, r) => m + r.count, 0), 0);

  const confirmClear = () => {
    showModal(
      <ConfirmModal
        strTitle="Clear update history?"
        strDescription="This removes all recorded update activity."
        strOKButtonText="Clear"
        onOK={() => service.clearHistory()}
      />,
    );
  };

  return (
    <PanelSection title="History">
      <ExpandRow
        label="Recent activity"
        description={entries.length === 0 ? "Nothing recorded yet" : `${entries.length} entries`}
        open={open}
        onToggle={() => {
          if (!open) service.refreshHistory();
          toggle();
        }}
      />
      {groups.map((group) => (
        <div key={group.day}>
          <PanelSectionRow>
            <div style={{ ...HINT_STYLE, padding: "10px 0 2px", textTransform: "uppercase", letterSpacing: 0.5 }}>
              {group.day}
            </div>
          </PanelSectionRow>
          {group.rows.map(({ entry, count }) => (
            <PanelSectionRow key={`${entry.source}-${entry.timestamp}`}>
              <Field
                label={`${sourceName(entry.source)}: ${shortHistorySummary(entry)}`}
                description={`${triggerLabel(entry.trigger)}${count > 1 ? ` · ${count} times` : ""}`}
                focusable
              >
                <span style={{ color: COLOR_MUTED, fontSize: 12 }}>{formatClock(entry.timestamp)}</span>
              </Field>
            </PanelSectionRow>
          ))}
        </div>
      ))}
      {open && shown < entries.length && (
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => setLimit((l) => l + HISTORY_PAGE)}>
            Show older
          </ButtonItem>
        </PanelSectionRow>
      )}
      {open && entries.length > 0 && (
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={confirmClear}>
            Clear history
          </ButtonItem>
        </PanelSectionRow>
      )}
    </PanelSection>
  );
}

// ── Panel ──────────────────────────────────────────────

function AutoUpdatePanel() {
  const state = useServiceState();
  const update: UpdateFn = (partial) => {
    service.updateSettings(partial);
  };

  if (!state.settingsLoaded) {
    return (
      <PanelSection>
        <PanelSectionRow>
          <div style={{ ...HINT_STYLE, padding: "8px 0" }}>
            <Spinner /> Loading...
          </div>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  return (
    <div style={{ overflowX: "clip" }}>
      <StatusSection state={state} />
      <SourcesSection state={state} update={update} />
      <AutomaticSection settings={state.settings} update={update} />
      <AdvancedSection settings={state.settings} update={update} />
      {state.settings.logHistory && <HistorySection state={state} />}
    </div>
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
    onDismount() {
      service.stop();
    },
  };
});
