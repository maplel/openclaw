import { assertAtlasCandidateSource, type AtlasUpdateSource } from "./atlas-update-source.js";
import { prepareGitMutation } from "./update-runner-git-target.js";
import type { CommandRunner, UpdateRunnerOptions } from "./update-runner-types.js";

export function createGitMutationInspector(
  base: { root: string; timeoutMs: number; runCommand: CommandRunner },
  beforeGitMutation: UpdateRunnerOptions["inspectGitTarget"],
  atlasUpdateSource: AtlasUpdateSource | null,
) {
  return async (revision: string, root = base.root) => {
    const inspection = { ...base, root, revision };
    await assertAtlasCandidateSource(atlasUpdateSource, inspection);
    await prepareGitMutation({ ...inspection, beforeGitMutation });
  };
}
