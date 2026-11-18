import { stageAtlasArm64Release } from "./atlas-arm64-release.js";
import { formatErrorMessage } from "./errors.js";
import { isFailedUpdateStep } from "./update-run-step.js";
import { DEFAULT_UPDATE_STEP_TIMEOUT_MS } from "./update-run-timeouts.js";
import { runStep } from "./update-runner-command.js";
import type { StepFactory } from "./update-runner-git-commands.js";
import type { RunStepOptions } from "./update-runner-types.js";

export async function prepareAtlasArm64Candidate(
  params: {
    worktreeDir: string;
    preflightRoot: string;
    workTimeoutMs?: number;
    workStep: StepFactory;
  },
  sha: string,
): Promise<boolean> {
  const artifact = await runStep({
    ...params.workStep(
      "preflight-atlas-arm64",
      ["fetch Atlas Linux ARM64 release", sha],
      params.worktreeDir,
    ),
    runCommand: async () => {
      try {
        await stageAtlasArm64Release({
          root: params.worktreeDir,
          stagingRoot: params.preflightRoot,
          sha,
          timeoutMs: params.workTimeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS,
        });
        return { code: 0, stdout: "", stderr: "" };
      } catch (error) {
        return { code: 1, stdout: "", stderr: formatErrorMessage(error) };
      }
    },
  });
  return !isFailedUpdateStep(artifact);
}

export async function verifyAtlasArm64FastForward(
  step: (name: string, ...args: string[]) => RunStepOptions,
  beforeSha: string | null | undefined,
  candidateSha: string,
): Promise<boolean> {
  if (!beforeSha || beforeSha === candidateSha) {
    return true;
  }
  const ancestry = await runStep(
    step("atlas-arm64-fast-forward", "merge-base", "--is-ancestor", beforeSha, candidateSha),
  );
  return !isFailedUpdateStep(ancestry);
}
