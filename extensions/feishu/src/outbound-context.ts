import type { ChannelOutboundAdapter } from "../runtime-api.js";
import { resolveFeishuAccount } from "./accounts.js";
import { bindFeishuExecApprovalReceipt } from "./exec-approval-replies.js";
import { withFeishuSendContext } from "./send-context.js";

export function withFeishuOutboundSendContext(
  adapter: ChannelOutboundAdapter,
): ChannelOutboundAdapter {
  const { sendText, sendMedia, sendPayload } = adapter;
  return {
    ...adapter,
    ...(sendText
      ? { sendText: async (ctx) => withFeishuSendContext(ctx, () => sendText(ctx)) }
      : {}),
    ...(sendMedia
      ? { sendMedia: async (ctx) => withFeishuSendContext(ctx, () => sendMedia(ctx)) }
      : {}),
    ...(sendPayload
      ? {
          sendPayload: async (ctx) =>
            withFeishuSendContext(ctx, async () => {
              const result = await sendPayload(ctx);
              const token = ctx.payload.channelData?.feishuExecApprovalTicket;
              if (token) {
                const accountId = resolveFeishuAccount(ctx).accountId;
                const parts = result.receipt?.parts ?? [];
                for (const part of parts) {
                  const id = part.raw?.meta?.feishuChatId;
                  bindFeishuExecApprovalReceipt(
                    token,
                    ctx.to,
                    accountId,
                    part.platformMessageId,
                    typeof id === "string" ? id : undefined,
                  );
                }
                if (!parts.some((part) => part.platformMessageId === result.messageId)) {
                  bindFeishuExecApprovalReceipt(token, ctx.to, accountId, result.messageId);
                }
              }
              return result;
            }),
        }
      : {}),
  };
}
