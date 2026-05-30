import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createHttpHandler } from "../src/http/router.js";
import { configureLogger, flushLogger } from "../src/logger.js";

describe("raw HTTP request log redaction", () => {
  const servers: http.Server[] = [];
  const tempRoots: string[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await close(servers.pop()!);
    }

    await flushLogger();
    configureLogger(disabledLoggerConfig());

    while (tempRoots.length > 0) {
      await fs.rm(tempRoots.pop()!, { recursive: true, force: true });
    }
  });

  it("redacts body-like fields from generic chat route raw request logs", async () => {
    const { baseUrl, logDir } = await startLoggedBroker({
      postChatMessage: async () => {},
      postChatState: async () => {},
      postChatFile: async () => ({
        platform: "feishu",
        fileId: "file_uploaded"
      })
    } as never);
    const inlineContent = Buffer.from("CHAT_SECRET_INLINE_FILE").toString("base64");

    await expect(postJson(`${baseUrl}/chat/post-message`, {
      platform: "feishu",
      conversation_id: "oc_group",
      root_message_id: "om_root",
      text: "CHAT_SECRET_TEXT",
      kind: "wait",
      reason: "CHAT_SECRET_REASON",
      stop_reason: "CHAT_SECRET_STOP_REASON",
      format: "card",
      card: {
        title: "CHAT_SECRET_CARD"
      },
      rich_text: {
        content: "CHAT_SECRET_RICH"
      },
      richText: {
        content: "CHAT_SECRET_RICH_CAMEL"
      }
    })).resolves.toBe(200);

    await expect(postJson(`${baseUrl}/chat/post-state`, {
      platform: "feishu",
      conversation_id: "oc_group",
      root_message_id: "om_root",
      kind: "block",
      reason: "CHAT_SECRET_STATE_REASON"
    })).resolves.toBe(200);

    await expect(postJson(`${baseUrl}/chat/post-file`, {
      platform: "feishu",
      conversation_id: "oc_group",
      root_message_id: "om_root",
      content_base64: inlineContent,
      contentBase64: inlineContent,
      filename: "report.txt",
      initial_comment: "CHAT_SECRET_COMMENT",
      initialComment: "CHAT_SECRET_COMMENT_CAMEL",
      text: "CHAT_SECRET_FILE_TEXT",
      alt_text: "CHAT_SECRET_ALT",
      altText: "CHAT_SECRET_ALT_CAMEL"
    })).resolves.toBe(200);

    const { raw, records } = await readRawHttpLog(logDir);
    expect(raw).not.toContain("CHAT_SECRET_TEXT");
    expect(raw).not.toContain("CHAT_SECRET_REASON");
    expect(raw).not.toContain("CHAT_SECRET_STOP_REASON");
    expect(raw).not.toContain("CHAT_SECRET_CARD");
    expect(raw).not.toContain("CHAT_SECRET_RICH");
    expect(raw).not.toContain("CHAT_SECRET_STATE_REASON");
    expect(raw).not.toContain("CHAT_SECRET_COMMENT");
    expect(raw).not.toContain("CHAT_SECRET_FILE_TEXT");
    expect(raw).not.toContain("CHAT_SECRET_ALT");
    expect(raw).not.toContain(inlineContent);

    const messageBody = findRawBody(records, "/chat/post-message");
    expect(messageBody.text).toMatch(/^\[redacted-text:\d+\]$/u);
    expect(messageBody.reason).toMatch(/^\[redacted-reason:\d+\]$/u);
    expect(messageBody.stop_reason).toMatch(/^\[redacted-reason:\d+\]$/u);
    expect(messageBody.card).toBe("[redacted-card]");
    expect(messageBody.rich_text).toBe("[redacted-rich-text]");
    expect(messageBody.richText).toBe("[redacted-rich-text]");

    const stateBody = findRawBody(records, "/chat/post-state");
    expect(stateBody.reason).toMatch(/^\[redacted-reason:\d+\]$/u);

    const fileBody = findRawBody(records, "/chat/post-file");
    expect(fileBody.content_base64).toMatch(/^\[redacted-base64:\d+\]$/u);
    expect(fileBody.contentBase64).toMatch(/^\[redacted-base64:\d+\]$/u);
    expect(fileBody.initial_comment).toMatch(/^\[redacted-comment:\d+\]$/u);
    expect(fileBody.initialComment).toMatch(/^\[redacted-comment:\d+\]$/u);
    expect(fileBody.text).toMatch(/^\[redacted-text:\d+\]$/u);
    expect(fileBody.alt_text).toMatch(/^\[redacted-alt-text:\d+\]$/u);
    expect(fileBody.altText).toMatch(/^\[redacted-alt-text:\d+\]$/u);
  });

  it("redacts body-like fields from legacy Slack route raw request logs", async () => {
    const { baseUrl, logDir } = await startLoggedBroker({
      postChatMessage: async () => {},
      postChatState: async () => {},
      postChatFile: async () => ({
        platform: "slack",
        fileId: "F123"
      })
    } as never);
    const inlineContent = Buffer.from("SLACK_SECRET_INLINE_FILE").toString("base64");

    await expect(postForm(`${baseUrl}/slack/post-message`, {
      channel_id: "C123",
      thread_ts: "111.222",
      text: "SLACK_SECRET_TEXT",
      kind: "wait",
      reason: "SLACK_SECRET_REASON",
      stop_reason: "SLACK_SECRET_STOP_REASON"
    })).resolves.toBe(200);

    await expect(postForm(`${baseUrl}/slack/post-state`, {
      channel_id: "C123",
      thread_ts: "111.222",
      kind: "block",
      reason: "SLACK_SECRET_STATE_REASON"
    })).resolves.toBe(200);

    await expect(postForm(`${baseUrl}/slack/post-file`, {
      channel_id: "C123",
      thread_ts: "111.222",
      content_base64: inlineContent,
      filename: "report.txt",
      initial_comment: "SLACK_SECRET_COMMENT",
      text: "SLACK_SECRET_FILE_TEXT",
      alt_text: "SLACK_SECRET_ALT"
    })).resolves.toBe(200);

    const { raw, records } = await readRawHttpLog(logDir);
    expect(raw).not.toContain("SLACK_SECRET_TEXT");
    expect(raw).not.toContain("SLACK_SECRET_REASON");
    expect(raw).not.toContain("SLACK_SECRET_STOP_REASON");
    expect(raw).not.toContain("SLACK_SECRET_STATE_REASON");
    expect(raw).not.toContain("SLACK_SECRET_COMMENT");
    expect(raw).not.toContain("SLACK_SECRET_FILE_TEXT");
    expect(raw).not.toContain("SLACK_SECRET_ALT");
    expect(raw).not.toContain(inlineContent);

    const messageBody = findRawBody(records, "/slack/post-message");
    expect(messageBody.text).toMatch(/^\[redacted-text:\d+\]$/u);
    expect(messageBody.reason).toMatch(/^\[redacted-reason:\d+\]$/u);
    expect(messageBody.stop_reason).toMatch(/^\[redacted-reason:\d+\]$/u);

    const stateBody = findRawBody(records, "/slack/post-state");
    expect(stateBody.reason).toMatch(/^\[redacted-reason:\d+\]$/u);

    const fileBody = findRawBody(records, "/slack/post-file");
    expect(fileBody.content_base64).toMatch(/^\[redacted-base64:\d+\]$/u);
    expect(fileBody.initial_comment).toMatch(/^\[redacted-comment:\d+\]$/u);
    expect(fileBody.text).toMatch(/^\[redacted-text:\d+\]$/u);
    expect(fileBody.alt_text).toMatch(/^\[redacted-alt-text:\d+\]$/u);
  });

  it("redacts scripts, tokens, and event bodies from job route raw request logs", async () => {
    const { baseUrl, logDir } = await startLoggedJobBroker();

    await expect(postJson(`${baseUrl}/jobs/register`, {
      platform: "feishu",
      conversation_id: "oc_group",
      root_message_id: "om_root",
      kind: "watch_ci",
      script: "JOB_SECRET_SCRIPT",
      cwd: "."
    })).resolves.toBe(200);

    await expect(postJson(`${baseUrl}/jobs/job-1/event`, {
      token: "JOB_SECRET_TOKEN",
      event_kind: "state_changed",
      summary: "JOB_SECRET_SUMMARY",
      details_text: "JOB_SECRET_DETAILS",
      details_json: {
        value: "JOB_SECRET_JSON"
      }
    })).resolves.toBe(200);

    await expect(postJson(`${baseUrl}/jobs/job-1/fail`, {
      token: "JOB_SECRET_TOKEN",
      summary: "JOB_SECRET_FAIL_SUMMARY",
      error: "JOB_SECRET_ERROR"
    })).resolves.toBe(200);

    const { raw, records } = await readRawHttpLog(logDir);
    expect(raw).not.toContain("JOB_SECRET_SCRIPT");
    expect(raw).not.toContain("JOB_SECRET_TOKEN");
    expect(raw).not.toContain("JOB_SECRET_SUMMARY");
    expect(raw).not.toContain("JOB_SECRET_DETAILS");
    expect(raw).not.toContain("JOB_SECRET_JSON");
    expect(raw).not.toContain("JOB_SECRET_ERROR");

    const registerBody = findRawBody(records, "/jobs/register");
    expect(registerBody.script).toMatch(/^\[redacted-script:\d+\]$/u);

    const eventBody = findRawBody(records, "/jobs/job-1/event");
    expect(eventBody.token).toMatch(/^\[redacted-token:\d+\]$/u);
    expect(eventBody.summary).toMatch(/^\[redacted-summary:\d+\]$/u);
    expect(eventBody.details_text).toMatch(/^\[redacted-details-text:\d+\]$/u);
    expect(eventBody.details_json).toBe("[redacted-details-json]");

    const failBody = findRawBody(records, "/jobs/job-1/fail");
    expect(failBody.error).toMatch(/^\[redacted-error:\d+\]$/u);
  });

  it("redacts MCP call arguments from integration route raw request logs", async () => {
    const { baseUrl, logDir } = await startLoggedIntegrationBroker();

    await expect(postJson(`${baseUrl}/integrations/mcp-call`, {
      server: "linear",
      name: "search",
      arguments: {
        query: "INTEGRATION_SECRET_QUERY",
        apiToken: "INTEGRATION_SECRET_TOKEN"
      }
    })).resolves.toBe(200);

    await expect(postJson(`${baseUrl}/integrations/mcp-call`, {
      server: "linear",
      name: "search",
      arguments: JSON.stringify({
        query: "INTEGRATION_SECRET_STRING_QUERY"
      })
    })).resolves.toBe(200);

    const { raw, records } = await readRawHttpLog(logDir);
    expect(raw).not.toContain("INTEGRATION_SECRET_QUERY");
    expect(raw).not.toContain("INTEGRATION_SECRET_TOKEN");
    expect(raw).not.toContain("INTEGRATION_SECRET_STRING_QUERY");

    const bodies = records
      .filter((record) => record.payload.path === "/integrations/mcp-call")
      .map((record) => record.payload.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.arguments).toBe("[redacted-arguments]");
    expect(bodies[1]?.arguments).toMatch(/^\[redacted-arguments:\d+\]$/u);
  });

  async function startLoggedBroker(bridge: never): Promise<{ baseUrl: string; logDir: string }> {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "broker-http-logs-"));
    tempRoots.push(logDir);
    configureLogger({
      ...disabledLoggerConfig(),
      logDir,
      rawHttpRequests: true
    });

    const server = http.createServer(
      createHttpHandler({
        bridge,
        config: {
          serviceName: "test-broker"
        } as never
      })
    );
    servers.push(server);

    return {
      baseUrl: await listen(server),
      logDir
    };
  }

  async function startLoggedJobBroker(): Promise<{ baseUrl: string; logDir: string }> {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "broker-http-logs-"));
    tempRoots.push(logDir);
    configureLogger({
      ...disabledLoggerConfig(),
      logDir,
      rawHttpRequests: true
    });

    const job = {
      id: "job-1",
      token: "JOB_SECRET_TOKEN",
      sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
      platform: "feishu",
      conversationId: "oc_group",
      rootMessageId: "om_root",
      channelId: "oc_group",
      rootThreadTs: "om_root",
      kind: "watch_ci",
      shell: "sh",
      cwd: "/tmp/workspace",
      scriptPath: "/tmp/jobs/job-1/run.sh",
      restartOnBoot: true,
      status: "running",
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z"
    };
    const server = http.createServer(
      createHttpHandler({
        jobManager: {
          registerJob: async () => job,
          emitJobEvent: async () => job,
          failJob: async () => ({
            ...job,
            status: "failed"
          })
        } as never,
        config: {
          serviceName: "test-broker"
        } as never
      })
    );
    servers.push(server);

    return {
      baseUrl: await listen(server),
      logDir
    };
  }

  async function startLoggedIntegrationBroker(): Promise<{ baseUrl: string; logDir: string }> {
    const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "broker-http-logs-"));
    tempRoots.push(logDir);
    configureLogger({
      ...disabledLoggerConfig(),
      logDir,
      rawHttpRequests: true
    });

    const server = http.createServer(
      createHttpHandler({
        isolatedMcp: {
          listTools: async () => [],
          callTool: async () => ({
            content: [{ type: "text", text: "ok" }],
            isError: false
          })
        } as never,
        config: {
          serviceName: "test-broker"
        } as never
      })
    );
    servers.push(server);

    return {
      baseUrl: await listen(server),
      logDir
    };
  }
});

async function postJson(url: string, body: Record<string, unknown>): Promise<number> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  return response.status;
}

async function postForm(url: string, body: Record<string, string>): Promise<number> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=utf-8"
    },
    body: new URLSearchParams(body).toString()
  });

  return response.status;
}

async function readRawHttpLog(logDir: string): Promise<{
  raw: string;
  records: Array<{ payload: { path: string; body: Record<string, unknown> } }>;
}> {
  await flushLogger();
  const raw = await fs.readFile(path.join(logDir, "raw", "http-requests.jsonl"), "utf8");
  const records = raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { payload: { path: string; body: Record<string, unknown> } });

  return { raw, records };
}

function findRawBody(
  records: Array<{ payload: { path: string; body: Record<string, unknown> } }>,
  requestPath: string
): Record<string, unknown> {
  const record = records.find((candidate) => candidate.payload.path === requestPath);
  if (!record) {
    throw new Error(`missing raw HTTP record for ${requestPath}`);
  }

  return record.payload.body;
}

function disabledLoggerConfig(): Parameters<typeof configureLogger>[0] {
  return {
    logDir: undefined,
    level: "info",
    rawSlackEvents: false,
    rawFeishuEvents: false,
    rawCodexRpc: false,
    rawHttpRequests: false
  };
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind test server");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
