import { describe, expect, it } from "vitest";

import { createSessionPageLinkMessage } from "../src/services/chat/session-page-link-message.js";
import type { SlackSessionRecord } from "../src/types.js";

const session: SlackSessionRecord = {
  key: "C123:111.222",
  channelId: "C123",
  rootThreadTs: "111.222",
  workspacePath: "/tmp/workspace",
  createdAt: "2026-06-09T00:00:00.000Z",
  updatedAt: "2026-06-09T00:00:00.000Z",
};

describe("session page link message", () => {
  it("hides the session timeline CTA unless enabled", () => {
    const hidden = createSessionPageLinkMessage({
      adminBaseUrl: "https://admin.example",
      session,
      style: "slack_mrkdwn",
    });
    const visible = createSessionPageLinkMessage({
      adminBaseUrl: "https://admin.example",
      session,
      style: "slack_mrkdwn",
      showSessionTimelineLink: true,
    });

    expect(hidden.text).not.toContain("查看会话活动时间线");
    expect(hidden.showSessionTimelineLink).toBe(false);
    expect(visible.text).toBe("<https://admin.example/admin/sessions/C123%3A111.222|查看会话活动时间线>");
    expect(visible.showSessionTimelineLink).toBe(true);
  });
});
