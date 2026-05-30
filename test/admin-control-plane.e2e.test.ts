import fs from "node:fs/promises";

import http from "node:http";

import os from "node:os";

import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

import { createHttpHandler } from "../src/http/router.js";

import { AdminService } from "../src/services/admin-service.js";

import type { AuthProfilesStatus } from "../src/services/auth-profile-service.js";

import { SessionManager } from "../src/services/session-manager.js";

import { StateStore } from "../src/store/state-store.js";

import type { AppConfig } from "../src/config.js";

import type { PersistedAgentTraceEvent, PersistedBackgroundJob, PersistedInboundMessage } from "../src/types.js";

import { seedAgentTraceFixture, seedActiveSession, inboundMessage, backgroundJob, deploymentStatus, authProfilesStatusFixture, authProfileFixture, readJson, postJson } from "./admin-control-plane.e2e-helpers.js";

describe("admin control plane e2e", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  async function startAdminFixture(options?: { readonly authProfilesStatus?: AuthProfilesStatus | undefined; readonly workerBaseUrl?: string | undefined }): Promise<{
    readonly baseUrl: string;
    readonly config: AppConfig;
    readonly sessions: SessionManager;
    readonly deploymentCalls: Array<Record<string, unknown>>;
  }> {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-control-plane-"));
    cleanups.push(async () => {
      await fs.rm(dataRoot, { force: true, recursive: true });
    });

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot,
      SERVICE_ROOT: dataRoot,
      ADMIN_LAUNCHD_LABEL: "admin.test",
      WORKER_LAUNCHD_LABEL: "worker.test",
      ADMIN_PLIST_PATH: path.join(dataRoot, "admin.plist"),
      WORKER_PLIST_PATH: path.join(dataRoot, "worker.plist"),
      ...(options?.workerBaseUrl ? { WORKER_BASE_URL: options.workerBaseUrl } : {}),
    } as NodeJS.ProcessEnv);
    await fs.mkdir(config.codexHome, { recursive: true });
    await fs.mkdir(config.logDir, { recursive: true });

    const stateStore = new StateStore(config.stateDir, config.sessionsRoot);
    const sessions = new SessionManager({
      stateStore,
      sessionsRoot: config.sessionsRoot,
    });
    await sessions.load();
    cleanups.push(async () => {
      stateStore.close();
    });

    const deploymentCalls: Array<Record<string, unknown>> = [];
    const adminService = new AdminService({
      config,
      sessions,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      authProfiles: {
        listProfilesStatus: async () =>
          options?.authProfilesStatus ?? {
            managedRoot: path.join(dataRoot, "auth-profiles"),
            profilesRoot: path.join(dataRoot, "auth-profiles", "docker", "profiles"),
            profiles: [],
          },
        addProfile: async () => ({ name: "profile" }),
        deleteProfile: async () => {},
      } as never,
      githubAuthorMappings: {
        load: async () => {},
        listMappings: () => [],
        upsertManualMapping: async () => ({}),
        deleteMapping: async () => {},
      } as never,
      runtime: {
        restartRuntime: async () => {},
        readAccountSummary: async () => ({
          account: {
            email: "admin@example.com",
            type: "chatgpt",
            planType: "team",
          },
          requiresOpenaiAuth: false,
        }),
        readAccountRateLimits: async () => ({
          rateLimits: null,
          rateLimitsByLimitId: {},
        }),
      } as never,
      deployment: {
        getStatus: async () => deploymentStatus(config),
        deploy: async ({ target, version }: { readonly target: "admin" | "worker"; readonly version: string }) => {
          deploymentCalls.push({ kind: "deploy", target, version });
          return deploymentStatus(config);
        },
        rollback: async ({ target, version }: { readonly target: "admin" | "worker"; readonly version?: string | undefined }) => {
          deploymentCalls.push({ kind: "rollback", target, version: version ?? null });
          return deploymentStatus(config);
        },
        restartWorker: async () => {},
      } as never,
    });

    const server = http.createServer(
      createHttpHandler({
        adminService,
        config,
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start admin fixture");
    }

    return {
      baseUrl: `http://127.0.0.1:${address.port}`,
      config,
      sessions,
      deploymentCalls,
    };
  }

  it("exposes overview, sessions, timeline, and preflight as separate control-plane resources", async () => {
    const { baseUrl, sessions } = await startAdminFixture();
    await seedActiveSession(sessions);
    const agentSessionId = "019e022d-049b-7d32-a69b-d6d23b3773f2";
    await sessions.setAgentSessionId("C123", "111.222", agentSessionId);
    await seedAgentTraceFixture(sessions, "C123:111.222");

    const overview = await readJson(`${baseUrl}/admin/api/overview`);
    expect(overview).toMatchObject({
      ok: true,
      state: {
        activeCount: 1,
        openInboundCount: 0,
        runningBackgroundJobCount: 1,
      },
    });
    expect((overview.state as Record<string, unknown>).sessions).toBeUndefined();
    expect((overview.state as Record<string, unknown>).recentBrokerLogs).toBeUndefined();

    const sessionList = await readJson(`${baseUrl}/admin/api/sessions`);
    expect(sessionList).toMatchObject({
      ok: true,
      sessions: [
        {
          key: "C123:111.222",
          activeTurnId: "turn-1",
          channelLabel: "C123",
          threadUrl: "https://slack.com/app_redirect?channel=C123&message_ts=111.222",
          firstUserMessage: {
            textPreview: "initial request",
          },
          lastUserMessage: {
            textPreview: "follow up",
          },
          openInboundCount: 1,
          runningBackgroundJobCount: 1,
          backgroundJobCount: 3,
          failedBackgroundJobCount: 1,
        },
      ],
    });
    expect((sessionList.sessions as Array<Record<string, unknown>>)[0]).not.toHaveProperty("backgroundJobs");
    expect((sessionList.sessions as Array<Record<string, unknown>>)[0]).not.toHaveProperty("failedBackgroundJobs");
    expect((sessionList.sessions as Array<Record<string, unknown>>)[0]).not.toHaveProperty("workspacePath");

    const timeline = await readJson(`${baseUrl}/admin/api/sessions/${encodeURIComponent("C123:111.222")}/timeline`);
    expect(timeline).toMatchObject({
      ok: true,
      session: {
        key: "C123:111.222",
        agentSessionId,
        lastTurnSignalKind: "wait",
      },
      trace: {
        source: "broker_db",
        eventCount: 7,
        modelRequestCount: 1,
        categories: {
          agent_system_prompt: 1,
          agent_memory: 1,
          agent_user_message: 1,
          agent_runtime_reminder: 1,
          agent_assistant_message: 1,
          agent_tool_call: 1,
          agent_tool_result: 1,
        },
      },
    });
    expect(timeline.trace).not.toHaveProperty("rolloutPath");
    expect(JSON.stringify(timeline)).not.toContain(".jsonl");
    const trace = timeline.trace as { readonly categories?: Record<string, unknown> };
    const eventTypes = (timeline.events as Array<{ type: string; summary?: string }>).map((event) => event.type);
    expect(eventTypes).not.toContain("agent_token_count");
    expect(eventTypes).not.toContain("agent_input_delivered");
    expect(eventTypes).not.toContain("agent_turn_started");
    expect(eventTypes).not.toContain("agent_turn_completed");
    expect(trace.categories).not.toHaveProperty("agent_token_count");
    expect(JSON.stringify(timeline.events)).not.toContain("tokenUsage");
    expect(eventTypes).toEqual(["agent_system_prompt", "agent_memory", "agent_user_message", "agent_runtime_reminder", "agent_assistant_message", "agent_tool_call", "agent_tool_result"]);
    expect(eventTypes).not.toEqual(expect.arrayContaining(["session_created", "inbound_message", "background_job", "turn_signal"]));
    expect(timeline.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "agent_system_prompt",
          title: "系统 Prompt",
          detailAvailable: true,
        }),
        expect.objectContaining({
          type: "agent_memory",
          title: "记忆",
          detailAvailable: true,
        }),
        expect.objectContaining({
          type: "agent_user_message",
          title: "用户消息",
          detailAvailable: true,
        }),
        expect.objectContaining({
          type: "agent_runtime_reminder",
          title: "Runtime 提醒",
          detailAvailable: true,
        }),
        expect.objectContaining({
          type: "agent_assistant_message",
          title: "Assistant 消息",
          detailAvailable: true,
        }),
        expect.objectContaining({
          type: "agent_tool_call",
          title: "工具调用",
          toolName: "exec_command",
          detailAvailable: true,
        }),
        expect.objectContaining({
          type: "agent_tool_result",
          title: "工具结果",
          callId: "call-1",
          turnId: "turn-1",
          detailAvailable: true,
        }),
      ]),
    );
    expect(JSON.stringify(timeline.events)).not.toContain("System core instruction");
    const toolResultDetail = await readJson(`${baseUrl}/admin/api/sessions/${encodeURIComponent("C123:111.222")}/timeline-events/${encodeURIComponent("C123:111.222:runtime:tool-result")}`);
    expect(toolResultDetail).toMatchObject({
      ok: true,
      event: {
        detail: expect.stringContaining("PASS admin-control-plane"),
      },
    });

    const preflight = await readJson(`${baseUrl}/admin/api/preflight?operation=deploy`);
    expect(preflight).toMatchObject({
      ok: true,
      operation: "deploy",
      safe: false,
      requiresAllowActive: true,
      activeCount: 1,
      openInboundCount: 1,
      runningBackgroundJobCount: 1,
    });
    expect(preflight.impacts).toEqual(expect.arrayContaining([expect.objectContaining({ type: "active_turn", sessionKey: "C123:111.222" }), expect.objectContaining({ type: "open_inbound", sessionKey: "C123:111.222" }), expect.objectContaining({ type: "running_background_job", sessionKey: "C123:111.222" })]));
  });

  it("switches a blocked session auth profile and asks the worker to resume pending dispatch", async () => {
    const workerResumePaths: string[] = [];
    const worker = http.createServer((request, response) => {
      workerResumePaths.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, resumedCount: 1 }));
    });
    await new Promise<void>((resolve) => worker.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      await new Promise<void>((resolve, reject) => {
        worker.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    });
    const address = worker.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start worker fixture");
    }

    const { baseUrl, sessions } = await startAdminFixture({
      workerBaseUrl: `http://127.0.0.1:${address.port}`,
      authProfilesStatus: authProfilesStatusFixture(),
    });
    let session = await sessions.ensureSession("C123", "111.222");
    session = await sessions.setAgentSessionId(session.channelId, session.rootThreadTs, "old-thread");
    session = await sessions.setActiveTurnId(session.channelId, session.rootThreadTs, "old-turn");
    session = await sessions.setSessionAuthProfile(session.key, "empty-profile", {
      boundAt: "2026-05-09T00:00:00.000Z",
    });
    await sessions.markSessionAuthBlocked(session.key, {
      reason: "primary_quota_exhausted",
      blockedAt: "2026-05-09T01:00:00.000Z",
    });

    const result = await postJson(`${baseUrl}/admin/api/sessions/${encodeURIComponent(session.key)}/auth-profile`, { name: "usable-profile" });

    expect(result).toMatchObject({
      ok: true,
      workerResume: {
        ok: true,
        resumedCount: 1,
      },
      session: {
        key: session.key,
        authProfileName: "usable-profile",
        authBlockedAt: null,
        agentSessionId: null,
        activeTurnId: null,
      },
    });
    expect(workerResumePaths).toEqual([`/slack/sessions/${encodeURIComponent(session.key)}/resume-pending`]);
    expect(sessions.getSessionByKey(session.key)).toMatchObject({
      authProfileName: "usable-profile",
      authBlockedAt: undefined,
      authBlockReason: undefined,
      agentSessionId: undefined,
      activeTurnId: undefined,
    });
  });

  it("auto-allocates a blocked session auth profile and asks the worker to resume pending dispatch", async () => {
    const workerResumePaths: string[] = [];
    const worker = http.createServer((request, response) => {
      workerResumePaths.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, resumedCount: 1 }));
    });
    await new Promise<void>((resolve) => worker.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      await new Promise<void>((resolve, reject) => {
        worker.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    });
    const address = worker.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start worker fixture");
    }

    const { baseUrl, sessions } = await startAdminFixture({
      workerBaseUrl: `http://127.0.0.1:${address.port}`,
      authProfilesStatus: authProfilesStatusFixture(),
    });
    let session = await sessions.ensureSession("C123", "111.222");
    session = await sessions.setAgentSessionId(session.channelId, session.rootThreadTs, "old-thread");
    session = await sessions.setActiveTurnId(session.channelId, session.rootThreadTs, "old-turn");
    session = await sessions.setSessionAuthProfile(session.key, "empty-profile", {
      boundAt: "2026-05-09T00:00:00.000Z",
    });
    await sessions.markSessionAuthBlocked(session.key, {
      reason: "primary_quota_exhausted",
      blockedAt: "2026-05-09T01:00:00.000Z",
    });

    const result = await postJson(`${baseUrl}/admin/api/sessions/${encodeURIComponent(session.key)}/auth-profile`, { mode: "auto" });

    expect(result).toMatchObject({
      ok: true,
      selectedMode: "auto",
      selectedProfileName: "usable-profile",
      workerResume: {
        ok: true,
        resumedCount: 1,
      },
      session: {
        key: session.key,
        authProfileName: "usable-profile",
        authBlockedAt: null,
        agentSessionId: null,
        activeTurnId: null,
      },
    });
    expect(workerResumePaths).toEqual([`/slack/sessions/${encodeURIComponent(session.key)}/resume-pending`]);
    expect(sessions.getSessionByKey(session.key)).toMatchObject({
      authProfileName: "usable-profile",
      authBlockedAt: undefined,
      authBlockReason: undefined,
      agentSessionId: undefined,
      activeTurnId: undefined,
    });
    expect(sessions.listAgentTraceEvents(session.key, 10).at(-1)).toMatchObject({
      title: "Auth Profile 已切换",
      summary: "自动分配到 usable-profile，继续处理待处理消息",
      metadata: {
        profileName: "usable-profile",
        selectionMode: "auto",
      },
    });
  });
});
