import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { atlasSyncHandlers } from "./update-atlas-sync.js";

const { readFile, assertCurrent } = vi.hoisted(() => ({
  readFile: vi.fn(),
  assertCurrent: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ readFile }));
vi.mock("../../infra/update-status-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-status-state.js")>()),
  getUpdateSchedule: () => ({
    atlasSource: { repositoryUrl: "https://github.com/maplel/openclaw", branch: "main" },
    officialRelease: { status: "pending-sync", latestVersion: "2026.11.5" },
  }),
}));
vi.mock("./session-mutation-guards.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-mutation-guards.js")>()),
  readGatewayRequestMutationAuthority: () => ({ assertCurrent }),
}));

const fetchGitHub = vi.fn<typeof fetch>();

async function call(method: string, params: Record<string, unknown> = {}) {
  const respond = vi.fn();
  await atlasSyncHandlers[`update.atlasSync.${method}`]({
    params,
    respond,
    context: { getRuntimeConfig: () => ({}) },
  } as unknown as GatewayRequestHandlerOptions);
  return respond.mock.calls[0];
}

describe("Atlas sync Gateway actions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", fetchGitHub);
    vi.stubEnv("OPENCLAW_ATLAS_SYNC_TOKEN_FILE", "/test/atlas-token");
    readFile.mockResolvedValue("test-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("dispatches the displayed version on the fixed workflow and returns the accepted run", async () => {
    fetchGitHub
      .mockResolvedValueOnce(Response.json({ workflow_runs: [] }))
      .mockResolvedValueOnce(Response.json({ workflow_run_id: 42 }));
    expect(await call("start", { version: "2026.11.5" })).toEqual([
      true,
      {
        id: 42,
        state: "running",
        runUrl: "https://github.com/maplel/openclaw/actions/runs/42",
        version: "2026.11.5",
      },
      undefined,
    ]);
    expect(assertCurrent).toHaveBeenCalledOnce();
    expect(fetchGitHub).toHaveBeenLastCalledWith(
      "https://api.github.com/repos/maplel/openclaw/actions/workflows/atlas-sync-stable.yml/dispatches",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ ref: "main", inputs: { version: "2026.11.5" } }),
      }),
    );
    expect((await call("start", { version: "2026.11.4" }))[0]).toBe(false);
    expect(fetchGitHub).toHaveBeenCalledTimes(2);
  });

  it("keeps the in-progress run when the operator clicks while a sync is active", async () => {
    fetchGitHub.mockResolvedValueOnce(
      Response.json({ workflow_runs: [{ id: 42, status: "in_progress" }] }),
    );
    expect((await call("start", { version: "2026.11.5" }))[1]).toMatchObject({
      id: 42,
      state: "running",
    });
    expect(fetchGitHub).toHaveBeenCalledOnce();
  });

  it.each([
    ["conflict", "failure", "failure", "skipped", "skipped"],
    ["testsFailed", "failure", "success", "failure", "skipped"],
    ["merged", "success", "success", "success", "success"],
    ["current", "success", "success", "skipped", "skipped"],
  ])("reports %s from GitHub job receipts", async (state, conclusion, prepare, verify, land) => {
    fetchGitHub
      .mockResolvedValueOnce(
        Response.json({
          id: 42,
          path: ".github/workflows/atlas-sync-stable.yml",
          status: "completed",
          conclusion,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          jobs: [
            {
              name: "Prepare pull request",
              conclusion: prepare,
              steps: [
                {
                  name: "Report merge conflict",
                  conclusion: state === "conflict" ? "failure" : "skipped",
                },
              ],
            },
            { name: "Verify candidate", conclusion: verify },
            { name: "Merge pull request", conclusion: land },
          ],
        }),
      );
    expect((await call("status", { runId: 42 }))[1]).toMatchObject({
      configured: true,
      run: { state },
    });
  });
});
