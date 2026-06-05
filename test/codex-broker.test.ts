import { describe, expect, it } from "vitest";

import { isRecoverableCodexConnectionError, resolveFinAgentName } from "../src/services/codex/codex-broker.js";

describe("codex broker", () => {
  it("treats EPIPE websocket writes as recoverable connection failures", () => {
    expect(isRecoverableCodexConnectionError(new Error("write EPIPE"))).toBe(true);
  });

  it("maps Slack channels to Fin agent names", () => {
    expect(
      resolveFinAgentName({
        platform: "slack",
        conversationId: "C123",
        channelId: "C123",
      }),
    ).toBe("slack_C123");
  });

  it("maps Feishu groups to Fin agent names", () => {
    expect(
      resolveFinAgentName({
        platform: "feishu",
        conversationId: "oc_7eeff913ec2e1e2674f05ce42a1c3624",
        channelId: "oc_7eeff913ec2e1e2674f05ce42a1c3624",
      }),
    ).toBe("feishu_oc_7eeff913ec2e1e2674f05ce42a1c3624");
  });

  it("keeps long Fin agent names valid and stable", () => {
    const agentName = resolveFinAgentName({
      platform: "feishu",
      conversationId: `oc_${"x".repeat(160)}`,
      channelId: `oc_${"x".repeat(160)}`,
    });

    expect(agentName).toMatch(/^feishu_oc_x+_[a-f0-9]{12}$/u);
    expect(agentName.length).toBeLessThanOrEqual(80);
  });
});
