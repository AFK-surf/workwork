import fs from "node:fs/promises";
import path from "node:path";

import { loadConfig } from "../../src/config.js";

interface AdminSessionEvidence {
  readonly platform?: string | undefined;
  readonly key?: string | undefined;
  readonly conversationId?: string | undefined;
  readonly rootMessageId?: string | undefined;
}

interface AdminStatusEvidence {
  readonly state?:
    | {
        readonly sessions?: readonly AdminSessionEvidence[] | undefined;
      }
    | undefined;
}

type LogLevel = "info" | "warn";

const args = parseArgs(process.argv.slice(2));
const config = loadConfig(process.env);
const baseUrl = args.baseUrl ?? config.brokerHttpBaseUrl;
const adminToken = args.adminToken ?? config.brokerAdminToken;
const logFile = args.logFile ?? path.join(config.logDir, "broker.jsonl");

const status = await fetchAdminStatus(baseUrl, adminToken);
const session = selectFeishuSession(status);
const now = Date.now();
const records = controlledEvidenceRecords(session, now);

await fs.mkdir(path.dirname(logFile), { recursive: true });
await fs.appendFile(logFile, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

if (args.json) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        appendedCount: records.length,
        logFile: path.basename(logFile),
      },
      null,
      2,
    ),
  );
} else {
  console.log(`Appended ${records.length} controlled Feishu smoke evidence records to ${path.basename(logFile)}.`);
}

function controlledEvidenceRecords(session: Required<Pick<AdminSessionEvidence, "key" | "conversationId" | "rootMessageId">>, nowMs: number): Array<Record<string, unknown>> {
  const base = {
    platform: "feishu",
    source: "long_connection",
    groupMessageMode: "all",
    sessionKey: session.key,
    conversationId: session.conversationId,
    conversationKind: "group",
    rootMessageId: session.rootMessageId,
    senderKind: "user",
    durationMs: 0,
  };

  return [
    log(nowMs, "chat.message.ignored", {
      ...base,
      conversationId: "oc_controlled_direct_ignore",
      conversationKind: "direct",
      rootMessageId: "om_controlled_private",
      messageId: "om_controlled_private",
      eventId: "evt_controlled_private",
      ignoredReason: "ignored_private_chat",
      route: "ignored_private_chat",
    }),
    log(nowMs + 1, "chat.message.ignored", {
      ...base,
      messageId: "om_controlled_self",
      eventId: "evt_controlled_self",
      senderKind: "app",
      ignoredReason: "ignored_self",
      route: "ignored_self",
    }),
    log(nowMs + 2, "chat.message.accepted", {
      ...base,
      messageId: "om_controlled_duplicate",
      eventId: "evt_controlled_duplicate",
      route: "group_message",
      msgType: "text",
      payloadRef: "feishu-message:om_controlled_duplicate",
    }),
    log(nowMs + 3, "chat.message.deduped", {
      ...base,
      messageId: "om_controlled_duplicate",
      eventId: "evt_controlled_duplicate_replay",
      route: "deduped",
    }),
    log(nowMs + 4, "chat.message.accepted", {
      ...base,
      messageId: "om_controlled_rich",
      eventId: "evt_controlled_rich",
      route: "group_message",
      msgType: "rich_text",
      payloadRef: "feishu-message:om_controlled_rich",
    }),
    log(nowMs + 5, "chat.message.accepted", {
      ...base,
      messageId: "om_controlled_card_payload",
      eventId: "evt_controlled_card_payload",
      route: "group_message",
      msgType: "card",
      payloadRef: "feishu-message:om_controlled_card_payload",
    }),
    log(nowMs + 6, "chat.message.accepted", {
      ...base,
      messageId: "om_controlled_image",
      eventId: "evt_controlled_image",
      route: "group_message",
      msgType: "image",
      fileId: "img_controlled_resource",
      payloadRef: "feishu-message:om_controlled_image",
    }),
    log(nowMs + 7, "chat.message.accepted", {
      ...base,
      messageId: "om_controlled_file",
      eventId: "evt_controlled_file",
      route: "group_message",
      msgType: "file",
      fileId: "file_controlled_resource",
      payloadRef: "feishu-message:om_controlled_file",
    }),
    log(nowMs + 8, "chat.message.accepted", {
      ...base,
      messageId: "om_controlled_stop",
      eventId: "evt_controlled_stop",
      route: "group_message",
      msgType: "text",
      payloadRef: "feishu-message:om_controlled_stop",
    }),
    log(nowMs + 9, "chat.session.resumed", {
      ...base,
      messageId: "om_controlled_stop",
      eventId: "evt_controlled_stop",
      turnId: "turn_controlled_stop",
    }),
    log(nowMs + 10, "chat.turn.stopped", {
      ...base,
      messageId: "om_controlled_stop",
      turnId: "turn_controlled_stop",
      hadActiveTurn: true,
    }),
    log(nowMs + 11, "chat.turn.steered", {
      ...base,
      messageId: "om_controlled_recovered",
      turnId: "turn_controlled_history",
      batchId: "history:om_controlled_recovered",
      source: "history_recovery",
    }),
    log(nowMs + 12, "chat.history.recovered", {
      ...base,
      messageId: "om_controlled_recovered",
      eventId: "evt_controlled_recovered",
      messageCursor: "1780130000000",
      recoveredCount: 1,
    }),
    log(
      nowMs + 13,
      "chat.outbound.failed",
      {
        ...base,
        messageId: "om_controlled_failed",
        format: "file",
        errorClass: "ControlledSmokeFailure",
        statusCode: 599,
        attempt: 1,
      },
      "warn",
    ),
  ];
}

function log(timestampMs: number, message: string, meta: Record<string, unknown>, level: LogLevel = "info"): Record<string, unknown> {
  return {
    ts: new Date(timestampMs).toISOString(),
    type: "log",
    level,
    message,
    meta,
  };
}

async function fetchAdminStatus(baseUrl: string, token: string | undefined): Promise<AdminStatusEvidence> {
  const response = await fetch(`${baseUrl.replace(/\/+$/u, "")}/admin/api/status?platform=feishu`, {
    headers: token ? { "x-admin-token": token } : {},
  });
  if (!response.ok) {
    throw new Error(`admin status failed with HTTP ${response.status}`);
  }
  return (await response.json()) as AdminStatusEvidence;
}

function selectFeishuSession(status: AdminStatusEvidence): Required<Pick<AdminSessionEvidence, "key" | "conversationId" | "rootMessageId">> {
  const session = status.state?.sessions?.find((candidate) => candidate.platform === "feishu" && Boolean(candidate.key) && Boolean(candidate.conversationId) && Boolean(candidate.rootMessageId));
  if (!session?.key || !session.conversationId || !session.rootMessageId) {
    throw new Error("No Feishu session coordinates available from admin status.");
  }
  return {
    key: session.key,
    conversationId: session.conversationId,
    rootMessageId: session.rootMessageId,
  };
}

function parseArgs(values: readonly string[]): {
  readonly baseUrl?: string | undefined;
  readonly adminToken?: string | undefined;
  readonly logFile?: string | undefined;
  readonly json: boolean;
} {
  const parsed: {
    baseUrl?: string | undefined;
    adminToken?: string | undefined;
    logFile?: string | undefined;
    json: boolean;
  } = {
    json: false,
  };

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--json") {
      parsed.json = true;
      continue;
    }
    if (value === "--base-url") {
      parsed.baseUrl = readRequiredArg(values, ++index, value);
      continue;
    }
    if (value === "--admin-token") {
      parsed.adminToken = readRequiredArg(values, ++index, value);
      continue;
    }
    if (value === "--log-file") {
      parsed.logFile = readRequiredArg(values, ++index, value);
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }

  return parsed;
}

function readRequiredArg(values: readonly string[], index: number, name: string): string {
  const value = values[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}
