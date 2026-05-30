import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createHttpHandler } from "../src/http/router.js";

describe("job routes", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("registers jobs with canonical platform-aware chat coordinates", async () => {
    const calls: unknown[] = [];
    const server = http.createServer(
      createHttpHandler({
        jobManager: {
          registerJob: async (payload: unknown) => {
            calls.push(payload);
            return {
              id: "job-1",
              token: "secret-token",
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
          }
        } as never,
        config: {
          serviceName: "test-broker"
        } as never
      })
    );
    const baseUrl = await listen(server);
    cleanups.push(() => close(server));

    const response = await fetch(`${baseUrl}/jobs/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        platform: "feishu",
        conversationId: "oc_group",
        rootMessageId: "om_root",
        kind: "watch_ci",
        cwd: ".",
        script: "node \"$BROKER_JOB_HELPER\" event --kind state_changed --summary done",
        restart_on_boot: false
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      job: {
        id: "job-1",
        status: "running",
        platform: "feishu",
        conversationId: "oc_group",
        rootMessageId: "om_root",
        channelId: "oc_group",
        rootThreadTs: "om_root"
      }
    });
    expect(calls).toEqual([
      {
        platform: "feishu",
        conversationId: "oc_group",
        rootMessageId: "om_root",
        channelId: undefined,
        rootThreadTs: undefined,
        kind: "watch_ci",
        script: "node \"$BROKER_JOB_HELPER\" event --kind state_changed --summary done",
        cwd: ".",
        shell: undefined,
        restartOnBoot: false
      }
    ]);
  });

  it("keeps legacy Slack job coordinates working", async () => {
    const calls: unknown[] = [];
    const server = http.createServer(
      createHttpHandler({
        jobManager: {
          registerJob: async (payload: unknown) => {
            calls.push(payload);
            return {
              id: "job-legacy",
              token: "secret-token",
              sessionKey: "C123:111.222",
              platform: "slack",
              conversationId: "C123",
              rootMessageId: "111.222",
              channelId: "C123",
              rootThreadTs: "111.222",
              kind: "watch_ci",
              shell: "sh",
              cwd: "/tmp/workspace",
              scriptPath: "/tmp/jobs/job-legacy/run.sh",
              restartOnBoot: true,
              status: "running",
              createdAt: "2026-05-29T00:00:00.000Z",
              updatedAt: "2026-05-29T00:00:00.000Z"
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

    const response = await fetch(`${baseUrl}/jobs/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        channel_id: "C123",
        thread_ts: "111.222",
        kind: "watch_ci",
        script: "sleep 30"
      })
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        platform: undefined,
        conversationId: undefined,
        rootMessageId: undefined,
        channelId: "C123",
        rootThreadTs: "111.222",
        kind: "watch_ci",
        script: "sleep 30",
        cwd: undefined,
        shell: undefined,
        restartOnBoot: true
      }
    ]);
  });

  it("documents generic job coordinates in missing-field errors", async () => {
    const server = http.createServer(
      createHttpHandler({
        jobManager: {} as never,
        config: {
          serviceName: "test-broker"
        } as never
      })
    );
    const baseUrl = await listen(server);
    cleanups.push(() => close(server));

    const response = await fetch(`${baseUrl}/jobs/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        kind: "watch_ci",
        script: "sleep 30"
      })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "missing_required_body",
      required: [
        "platform",
        "conversationId (alias: conversation_id)",
        "rootMessageId (alias: root_message_id)",
        "kind",
        "script"
      ],
      legacyAliases: ["channel_id", "thread_ts"]
    });
  });

  it("rejects invalid job platforms before missing-coordinate validation", async () => {
    const calls: unknown[] = [];
    const server = http.createServer(
      createHttpHandler({
        jobManager: {
          registerJob: async (payload: unknown) => {
            calls.push(payload);
            return {};
          }
        } as never,
        config: {
          serviceName: "test-broker"
        } as never
      })
    );
    const baseUrl = await listen(server);
    cleanups.push(() => close(server));

    const response = await fetch(`${baseUrl}/jobs/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        platform: "teams",
        kind: "watch_ci",
        script: "sleep 30"
      })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "invalid_platform",
      allowed: ["slack", "feishu"]
    });

    const nonStringPlatform = await fetch(`${baseUrl}/jobs/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        platform: 123,
        conversationId: "C123",
        rootMessageId: "111.222",
        kind: "watch_ci",
        script: "sleep 30"
      })
    });
    expect(nonStringPlatform.status).toBe(400);
    await expect(nonStringPlatform.json()).resolves.toEqual({
      ok: false,
      error: "invalid_platform",
      allowed: ["slack", "feishu"]
    });
    expect(calls).toEqual([]);
  });

  it("does not treat legacy Slack job coordinates as Feishu coordinates", async () => {
    const calls: unknown[] = [];
    const server = http.createServer(
      createHttpHandler({
        jobManager: {
          registerJob: async (payload: unknown) => {
            calls.push(payload);
            return {};
          }
        } as never,
        config: {
          serviceName: "test-broker"
        } as never
      })
    );
    const baseUrl = await listen(server);
    cleanups.push(() => close(server));

    const response = await fetch(`${baseUrl}/jobs/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        platform: "feishu",
        channel_id: "C123",
        thread_ts: "111.222",
        kind: "watch_ci",
        script: "sleep 30"
      })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "missing_required_body",
      required: [
        "platform",
        "conversationId (alias: conversation_id)",
        "rootMessageId (alias: root_message_id)",
        "kind",
        "script"
      ],
      legacyAliases: ["channel_id", "thread_ts"]
    });
    expect(calls).toEqual([]);
  });

  it("rejects invalid job details JSON fields before delegation", async () => {
    const calls: unknown[] = [];
    const server = http.createServer(
      createHttpHandler({
        jobManager: {
          emitJobEvent: async (...args: unknown[]) => {
            calls.push(["event", ...args]);
            return {};
          },
          completeJob: async (...args: unknown[]) => {
            calls.push(["complete", ...args]);
            return {};
          },
          failJob: async (...args: unknown[]) => {
            calls.push(["fail", ...args]);
            return {};
          }
        } as never,
        config: {
          serviceName: "test-broker"
        } as never
      })
    );
    const baseUrl = await listen(server);
    cleanups.push(() => close(server));

    const actionBodies: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      [
        "event",
        {
          token: "secret-token",
          event_kind: "state_changed",
          summary: "changed",
          details_json: "{not json"
        }
      ],
      [
        "complete",
        {
          token: "secret-token",
          summary: "done",
          detailsJson: "{not json"
        }
      ],
      [
        "fail",
        {
          token: "secret-token",
          summary: "failed",
          error: "failed",
          details_json: "{not json"
        }
      ]
    ];

    for (const [action, body] of actionBodies) {
      const response = await fetch(`${baseUrl}/jobs/job-1/${action}`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(body)
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: "invalid_json_field",
        field: "detailsJson (alias: details_json)"
      });
    }

    expect(calls).toEqual([]);
  });

  it("accepts canonical job details JSON aliases before delegation", async () => {
    const calls: unknown[] = [];
    const server = http.createServer(
      createHttpHandler({
        jobManager: {
          completeJob: async (...args: unknown[]) => {
            calls.push(args);
            return {
              id: "job-1",
              status: "completed"
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

    const response = await fetch(`${baseUrl}/jobs/job-1/complete`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        token: "secret-token",
        summary: "done",
        detailsJson: JSON.stringify({
          conclusion: "success"
        })
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      job: {
        id: "job-1",
        status: "completed"
      }
    });
    expect(calls).toEqual([
      [
        "job-1",
        "secret-token",
        {
          summary: "done",
          detailsText: undefined,
          detailsJson: {
            conclusion: "success"
          }
        }
      ]
    ]);
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
