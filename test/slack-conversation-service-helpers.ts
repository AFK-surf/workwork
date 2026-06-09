import { EventEmitter } from "node:events";

import fs from "node:fs/promises";

import os from "node:os";

import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";

import { AuthProfileUnavailableError } from "../src/services/agent-runtime/session-auth-profile-runtime.js";

import { SlackConversationService } from "../src/services/slack/slack-conversation-service.js";

import { SlackApiError } from "../src/services/slack/slack-api.js";

import { SessionManager } from "../src/services/session-manager.js";

import { StateStore } from "../src/store/state-store.js";

import type { PersistedAgentTraceEvent, PersistedInboundMessage, SlackSessionRecord } from "../src/types.js";

export const TEST_SESSION: SlackSessionRecord = {
  key: "C123:111.222",
  channelId: "C123",
  rootThreadTs: "111.222",
  workspacePath: "/tmp/workspace",
  agentSessionId: "thread-1",
  activeTurnId: "turn-1",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

export const TEST_CONFIG = {
  slackInitialThreadHistoryCount: 8,
  slackHistoryApiMaxLimit: 50,
  slackActiveTurnReconcileIntervalMs: 15_000,
  slackMissedThreadRecoveryIntervalMs: 15_000,
  adminBaseUrl: "https://admin.example",
  sessionTimelineLinkEnabled: true,
} as AppConfig;

afterEach(() => {
  vi.restoreAllMocks();
});
