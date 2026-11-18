import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { ATLAS_UPDATE_TRACKING_REF, readAtlasUpdateSource } from "./atlas-update-source.js";
import { resolveEffectiveUpdateChannel } from "./update-channels.js";
import { readGitUpdateFetchTarget } from "./update-git-metadata.js";
import { fetchGitUpdateTarget } from "./update-runner-git-target.js";
import type { CommandRunner, RunStepOptions } from "./update-runner-types.js";

const source = { repositoryUrl: "https://github.com/maplel/openclaw", branch: "main" };

describe("Atlas distribution update source", () => {
  it("leaves ordinary upstream installations unchanged", async () => {
    await withTestDir({ prefix: "openclaw-atlas-source-" }, async (root) => {
      await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
      await expect(readAtlasUpdateSource(root)).resolves.toBeNull();
      expect(
        resolveEffectiveUpdateChannel({ installKind: "git", configChannel: "stable" }).channel,
      ).toBe("stable");
    });
  });

  it("uses distribution main instead of operator release-channel and remote settings", async () => {
    await withTestDir({ prefix: "openclaw-atlas-source-" }, async (root) => {
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ openclaw: { atlasUpdateSource: source } }),
      );
      const atlasUpdateSource = await readAtlasUpdateSource(root);
      expect(atlasUpdateSource).toEqual(source);
      for (const configChannel of ["stable", "beta", "extended-stable", "dev"] as const) {
        expect(
          resolveEffectiveUpdateChannel({ installKind: "git", configChannel, atlasUpdateSource })
            .channel,
        ).toBe("dev");
      }
      const readGit = vi.fn(async () => "upstream");
      await expect(
        readGitUpdateFetchTarget(readGit, "main", true, {
          root,
          sha: "a".repeat(40),
          receipt: null,
          fetchRemote: true,
        }),
      ).resolves.toEqual({
        remote: `${source.repositoryUrl}.git`,
        mergeRef: `refs/heads/main:${ATLAS_UPDATE_TRACKING_REF}`,
        revision: ATLAS_UPDATE_TRACKING_REF,
        upstreamSource: "tracking",
      });
      expect(readGit).not.toHaveBeenCalled();
    });
  });

  it("reports malformed declared metadata rather than dropping the source policy", async () => {
    await withTestDir({ prefix: "openclaw-atlas-source-" }, async (root) => {
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ openclaw: { atlasUpdateSource: {} } }),
      );
      await expect(readAtlasUpdateSource(root)).rejects.toThrow("Invalid Atlas update source");
    });
  });

  it.each([0, 128])("fetches only Atlas main and never falls back (exit %s)", async (code) => {
    const runCommand = vi.fn<CommandRunner>(async () => ({
      code,
      stdout: "",
      stderr: code ? "unavailable" : "",
    }));
    const step = (name: string, argv: string[], cwd: string): RunStepOptions => ({
      name,
      argv,
      cwd,
      runCommand,
      timeoutMs: 1_000,
      stepIndex: 0,
      totalSteps: 1,
    });
    const result = await fetchGitUpdateTarget({
      root: ".",
      atlasUpdateSource: source,
      channel: "dev",
      name: "atlas-fetch",
      step,
      workStep: step,
      steps: [],
    });
    expect(result.ok).toBe(code === 0);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand.mock.calls[0]?.[0]).toEqual([
      "git",
      "-C",
      ".",
      "fetch",
      "--no-tags",
      "--no-prune",
      "--no-prune-tags",
      "--no-recurse-submodules",
      "--",
      `${source.repositoryUrl}.git`,
      `refs/heads/main:${ATLAS_UPDATE_TRACKING_REF}`,
    ]);
  });

  it("rejects a detached official target before fetching", async () => {
    const runCommand = vi.fn<CommandRunner>();
    const step = (name: string, argv: string[], cwd: string): RunStepOptions => ({
      name,
      argv,
      cwd,
      runCommand,
      stepIndex: 0,
      totalSteps: 1,
    });
    await expect(
      fetchGitUpdateTarget({
        root: ".",
        atlasUpdateSource: source,
        channel: "dev",
        name: "atlas-fetch",
        step,
        workStep: step,
        steps: [],
        devTarget: { mode: "detached", ref: "v2026.11.2" },
      }),
    ).rejects.toThrow("only accept the tracked");
    expect(runCommand).not.toHaveBeenCalled();
  });
});
