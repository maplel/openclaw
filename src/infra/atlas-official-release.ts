import type { UpdateScheduleState } from "../../packages/gateway-protocol/src/index.js";
import { VERSION } from "../version.js";
import { compareSemverStrings, fetchNpmTagVersion } from "./update-check.js";

/** Official stable discovery carries no executable update target. */
export async function checkAtlasOfficialRelease(
  signal: AbortSignal,
): Promise<NonNullable<UpdateScheduleState["officialRelease"]>> {
  const checkedAtMs = Date.now();
  try {
    const result = await fetchNpmTagVersion({ tag: "latest", signal });
    signal.throwIfAborted();
    const comparison = compareSemverStrings(VERSION, result.version);
    if (!result.version || comparison === null) {
      return {
        status: "unavailable",
        currentVersion: VERSION,
        checkedAtMs,
        error: result.error || "Official stable version is unavailable.",
      };
    }
    return {
      status: comparison < 0 ? "pending-sync" : "current",
      currentVersion: VERSION,
      latestVersion: result.version,
      checkedAtMs,
    };
  } catch (error) {
    signal.throwIfAborted();
    return {
      status: "unavailable",
      currentVersion: VERSION,
      checkedAtMs,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
