import { Show } from "solid-js";
import type { UpdateScheduleState } from "../../api/types.ts";
import { SettingsRow, SettingsValue } from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import type { AtlasSyncControl } from "./updates-types.ts";

registerEnglishCatalog(registerSettingsEnglish);

function formatOfficialReleaseLabel(official: NonNullable<UpdateScheduleState["officialRelease"]>) {
  return official.status === "unavailable"
    ? t("updates.officialUnavailable", { error: official.error })
    : t(
        official.status === "pending-sync"
          ? "updates.officialPendingSync"
          : "updates.officialCurrent",
        { version: official.latestVersion },
      );
}

export function AtlasOfficialReleaseRow(props: {
  official: UpdateScheduleState["officialRelease"];
  sync?: AtlasSyncControl;
  updateBusy: boolean;
}) {
  return (
    <Show when={props.official}>
      {(official) => (
        <SettingsRow
          title={t("updates.officialStable")}
          description={t(props.sync ? "updates.atlasSync.hint" : "updates.officialHint")}
          control={
            <div>
              <SettingsValue value={formatOfficialReleaseLabel(official())} />
              <Show when={props.sync}>
                {(sync) => (
                  <div>
                    <button
                      type="button"
                      class="btn primary"
                      disabled={!sync().canStart || sync().busy || props.updateBusy}
                      onClick={() => sync().start()}
                    >
                      {t("updates.atlasSync.start")}
                    </button>
                    <div role="status">
                      <Show when={sync().state}>
                        {(state) => (
                          <div>
                            {sync().version ? `${sync().version} · ` : ""}
                            {t(`updates.atlasSync.${state()}`)}
                          </div>
                        )}
                      </Show>
                      <Show when={sync().detail}>{(detail) => <div>{detail()}</div>}</Show>
                    </div>
                    <Show when={sync().runUrl}>
                      {(url) => (
                        <a href={url()} target="_blank" rel="noopener noreferrer">
                          {t("updates.atlasSync.run")}
                        </a>
                      )}
                    </Show>
                  </div>
                )}
              </Show>
            </div>
          }
        />
      )}
    </Show>
  );
}
