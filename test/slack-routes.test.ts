import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createHttpHandler } from "../src/http/router.js";

describe("legacy Slack routes", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("delegates Slack thread history to generic chat coordinates", async () => {
    const calls: unknown[] = [];
    const server = http.createServer(
      createHttpHandler({
        bridge: {
          readChatThreadHistory: async (payload: unknown) => {
            calls.push(payload);
            return {
              messages: [
                {
                  messageId: "111.221"
                }
              ],
              formattedText: "older Slack context",
              hasMore: true
            };
          }
        } as never,
        config: {
          serviceName: "test-broker",
          slackHistoryApiMaxLimit: 50
        } as never
      })
    );
    const baseUrl = await listen(server);
    cleanups.push(() => close(server));

    const response = await fetch(
      `${baseUrl}/slack/thread-history?channel_id=C123&thread_ts=111.222&before_ts=111.221&channel_type=im&limit=20&format=json`
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      channelId: "C123",
      rootThreadTs: "111.222",
      beforeMessageTs: "111.221",
      returnedCount: 1,
      hasMore: true,
      maxLimit: 50,
      formattedText: "older Slack context"
    });
    expect(calls).toEqual([
      {
        platform: "slack",
        conversationId: "C123",
        rootMessageId: "111.222",
        beforeMessageId: "111.221",
        channelType: "im",
        limit: 20
      }
    ]);
  });

  it("rejects non-positive or fractional Slack thread history limits before delegation", async () => {
    const calls: unknown[] = [];
    const server = http.createServer(
      createHttpHandler({
        bridge: {
          readChatThreadHistory: async (payload: unknown) => {
            calls.push(payload);
            return {
              messages: [],
              hasMore: false
            };
          }
        } as never,
        config: {
          serviceName: "test-broker",
          slackHistoryApiMaxLimit: 50
        } as never
      })
    );
    const baseUrl = await listen(server);
    cleanups.push(() => close(server));

    for (const limit of ["abc", "0", "-1", "1.5"]) {
      const response = await fetch(
        `${baseUrl}/slack/thread-history?channel_id=C123&thread_ts=111.222&limit=${encodeURIComponent(limit)}`
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: "invalid_limit",
        message: "limit must be a positive integer"
      });
    }

    expect(calls).toEqual([]);
  });

  it("rejects invalid Slack thread history response formats before delegation", async () => {
    const calls: unknown[] = [];
    const server = http.createServer(
      createHttpHandler({
        bridge: {
          readChatThreadHistory: async (payload: unknown) => {
            calls.push(payload);
            return {
              messages: [],
              hasMore: false
            };
          }
        } as never,
        config: {
          serviceName: "test-broker",
          slackHistoryApiMaxLimit: 50
        } as never
      })
    );
    const baseUrl = await listen(server);
    cleanups.push(() => close(server));

    for (const format of ["markdown", "JSON", ""]) {
      const response = await fetch(
        `${baseUrl}/slack/thread-history?channel_id=C123&thread_ts=111.222&format=${encodeURIComponent(format)}`
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: "invalid_format",
        allowed: ["json", "text"]
      });
    }

    expect(calls).toEqual([]);
  });

  it("delegates Slack post-message to generic chat coordinates", async () => {
    const calls: unknown[] = [];
    const server = http.createServer(
      createHttpHandler({
        bridge: {
          postChatMessage: async (payload: unknown) => {
            calls.push(payload);
          }
        } as never,
        config: {
          serviceName: "test-broker"
        } as never
      })
    );
    const baseUrl = await listen(server);
    cleanups.push(() => close(server));

    const response = await postForm(`${baseUrl}/slack/post-message`, {
      channel_id: "C123",
      thread_ts: "111.222",
      text: "done",
      kind: "final"
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(calls).toEqual([
      {
        platform: "slack",
        conversationId: "C123",
        rootMessageId: "111.222",
        text: "done",
        kind: "final",
        reason: undefined
      }
    ]);
  });

  it("delegates Slack post-state to generic chat coordinates", async () => {
    const calls: unknown[] = [];
    const server = http.createServer(
      createHttpHandler({
        bridge: {
          postChatState: async (payload: unknown) => {
            calls.push(payload);
          }
        } as never,
        config: {
          serviceName: "test-broker"
        } as never
      })
    );
    const baseUrl = await listen(server);
    cleanups.push(() => close(server));

    const response = await postForm(`${baseUrl}/slack/post-state`, {
      channel_id: "C123",
      thread_ts: "111.222",
      kind: "wait",
      reason: "waiting for CI"
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(calls).toEqual([
      {
        platform: "slack",
        conversationId: "C123",
        rootMessageId: "111.222",
        kind: "wait",
        reason: "waiting for CI"
      }
    ]);
  });

  it("delegates Slack post-file to generic chat coordinates", async () => {
    const calls: unknown[] = [];
    const server = http.createServer(
      createHttpHandler({
        bridge: {
          postChatFile: async (payload: unknown) => {
            calls.push(payload);
            return {
              platform: "slack",
              fileId: "F123",
              title: "report"
            };
          }
        } as never,
        config: {
          serviceName: "test-broker"
        } as never
      })
    );
    const baseUrl = await listen(server);
    cleanups.push(() => close(server));

    const response = await postForm(`${baseUrl}/slack/post-file`, {
      channel_id: "C123",
      thread_ts: "111.222",
      file_path: "/tmp/report.txt",
      title: "report",
      initial_comment: "see attached"
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      file: {
        platform: "slack",
        fileId: "F123",
        title: "report"
      }
    });
    expect(calls).toEqual([
      {
        platform: "slack",
        conversationId: "C123",
        rootMessageId: "111.222",
        filePath: "/tmp/report.txt",
        contentBase64: undefined,
        filename: undefined,
        title: "report",
        initialComment: "see attached",
        altText: undefined,
        snippetType: undefined,
        contentType: undefined
      }
    ]);
  });

  it("validates Slack post-file file sources before delegation", async () => {
    const calls: unknown[] = [];
    const server = http.createServer(
      createHttpHandler({
        bridge: {
          postChatFile: async (payload: unknown) => {
            calls.push(payload);
            return {
              platform: "slack",
              fileId: "F123"
            };
          }
        } as never,
        config: {
          serviceName: "test-broker"
        } as never
      })
    );
    const baseUrl = await listen(server);
    cleanups.push(() => close(server));

    const missingSource = await postForm(`${baseUrl}/slack/post-file`, {
      channel_id: "C123",
      thread_ts: "111.222"
    });
    expect(missingSource.status).toBe(400);
    await expect(missingSource.json()).resolves.toEqual({
      ok: false,
      error: "provide_exactly_one_file_source",
      required: [
        "filePath (alias: file_path)",
        "contentBase64 (alias: content_base64)"
      ]
    });

    const duplicateSource = await postForm(`${baseUrl}/slack/post-file`, {
      channel_id: "C123",
      thread_ts: "111.222",
      file_path: "/tmp/report.txt",
      content_base64: Buffer.from("report").toString("base64")
    });
    expect(duplicateSource.status).toBe(400);
    await expect(duplicateSource.json()).resolves.toEqual({
      ok: false,
      error: "provide_exactly_one_file_source",
      required: [
        "filePath (alias: file_path)",
        "contentBase64 (alias: content_base64)"
      ]
    });

    expect(calls).toEqual([]);
  });

  it("rejects Slack inline file uploads without a filename before delegation", async () => {
    const calls: unknown[] = [];
    const server = http.createServer(
      createHttpHandler({
        bridge: {
          postChatFile: async (payload: unknown) => {
            calls.push(payload);
            return {
              platform: "slack",
              fileId: "F123"
            };
          }
        } as never,
        config: {
          serviceName: "test-broker"
        } as never
      })
    );
    const baseUrl = await listen(server);
    cleanups.push(() => close(server));

    const response = await postForm(`${baseUrl}/slack/post-file`, {
      channel_id: "C123",
      thread_ts: "111.222",
      content_base64: Buffer.from("report").toString("base64")
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "missing_required_body",
      message: "filename is required when using contentBase64 (alias: content_base64)",
      required: ["filename"]
    });
    expect(calls).toEqual([]);
  });

  it("rejects invalid Slack inline file content before delegation", async () => {
    const calls: unknown[] = [];
    const server = http.createServer(
      createHttpHandler({
        bridge: {
          postChatFile: async (payload: unknown) => {
            calls.push(payload);
            return {
              platform: "slack",
              fileId: "F123"
            };
          }
        } as never,
        config: {
          serviceName: "test-broker"
        } as never
      })
    );
    const baseUrl = await listen(server);
    cleanups.push(() => close(server));

    const response = await postForm(`${baseUrl}/slack/post-file`, {
      channel_id: "C123",
      thread_ts: "111.222",
      content_base64: "!!!!",
      filename: "report.pdf"
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "invalid_content_base64",
      message: "contentBase64 (alias: content_base64) must decode to non-empty file content",
      required: ["contentBase64 (alias: content_base64)"]
    });
    expect(calls).toEqual([]);
  });
});

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

async function postForm(url: string, body: Record<string, string>): Promise<Response> {
  return await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(body)
  });
}
