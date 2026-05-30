import http from "node:http";

import { URL } from "node:url";

import type { AppConfig } from "../config.js";

import { logger } from "../logger.js";

import type { SlackAgentBridge } from "../services/slack/slack-agent-bridge.js";

import { readBoolean, readJsonBody, readFormBody, readString, respondJson } from "./common.js";

import {
  LEGACY_COAUTHOR_MAPPING_ERROR,
  handleSlackResumePendingSessionRequest,
  handleSlackResetSessionRequest,
  handleSlackDeleteSessionRequest,
  handleSlackThreadHistoryRequest,
  handleSlackReplayThreadMessageRequest,
  handleSlackPostMessageRequest,
  handleSlackPostStateRequest,
  handleSlackPostFileRequest,
  handleResolveCommitCoauthorsRequest,
  handleResolveGitHubTokenRequest,
  handleGetCommitCoauthorStatusRequest,
  handleConfigureCommitCoauthorsRequest,
  normalizeStringArray,
  matchResumeSessionPath,
  matchResetSessionPath,
  matchDeleteSessionPath,
  normalizeMappings,
} from "./slack-routes-helpers.js";

export async function handleSlackRequest(
  method: string,
  url: URL,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: {
    readonly bridge: SlackAgentBridge;
    readonly config: AppConfig;
  },
): Promise<boolean> {
  if (method === "GET" && url.pathname === "/slack/thread-history") {
    await handleSlackThreadHistoryRequest(url, response, options);
    return true;
  }

  if (method === "GET" && url.pathname === "/slack/replay-thread-message") {
    await handleSlackReplayThreadMessageRequest(url, response, options);
    return true;
  }

  const matchedResumeSession = matchResumeSessionPath(url.pathname);
  if (method === "POST" && matchedResumeSession) {
    await handleSlackResumePendingSessionRequest(response, options, matchedResumeSession.sessionKey);
    return true;
  }

  const matchedResetSession = matchResetSessionPath(url.pathname);
  if (method === "POST" && matchedResetSession) {
    await handleSlackResetSessionRequest(response, options, matchedResetSession.sessionKey);
    return true;
  }

  const matchedDeleteSession = matchDeleteSessionPath(url.pathname);
  if (method === "DELETE" && matchedDeleteSession) {
    await handleSlackDeleteSessionRequest(response, options, matchedDeleteSession.sessionKey);
    return true;
  }

  if (method === "POST" && url.pathname === "/slack/post-message") {
    await handleSlackPostMessageRequest(request, response, options);
    return true;
  }

  if (method === "POST" && url.pathname === "/slack/post-state") {
    await handleSlackPostStateRequest(request, response, options);
    return true;
  }

  if (method === "POST" && url.pathname === "/slack/post-file") {
    await handleSlackPostFileRequest(request, response, options);
    return true;
  }

  if (method === "POST" && url.pathname === "/slack/git-coauthors/resolve-commit-message") {
    await handleResolveCommitCoauthorsRequest(request, response, options);
    return true;
  }

  if (method === "GET" && url.pathname === "/slack/git-coauthors/session-status") {
    await handleGetCommitCoauthorStatusRequest(url, response, options);
    return true;
  }

  if (method === "POST" && url.pathname === "/slack/git-coauthors/configure-session") {
    await handleConfigureCommitCoauthorsRequest(request, response, options);
    return true;
  }

  if (method === "POST" && url.pathname === "/slack/github-token/resolve") {
    await handleResolveGitHubTokenRequest(request, response, options);
    return true;
  }

  return false;
}
