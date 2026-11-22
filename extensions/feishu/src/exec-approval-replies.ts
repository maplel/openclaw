import { randomUUID } from "node:crypto";
import type { resolveApprovalOverGateway } from "openclaw/plugin-sdk/approval-gateway-runtime";
import {
  buildTypedExecApprovalPendingReplyPayload,
  formatFencedCodeBlock,
  resolveExecApprovalCommandDisplay,
  resolveExecApprovalRequestAllowedDecisions,
} from "openclaw/plugin-sdk/approval-reply-runtime";
import type { ExecApprovalRequest } from "openclaw/plugin-sdk/approval-runtime";
import { isApprovalNotFoundError } from "openclaw/plugin-sdk/error-runtime";
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuAccount } from "./accounts.js";
import { feishuApprovalAuth } from "./approval-auth.js";
import { DEDUP_TTL_MS } from "./dedup-state.js";
import type { FeishuMessageEvent } from "./event-types.js";
import { normalizeFeishuTarget } from "./targets.js";

type Binding = {
  approvalId: string;
  accountId: string;
  owner: string;
  decisions: readonly string[];
  messageIds: Map<string, string | undefined>;
  terminalReply?: string;
};
export type FeishuExecApprovalGatewayRuntime = NonNullable<
  Parameters<typeof resolveApprovalOverGateway>[0]["gatewayRuntime"]
>;

// Renderer, outbound transport and receive handler can be separate plugin entry modules.
// Native exec approval IDs are owned by this Gateway process and expire with it.
const state = globalThis as typeof globalThis & {
  __openclawFeishuExecApprovalReplies?: {
    tickets: Map<string, Binding>;
    messages: Map<string, Binding>;
  };
};
const receipts = (state.__openclawFeishuExecApprovalReplies ??= {
  tickets: new Map(),
  messages: new Map(),
});

function explicitOwner(cfg: ClawdbotConfig, id: string) {
  return (
    id.startsWith("ou_") &&
    cfg.commands?.ownerAllowFrom?.some(
      (entry) => typeof entry === "string" && (entry === id || entry === `feishu:${id}`),
    )
  );
}

export function renderFeishuExecApproval(params: {
  cfg: ClawdbotConfig;
  request: ExecApprovalRequest;
  target: { to: string; accountId?: string | null };
  nowMs: number;
}) {
  const { cfg, request, target, nowMs } = params;
  const owner = normalizeFeishuTarget(target.to);
  if (!owner || !explicitOwner(cfg, owner)) return null;
  const accountId = resolveFeishuAccount({ cfg, accountId: target.accountId }).accountId;
  const details = request.request;
  const decisions = resolveExecApprovalRequestAllowedDecisions(details);
  const token = randomUUID();
  const bound: Binding = {
    approvalId: request.id,
    accountId,
    owner,
    decisions,
    messageIds: new Map(),
  };
  receipts.tickets.set(token, bound);
  setTimeout(
    () => {
      receipts.tickets.delete(token);
      bound.terminalReply ??= "本条消息已超过审批截止时间。";
      const cleanup = setTimeout(() => {
        for (const id of bound.messageIds.keys()) receipts.messages.delete(id);
      }, DEDUP_TTL_MS);
      cleanup.unref();
    },
    Math.max(0, request.expiresAtMs - nowMs),
  ).unref();
  const payload = buildTypedExecApprovalPendingReplyPayload({
    approvalId: request.id,
    approvalSlug: request.id.slice(0, 8),
    approvalCommandId: request.id,
    command: resolveExecApprovalCommandDisplay(details).commandText,
    cwd: details.cwd ?? undefined,
    warningText: details.warningText ?? undefined,
    host: details.host === "node" ? "node" : "gateway",
    scope: details.scope,
    agentId: details.agentId,
    ask: details.ask,
    sessionKey: details.sessionKey,
    allowedDecisions: decisions,
    nodeId: details.nodeId ?? undefined,
    expiresAtMs: request.expiresAtMs,
    nowMs,
  });
  const choices = [
    decisions.includes("allow-once") && "允许",
    decisions.includes("deny") && "拒绝",
  ].filter(Boolean);
  const reason = details.reason?.trim();
  const command = resolveExecApprovalCommandDisplay(details).commandText;
  const durationMinutes = Math.ceil((request.expiresAtMs - request.createdAtMs) / 60_000);
  const deadline = new Date(request.expiresAtMs).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: cfg.agents?.defaults?.userTimezone,
    hour12: false,
    timeZoneName: "short",
  });
  return {
    ...payload,
    text: [
      "OpenClaw 请求执行命令",
      reason && `操作目的：${reason}`,
      `授权原因：${details.warningText?.trim() || (details.ask === "always" ? "当前执行策略要求每次操作都由人工确认。" : "当前执行策略要求人工批准此操作。")}`,
      (details.ask || details.security) &&
        `策略配置：${[details.ask && "ask=" + details.ask, details.security && "security=" + details.security].filter(Boolean).join("，")}`,
      details.commandAnalysis?.riskKinds.includes("inline-eval") &&
        "此命令会让解释器直接执行命令行参数中的代码，请核对完整代码后再决定。",
      ...(details.commandAnalysis?.warningLines ?? []),
      `执行命令：\n${formatFencedCodeBlock(command, "sh")}`,
      details.cwd && `工作目录：${details.cwd}`,
      details.host && `执行位置：${details.host}${details.nodeId ? " · " + details.nodeId : ""}`,
      details.envKeys?.length && `涉及环境变量：${details.envKeys.join("、")}`,
      details.scope && `授权范围：${JSON.stringify(details.scope)}`,
      `有效期：${durationMinutes} 分钟，截止 ${deadline}`,
      choices.length && `请直接回复本条消息「${choices.join("」或「")}」。`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    channelData: { ...payload.channelData, feishuExecApprovalTicket: token },
  };
}

export function bindFeishuExecApprovalReceipt(
  token: unknown,
  to: string,
  accountId: string,
  messageId: string,
  providerChatId?: string,
) {
  const binding = typeof token === "string" ? receipts.tickets.get(token) : undefined;
  if (
    !binding ||
    !messageId ||
    binding.accountId !== accountId ||
    normalizeFeishuTarget(to) !== binding.owner
  )
    return;
  binding.messageIds.set(messageId, providerChatId);
  receipts.messages.set(messageId, binding);
}

export function feishuExecApprovalReplyLane(
  accountId: string,
  parentId: unknown,
  sender: unknown,
  chatType: unknown,
  messageType: unknown,
  content: unknown,
  claimedLaneKey?: string,
) {
  if (
    typeof parentId !== "string" ||
    typeof sender !== "string" ||
    messageType !== "text" ||
    (chatType !== "p2p" && chatType !== "private") ||
    typeof content !== "string"
  )
    return;
  let text: unknown;
  try {
    text = JSON.parse(content)?.text;
  } catch {
    return;
  }
  if (text !== "允许" && text !== "拒绝") return;
  const lane = `exec-approval:${parentId}`;
  // A previously admitted row keeps its physical ordering key through plugin or Gateway restart.
  // Authorization is checked separately against the live receipt in the receive handler.
  if (claimedLaneKey !== undefined) return claimedLaneKey === lane ? lane : undefined;
  const binding = receipts.messages.get(parentId);
  if (binding?.accountId === accountId && binding.owner === sender) return lane;
  return undefined;
}

export async function handleFeishuExecApprovalReply(
  cfg: ClawdbotConfig,
  accountId: string,
  event: FeishuMessageEvent,
  gatewayRuntime?: FeishuExecApprovalGatewayRuntime,
) {
  const m = event.message;
  if (
    !m.parent_id ||
    (m.chat_type !== "p2p" && m.chat_type !== "private") ||
    m.message_type !== "text"
  )
    return;
  const b = receipts.messages.get(m.parent_id);
  const sender = event.sender.sender_id.open_id;
  if (
    !b ||
    !sender ||
    b.owner !== sender ||
    b.accountId !== accountId ||
    !explicitOwner(cfg, sender)
  )
    return;
  if (event.sender.sender_type && event.sender.sender_type !== "user") return;
  let body: unknown;
  try {
    body = (JSON.parse(m.content) as { text?: unknown }).text;
  } catch {
    return;
  }
  const decision = body === "允许" ? "allow-once" : body === "拒绝" ? "deny" : undefined;
  if (!decision) return;
  if (!b.decisions.includes(decision)) return "本次请求未提供该选项。";
  const auth = feishuApprovalAuth.authorizeActorAction({
    cfg,
    accountId,
    senderId: sender,
    action: "approve",
    approvalKind: "exec",
  });
  if (!auth.authorized) return auth.reason ?? "此账号无权审批。";
  let chatId = b.messageIds.get(m.parent_id);
  if (!chatId) {
    const { getMessageFeishu } = await import("./send.js");
    const original = await getMessageFeishu({
      cfg,
      accountId,
      messageId: m.parent_id,
      throwOnError: true,
    });
    if (original?.messageId === m.parent_id && original.chatId) {
      chatId = original.chatId;
      b.messageIds.set(m.parent_id, chatId);
    }
  }
  if (!chatId || chatId !== m.chat_id) {
    return "无法核对本私聊中的审批原消息，本次回复未授权执行。";
  }
  if (b.terminalReply) return b.terminalReply;
  try {
    const { resolveApprovalOverGateway } =
      await import("openclaw/plugin-sdk/approval-gateway-runtime");
    const { approval } = await resolveApprovalOverGateway({
      cfg,
      approvalKind: "exec",
      approvalId: b.approvalId,
      decision,
      channel: "feishu",
      accountId,
      senderId: sender,
      gatewayRuntime,
    });
    switch (approval.status) {
      case "allowed":
        b.terminalReply = "已允许本次执行。";
        break;
      case "denied":
        b.terminalReply = "已拒绝本次执行。";
        break;
      case "expired":
        b.terminalReply = "本次审批已过期。";
        break;
      case "cancelled":
        b.terminalReply = "本次审批已取消。";
        break;
    }
    return b.terminalReply;
  } catch (error) {
    if (isApprovalNotFoundError(error)) return "本次审批已结束。";
    throw error;
  }
}

export const feishuExecApprovalCapability = {
  ...feishuApprovalAuth,
  render: { exec: { buildPendingPayload: renderFeishuExecApproval } },
};
