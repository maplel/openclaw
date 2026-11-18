import { expect, it, vi, type Mock } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { resolveLeastPrivilegeOperatorScopesForMethod } from "../method-scopes.js";
import {
  directCliClientForTests as directCliClient,
  firstRespondCall,
} from "./send.test-helpers.js";
import {
  makeContext,
  type MessageMethodDriver,
  type MessageMethodPlugins,
} from "./send.test-support.js";

type OwnerSendHarness = Pick<MessageMethodDriver, "runMessageActionRequest"> & {
  mocks: {
    resolveMessageChannelSelection: Mock;
    dispatchChannelMessageAction: Mock;
    deliverOutboundPayloads: Mock;
    appendAssistantMessageToSessionTranscript: Mock;
  };
};

export function registerGatewayNativeOwnerSendTest({
  mocks,
  runMessageActionRequest,
  registerMessageActionPlugin,
}: OwnerSendHarness & Pick<MessageMethodPlugins, "registerMessageActionPlugin">) {
  it("records a CLI send through a native Feishu action with its destination and receipt", async () => {
    const plugin = registerMessageActionPlugin({ id: "feishu" });
    plugin.messaging = { targetResolver: { looksLikeId: () => true, hint: "<chat ID>" } };
    mocks.resolveMessageChannelSelection.mockResolvedValue({ channel: "feishu", plugin });
    const receipt = { ok: true, channel: "feishu", action: "send", messageId: "om-result" };
    mocks.dispatchChannelMessageAction.mockResolvedValueOnce(jsonResult(receipt));
    const history = vi
      .spyOn(
        await import("../../sessions/confirmed-visible-message.js"),
        "commitConfirmedVisibleMessage",
      )
      .mockResolvedValue({ ok: true });
    try {
      const request = {
        channel: "feishu",
        action: "send",
        gatewayOwnsSend: true,
        conversationReadOrigin: "direct-operator",
        agentId: "main",
        accountId: "default",
        senderIsOwner: true,
        idempotencyKey: "feishu-cli-notification",
        params: { target: "chat:oc_owner", message: "request", replyTo: "om-original" },
      };
      const cli = directCliClient();
      const { respond } = await runMessageActionRequest(request, {
        ...cli,
        connect: {
          ...cli.connect,
          scopes: resolveLeastPrivilegeOperatorScopesForMethod("message.action", request),
        },
      });
      expect(firstRespondCall(respond)[2]).toBeUndefined();
      expect(firstRespondCall(respond)[1]).toMatchObject({
        kind: "send",
        handledBy: "plugin",
        payload: receipt,
      });
      expect(mocks.dispatchChannelMessageAction).toHaveBeenCalledOnce();
      expect(mocks.dispatchChannelMessageAction.mock.calls.at(-1)?.[0]).toMatchObject({
        accountId: "default",
        reply: { source: "explicit", replyToId: "om-original" },
        senderIsOwner: false,
      });
      expect(history).toHaveBeenCalledOnce();
      expect(history).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "feishu",
          accountId: "default",
          deliveryId: request.idempotencyKey,
          payload: expect.objectContaining({ text: "request" }),
        }),
      );
    } finally {
      history.mockRestore();
    }
  });
}

export function registerGatewayCoreOwnerSendTests({
  mocks,
  runMessageActionRequest,
  getPlugin,
}: OwnerSendHarness & { getPlugin: () => ChannelPlugin }) {
  it("routes the account default through one canonical gateway send", async () => {
    getPlugin().outbound!.deliveryMode = "gateway";
    const { respond } = await runMessageActionRequest(
      {
        channel: "twitch",
        params: { message: "hello" },
        accountId: "secondary",
      },
      directCliClient(),
    );
    const response = firstRespondCall(respond);
    expect(response[2]).toBeUndefined();
    expect(response[0]).toBe(true);
    expect(response[1]).toMatchObject({
      channel: "twitch",
      to: "secondary-room",
      via: "gateway",
      deliveryStatus: "sent",
      result: { messageId: "core-send" },
    });
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledOnce();
    expect(mocks.deliverOutboundPayloads.mock.calls[0]?.[0]).toMatchObject({
      to: "secondary-room",
      accountId: "secondary",
      payloads: [expect.objectContaining({ text: "hello" })],
    });
    expect(
      mocks.dispatchChannelMessageAction.mock.calls.at(-1)?.[0]?.deliveryRetryOwner,
    ).toBeUndefined();
    expect(mocks.dispatchChannelMessageAction.mock.calls.at(-1)?.[0]?.skipQueue).toBe(false);
    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });

  it("records an operator CLI send at the owner and returns its full command result", async () => {
    mocks.dispatchChannelMessageAction.mockReset().mockResolvedValue(null);
    mocks.deliverOutboundPayloads
      .mockReset()
      .mockResolvedValue([{ channel: "twitch", messageId: "core-send" }]);
    const request = {
      channel: "twitch",
      params: { target: "explicit-room", message: "hello" },
      gatewayOwnsSend: true,
      senderIsOwner: true,
      conversationReadOrigin: "direct-operator",
      idempotencyKey: "operator-owned-send",
    };
    const cli = directCliClient();
    const context = makeContext();
    const scopes = resolveLeastPrivilegeOperatorScopesForMethod("message.action", request);
    expect(scopes).toEqual(["operator.write"]);
    const client = { ...cli, connect: { ...cli.connect, scopes } };
    const send = () => runMessageActionRequest(request, client, context);
    const first = firstRespondCall((await send()).respond);
    expect(first[2]).toBeUndefined();
    expect(first[1]).toMatchObject({
      kind: "send",
      channel: "twitch",
      action: "send",
      handledBy: "core",
      payload: { deliveryStatus: "sent", result: { messageId: "core-send" } },
    });
    expect(mocks.deliverOutboundPayloads.mock.calls[0]?.[0]).toMatchObject({
      skipDestinationHistory: false,
    });
    expect(firstRespondCall((await send()).respond)[1]).toEqual(first[1]);
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledOnce();
  });
}
