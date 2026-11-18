import { createMemo } from "@solidjs/signals";
import { createSignal, onSettled, Show } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import {
  confirmAndStartUpdate,
  createUpdateProgressWatcher,
} from "../../app/update-confirmation.ts";
import { canReportUpdateFailure } from "../../app/update-failure-report-owner.ts";
import { CONTROL_UI_BUILD_INFO } from "../../build-info.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import {
  projectApplicationConfig,
  projectGateway,
  projectOverlays,
} from "../../lib/reactive/application.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { AtlasSyncControl, UpdatesCommandPresentation } from "./updates-types.ts";
import { Updates } from "./updates.tsx";

type AtlasSyncRun = {
  id: number;
  version?: string;
  sha?: string;
  state: NonNullable<AtlasSyncControl["state"]>;
};
type AtlasSyncStatus = { configured: boolean; run?: AtlasSyncRun | null };

function AtlasSyncBinding(props: { bind: () => () => void }) {
  onSettled(() => props.bind());
  return null;
}

export function UpdatesPage(props: {
  context: ApplicationContext;
  configObject: Record<string, unknown>;
  configBusy: boolean;
  updateBusy: boolean;
  statusRead: Promise<boolean> | null;
  onCheckStatus: () => Promise<boolean>;
  captureCommandPresentation: () => UpdatesCommandPresentation;
  nowMs?: number;
}) {
  const gateway = createMemo(() => projectGateway(props.context.gateway));
  const overlays = createMemo(() => projectOverlays(props.context.overlays));
  const config = createMemo(() => projectApplicationConfig(props.context.config));
  const snapshot = () => gateway().read().snapshot;
  const schedule = () => overlays().read().updateSchedule;
  const clientForSync = createMemo(() =>
    schedule()?.atlasSource &&
    canCallGatewayMethod(snapshot(), "update.atlasSync.status", "operator.admin")
      ? snapshot().client
      : null,
  );
  const release = () => schedule()?.officialRelease;
  const syncVersion = () => {
    const official = release();
    return official?.status === "pending-sync" ||
      (official?.status === "current" && schedule()?.install?.git?.status === "behind")
      ? official.latestVersion
      : undefined;
  };
  const [configured, setConfigured] = createSignal<boolean | undefined>(undefined, {
    ownedWrite: true,
  });
  const [run, setRun] = createSignal<AtlasSyncRun | null>(null, { ownedWrite: true });
  const [starting, setStarting] = createSignal(false, { ownedWrite: true });
  const [error, setError] = createSignal<string | undefined>(undefined, { ownedWrite: true });
  const [statusError, setStatusError] = createSignal<string | undefined>(undefined, {
    ownedWrite: true,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;

  async function refreshAtlasSync(
    client: NonNullable<ReturnType<typeof clientForSync>>,
    owner: number,
    runId?: number,
  ) {
    try {
      const result = await client.request<AtlasSyncStatus>(
        "update.atlasSync.status",
        runId ? { runId } : {},
      );
      if (owner !== generation || clientForSync() !== client) {
        return;
      }
      setConfigured(result.configured);
      setRun(result.run ?? null);
      setStatusError(undefined);
      if (result.run?.state === "running") {
        timer = setTimeout(() => void refreshAtlasSync(client, owner, result.run?.id), 5000);
      }
    } catch (cause) {
      if (owner === generation && clientForSync() === client) {
        setStatusError(String(cause));
        timer = setTimeout(() => void refreshAtlasSync(client, owner, runId), 10_000);
      }
    }
  }

  const bindAtlasSync = (client: NonNullable<ReturnType<typeof clientForSync>>) => {
    clearTimeout(timer);
    const owner = ++generation;
    setConfigured(undefined);
    setRun(null);
    setError(undefined);
    setStatusError(undefined);
    setStarting(false);
    void refreshAtlasSync(client, owner);
    return () => {
      generation++;
      clearTimeout(timer);
    };
  };

  const publishedRelease = () => {
    const published = run();
    const official = release();
    return published?.state === "published" &&
      official &&
      official.status !== "unavailable" &&
      published.version === official.latestVersion
      ? published
      : undefined;
  };
  const publishedTarget = () => {
    const sha = publishedRelease()?.sha;
    const git = schedule()?.install?.git;
    // The publication RPC has already verified the package against live Atlas main.
    // Installation still checks the exact revision and ancestry before activation.
    return sha &&
      git?.currentSha &&
      git.currentSha !== sha &&
      git.status !== "ahead" &&
      git.status !== "diverged"
      ? { kind: "git" as const, upstreamRef: "refs/remotes/atlas/main", upstreamSha: sha }
      : undefined;
  };
  const awaitingPackage = () => syncVersion() !== undefined && !publishedTarget();
  const canStartSync = () =>
    configured() === true &&
    schedule()?.autoEnabled === false &&
    syncVersion() !== undefined &&
    !publishedRelease() &&
    canCallGatewayMethod(snapshot(), "update.atlasSync.start", "operator.admin");

  async function startAtlasSync() {
    const client = clientForSync();
    const version = syncVersion();
    if (!client || !version || !canStartSync() || starting() || run()?.state === "running") {
      return;
    }
    const owner = ++generation;
    clearTimeout(timer);
    setStarting(true);
    setError(undefined);
    try {
      const accepted = await client.request<AtlasSyncRun>("update.atlasSync.start", {
        version,
      });
      if (owner === generation && clientForSync() === client) {
        setRun(accepted);
        void refreshAtlasSync(client, owner, accepted.id);
      }
    } catch (cause) {
      if (owner === generation && clientForSync() === client) {
        setError(String(cause));
        void refreshAtlasSync(client, owner);
      }
    } finally {
      if (owner === generation && clientForSync() === client) {
        setStarting(false);
      }
    }
  }

  return (
    <>
      <Show when={clientForSync()} keyed>
        {(client) => <AtlasSyncBinding bind={() => bindAtlasSync(client)} />}
      </Show>
      <Updates
        update={overlays().read()}
        statusRead={props.statusRead}
        commandScope={snapshot().client ?? props.context.overlays}
        captureCommandPresentation={props.captureCommandPresentation}
        atlasSync={
          clientForSync()
            ? {
                busy: starting() || run()?.state === "running",
                canStart: canStartSync(),
                awaitingPackage: awaitingPackage(),
                readyToInstall: Boolean(publishedTarget()),
                state: run()?.state,
                version: run()?.version,
                detail:
                  error() ??
                  statusError() ??
                  (configured() === false ? t("updates.atlasSync.unconfigured") : undefined) ??
                  (schedule()?.autoEnabled ? t("updates.atlasSync.manualInstall") : undefined),
                runUrl:
                  run() && Number.isSafeInteger(run()?.id) && run()!.id > 0
                    ? `https://github.com/maplel/openclaw/actions/runs/${run()!.id}`
                    : undefined,
                start: () => void startAtlasSync(),
              }
            : undefined
        }
        nativeDeviceSettings={props.context.nativeDeviceSettings}
        configObject={props.configObject}
        gatewayVersion={config().read().serverVersion ?? snapshot().hello?.server?.version ?? null}
        gatewayBuildId={snapshot().hello?.server?.buildId}
        controlUiCommit={CONTROL_UI_BUILD_INFO.commit}
        controlUiCommitAt={CONTROL_UI_BUILD_INFO.commitAt}
        controlUiBuiltAt={CONTROL_UI_BUILD_INFO.builtAt}
        connected={snapshot().phase === "connected"}
        configBusy={props.configBusy}
        canAdmin={hasOperatorAdminAccess(snapshot().hello?.auth ?? null)}
        canUpdate={canCallGatewayMethod(snapshot(), "update.run", "operator.admin")}
        canCheckStatus={canCallGatewayMethod(snapshot(), "update.status", "operator.admin")}
        canHoldUpdate={canCallGatewayMethod(snapshot(), "update.hold", "operator.admin")}
        canReport={canReportUpdateFailure(snapshot())}
        canDiagnose={canCallGatewayMethod(snapshot(), "openclaw.chat", "operator.admin")}
        updateBusy={props.updateBusy}
        nowMs={props.nowMs}
        onChannelChange={(channel) =>
          props.context.runtimeConfig.patchForm(["update", "channel"], channel)
        }
        onUpdateChecksChange={(enabled) =>
          props.context.runtimeConfig.patchForm(["update", "checkOnStart"], enabled)
        }
        onAutomaticUpdatesChange={(enabled) =>
          props.context.runtimeConfig.patchForm(["update", "auto", "enabled"], enabled)
        }
        onUpdateNow={async () => {
          if (clientForSync() && awaitingPackage()) {
            return;
          }
          const context = props.context;
          const update = overlays().read();
          const target = publishedTarget();
          return confirmAndStartUpdate({
            isCurrentTarget: context.overlays.captureUpdateTarget(),
            startGatewayUpdate: () => void context.overlays.runUpdate(target),
            // The dialog outlives this page, so read live snapshots after each change.
            watchUpdateProgress: createUpdateProgressWatcher(context),
            onCheckStatus: () => context.overlays.refreshUpdateStatus(),
            onAcknowledge: () => context.overlays.acknowledgeUpdateRun(),
            updateAvailable: update.updateAvailable,
            updateSchedule: update.updateSchedule,
            startOnOpen: Boolean(target),
            // Keep Gateway routing: this row has no native-decline listener.
            viaNativeApp: false,
          });
        }}
        onHoldUpdate={() => props.context.overlays.holdUpdate()}
        onCheckStatus={() => props.onCheckStatus()}
        onReportFailure={(attemptId) => props.context.overlays.reportUpdateFailure(attemptId)}
        onDiagnoseFailure={(attemptId) => props.context.overlays.diagnoseUpdateFailure(attemptId)}
      />
    </>
  );
}
