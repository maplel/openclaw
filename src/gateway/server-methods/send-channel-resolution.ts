import {
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  selectApplicableRuntimeConfig,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveOutboundChannelPlugin } from "../../infra/outbound/channel-resolution.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import { resolveImplicitMessageActionTarget } from "../../infra/outbound/message-action-normalization.js";
import { actionHasTarget } from "../../infra/outbound/message-action-spec.js";
import { resolveOutboundTarget } from "../../infra/outbound/targets.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import { respondError } from "./response.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

export async function resolveRequestedChannel(params: {
  requestChannel: unknown;
  unsupportedMessage: (input: string) => string;
  context: GatewayRequestContext;
  config?: OpenClawConfig;
  rejectWebchatAsInternalOnly?: boolean;
}) {
  const channelInput = readStringValue(params.requestChannel);
  const normalizedChannel = channelInput ? normalizeMessageChannel(channelInput) : undefined;
  if (params.rejectWebchatAsInternalOnly && normalizedChannel === INTERNAL_MESSAGE_CHANNEL) {
    return {
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "unsupported channel: webchat (internal-only). Use `chat.send` for WebChat UI messages or choose a deliverable channel.",
      ),
    };
  }
  if (channelInput && !normalizedChannel) {
    return {
      error: errorShape(ErrorCodes.INVALID_REQUEST, params.unsupportedMessage(channelInput)),
    };
  }
  const cfg = params.config ?? params.context.getRuntimeConfig();
  let channel = normalizedChannel;
  if (!channel) {
    try {
      channel = (await resolveMessageChannelSelection({ cfg })).channel;
    } catch (err) {
      return { error: errorShape(ErrorCodes.INVALID_REQUEST, String(err)) };
    }
  }
  return { cfg, channel };
}

export async function resolveGatewayOutboundTarget(params: {
  channel: string;
  to: string;
  cfg: OpenClawConfig;
  accountId?: string;
}) {
  const resolved = await resolveOutboundTarget({
    ...params,
    mode: "explicit",
  });
  if (!resolved.ok) {
    return {
      ok: false as const,
      error: errorShape(ErrorCodes.INVALID_REQUEST, String(resolved.error)),
    };
  }
  return { ok: true as const, to: resolved.to };
}

export function resolveMessageActionRuntimeConfig(cfg: OpenClawConfig): OpenClawConfig {
  const runtimeConfig = getRuntimeConfigSnapshot();
  const runtimeSourceConfig = getRuntimeConfigSourceSnapshot();
  if (!runtimeConfig || !runtimeSourceConfig) {
    return cfg;
  }
  // Message actions must use the hot runtime snapshot when it matches the caller's source config.
  return (
    selectApplicableRuntimeConfig({ inputConfig: cfg, runtimeConfig, runtimeSourceConfig }) ?? cfg
  );
}

export async function resolveGatewayActionChannel({
  requestChannel,
  action,
  config,
  context,
  respond,
}: {
  requestChannel: unknown;
  action: string;
  config?: OpenClawConfig;
  context: GatewayRequestContext;
  respond: RespondFn;
}) {
  const resolved = await resolveRequestedChannel({
    requestChannel,
    unsupportedMessage: (input) => `unsupported channel: ${input}`,
    context,
    config,
    rejectWebchatAsInternalOnly: true,
  });
  if ("error" in resolved) {
    respond(false, undefined, resolved.error);
    return undefined;
  }
  const { cfg: selectedCfg, channel } = resolved;
  const cfg = config ?? resolveMessageActionRuntimeConfig(selectedCfg);
  const plugin = resolveOutboundChannelPlugin({ channel, cfg });
  const canonicalAction =
    ((action === "send" && Boolean(plugin?.message?.send?.text || plugin?.outbound?.sendText)) ||
      (action === "poll" && Boolean(plugin?.outbound?.sendPoll))) &&
    (!plugin?.actions?.handleAction || plugin.actions.supportsAction?.({ action }) === false);
  if (!plugin || (!plugin.actions?.handleAction && !canonicalAction)) {
    respondError(
      respond,
      ErrorCodes.INVALID_REQUEST,
      `Channel ${channel} does not support action ${action}.`,
    );
    return undefined;
  }
  return { cfg, channel, plugin, canonicalAction };
}

export async function applyGatewaySendDefaultTarget({
  actionParams,
  toolContext,
  channel,
  plugin,
  cfg,
  accountId,
}: {
  actionParams: Record<string, unknown>;
  toolContext: Parameters<typeof resolveImplicitMessageActionTarget>[0];
  channel: string;
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId?: string;
}): Promise<void> {
  if (
    normalizeOptionalString(actionParams.target) ||
    actionHasTarget("send", actionParams, {
      channel,
      aliasSpec: plugin.actions?.messageActionTargetAliases?.send ?? null,
    }) ||
    resolveImplicitMessageActionTarget(toolContext)
  ) {
    return;
  }
  // Native sends can use account defaults without an explicit target.
  const target = await resolveOutboundTarget({ channel, plugin, cfg, accountId });
  if (!target.ok) {
    throw target.error;
  }
  actionParams.to = target.to;
}
