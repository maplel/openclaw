import { resolveApprovalOverGateway } from "openclaw/plugin-sdk/approval-gateway-runtime";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it, vi } from "vitest";
import type { FeishuMessageEvent } from "./event-types.js";
import {
  bindFeishuExecApprovalReceipt,
  handleFeishuExecApprovalReply,
  renderFeishuExecApproval,
} from "./exec-approval-replies.js";
import { withFeishuOutboundSendContext } from "./outbound-context.js";
import { buildFeishuPayloadCard } from "./presentation-card.js";
import { toFeishuSendResult } from "./send-result.js";
import { getMessageFeishu } from "./send.js";

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: vi.fn(async ({ decision }) => ({
    applied: true,
    approval: { status: decision === "deny" ? "denied" : "allowed" },
  })),
}));
vi.mock("./send.js", () => ({
  getMessageFeishu: vi.fn(async ({ messageId }) => ({ messageId, chatId: "oc_private" })),
}));
const cfg = {
  commands: { ownerAllowFrom: ["feishu:ou_owner"] },
  channels: { feishu: { allowFrom: ["ou_owner"] } },
};
function render(id: string) {
  return renderFeishuExecApproval({
    cfg,
    request: {
      id,
      createdAtMs: 0,
      expiresAtMs: 30 * 60_000,
      request: {
        command: "pwd",
        reason: "检查目录",
        warningText: "requires approval",
        commandAnalysis: {
          commandCount: 1,
          nestedCommandCount: 0,
          riskKinds: ["inline-eval"],
          warningLines: [],
        },
        allowedDecisions: ["allow-once", "deny"],
      },
    },
    target: { to: "user:ou_owner", accountId: "default" },
    nowMs: 0,
  })!;
}
function reply(parent: string, text = "允许"): FeishuMessageEvent {
  return {
    sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
    message: {
      message_id: "om_answer",
      chat_id: "oc_private",
      chat_type: "p2p",
      parent_id: parent,
      message_type: "text",
      content: JSON.stringify({ text }),
    },
  };
}
describe("owner replies to a forwarded native exec request", () => {
  it("binds the callback to the exact owner DM message even with multiple approvals", async () => {
    for (const id of ["first", "second"]) {
      const prompt = render(id);
      expect(prompt.text).toContain("检查目录");
      expect(prompt.text).toContain("requires approval");
      expect(prompt.text).toContain("pwd");
      const card = JSON.stringify(buildFeishuPayloadCard({ payload: prompt }));
      for (const text of [
        "检查目录",
        "requires approval",
        "解释器",
        "pwd",
        "30 分钟",
        "允许",
        "拒绝",
      ]) {
        expect(card).toContain(text);
      }
      bindFeishuExecApprovalReceipt(
        prompt.channelData.feishuExecApprovalTicket,
        "user:ou_owner",
        "default",
        "om_" + id,
      );
    }
    expect(await handleFeishuExecApprovalReply(cfg, "default", reply("om_second"))).toContain(
      "已允许",
    );
    expect(resolveApprovalOverGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "second",
        approvalKind: "exec",
        decision: "allow-once",
        senderId: "ou_owner",
      }),
    );
    expect(
      await handleFeishuExecApprovalReply(cfg, "default", reply("om_first", "拒绝")),
    ).toContain("已拒绝");
    expect(resolveApprovalOverGateway).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "first", decision: "deny" }),
    );
  });
  it("uses the provider chat receipt for each part and retains the canonical result", async () => {
    const p = render("parts");
    const results = ["om_part_A", "om_part_B"].map((id) =>
      toFeishuSendResult(
        { code: 0, data: { message_id: id, chat_id: "oc_private" } },
        "ou_owner",
        "text",
      ),
    );
    const adapter = withFeishuOutboundSendContext({
      deliveryMode: "direct",
      sendPayload: async () => ({
        channel: "feishu",
        messageId: "om_part_B",
        receipt: createMessageReceiptFromOutboundResults({ results }),
      }),
    });
    await adapter.sendPayload!({ cfg, to: "user:ou_owner", payload: p, text: p.text });
    vi.mocked(getMessageFeishu).mockClear();
    const wrong = reply("om_part_A");
    wrong.message.chat_id = "oc_wrong";
    expect(await handleFeishuExecApprovalReply(cfg, "default", wrong)).toContain("未授权");
    expect(
      await handleFeishuExecApprovalReply(cfg, "default", reply("om_part_B", "拒绝")),
    ).toContain("已拒绝");
    expect(await handleFeishuExecApprovalReply(cfg, "default", reply("om_part_A"))).toContain(
      "已拒绝",
    );
    expect(getMessageFeishu).not.toHaveBeenCalled();
  });
  it("propagates temporary read failures and resolves the same reply on retry", async () => {
    const p = render("retry");
    bindFeishuExecApprovalReceipt(
      p.channelData.feishuExecApprovalTicket,
      "user:ou_owner",
      "default",
      "om_retry",
    );
    vi.mocked(getMessageFeishu).mockRejectedValueOnce(new Error("temporary transport failure"));
    await expect(handleFeishuExecApprovalReply(cfg, "default", reply("om_retry"))).rejects.toThrow(
      "temporary",
    );
    expect(await handleFeishuExecApprovalReply(cfg, "default", reply("om_retry"))).toContain(
      "已允许",
    );
  });
  it("leaves ordinary replies, another account, groups, and a nonowner outside approval resolution", async () => {
    vi.mocked(resolveApprovalOverGateway).mockClear();
    const p = render("scoped");
    bindFeishuExecApprovalReceipt(
      p.channelData.feishuExecApprovalTicket,
      "user:ou_owner",
      "default",
      "om_scoped",
    );
    const group = reply("om_scoped");
    group.message.chat_type = "group";
    const outsider = reply("om_scoped");
    outsider.sender.sender_id.open_id = "ou_other";
    for (const e of [group, outsider, reply("om_random"), reply("om_scoped", "在吗")]) {
      expect(await handleFeishuExecApprovalReply(cfg, "default", e)).toBeUndefined();
    }
    expect(
      await handleFeishuExecApprovalReply(cfg, "secondary", reply("om_scoped")),
    ).toBeUndefined();
    expect(resolveApprovalOverGateway).not.toHaveBeenCalled();
  });
});
