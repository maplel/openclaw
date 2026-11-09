import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { tryReadJson } from "./json-files.js";
import {
  DEFAULT_GIT_CHANNEL,
  resolveEffectiveUpdateChannel,
  type UpdateChannel,
} from "./update-channels.js";
import type { DevUpdateTarget } from "./update-dev-target.js";
import type { UpdateInstallKind } from "./update-install-kind.js";
import type { CommandRunner } from "./update-runner-types.js";

export type AtlasUpdateSource = {
  repositoryUrl: string;
  branch: string;
};

export const ATLAS_UPDATE_TRACKING_REF = "refs/remotes/atlas/main";

export function parseAtlasUpdateSource(value: unknown): AtlasUpdateSource | null {
  const manifest = asNullableRecord(value);
  const openclaw = asNullableRecord(manifest?.openclaw);
  if (openclaw?.atlasUpdateSource === undefined) {
    return null;
  }
  const source = asNullableRecord(openclaw.atlasUpdateSource);
  if (source?.repositoryUrl !== "https://github.com/maplel/openclaw" || source.branch !== "main") {
    throw new Error(
      "Invalid Atlas update source; expected https://github.com/maplel/openclaw main.",
    );
  }
  return { repositoryUrl: source.repositoryUrl, branch: source.branch };
}

/** Distribution metadata owns the update source, independently of release notifications. */
export async function readAtlasUpdateSource(
  root: string | null,
): Promise<AtlasUpdateSource | null> {
  if (!root) {
    return null;
  }
  return parseAtlasUpdateSource(await tryReadJson<unknown>(path.join(root, "package.json")));
}

export function atlasGitFetchTarget(source: AtlasUpdateSource) {
  return {
    remote: `${source.repositoryUrl}.git`,
    mergeRef: `refs/heads/${source.branch}:${ATLAS_UPDATE_TRACKING_REF}`,
    revision: ATLAS_UPDATE_TRACKING_REF,
    upstreamSource: "tracking" as const,
  };
}

/** Preserve upstream routing when no distribution owns the source. */
export function resolveAtlasUpdateRoute(params: {
  atlasUpdateSource: AtlasUpdateSource | null;
  sourceUpdate?: boolean;
  requestedChannel: UpdateChannel | null;
  storedChannel: UpdateChannel | null;
  installKind: UpdateInstallKind;
  explicitTag: string | null;
  currentVersion: string;
}) {
  const { atlasUpdateSource, requestedChannel, installKind, explicitTag } = params;
  const channel =
    (atlasUpdateSource || params.sourceUpdate ? DEFAULT_GIT_CHANNEL : requestedChannel) ??
    params.storedChannel ??
    (installKind === "git" ? DEFAULT_GIT_CHANNEL : resolveEffectiveUpdateChannel(params).channel);
  return {
    channel,
    switchToGit:
      installKind !== "git" &&
      (Boolean(atlasUpdateSource) ||
        requestedChannel === "dev" ||
        (channel === "dev" && explicitTag === null)),
    switchToPackage:
      !atlasUpdateSource &&
      requestedChannel !== null &&
      requestedChannel !== "dev" &&
      installKind === "git",
  };
}

export function atlasUpdateTargetError(
  source: AtlasUpdateSource | null | undefined,
  target: { explicitTag?: string | null; devTarget?: DevUpdateTarget },
): string | null {
  if (!source) {
    return null;
  }
  if (target.explicitTag) {
    return "Atlas updates use maplel/openclaw main; package --tag overrides are not supported.";
  }
  if (
    target.devTarget &&
    (target.devTarget.mode !== "tracked" ||
      target.devTarget.upstreamRef !== ATLAS_UPDATE_TRACKING_REF)
  ) {
    return "Atlas updates only accept the tracked maplel/openclaw main target.";
  }
  return null;
}

export function assertAtlasUpdateTarget(
  source: AtlasUpdateSource | null,
  devTarget?: DevUpdateTarget,
) {
  const error = atlasUpdateTargetError(source, { devTarget });
  if (error) {
    throw new Error(error);
  }
}

/** A candidate must keep the distribution's update owner for subsequent upgrades. */
export async function assertAtlasCandidateSource(
  source: AtlasUpdateSource | null,
  params: { root: string; revision: string; timeoutMs: number; runCommand: CommandRunner },
) {
  if (!source) {
    return;
  }
  const manifest = await params.runCommand(
    ["git", "-C", params.root, "show", `${params.revision}:package.json`],
    { cwd: params.root, timeoutMs: params.timeoutMs },
  );
  if (manifest.code !== 0 || !parseAtlasUpdateSource(JSON.parse(manifest.stdout))) {
    throw new Error("Atlas update candidate must preserve the maplel/openclaw main update source.");
  }
}
