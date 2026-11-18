import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { atlasUpdateTargetError, ATLAS_UPDATE_TRACKING_REF } from "./atlas-update-source.js";
import { checkUpdateStatus } from "./update-check.js";
import { devUpdateTargetFromGitTarget } from "./update-dev-target.js";
import { resolveDevGitUpdate } from "./update-startup-refresh.js";

async function git(cwd: string, ...args: string[]) {
  const result = await runCommandWithTimeout(["git", ...args], { cwd, timeoutMs: 10_000 });
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}

it("carries real Atlas Git discovery into an executable tracked target", async () => {
  await withTestDir({ prefix: "openclaw-atlas-discovery-" }, async (directory) => {
    const source = { repositoryUrl: "https://github.com/maplel/openclaw", branch: "main" };
    const remote = path.join(directory, "remote");
    const checkout = path.join(directory, "checkout");
    await git(directory, "init", "--quiet", "--initial-branch=main", remote);
    await git(remote, "config", "user.name", "Atlas Test");
    await git(remote, "config", "user.email", "atlas@example.invalid");
    await fs.writeFile(
      path.join(remote, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.11.2",
        openclaw: { atlasUpdateSource: source },
      }),
    );
    await git(remote, "add", "package.json");
    await git(remote, "commit", "--quiet", "-m", "Atlas baseline");
    await git(directory, "clone", "--quiet", remote, checkout);
    // Bind the production URL to a task-owned local repository; no network is used.
    await git(
      checkout,
      "config",
      `url.${remote.replaceAll("\\", "/")}.insteadOf`,
      `${source.repositoryUrl}.git`,
    );
    await fs.writeFile(path.join(remote, "change.txt"), "Atlas update");
    await git(remote, "add", "change.txt");
    await git(remote, "commit", "--quiet", "-m", "Atlas update");
    const targetSha = await git(remote, "rev-parse", "HEAD");

    const status = await checkUpdateStatus({
      root: checkout,
      fetchGit: true,
      includeRegistry: false,
    });
    expect(status.git).toMatchObject({
      upstream: ATLAS_UPDATE_TRACKING_REF,
      upstreamSha: targetSha,
      behind: 1,
      fetchOk: true,
      repositoryUrl: source.repositoryUrl,
    });
    const discovered = await resolveDevGitUpdate(status, new AbortController().signal);
    expect(discovered?.target).toMatchObject({
      kind: "git",
      upstreamSha: targetSha,
      upstreamRef: ATLAS_UPDATE_TRACKING_REF,
    });
    expect(discovered).not.toBeNull();
    const devTarget = devUpdateTargetFromGitTarget(discovered!.target);
    expect(atlasUpdateTargetError(status.atlasUpdateSource, { devTarget })).toBeNull();
  });
});
