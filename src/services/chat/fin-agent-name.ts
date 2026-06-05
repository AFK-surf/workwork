import { createHash } from "node:crypto";

import type { SlackSessionRecord } from "../../types.js";

export function resolveFinAgentName(session: Pick<SlackSessionRecord, "platform" | "conversationId" | "channelId">): string {
  const platform = session.platform ?? "slack";
  const conversationId = session.conversationId ?? session.channelId;
  const prefix = `${platform}_`;
  const sanitized = conversationId.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "conversation";
  const candidate = `${prefix}${sanitized}`;
  if (candidate.length <= 80 && /^[a-zA-Z0-9_-]+$/u.test(candidate)) {
    return candidate;
  }

  const digest = createHash("sha256").update(`${platform}:${conversationId}`).digest("hex").slice(0, 12);
  const maxStemLength = Math.max(1, 80 - prefix.length - digest.length - 1);
  return `${prefix}${sanitized.slice(0, maxStemLength)}_${digest}`;
}
