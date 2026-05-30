import { spawn, type ChildProcessByStdio } from "node:child_process";

import fs from "node:fs/promises";

import os from "node:os";

import path from "node:path";

import { DatabaseSync } from "node:sqlite";

import type { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { CURRENT_STATE_SCHEMA_VERSION, STATE_DATABASE_FILENAME, STATE_STORE_BUSY_TIMEOUT_MS, StateStore } from "../src/store/state-store.js";

import { LOCK_DATABASE_SCRIPT, waitForOutput, extractMethodBody } from "./state-store-helpers.js";
import { readCompanionSource } from "./source-helpers.js";

describe("StateStore", () => {
  it(
    "does not rerun migrations on repeated load calls",
    async () => {
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-"));
      const sessionsRoot = path.join(stateDir, "sessions");
      const store = new StateStore(stateDir, sessionsRoot);
      await store.load();

      const lockConnection = new DatabaseSync(path.join(stateDir, STATE_DATABASE_FILENAME));
      lockConnection.exec("BEGIN IMMEDIATE");
      try {
        const startedAt = Date.now();
        await expect(store.load()).resolves.toBeUndefined();
        expect(Date.now() - startedAt).toBeLessThan(250);
      } finally {
        lockConnection.exec("ROLLBACK");
        lockConnection.close();
        store.close();
      }
    },
    STATE_STORE_BUSY_TIMEOUT_MS + 1_000,
  );

  it(
    "waits for short-lived startup write locks before running migrations",
    async () => {
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-"));
      const sessionsRoot = path.join(stateDir, "sessions");
      await fs.mkdir(stateDir, { recursive: true });

      const locker = spawn(process.execPath, ["-e", LOCK_DATABASE_SCRIPT], {
        env: {
          ...process.env,
          DB_PATH: path.join(stateDir, STATE_DATABASE_FILENAME),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      try {
        await waitForOutput(locker, "locked");

        const store = new StateStore(stateDir, sessionsRoot);
        try {
          const startedAt = Date.now();
          await expect(store.load()).resolves.toBeUndefined();
          expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
        } finally {
          store.close();
        }
      } finally {
        if (locker.exitCode === null) {
          locker.kill();
        }
      }
    },
    STATE_STORE_BUSY_TIMEOUT_MS + 1_000,
  );

  it("persists sessions and processed events in the SQLite database", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-"));
    const sessionsRoot = path.join(stateDir, "sessions");
    const store = new StateStore(stateDir, sessionsRoot);
    await store.load();

    await Promise.all([
      store.markProcessedEvent("EvA"),
      store.markProcessedEvent("EvB"),
      store.upsertSession({
        key: "C123:111.222",
        channelId: "C123",
        rootThreadTs: "111.222",
        workspacePath: "/tmp/sessions/C123-111.222/workspace",
        createdAt: "2026-03-15T00:00:00.000Z",
        updatedAt: "2026-03-15T00:00:00.000Z",
      }),
    ]);
    store.close();

    await expect(fs.access(path.join(stateDir, STATE_DATABASE_FILENAME))).resolves.toBeUndefined();

    const reloaded = new StateStore(stateDir, sessionsRoot);
    await reloaded.load();
    expect(reloaded.hasProcessedEvent("EvA")).toBe(true);
    expect(reloaded.hasProcessedEvent("EvB")).toBe(true);
    expect(reloaded.getSession("C123:111.222")).toEqual(
      expect.objectContaining({
        key: "C123:111.222",
      }),
    );
    reloaded.close();
  });

  it("persists pending Slack events until they are processed", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-"));
    const sessionsRoot = path.join(stateDir, "sessions");
    const store = new StateStore(stateDir, sessionsRoot);
    await store.load();

    await store.enqueueSlackEvent("EvA", {
      event_id: "EvA",
      event: {
        type: "message",
        channel: "C123",
        thread_ts: "111.222",
        ts: "111.223",
        user: "U123",
        text: "hello",
      },
    });

    expect(store.listPendingSlackEvents()).toEqual([
      expect.objectContaining({
        eventId: "EvA",
        status: "pending",
        payload: expect.objectContaining({
          event_id: "EvA",
        }),
      }),
    ]);

    store.close();
    const reloaded = new StateStore(stateDir, sessionsRoot);
    await reloaded.load();
    expect(reloaded.listPendingSlackEvents()).toHaveLength(1);

    await reloaded.markSlackEventProcessed("EvA");
    expect(reloaded.hasProcessedEvent("EvA")).toBe(true);
    expect(reloaded.listPendingSlackEvents()).toHaveLength(0);
    reloaded.close();
  });

  it("deletes session state transactionally with inbound messages and background jobs", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-"));
    const sessionsRoot = path.join(stateDir, "sessions");
    const store = new StateStore(stateDir, sessionsRoot);
    await store.load();
    await store.upsertSession({
      key: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      workspacePath: "/tmp/sessions/C123-111.222/workspace",
      createdAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z",
    });
    await store.upsertInboundMessage({
      key: "inbound-1",
      sessionKey: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      messageTs: "111.223",
      source: "thread_reply",
      userId: "U123",
      text: "follow up",
      status: "pending",
      createdAt: "2026-03-15T00:00:01.000Z",
      updatedAt: "2026-03-15T00:00:01.000Z",
    });
    await store.upsertBackgroundJob({
      id: "job-1",
      token: "token-1",
      sessionKey: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      kind: "watch_ci",
      shell: "sh",
      cwd: "/tmp/sessions/C123-111.222/workspace",
      scriptPath: "/tmp/jobs/job-1/run.sh",
      restartOnBoot: true,
      status: "running",
      createdAt: "2026-03-15T00:00:02.000Z",
      updatedAt: "2026-03-15T00:00:02.000Z",
    });

    await expect(store.deleteSession("C123:111.222")).resolves.toBe(true);

    expect(store.getSession("C123:111.222")).toBeUndefined();
    expect(store.listInboundMessages({ sessionKey: "C123:111.222" })).toHaveLength(0);
    expect(store.listBackgroundJobs({ sessionKey: "C123:111.222" })).toHaveLength(0);
    store.close();
  });

  it("persists agent turn token usage and cascades it with the owning session", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-usage-"));
    const sessionsRoot = path.join(stateDir, "sessions");
    const store = new StateStore(stateDir, sessionsRoot);
    await store.load();
    await store.upsertSession({
      key: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      workspacePath: "/tmp/sessions/C123-111.222/workspace",
      createdAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z",
    });

    await store.upsertAgentTurnUsage({
      turnId: "turn-1",
      sessionKey: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      agentSessionId: "thread-1",
      status: "completed",
      source: "exact",
      model: "gpt-5.5",
      effort: "xhigh",
      inputTokens: 1200,
      cachedInputTokens: 300,
      outputTokens: 450,
      reasoningTokens: 75,
      totalTokens: 1725,
      rawUsage: {
        total_tokens: 1725,
      },
      startedAt: "2026-03-15T00:00:01.000Z",
      completedAt: "2026-03-15T00:00:09.000Z",
      createdAt: "2026-03-15T00:00:01.000Z",
      updatedAt: "2026-03-15T00:00:09.000Z",
    });

    expect(store.listAgentTurnUsage()).toEqual([
      expect.objectContaining({
        turnId: "turn-1",
        sessionKey: "C123:111.222",
        source: "exact",
        totalTokens: 1725,
        rawUsage: {
          total_tokens: 1725,
        },
      }),
    ]);

    await store.deleteSession("C123:111.222");
    expect(store.listAgentTurnUsage()).toHaveLength(0);
    store.close();
  });

  it("persists agent trace events and cascades them with the owning session", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-agent-trace-"));
    const sessionsRoot = path.join(stateDir, "sessions");
    const store = new StateStore(stateDir, sessionsRoot);
    await store.load();
    await store.upsertSession({
      key: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      workspacePath: "/tmp/sessions/C123-111.222/workspace",
      createdAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z",
    });

    await store.upsertAgentTraceEvent({
      id: "trace-1",
      sessionKey: "C123:111.222",
      source: "broker",
      type: "agent_user_message",
      at: "2026-03-15T00:00:01.000Z",
      sequence: 1,
      title: "用户消息",
      summary: "hello",
      detail: "hello",
      status: "received",
      role: "user",
      turnId: "turn-1",
      metadata: {
        sample: true,
      },
      createdAt: "2026-03-15T00:00:01.000Z",
      updatedAt: "2026-03-15T00:00:01.000Z",
    });

    expect(store.listAgentTraceEvents("C123:111.222")).toEqual([
      expect.objectContaining({
        id: "trace-1",
        sessionKey: "C123:111.222",
        source: "broker",
        type: "agent_user_message",
        summary: "hello",
        metadata: {
          sample: true,
        },
      }),
    ]);

    await store.deleteSession("C123:111.222");
    expect(store.listAgentTraceEvents("C123:111.222")).toHaveLength(0);
    store.close();
  });

  it("keeps agent trace summary updates bounded to the changed event", async () => {
    const source = await readCompanionSource(new URL("../src/store/state-store.ts", import.meta.url));
    const method = extractMethodBody(source, "async upsertAgentTraceEvent");

    expect(method).not.toContain("rebuildAgentSessionTraceSummary");
    expect(method).not.toMatch(/SELECT\s+[^`]*FROM agent_trace_events\s+WHERE session_key = \?/s);
  });

  it("updates agent trace summaries incrementally when tool results hide tool calls", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-agent-trace-summary-"));
    const sessionsRoot = path.join(stateDir, "sessions");
    const store = new StateStore(stateDir, sessionsRoot);
    await store.load();
    await store.upsertSession({
      key: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      workspacePath: "/tmp/sessions/C123-111.222/workspace",
      createdAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z",
    });

    await store.upsertAgentTraceEvent({
      id: "call-1",
      sessionKey: "C123:111.222",
      source: "agent_runtime",
      type: "agent_tool_call",
      at: "2026-03-15T00:00:01.000Z",
      sequence: 1,
      title: "exec_command",
      summary: "running",
      status: "running",
      role: "assistant",
      toolName: "exec_command",
      callId: "tool-call-1",
      turnId: "turn-1",
      createdAt: "2026-03-15T00:00:01.000Z",
      updatedAt: "2026-03-15T00:00:01.000Z",
    });
    await store.upsertAgentTraceEvent({
      id: "usage-1",
      sessionKey: "C123:111.222",
      source: "agent_runtime",
      type: "agent_token_count",
      at: "2026-03-15T00:00:02.000Z",
      sequence: 2,
      title: "Token",
      summary: "100 tokens",
      status: "completed",
      turnId: "turn-1",
      createdAt: "2026-03-15T00:00:02.000Z",
      updatedAt: "2026-03-15T00:00:02.000Z",
    });
    await store.upsertAgentTraceEvent({
      id: "result-1",
      sessionKey: "C123:111.222",
      source: "agent_runtime",
      type: "agent_tool_result",
      at: "2026-03-15T00:00:03.000Z",
      sequence: 3,
      title: "exec_command",
      summary: "done",
      status: "completed",
      role: "tool",
      toolName: "exec_command",
      callId: "tool-call-1",
      turnId: "turn-1",
      createdAt: "2026-03-15T00:00:03.000Z",
      updatedAt: "2026-03-15T00:00:03.000Z",
    });

    expect(store.getAgentSessionTraceSummary("C123:111.222")).toEqual(
      expect.objectContaining({
        eventCount: 1,
        modelRequestCount: 1,
        categories: {
          agent_tool_result: 1,
        },
        sources: {
          agent_runtime: 1,
        },
      }),
    );

    await store.upsertAgentTraceEvent({
      id: "result-1",
      sessionKey: "C123:111.222",
      source: "agent_runtime",
      type: "agent_assistant_message",
      at: "2026-03-15T00:00:03.000Z",
      sequence: 3,
      title: "Assistant",
      summary: "done",
      status: "completed",
      role: "assistant",
      toolName: "exec_command",
      callId: "tool-call-1",
      turnId: "turn-1",
      createdAt: "2026-03-15T00:00:03.000Z",
      updatedAt: "2026-03-15T00:00:04.000Z",
    });

    expect(store.getAgentSessionTraceSummary("C123:111.222")).toEqual(
      expect.objectContaining({
        eventCount: 2,
        modelRequestCount: 1,
        categories: {
          agent_assistant_message: 1,
          agent_tool_call: 1,
        },
        sources: {
          agent_runtime: 2,
        },
      }),
    );
    store.close();
  });

  it("does not prune realtime admin events on every append", async () => {
    const source = await readCompanionSource(new URL("../src/store/state-store.ts", import.meta.url));
    const method = extractMethodBody(source, "\n  privateAppendAdminEvent(");
    const pruneMethod = extractMethodBody(source, "\n  privatePruneAdminEvents(");

    expect(method).not.toMatch(/DELETE FROM admin_events[\s\S]*LIMIT \?/);
    expect(pruneMethod).not.toContain("NOT IN");
    expect(pruneMethod).not.toContain("LIMIT ?");
  });

  it("keeps Slack event retention out of the per-event hot path", async () => {
    const source = await readCompanionSource(new URL("../src/store/state-store.ts", import.meta.url));
    const processedPruneMethod = extractMethodBody(source, "\n  privatePruneProcessedEvents(");
    const doneSlackPruneMethod = extractMethodBody(source, "\n  privatePruneDoneSlackEvents(");

    expect(processedPruneMethod).toContain("PROCESSED_EVENT_PRUNE_INTERVAL");
    expect(processedPruneMethod).not.toContain("NOT IN");
    expect(processedPruneMethod).not.toMatch(/SELECT[\s\S]*LIMIT 2000[\s\S]*DELETE FROM processed_events/);
    expect(doneSlackPruneMethod).toContain("SLACK_DONE_EVENT_PRUNE_INTERVAL");
    expect(doneSlackPruneMethod).not.toContain("NOT IN");
    expect(doneSlackPruneMethod).not.toMatch(/SELECT[\s\S]*LIMIT 2000[\s\S]*DELETE FROM slack_events/);
  });
});
