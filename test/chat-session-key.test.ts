import path from "node:path";

import { describe, expect, it } from "vitest";

import { createChatSessionKey, createChatWorkspacePath, decodeSessionKeyPart, encodeSessionKeyPart } from "../src/services/chat/chat-session-key.js";

describe("chat session keys", () => {
  it("creates stable platform-scoped keys for Slack and Feishu coordinates", () => {
    expect(
      createChatSessionKey({
        platform: "slack",
        conversationId: "C123",
        rootMessageId: "111.222",
      }),
    ).toBe("slack:QzEyMw:MTExLjIyMg");

    expect(
      createChatSessionKey({
        platform: "feishu",
        conversationId: "oc_abc/unsafe",
        rootMessageId: "om_root:123",
      }),
    ).toBe("feishu:b2NfYWJjL3Vuc2FmZQ:b21fcm9vdDoxMjM");
  });

  it("round-trips encoded key parts", () => {
    const raw = "oc_abc/unsafe:中文";
    expect(decodeSessionKeyPart(encodeSessionKeyPart(raw))).toBe(raw);
  });

  it("creates readable workspace directories without unsafe path characters", () => {
    expect(
      createChatWorkspacePath("/tmp/sessions", {
        platform: "feishu",
        conversationId: "oc_abc/unsafe",
        rootMessageId: "om_root:123",
      }),
    ).toBe(path.join("/tmp/sessions", "feishu-oc-abc-unsafe-om-root-123", "workspace"));
  });
});
