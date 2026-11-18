import { readFile } from "node:fs/promises";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { getUpdateSchedule } from "../../infra/update-status-state.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlers } from "./types.js";

const repository = "maplel/openclaw";
const workflow = "/actions/workflows/atlas-sync-stable.yml";
const latestRun = `${workflow}/runs?branch=main&event=workflow_dispatch&per_page=1`;
const tokenFile = "OPENCLAW_ATLAS_SYNC_TOKEN_FILE";
let dispatching = false;

async function getToken() {
  const filename = process.env[tokenFile]?.trim();
  if (!filename) {
    return null;
  }
  try {
    return (await readFile(filename, "utf8")).trim() || null;
  } catch {
    throw new Error("The Gateway could not read the Atlas sync credential file.");
  }
}

async function github(token: string, endpoint: string, body?: object) {
  const response = await fetch(`https://api.github.com/repos/${repository}${endpoint}`, {
    method: body ? "POST" : "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2026-03-10",
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub rejected the Atlas sync request (HTTP ${response.status}).`);
  }
  return asNullableRecord(await response.json());
}

function isRunId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

async function readLatestRun(token: string) {
  const data = await github(token, latestRun);
  if (!Array.isArray(data?.workflow_runs)) {
    throw new Error("GitHub returned an invalid Atlas sync run list.");
  }
  return asNullableRecord(data.workflow_runs[0]);
}

function runUrl(id: number) {
  return `https://github.com/${repository}/actions/runs/${id}`;
}

async function readRunResult(token: string, run: Record<string, unknown>) {
  if (!isRunId(run.id) || typeof run.status !== "string") {
    throw new Error("GitHub returned invalid Atlas sync run details.");
  }
  const url = runUrl(run.id);
  const version =
    typeof run.display_title === "string"
      ? /^Atlas sync (\d+\.\d+\.\d+)$/.exec(run.display_title)?.[1]
      : undefined;
  if (run.status !== "completed") {
    return { id: run.id, state: "running", runUrl: url, version };
  }
  const data = await github(token, `/actions/runs/${run.id}/jobs?filter=latest`);
  if (!Array.isArray(data?.jobs)) {
    throw new Error("GitHub returned invalid Atlas sync job details.");
  }
  const jobs = data.jobs.map(asNullableRecord);
  const prepare = jobs.find((job) => job?.name === "Prepare pull request");
  const verify = jobs.find((job) => job?.name === "Verify candidate");
  const land = jobs.find((job) => job?.name === "Merge pull request");
  const conflict =
    Array.isArray(prepare?.steps) &&
    prepare.steps.some((step: unknown) => {
      const record = asNullableRecord(step);
      return record?.name === "Report merge conflict" && record.conclusion === "failure";
    });
  let state = "failed";
  if (conflict) {
    state = "conflict";
  } else if (verify?.conclusion === "failure") {
    state = "testsFailed";
  } else if (run.conclusion === "success" && land?.conclusion === "success") {
    state = "merged";
  } else if (
    run.conclusion === "success" &&
    prepare?.conclusion === "success" &&
    verify?.conclusion === "skipped" &&
    land?.conclusion === "skipped"
  ) {
    state = "current";
  }
  return { id: run.id, state, runUrl: url, version };
}

export const atlasSyncHandlers: GatewayRequestHandlers = {
  "update.atlasSync.status": async ({ params, respond }) => {
    const runId = params.runId;
    if (runId !== undefined && !isRunId(runId)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Invalid workflow run ID."));
      return;
    }
    try {
      const token = await getToken();
      if (!token) {
        respond(true, { configured: false }, undefined);
        return;
      }
      const run = runId
        ? await github(token, `/actions/runs/${runId}`)
        : await readLatestRun(token);
      if (runId && run?.path !== ".github/workflows/atlas-sync-stable.yml") {
        throw new Error("The selected GitHub run is not an Atlas sync.");
      }
      respond(true, { configured: true, run: run && (await readRunResult(token, run)) }, undefined);
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, (error as Error).message));
    }
  },
  "update.atlasSync.start": async (request) => {
    const { params, respond } = request;
    const schedule = getUpdateSchedule();
    const release = schedule?.officialRelease;
    const version = params.version;
    if (request.context.getRuntimeConfig().update?.auto?.enabled) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Turn off automatic updates to install this sync manually.",
        ),
      );
      return;
    }
    if (
      !schedule?.atlasSource ||
      release?.status !== "pending-sync" ||
      version !== release.latestVersion ||
      typeof version !== "string" ||
      !/^\d+\.\d+\.\d+$/.test(version)
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Refresh the official stable release before syncing.",
        ),
      );
      return;
    }
    if (dispatching) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "An Atlas sync request is already being started."),
      );
      return;
    }
    dispatching = true;
    try {
      const token = await getToken();
      if (!token) {
        throw new Error(`Set ${tokenFile} on the Gateway to connect Atlas to GitHub Actions.`);
      }
      const recent = await readLatestRun(token);
      if (recent && isRunId(recent.id) && recent.status !== "completed") {
        respond(true, await readRunResult(token, recent), undefined);
        return;
      }
      readGatewayRequestMutationAuthority(request).assertCurrent();
      const data = await github(token, `${workflow}/dispatches`, {
        ref: "main",
        inputs: { version },
      });
      if (!isRunId(data?.workflow_run_id)) {
        throw new Error(
          "GitHub did not return an Atlas sync run ID. Check Actions before trying again.",
        );
      }
      respond(
        true,
        {
          id: data.workflow_run_id,
          state: "running",
          runUrl: runUrl(data.workflow_run_id),
          version,
        },
        undefined,
      );
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, (error as Error).message));
    } finally {
      dispatching = false;
    }
  },
};
