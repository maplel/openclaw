/* @vitest-environment jsdom */
import { beforeEach, expect, it, vi } from "vitest";
import type { UpdateScheduleState } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import { createUpdatesViewDom, createUpdatesViewProps } from "./updates.test-support.ts";

beforeEach(async () => {
  await i18n.setLocale("en");
});

it("links failed sync runs and enables board installation once an ARM64 package is published", () => {
  const updateSchedule: UpdateScheduleState = {
    channel: "dev",
    autoEnabled: false,
    atlasSource: { repositoryUrl: "https://github.com/maplel/openclaw", branch: "main" },
    install: { kind: "git", git: { status: "current" } },
    officialRelease: {
      status: "pending-sync",
      currentVersion: "2026.11.2",
      latestVersion: "2026.11.5",
      checkedAtMs: 1000,
    },
  };
  const start = vi.fn();
  const install = vi.fn(async () => {});
  const runUrl = "https://github.com/maplel/openclaw/actions/runs/42";
  const { mountUpdates, row } = createUpdatesViewDom();
  mountUpdates(
    createUpdatesViewProps({
      update: { updateSchedule },
      atlasSync: {
        busy: false,
        canStart: true,
        state: "conflict",
        awaitingPackage: true,
        runUrl,
        start,
      },
      onUpdateNow: install,
    }),
  );
  const official = row("Official stable release");
  expect(official.textContent).toContain("Merge conflict");
  expect(official.querySelector("a")?.href).toBe(runUrl);
  official.querySelector("button")!.click();
  expect(start).toHaveBeenCalledOnce();
  expect(install).not.toHaveBeenCalled();
  expect(row("Update Gateway…").querySelector("button")!.disabled).toBe(true);
  mountUpdates(
    createUpdatesViewProps({
      update: { updateSchedule },
      atlasSync: {
        busy: false,
        canStart: false,
        state: "published",
        readyToInstall: true,
        runUrl,
        start,
      },
      onUpdateNow: install,
    }),
  );
  expect(row("Official stable release").textContent).toContain("Ready to install");
  row("Update Gateway…").querySelector("button")!.click();
  expect(install).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledOnce();
  mountUpdates(
    createUpdatesViewProps({
      update: {
        updateSchedule,
        updateStatusRefreshing: true,
        updateStatusBanner: { tone: "danger", text: "Installation failed" },
      },
      atlasSync: {
        busy: false,
        canStart: false,
        state: "published",
        version: "2026.11.5",
        readyToInstall: true,
        start,
      },
    }),
  );
  expect(row("Status").textContent).toContain("Installation failed");
});

it("renders official pending-sync as information without changing the Atlas upgrade action", () => {
  const updateSchedule: UpdateScheduleState = {
    channel: "dev",
    autoEnabled: false,
    atlasSource: { repositoryUrl: "https://github.com/maplel/openclaw", branch: "main" },
    install: { kind: "git", git: { status: "current" } },
    officialRelease: {
      status: "pending-sync",
      currentVersion: "2026.11.2",
      latestVersion: "2099.1.1",
      checkedAtMs: 1000,
    },
  };
  const { mountUpdates, row } = createUpdatesViewDom();
  mountUpdates(
    createUpdatesViewProps({
      update: { updateSchedule: { ...updateSchedule, officialRelease: undefined } },
    }),
  );
  const wasDisabled = row("Update Gateway…").querySelector("button")!.disabled;
  mountUpdates(createUpdatesViewProps({ update: { updateSchedule } }));
  expect(row("Official stable release").textContent).toContain(
    "2099.1.1 · Newer than installed Atlas",
  );
  expect(row("Atlas repository").textContent).toContain("maplel/openclaw · main");
  expect(row("Update Gateway…").querySelector("button")!.disabled).toBe(wasDisabled);
  expect(updateSchedule?.target).toBeUndefined();
});
