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

  it("injects personal memory into thread/start base instructions only once", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "app-server-client-"));
    tempDirs.push(tempRoot);
    const personalMemoryFilePath = path.join(tempRoot, "AGENT.md");
    await fs.writeFile(personalMemoryFilePath, "remember this\n");

    let threadStartParams: Record<string, unknown> | undefined;
    let threadResumeParams: Record<string, unknown> | undefined;
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
        threadStartParams = (message as { params?: Record<string, unknown> }).params;
        socket.send(
          JSON.stringify({
            id: message.id,
            result: {
              thread: {
                id: "thread-1",
              },
            },
          }),
        );
        return;
      }

      if (message.method === "thread/resume") {
        threadResumeParams = (message as { params?: Record<string, unknown> }).params;
        socket.send(
          JSON.stringify({
            id: message.id,
            result: {
              thread: {
                id: "thread-1",
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
      personalMemoryFilePath,
    });
    client.setSlackBotIdentity({
      userId: "U999",
      mention: "<@U999>",
      displayName: "codex-3720",
      username: "codexdmbot",
      realName: "codex-3720",
    });

    await client.connect();
    await expect(
      client.ensureThread({
        channelId: "C123",
        rootThreadTs: "111.222",
        workspacePath: "/tmp/workspace",
      }),
    ).resolves.toBe("thread-1");
    await expect(
      client.ensureThread({
        channelId: "C123",
        rootThreadTs: "111.222",
        agentSessionId: "thread-1",
        workspacePath: "/tmp/workspace",
      }),
    ).resolves.toBe("thread-1");

    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("channel_id: C123"));
    expect(threadStartParams?.experimentalRawEvents).toBe(true);
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("thread_ts: 111.222"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("session_workspace: /tmp/workspace"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining(`runtime_platform: ${process.platform}`));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining(`runtime_hostname: ${os.hostname()}`));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("runtime_containerized:"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("Verify platform-specific app/runtime behavior from the runtime you can actually observe"));
    expect(threadStartParams?.baseInstructions).not.toEqual(expect.stringContaining("You are running inside the broker's Linux Docker container, not on a macOS host."));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("~/.codex/AGENT.md"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("remember this"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("bot_user_id: U999"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("bot_mention: <@U999>"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("bot_display_name: codex-3720"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("Do not assume it is addressed to you"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("bias toward sending a short direct Slack answer"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("BROKER_JOB_HELPER"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("Write normal Markdown in the `text` field"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("the broker converts markdownish output to `mrkdwn` before posting"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("The main Codex runtime for this Slack broker does not load the linear or notion MCPs directly"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("/integrations/mcp-tools?server=linear"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("/integrations/mcp-tools?server=notion"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("/integrations/mcp-call"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("UI/frontend/layout/styling contract"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("kimi --work-dir /absolute/project/path"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("consult Kimi first by default"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("Keep APIs, data contracts, and non-UI behavior unchanged"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("user explicitly asks you to do the UI work directly yourself"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("Kimi is unavailable right now and then continue the UI work yourself"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining('"server":"linear"'));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining('"name":"replace_with_linear_tool_name"'));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining('"server":"notion"'));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining('"name":"replace_with_notion_tool_name"'));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("Turn stopping contract"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("kind=wait"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("/slack/post-state"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("silent block state"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("silent final state"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("Do not send one plain Slack reply and then a second state-only reply"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("Do not prefix the message body with tags like [final], [block], or [wait]"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("Do not emit repeated wait updates for routine watcher ticks"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("do not mirror every watcher update back into Slack"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("shared_repos_root: /tmp/repos"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("Git commit co-author contract"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("Do not bypass git hooks"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("The broker may append `Co-authored-by:` trailers automatically"));
    expect(String(threadStartParams?.baseInstructions)).toContain('node \\"$BROKER_JOB_HELPER\\" event');
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("Identity and instruction boundaries"));
    expect(threadStartParams?.baseInstructions).toEqual(expect.stringContaining("Do not store personal operating memory in repository AGENTS.md files"));
    expect(String(threadStartParams?.baseInstructions)).not.toContain("{{");
    expect(threadResumeParams?.baseInstructions).toBeNull();
  });
});
