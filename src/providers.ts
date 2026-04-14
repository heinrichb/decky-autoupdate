/**
 * Update source providers — Steam, Flatpak, Decky plugins, Decky Loader, and SteamOS.
 *
 * Each provider implements check() which returns an UpdateCheckResult.
 * steamClient.ts remains the raw SteamClient API layer;
 * deckyApi.ts handles Decky Loader communication;
 * this module wraps them (and the Flatpak/SteamOS backend) into a uniform shape.
 */

import { UpdateCheckResult, FlatpakUpdate, emptyResult } from "./types";
import { errorMessage, log, logError, logWarn, debug } from "./helpers";
import { forceStartAllUpdates } from "./steamClient";
import {
  isDeckyAvailable,
  findPluginUpdates,
  installPluginsAndConfirm,
  checkDeckyLoaderUpdate,
  applyDeckyLoaderUpdate,
  callPluginMethod,
} from "./deckyApi";

// ── Backend call types ──────────────────────────────────────

type FlatpakCheckResult = { success: boolean; updates: FlatpakUpdate[]; error: string };
type SubprocessResult = { success: boolean; stdout: string; stderr: string; returncode: number };
type SteamosCheckResult = {
  success: boolean;
  hasUpdate: boolean;
  buildId: string;
  needsReboot: boolean;
  error: string;
};

// ── Steam provider ───────────────────────────────────────────

export async function checkSteam(): Promise<UpdateCheckResult> {
  debug("checkSteam: delegating to forceStartAllUpdates");
  return forceStartAllUpdates();
}

// ── Flatpak provider ─────────────────────────────────────────

let flatpakAvailable: boolean | null = null;

export async function isFlatpakAvailable(): Promise<boolean> {
  if (flatpakAvailable !== null) {
    debug("isFlatpakAvailable: cached =", flatpakAvailable);
    return flatpakAvailable;
  }
  try {
    debug("isFlatpakAvailable: calling backend...");
    const result = await callPluginMethod<boolean>("get_flatpak_available", 10_000);
    flatpakAvailable = result;
    debug("isFlatpakAvailable:", result);
    return result;
  } catch (e) {
    debug("isFlatpakAvailable: failed:", errorMessage(e));
    // Don't cache IPC errors — allow retry on next call
    return false;
  }
}

/**
 * Check for available Flatpak updates (does not apply them).
 */
export async function checkFlatpakOnly(): Promise<UpdateCheckResult> {
  try {
    debug("checkFlatpakOnly: calling check_flatpak_updates...");
    const t0 = Date.now();
    const check = await callPluginMethod<FlatpakCheckResult>("check_flatpak_updates", 60_000);
    debug(
      `checkFlatpakOnly: response in ${Date.now() - t0}ms — success=${check.success}, updates=${check.updates?.length ?? 0}`,
    );
    if (!check.success) {
      return emptyResult("flatpak", [check.error || "Failed to check for Flatpak updates"]);
    }

    if (check.updates.length > 0) {
      debug("checkFlatpakOnly: updates:", check.updates.map((u) => u.name).join(", "));
    }

    return {
      ...emptyResult("flatpak"),
      pendingCount: check.updates.length,
      flatpakUpdates: check.updates,
    };
  } catch (e) {
    logError("checkFlatpakOnly failed:", errorMessage(e));
    return emptyResult("flatpak", [errorMessage(e)]);
  }
}

/**
 * Apply all available Flatpak updates. Call after checkFlatpakOnly.
 */
export async function applyFlatpak(pendingUpdates: FlatpakUpdate[]): Promise<UpdateCheckResult> {
  const errors: string[] = [];
  let forcedCount = 0;

  try {
    debug("applyFlatpak: applying", pendingUpdates.length, "update(s)...");
    const t0 = Date.now();
    const apply = await callPluginMethod<SubprocessResult>("apply_flatpak_updates", 120_000);
    debug(`applyFlatpak: completed in ${Date.now() - t0}ms — success=${apply.success}`);
    if (apply.success) {
      forcedCount = pendingUpdates.length;
    } else {
      logError("applyFlatpak: failed:", apply.stderr);
      errors.push(apply.stderr || "Flatpak update failed");
    }
  } catch (e) {
    logError("applyFlatpak: exception:", errorMessage(e));
    errors.push(errorMessage(e));
  }

  return {
    ...emptyResult("flatpak"),
    pendingCount: pendingUpdates.length,
    forcedCount,
    errors,
    flatpakUpdates: pendingUpdates,
  };
}

// ── Decky plugin provider ───────────────────────────────────

export async function isDeckyApiAvailable(): Promise<boolean> {
  // Try up to 3 times with increasing delay.
  // Decky Loader may still be starting when our plugin initializes.
  const delays = [0, 2000, 5000];
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) {
      debug(`isDeckyApiAvailable: waiting ${delays[i]}ms before attempt ${i + 1}`);
      await new Promise((resolve) => setTimeout(resolve, delays[i]));
    }
    try {
      debug(`isDeckyApiAvailable: attempt ${i + 1} of ${delays.length}`);
      const available = await isDeckyAvailable();
      if (available) {
        log(`Decky API available (attempt ${i + 1} of ${delays.length})`);
        return true;
      }
      debug("isDeckyApiAvailable: not available yet");
    } catch (e) {
      debug(`isDeckyApiAvailable: attempt ${i + 1} error:`, errorMessage(e));
    }
  }
  logWarn(`Decky API not available after ${delays.length} attempts`);
  return false;
}

/**
 * Apply Decky plugin updates: install and auto-confirm.
 */
export async function applyDeckyPluginUpdates(blacklist: string[]): Promise<UpdateCheckResult> {
  const errors: string[] = [];

  try {
    debug("applyDeckyPluginUpdates: finding updates (blacklist:", blacklist, ")");
    const { updates, details } = await findPluginUpdates(blacklist);

    if (updates.length === 0) {
      debug("applyDeckyPluginUpdates: no updates found");
      return emptyResult("decky");
    }

    log(
      `Applying ${updates.length} Decky plugin update(s): ${details.map((d) => `${d.name} ${d.currentVersion}→${d.newVersion}`).join(", ")}`,
    );

    debug("applyDeckyPluginUpdates: calling installPluginsAndConfirm...");
    await installPluginsAndConfirm(updates);
    debug("applyDeckyPluginUpdates: install complete");

    return {
      ...emptyResult("decky"),
      pendingCount: details.length,
      forcedCount: details.length,
      deckyPluginUpdates: details,
    };
  } catch (e) {
    logError("Failed to apply Decky plugin updates:", e);
    errors.push(errorMessage(e));
    return emptyResult("decky", errors);
  }
}

// ── Decky Loader update provider ──────────────────────────

/**
 * Check for Decky Loader update and auto-apply if available.
 */
export async function checkAndApplyDeckyLoaderUpdate(): Promise<UpdateCheckResult> {
  try {
    debug("checkAndApplyDeckyLoaderUpdate: checking...");
    const check = await checkDeckyLoaderUpdate();
    debug("checkAndApplyDeckyLoaderUpdate: hasUpdate =", check.hasUpdate, "current =", check.currentVersion);

    if (!check.hasUpdate) {
      return emptyResult("decky-loader");
    }

    log(`Decky Loader update available: ${check.currentVersion} → ${check.remoteVersion || "latest"}`);

    debug("checkAndApplyDeckyLoaderUpdate: applying update...");
    await applyDeckyLoaderUpdate();
    debug("checkAndApplyDeckyLoaderUpdate: update applied");

    return {
      ...emptyResult("decky-loader"),
      pendingCount: 1,
      forcedCount: 1,
      deckyPluginUpdates: [
        {
          name: "Decky Loader",
          currentVersion: check.currentVersion,
          newVersion: check.remoteVersion || "latest",
        },
      ],
    };
  } catch (e) {
    logError("Decky Loader update failed:", e);
    return emptyResult("decky-loader", [errorMessage(e)]);
  }
}

// ── SteamOS update provider ───────────────────────────────

let steamosAvailable: boolean | null = null;

export async function isSteamosAvailable(): Promise<boolean> {
  if (steamosAvailable !== null) {
    debug("isSteamosAvailable: cached =", steamosAvailable);
    return steamosAvailable;
  }
  try {
    debug("isSteamosAvailable: calling backend...");
    const result = await callPluginMethod<boolean>("get_steamos_update_available", 10_000);
    steamosAvailable = result;
    debug("isSteamosAvailable:", result);
    return result;
  } catch (e) {
    debug("isSteamosAvailable: failed:", errorMessage(e));
    return false;
  }
}

/**
 * Check for SteamOS update and auto-download+stage if available.
 */
export async function checkAndApplySteamos(): Promise<UpdateCheckResult> {
  try {
    debug("checkAndApplySteamos: calling check_steamos_updates...");
    const t0 = Date.now();
    const check = await callPluginMethod<SteamosCheckResult>("check_steamos_updates", 30_000);
    debug(
      `checkAndApplySteamos: response in ${Date.now() - t0}ms — success=${check.success}, hasUpdate=${check.hasUpdate}`,
    );

    if (!check.success) {
      return emptyResult("steamos", [check.error || "Failed to check SteamOS updates"]);
    }

    if (check.needsReboot) {
      log("SteamOS update already staged — reboot to apply");
      return { ...emptyResult("steamos"), pendingCount: 1, forcedCount: 1 };
    }

    if (!check.hasUpdate) {
      return emptyResult("steamos");
    }

    log(`SteamOS update available: build ${check.buildId} — downloading and staging`);

    debug("checkAndApplySteamos: applying update...");
    const apply = await callPluginMethod<SubprocessResult>("apply_steamos_update", 120_000);
    debug("checkAndApplySteamos: apply result — success =", apply.success);
    if (!apply.success) {
      return { ...emptyResult("steamos"), pendingCount: 1, errors: [apply.stderr || "SteamOS update failed"] };
    }

    return { ...emptyResult("steamos"), pendingCount: 1, forcedCount: 1 };
  } catch (e) {
    logError("SteamOS update failed:", e);
    return emptyResult("steamos", [errorMessage(e)]);
  }
}
