/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { expect, it } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import type { RequestFn } from "../../app/overlays-access.test-support.ts";
import { createApplicationOverlays } from "../../app/overlays.ts";
import { updateRunHarness } from "../../app/update-run.test-support.ts";
import { i18n } from "../../i18n/index.ts";
import { createModalDialogTestFixture } from "../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { UpdatesPage } from "./updates-page.tsx";
import { createUpdatesViewProps } from "./updates.test-support.ts";

it.each(["current", "unavailable"] as const)(
  "installs the verified Atlas release when the Git status check reports %s",
  async (gitStatus) => {
    await i18n.setLocale("en");
    const dialog = createModalDialogTestFixture();
    const currentSha = "a".repeat(40);
    const publishedSha = "b".repeat(40);
    const pendingCheckout = Promise.withResolvers<unknown>();
    const replies: Record<string, unknown> = {
      "update.status": {
        schedule: {
          channel: "dev",
          autoEnabled: false,
          atlasSource: { repositoryUrl: "https://github.com/maplel/openclaw", branch: "main" },
          install: {
            kind: "git",
            git:
              gitStatus === "current"
                ? { status: gitStatus, currentSha, upstreamSha: currentSha }
                : { status: gitStatus, currentSha, reason: "fetch-failed" },
          },
          officialRelease: {
            status: "pending-sync",
            currentVersion: "2026.11.2",
            latestVersion: "2026.11.5",
            checkedAtMs: 1000,
          },
        },
      },
      "update.atlasSync.status": {
        configured: true,
        run: { id: 42, state: "published", version: "2026.11.5", sha: publishedSha },
      },
      "update.run": {},
    };
    const request = dialog.mockRequest<Parameters<RequestFn>, unknown>((method, params) =>
      method === "update.status" && params?.refreshCheckout
        ? pendingCheckout.promise
        : Promise.resolve(replies[method] ?? {}),
    );
    const harness = updateRunHarness(request);
    harness.update({
      hello: {
        ...harness.gateway.snapshot.hello!,
        features: {
          methods: [
            "update.run",
            "update.status",
            "update.atlasSync.status",
            "update.atlasSync.start",
          ],
        },
      },
    });
    const overlays = createApplicationOverlays(harness.gateway);
    const context = {
      gateway: harness.gateway,
      overlays,
      config: { current: { serverVersion: "2026.11.2" }, subscribe: () => () => undefined },
      nativeDeviceSettings: null,
    } as unknown as ApplicationContext;
    const statusRead = overlays.refreshUpdateStatus();
    const mounted = mountSolid(() =>
      createComponent(UpdatesPage, {
        ...createUpdatesViewProps({ configObject: {} }),
        context,
        statusRead,
        onCheckStatus: () => overlays.refreshUpdateStatus(),
      }),
    );
    try {
      await dialog.waitFor(() =>
        expect(mounted.container.textContent).toContain("Ready to install"),
      );
      flush();
      expect(
        mounted.getByRole<HTMLButtonElement>("button", { name: "Sync and publish" }).disabled,
      ).toBe(true);
      const install = mounted.getByRole<HTMLButtonElement>("button", { name: "Update Gateway…" });
      expect(install.disabled).toBe(false);
      expect(mounted.container.textContent).not.toContain("Checking for updates");
      expect(
        request.mock.calls.filter(
          ([method, params]) => method === "update.status" && params?.refreshCheckout,
        ),
      ).toHaveLength(1);
      install.click();
      await dialog.waitFor(() =>
        expect(request.mock.calls).toContainEqual([
          "update.run",
          expect.objectContaining({
            target: {
              kind: "git",
              upstreamRef: "refs/remotes/atlas/main",
              upstreamSha: publishedSha,
            },
          }),
          expect.anything(),
        ]),
      );
    } finally {
      pendingCheckout.resolve(replies["update.status"]);
      await statusRead;
      mounted.unmount();
      await dialog.cleanup();
      overlays.dispose();
    }
  },
);
