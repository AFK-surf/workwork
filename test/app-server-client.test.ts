import http from "node:http";

import fs from "node:fs/promises";

import os from "node:os";

import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WebSocketServer, type WebSocket } from "ws";

import { AppServerClient } from "../src/services/codex/app-server-client.js";

import { TestServer, createServer } from "./app-server-client-helpers.js";

describe("AppServerClient disconnect handling", () => {
  const servers: TestServer[] = [];

  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(
      tempDirs.splice(0).map((directory) =>
        fs.rm(directory, {
          force: true,
          recursive: true,
        }),
      ),
    );
  });

  it("rejects pending requests when the websocket closes", async () => {
    const server = await createServer((socket, message) => {
      if (message.method === "initialize") {
        socket.send(
          JSON.stringify({
            id: message.id,
            result: { ok: true },
          }),
        );
        return;
      }

      if (message.method === "thread/start") {
        socket.close();
      }
    });
    servers.push(server);

    const client = new AppServerClient({
      url: server.url,
      serviceName: "test",
      brokerHttpBaseUrl: "http://127.0.0.1:3000",
      reposRoot: "/tmp/repos",
    });

    await client.connect();

    await expect(client.request("thread/start", {})).rejects.toThrow(/closed/i);
  });

  it("rejects active turn completions when the websocket closes", async () => {
    const server = await createServer((socket, message) => {
      if (message.method === "initialize") {
        socket.send(
          JSON.stringify({
            id: message.id,
            result: { ok: true },
          }),
        );
        return;
      }

      if (message.method === "turn/start") {
        socket.send(
          JSON.stringify({
            id: message.id,
            result: {
              turn: {
                id: "turn-1",
              },
            },
          }),
        );
        setTimeout(() => {
          socket.close();
        }, 10);
      }
    });
    servers.push(server);

    const client = new AppServerClient({
      url: server.url,
      serviceName: "test",
      brokerHttpBaseUrl: "http://127.0.0.1:3000",
      reposRoot: "/tmp/repos",
    });

    await client.connect();
    const started = await client.startTurn("thread-1", "/tmp", [
      {
        type: "text",
        text: "hello",
        text_elements: [],
      },
    ]);

    await expect(started.completion).rejects.toThrow(/closed/i);
  });

  it("buffers turn events that arrive before startTurn finishes registering the turn", async () => {
    const server = await createServer((socket, message) => {
      if (message.method === "initialize") {
        socket.send(
          JSON.stringify({
            id: message.id,
            result: { ok: true },
          }),
        );
        return;
      }

      if (message.method === "turn/start") {
        socket.send(
          JSON.stringify({
            id: message.id,
            result: {
              turn: {
                id: "turn-1",
              },
            },
          }),
        );
        socket.send(
          JSON.stringify({
            method: "item/agentMessage/delta",
            params: {
              turnId: "turn-1",
              delta: "done",
            },
          }),
        );
        socket.send(
          JSON.stringify({
            method: "turn/completed",
            params: {
              turn: {
                id: "turn-1",
              },
            },
          }),
        );
      }
    });
    servers.push(server);

    const client = new AppServerClient({
      url: server.url,
      serviceName: "test",
      brokerHttpBaseUrl: "http://127.0.0.1:3000",
      reposRoot: "/tmp/repos",
    });

    await client.connect();
    const started = await client.startTurn("thread-1", "/tmp", [
      {
        type: "text",
        text: "hello",
        text_elements: [],
      },
    ]);

    await expect(started.completion).resolves.toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      finalMessage: "done",
      aborted: false,
      generatedImages: [],
    });
  });

  it("captures exact token usage from turn completion notifications", async () => {
    const server = await createServer((socket, message) => {
      if (message.method === "initialize") {
        socket.send(
          JSON.stringify({
            id: message.id,
            result: { ok: true },
          }),
        );
        return;
      }

      if (message.method === "turn/start") {
        socket.send(
          JSON.stringify({
            id: message.id,
            result: {
              turn: {
                id: "turn-usage",
              },
            },
          }),
        );
        socket.send(
          JSON.stringify({
            method: "turn/completed",
            params: {
              turn: {
                id: "turn-usage",
                usage: {
                  input_tokens: 1200,
                  cached_input_tokens: 300,
                  output_tokens: 450,
                  reasoning_tokens: 75,
                  total_tokens: 1725,
                  model: "gpt-5.5",
                  effort: "xhigh",
                },
              },
            },
          }),
        );
      }
    });
    servers.push(server);

    const client = new AppServerClient({
      url: server.url,
      serviceName: "test",
      brokerHttpBaseUrl: "http://127.0.0.1:3000",
      reposRoot: "/tmp/repos",
    });

    await client.connect();
    const started = await client.startTurn("thread-1", "/tmp", [
      {
        type: "text",
        text: "hello",
        text_elements: [],
      },
    ]);

    await expect(started.completion).resolves.toMatchObject({
      threadId: "thread-1",
      turnId: "turn-usage",
      usage: {
        source: "exact",
        inputTokens: 1200,
        cachedInputTokens: 300,
        outputTokens: 450,
        reasoningTokens: 75,
        totalTokens: 1725,
        model: "gpt-5.5",
        effort: "xhigh",
      },
    });
  });

  it("accumulates exact token usage from Codex token_count events", async () => {
    const server = await createServer((socket, message) => {
      if (message.method === "initialize") {
        socket.send(
          JSON.stringify({
            id: message.id,
            result: { ok: true },
          }),
        );
        return;
      }

      if (message.method === "turn/start") {
        socket.send(
          JSON.stringify({
            id: message.id,
            result: {
              turn: {
                id: "turn-token-count",
              },
            },
          }),
        );
        socket.send(
          JSON.stringify({
            method: "codex/event/token_count",
            params: {
              msg: {
                type: "token_count",
                info: {
                  total_token_usage: {
                    total_tokens: 12,
                  },
                  last_token_usage: {
                    input_tokens: 10,
                    cached_input_tokens: 4,
                    output_tokens: 2,
                    reasoning_output_tokens: 1,
                    total_tokens: 12,
                  },
                },
              },
            },
          }),
        );
        socket.send(
          JSON.stringify({
            method: "codex/event/token_count",
            params: {
              msg: {
                type: "token_count",
                info: {
                  total_token_usage: {
                    total_tokens: 22,
                  },
                  last_token_usage: {
                    input_tokens: 7,
                    cached_input_tokens: 3,
                    output_tokens: 3,
                    reasoning_output_tokens: 1,
                    total_tokens: 10,
                  },
                },
              },
            },
          }),
        );
        socket.send(
          JSON.stringify({
            method: "codex/event/token_count",
            params: {
              msg: {
                type: "token_count",
                info: {
                  total_token_usage: {
                    total_tokens: 22,
                  },
                  last_token_usage: {
                    input_tokens: 7,
                    cached_input_tokens: 3,
                    output_tokens: 3,
                    reasoning_output_tokens: 1,
                    total_tokens: 10,
                  },
                },
              },
            },
          }),
        );
        socket.send(
          JSON.stringify({
            method: "item/agentMessage/delta",
            params: {
              turnId: "turn-token-count",
              delta: "done",
            },
          }),
        );
        socket.send(
          JSON.stringify({
            method: "turn/completed",
            params: {
              turn: {
                id: "turn-token-count",
              },
            },
          }),
        );
      }
    });
    servers.push(server);

    const client = new AppServerClient({
      url: server.url,
      serviceName: "test",
      brokerHttpBaseUrl: "http://127.0.0.1:3000",
      reposRoot: "/tmp/repos",
    });

    await client.connect();
    const started = await client.startTurn("thread-1", "/tmp", [
      {
        type: "text",
        text: "hello",
        text_elements: [],
      },
    ]);

    const result = await started.completion;
    expect(result).toMatchObject({
      threadId: "thread-1",
      turnId: "turn-token-count",
      finalMessage: "done",
      usage: {
        source: "exact",
        inputTokens: 17,
        cachedInputTokens: 7,
        outputTokens: 5,
        reasoningTokens: 2,
        totalTokens: 22,
      },
    });
    expect(result.usage?.rawUsage).toMatchObject({
      kind: "aggregated_token_usage",
      eventCount: 2,
      inputTokens: 17,
      cachedInputTokens: 7,
      outputTokens: 5,
      reasoningTokens: 2,
      totalTokens: 22,
    });
  });

  it("captures exact token usage from thread/tokenUsage/updated notifications", async () => {
    const server = await createServer((socket, message) => {
      if (message.method === "initialize") {
        socket.send(
          JSON.stringify({
            id: message.id,
            result: { ok: true },
          }),
        );
        return;
      }

      if (message.method === "turn/start") {
        socket.send(
          JSON.stringify({
            id: message.id,
            result: {
              turn: {
                id: "turn-thread-usage",
              },
            },
          }),
        );
        socket.send(
          JSON.stringify({
            method: "thread/tokenUsage/updated",
            params: {
              threadId: "thread-1",
              turnId: "turn-thread-usage",
              tokenUsage: {
                total: {
                  totalTokens: 2_050,
                  inputTokens: 1_500,
                  cachedInputTokens: 250,
                  outputTokens: 550,
                  reasoningOutputTokens: 125,
                },
                last: {
                  totalTokens: 2_050,
                  inputTokens: 1_500,
                  cachedInputTokens: 250,
                  outputTokens: 550,
                  reasoningOutputTokens: 125,
                },
                modelContextWindow: 272_000,
              },
            },
          }),
        );
        socket.send(
          JSON.stringify({
            method: "item/agentMessage/delta",
            params: {
              turnId: "turn-thread-usage",
              delta: "done",
            },
          }),
        );
        socket.send(
          JSON.stringify({
            method: "turn/completed",
            params: {
              turn: {
                id: "turn-thread-usage",
              },
            },
          }),
        );
      }
    });
    servers.push(server);

    const client = new AppServerClient({
      url: server.url,
      serviceName: "test",
      brokerHttpBaseUrl: "http://127.0.0.1:3000",
      reposRoot: "/tmp/repos",
    });

    await client.connect();
    const started = await client.startTurn("thread-1", "/tmp", [
      {
        type: "text",
        text: "hello",
        text_elements: [],
      },
    ]);

    await expect(started.completion).resolves.toMatchObject({
      threadId: "thread-1",
      turnId: "turn-thread-usage",
      finalMessage: "done",
      usage: {
        source: "exact",
        inputTokens: 1_500,
        cachedInputTokens: 250,
        outputTokens: 550,
        reasoningTokens: 125,
        totalTokens: 2_050,
      },
    });
  });
});
