import path from "node:path";

import type { ChatPlatform } from "./chat-types.js";

export interface ChatSessionCoordinates {
  readonly platform: ChatPlatform;
  readonly conversationId: string;
  readonly rootMessageId: string;
}

export function createChatSessionKey(coordinates: ChatSessionCoordinates): string {
  return [coordinates.platform, encodeSessionKeyPart(coordinates.conversationId), encodeSessionKeyPart(coordinates.rootMessageId)].join(":");
}

export function createChatWorkspacePath(sessionsRoot: string, coordinates: ChatSessionCoordinates): string {
  return path.join(sessionsRoot, createChatWorkspaceDirectoryName(coordinates), "workspace");
}

export function createChatWorkspaceDirectoryName(coordinates: ChatSessionCoordinates): string {
  return [coordinates.platform, sanitizeForPath(coordinates.conversationId), sanitizeForPath(coordinates.rootMessageId)].filter(Boolean).join("-");
}

export function encodeSessionKeyPart(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function decodeSessionKeyPart(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sanitizeForPath(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
