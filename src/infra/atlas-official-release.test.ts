import { afterEach, expect, it, vi } from "vitest";
import { VERSION } from "../version.js";
import { checkAtlasOfficialRelease } from "./atlas-official-release.js";
import { withUpdateInstallStatus } from "./update-install-status.js";

afterEach(() => vi.unstubAllGlobals());

it.each([
  [VERSION, "current"],
  ["2099.1.1", "pending-sync"],
])("reports official %s as %s without admitting an upgrade", async (version, status) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ version }));
  vi.stubGlobal("fetch", fetch);
  const officialRelease = await checkAtlasOfficialRelease(new AbortController().signal);
  expect(fetch.mock.calls[0]?.[0]).toBe("https://registry.npmjs.org/openclaw/latest");
  expect(officialRelease).toMatchObject({ status, latestVersion: version });
  const schedule = withUpdateInstallStatus(
    { channel: "dev", autoEnabled: true },
    { root: null, installKind: "git", packageManager: "pnpm", officialRelease },
    true,
    null,
    null,
  );
  expect(schedule.officialRelease).toEqual(officialRelease);
  expect(schedule.target).toBeUndefined();
  expect(schedule.campaign).toBeUndefined();
});

it("exposes an official registry outage while retaining the Atlas Git target", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("registry offline");
    }),
  );
  const officialRelease = await checkAtlasOfficialRelease(new AbortController().signal);
  expect(officialRelease).toMatchObject({
    status: "unavailable",
    error: expect.stringContaining("registry offline"),
  });
  const target = {
    kind: "git" as const,
    upstreamRef: "refs/remotes/atlas/main",
    upstreamSha: "a".repeat(40),
    commitsBehind: 1,
  };
  const schedule = withUpdateInstallStatus(
    { channel: "dev", autoEnabled: false, target },
    { root: null, installKind: "git", packageManager: "pnpm", officialRelease },
    true,
    null,
    null,
  );
  expect(schedule.target).toEqual(target);
  expect(schedule.officialRelease?.status).toBe("unavailable");
});
