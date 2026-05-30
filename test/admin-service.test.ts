import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { AdminService } from "../src/services/admin-service.js";
import { SessionManager } from "../src/services/session-manager.js";
import { StateStore } from "../src/store/state-store.js";

describe("AdminService", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((directory) =>
        fs.rm(directory, {
          force: true,
          recursive: true
        })
      )
    );
  });

  it("includes account rate limits in status output", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-"));
    tempDirs.push(dataRoot);

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);

    await fs.mkdir(config.codexHome, { recursive: true });
    await fs.mkdir(config.logDir, { recursive: true });
    await fs.writeFile(path.join(config.logDir, "broker.jsonl"), "", "utf8");

    const service = new AdminService({
      config,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      sessions: {
        listSessions: () => [],
        listInboundMessages: () => [],
        listBackgroundJobs: () => []
      } as never,
      authProfiles: {
        listProfilesStatus: async () => ({
          managedRoot: path.join(dataRoot, "auth-profiles"),
          profilesRoot: path.join(dataRoot, "auth-profiles", "docker", "profiles"),
          activeProfile: "primary",
          activeAuthPath: path.join(config.codexHome, "auth.json"),
          profiles: []
        })
      } as never,
      githubAuthorMappings: {
        load: async () => {},
        listMappings: () => []
      } as never,
      runtime: {
        restartRuntime: async () => {},
        readAccountSummary: async () => ({
          account: {
            email: "quota@example.com",
            type: "chatgpt",
            planType: "team"
          },
          requiresOpenaiAuth: false
        }),
        readAccountRateLimits: async () => ({
          rateLimits: {
            limitId: "codex",
            limitName: "Codex",
            primary: {
              usedPercent: 42,
              windowDurationMins: 300,
              resetsAt: 1_735_692_000
            },
            secondary: {
              usedPercent: 7,
              windowDurationMins: 10_080,
              resetsAt: 1_735_999_999
            },
            credits: {
              hasCredits: true,
              unlimited: false,
              balance: "18.75"
            },
            planType: "team"
          },
          rateLimitsByLimitId: {
            codex: {
              limitId: "codex",
              limitName: "Codex",
              primary: {
                usedPercent: 42,
                windowDurationMins: 300,
                resetsAt: 1_735_692_000
              },
              secondary: {
                usedPercent: 7,
                windowDurationMins: 10_080,
                resetsAt: 1_735_999_999
              },
              credits: {
                hasCredits: true,
                unlimited: false,
                balance: "18.75"
              },
              planType: "team"
            }
          }
        })
      } as never
    });

    const status = await service.getStatus();
    expect(status).toMatchObject({
      account: {
        ok: true,
        account: {
          email: "quota@example.com",
          type: "chatgpt",
          planType: "team"
        }
      },
      rateLimits: {
        ok: true,
        rateLimits: {
          limitId: "codex",
          planType: "team",
          credits: {
            balance: "18.75",
            hasCredits: true,
            unlimited: false
          }
        },
        rateLimitsByLimitId: {
          codex: {
            limitName: "Codex"
          }
        }
      },
      authProfiles: {
        activeProfile: "primary",
        profiles: []
      }
    });
  });

  it("reports independent Slack and Feishu platform health without exposing secrets", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-platforms-"));
    tempDirs.push(dataRoot);

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      FEISHU_ENABLED: "true",
      FEISHU_APP_ID: "cli-test",
      FEISHU_APP_SECRET: "secret-test",
      FEISHU_BOT_OPEN_ID: "ou_bot",
      FEISHU_GROUP_MESSAGE_MODE: "at_only",
      FEISHU_STARTUP_REQUIRED: "false",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);

    await fs.mkdir(config.codexHome, { recursive: true });
    await fs.mkdir(config.logDir, { recursive: true });
    await fs.writeFile(path.join(config.logDir, "broker.jsonl"), "", "utf8");

    const service = new AdminService({
      config,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      sessions: {
        listSessions: () => [],
        listInboundMessages: () => [],
        listBackgroundJobs: () => []
      } as never,
      authProfiles: {
        listProfilesStatus: async () => ({
          managedRoot: path.join(dataRoot, "auth-profiles"),
          profilesRoot: path.join(dataRoot, "auth-profiles", "docker", "profiles"),
          activeProfile: null,
          activeAuthPath: path.join(config.codexHome, "auth.json"),
          profiles: []
        })
      } as never,
      githubAuthorMappings: {
        load: async () => {},
        listMappings: () => []
      } as never,
      runtime: {
        restartRuntime: async () => {},
        readAccountSummary: async () => ({
          account: null,
          requiresOpenaiAuth: true
        }),
        readAccountRateLimits: async () => ({
          rateLimits: null,
          rateLimitsByLimitId: {}
        })
      } as never
    });

    const status = await service.getStatus();
    expect(status).toMatchObject({
      platforms: {
        slack: {
          platform: "slack",
          enabled: true,
          state: "ready",
          startupRequired: true,
          connection: {
            mode: "socket_mode",
            connected: false
          }
        },
        feishu: {
          platform: "feishu",
          enabled: true,
          state: "degraded",
          startupRequired: false,
          groupMessageMode: "at_only",
          allMessageDeliveryVerified: false,
          degradedReason: "group_message_all_unavailable",
          connection: {
            mode: "long_connection",
            connected: false
          },
          permissions: expect.arrayContaining([
            expect.objectContaining({
              name: "bot_identity",
              status: "configured"
            }),
            expect.objectContaining({
              name: "im:message.group_msg",
              status: "missing"
            })
          ])
        }
      }
    });
    expect(JSON.stringify(status)).not.toContain("secret-test");
    expect(JSON.stringify(status)).not.toContain(dataRoot);
    expect(status).toMatchObject({
      service: {
        sessionsRoot: "sessions (path redacted)",
        reposRoot: "repos (path redacted)",
        codexHome: "codex-home (path redacted)"
      },
      authFiles: {
        authJson: expect.objectContaining({
          path: "auth.json (path redacted)"
        })
      },
      authProfiles: {
        managedRoot: "auth-profiles (path redacted)",
        profilesRoot: "profiles (path redacted)",
        activeAuthPath: "auth.json (path redacted)"
      }
    });
  });

  it("redacts inbound message bodies from admin status summaries", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-inbound-redaction-"));
    tempDirs.push(dataRoot);

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      FEISHU_ENABLED: "true",
      FEISHU_APP_ID: "cli-test",
      FEISHU_APP_SECRET: "secret-test",
      FEISHU_BOT_OPEN_ID: "ou_bot",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);
    const sentinelBody = "FEISHU_SECRET_BODY_SENTINEL";
    const session = {
      key: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
      platform: "feishu",
      conversationId: "oc_group",
      conversationKind: "group",
      rootMessageId: "om_root",
      channelId: "oc_group",
      rootThreadTs: "om_root",
      workspacePath: path.join(config.sessionsRoot, "feishu"),
      createdAt: "2026-03-19T00:00:00.000Z",
      updatedAt: "2026-03-19T00:00:01.000Z"
    };

    await fs.mkdir(config.codexHome, { recursive: true });
    await fs.mkdir(config.logDir, { recursive: true });
    await fs.writeFile(path.join(config.logDir, "broker.jsonl"), "", "utf8");

    const service = new AdminService({
      config,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      sessions: {
        listSessions: () => [session],
        listInboundMessages: () => [
          {
            key: `${session.key}:om_pending`,
            sessionKey: session.key,
            channelId: "oc_group",
            rootThreadTs: "om_root",
            messageTs: "om_pending",
            source: "thread_reply",
            userId: "ou_user",
            text: sentinelBody,
            status: "pending",
            createdAt: "2026-03-19T00:00:00.000Z",
            updatedAt: "2026-03-19T00:00:01.000Z"
          }
        ],
        listBackgroundJobs: () => []
      } as never,
      authProfiles: {
        listProfilesStatus: async () => ({
          managedRoot: path.join(dataRoot, "auth-profiles"),
          profilesRoot: path.join(dataRoot, "auth-profiles", "docker", "profiles"),
          activeProfile: null,
          activeAuthPath: path.join(config.codexHome, "auth.json"),
          profiles: []
        })
      } as never,
      githubAuthorMappings: {
        load: async () => {},
        listMappings: () => []
      } as never,
      runtime: {
        restartRuntime: async () => {},
        readAccountSummary: async () => ({
          account: null,
          requiresOpenaiAuth: true
        }),
        readAccountRateLimits: async () => ({
          rateLimits: null,
          rateLimitsByLimitId: {}
        })
      } as never
    });

    const status = await service.getStatus({ platform: "feishu" });
    expect(JSON.stringify(status)).not.toContain(sentinelBody);
    expect(status).toMatchObject({
      state: {
        openInbound: [
          expect.objectContaining({
            textPreview: `message body redacted (${sentinelBody.length} chars)`,
            textLength: sentinelBody.length,
            textRedacted: true
          })
        ],
        sessions: [
          expect.objectContaining({
            openInbound: [
              expect.objectContaining({
                textPreview: `message body redacted (${sentinelBody.length} chars)`,
                textLength: sentinelBody.length,
                textRedacted: true
              })
            ]
          })
        ]
      }
    });
  });

  it("summarizes active sessions and background job errors without raw co-author ids or job secrets", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-job-redaction-"));
    tempDirs.push(dataRoot);

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      FEISHU_ENABLED: "true",
      FEISHU_APP_ID: "cli-test",
      FEISHU_APP_SECRET: "secret-test",
      FEISHU_BOT_OPEN_ID: "ou_bot",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);
    const session = {
      key: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
      platform: "feishu",
      conversationId: "oc_group",
      conversationKind: "group",
      rootMessageId: "om_root",
      channelId: "oc_group",
      rootThreadTs: "om_root",
      workspacePath: path.join(config.sessionsRoot, "feishu"),
      codexThreadId: "codex-secret-thread",
      activeTurnId: "turn-1",
      coAuthorCandidateUserIds: ["ou_secret_candidate"],
      coAuthorConfirmedUserIds: ["ou_secret_confirmed"],
      createdAt: "2026-03-19T00:00:00.000Z",
      updatedAt: "2026-03-19T00:00:01.000Z"
    };
    const jobError = "ADMIN_JOB_ERROR_SECRET";

    await fs.mkdir(config.codexHome, { recursive: true });
    await fs.mkdir(config.logDir, { recursive: true });
    await fs.writeFile(path.join(config.logDir, "broker.jsonl"), "", "utf8");

    const service = new AdminService({
      config,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      sessions: {
        listSessions: () => [session],
        listInboundMessages: () => [],
        listBackgroundJobs: () => [
          {
            id: "job-1",
            token: "ADMIN_JOB_TOKEN_SECRET",
            sessionKey: session.key,
            platform: "feishu",
            conversationId: "oc_group",
            rootMessageId: "om_root",
            channelId: "oc_group",
            rootThreadTs: "om_root",
            kind: "watch_ci",
            shell: "/bin/zsh",
            cwd: path.join(config.sessionsRoot, "feishu"),
            scriptPath: "/tmp/ADMIN_JOB_SCRIPT_SECRET.sh",
            restartOnBoot: true,
            status: "failed",
            error: jobError,
            createdAt: "2026-03-19T00:00:00.000Z",
            updatedAt: "2026-03-19T00:00:02.000Z"
          }
        ]
      } as never,
      authProfiles: {
        listProfilesStatus: async () => ({
          managedRoot: path.join(dataRoot, "auth-profiles"),
          profilesRoot: path.join(dataRoot, "auth-profiles", "docker", "profiles"),
          activeProfile: null,
          activeAuthPath: path.join(config.codexHome, "auth.json"),
          profiles: []
        })
      } as never,
      githubAuthorMappings: {
        load: async () => {},
        listMappings: () => []
      } as never,
      runtime: {
        restartRuntime: async () => {},
        readAccountSummary: async () => ({
          account: null,
          requiresOpenaiAuth: true
        }),
        readAccountRateLimits: async () => ({
          rateLimits: null,
          rateLimitsByLimitId: {}
        })
      } as never
    });

    const status = await service.getStatus({ platform: "feishu" });
    const serialized = JSON.stringify(status);

    expect(serialized).not.toContain("codex-secret-thread");
    expect(serialized).not.toContain("ou_secret_candidate");
    expect(serialized).not.toContain("ou_secret_confirmed");
    expect(serialized).not.toContain("ADMIN_JOB_TOKEN_SECRET");
    expect(serialized).not.toContain("ADMIN_JOB_SCRIPT_SECRET");
    expect(serialized).not.toContain(jobError);
    expect(serialized).not.toContain(dataRoot);
    expect(serialized).not.toContain(config.sessionsRoot);
    expect(status).toMatchObject({
      state: {
        activeSessions: [
          expect.objectContaining({
            key: session.key,
            platform: "feishu",
            activeTurnId: "turn-1",
            workspacePath: "feishu (path redacted)",
            workspacePathBasename: "feishu"
          })
        ],
        sessions: [
          expect.objectContaining({
            workspacePath: "feishu (path redacted)",
            workspacePathBasename: "feishu",
            backgroundJobs: [
              expect.objectContaining({
                id: "job-1",
                platform: "feishu",
                conversationId: "oc_group",
                rootMessageId: "om_root",
                kind: "watch_ci",
                status: "failed",
                cwd: "feishu (path redacted)",
                cwdBasename: "feishu",
                errorLength: jobError.length,
                errorRedacted: true
              })
            ]
          })
        ]
      }
    });
  });

  it("allowlists recent broker log metadata in admin status evidence", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-log-redaction-"));
    tempDirs.push(dataRoot);

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      FEISHU_ENABLED: "true",
      FEISHU_APP_ID: "cli-test",
      FEISHU_APP_SECRET: "secret-test",
      FEISHU_BOT_OPEN_ID: "ou_bot",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);
    const sentinelBody = "FEISHU_RECENT_LOG_SECRET_BODY";

    await fs.mkdir(config.codexHome, { recursive: true });
    await fs.mkdir(config.logDir, { recursive: true });
    await fs.writeFile(
      path.join(config.logDir, "broker.jsonl"),
      [
        JSON.stringify({
          ts: "2026-03-19T00:00:01.000Z",
          type: "log",
          level: "info",
          message: "chat.message.accepted",
          meta: {
            platform: "feishu",
            conversationId: "oc_group",
            conversationKind: "group",
            rootMessageId: "om_root",
            messageId: "om_msg",
            eventId: "evt_msg",
            jobId: "job-1",
            payloadRef: "Bearer admin-log-token",
            fileId: "xoxb-admin-secret",
            senderKind: "user",
            msgType: "text",
            route: "group_message",
            content: sentinelBody,
            rawPayload: {
              text: sentinelBody
            }
          }
        }),
        JSON.stringify({
          ts: "FEISHU_TIMESTAMP_SECRET_BODY",
          type: "log",
          level: "info",
          message: "FEISHU_RECENT_TOP_LEVEL_SECRET_BODY",
          meta: {
            platform: "feishu",
            conversationId: "oc_group"
          }
        }),
        `not json ${sentinelBody}`
      ].join("\n") + "\n",
      "utf8"
    );

    const status = await createAdminService(config, dataRoot).getStatus({ platform: "feishu" });
    expect(JSON.stringify(status)).not.toContain(sentinelBody);
    expect(JSON.stringify(status)).not.toContain("Bearer admin-log-token");
    expect(JSON.stringify(status)).not.toContain("xoxb-admin-secret");
    expect(JSON.stringify(status)).not.toContain("FEISHU_TIMESTAMP_SECRET_BODY");
    expect(JSON.stringify(status)).not.toContain("FEISHU_RECENT_TOP_LEVEL_SECRET_BODY");
    expect(status).toMatchObject({
      state: {
        recentBrokerLogs: expect.arrayContaining([
          expect.objectContaining({
            type: "log",
            message: "chat.message.accepted",
            meta: expect.objectContaining({
              platform: "feishu",
              conversationId: "oc_group",
              jobId: "job-1",
              messageId: "om_msg",
              route: "group_message"
            })
          }),
          expect.objectContaining({
            type: "log_parse_error",
            message: "unparseable broker log line"
          })
        ])
      }
    });
    const firstLog = (status.state as { recentBrokerLogs: Array<{ meta?: Record<string, unknown> }> }).recentBrokerLogs[0];
    expect(firstLog?.meta).not.toHaveProperty("content");
    expect(firstLog?.meta).not.toHaveProperty("rawPayload");
    expect(firstLog?.meta).not.toHaveProperty("payloadRef");
    expect(firstLog?.meta).not.toHaveProperty("fileId");
  });

  it("keeps meaningful broker evidence after sanitized timestamp-only noise", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-log-noise-"));
    tempDirs.push(dataRoot);
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      FEISHU_ENABLED: "true",
      FEISHU_APP_ID: "cli-test",
      FEISHU_APP_SECRET: "secret-test",
      FEISHU_BOT_OPEN_ID: "ou_bot",
      FEISHU_GROUP_MESSAGE_MODE: "all",
      FEISHU_ALL_MESSAGE_DELIVERY_VERIFIED: "true",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);
    const noise = Array.from({ length: 250 }, (_, index) => ({
      ts: `2026-03-19T00:${String(index).padStart(2, "0")}:00.000Z`,
      type: "log",
      level: "info",
      message: "Checking Slack threads for missed messages",
      meta: {
        reason: "periodic"
      }
    }));

    await fs.mkdir(config.logDir, { recursive: true });
    await fs.writeFile(
      path.join(config.logDir, "broker.jsonl"),
      [
        {
          ts: "2026-03-19T00:00:00.500Z",
          type: "log",
          level: "info",
          message: "chat.platform.ready",
          meta: {
            platform: "slack",
            source: "socket_mode",
            durationMs: 8
          }
        },
        {
          ts: "2026-03-19T00:00:01.000Z",
          type: "log",
          level: "info",
          message: "chat.platform.ready",
          meta: {
            platform: "feishu",
            source: "long_connection",
            groupMessageMode: "all",
            durationMs: 15
          }
        },
        ...noise
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
      "utf8"
    );

    const status = await createAdminService(config, dataRoot).getStatus({ platform: "feishu" });

    expect(status).toMatchObject({
      platforms: {
        slack: {
          connection: {
            connected: true,
            lastConnectedAt: "2026-03-19T00:00:00.500Z"
          }
        },
        feishu: {
          connection: {
            connected: true,
            lastConnectedAt: "2026-03-19T00:00:01.000Z"
          }
        }
      },
      state: {
        recentBrokerLogs: expect.arrayContaining([
          expect.objectContaining({
            message: "chat.platform.ready",
            meta: expect.objectContaining({
              platform: "feishu",
              source: "long_connection"
            })
          })
        ])
      }
    });
  });

  it("returns the full sanitized broker evidence window instead of truncating to forty logs", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-log-window-"));
    tempDirs.push(dataRoot);
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      FEISHU_ENABLED: "true",
      FEISHU_APP_ID: "cli-test",
      FEISHU_APP_SECRET: "secret-test",
      FEISHU_BOT_OPEN_ID: "ou_bot",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);

    await fs.mkdir(config.logDir, { recursive: true });
    await fs.writeFile(
      path.join(config.logDir, "broker.jsonl"),
      Array.from({ length: 60 }, (_, index) => JSON.stringify({
        ts: `2026-03-19T00:00:${String(index).padStart(2, "0")}.000Z`,
        type: "log",
        level: "info",
        message: "chat.message.accepted",
        meta: {
          platform: "feishu",
          conversationId: "oc_group",
          conversationKind: "group",
          rootMessageId: "om_root",
          messageId: `om_${index}`,
          eventId: `evt_${index}`,
          senderKind: "user",
          msgType: "text",
          route: "group_message"
        }
      })).join("\n") + "\n",
      "utf8"
    );

    const status = await createAdminService(config, dataRoot).getStatus({ platform: "feishu" });
    const logs = (status.state as { recentBrokerLogs: unknown[] }).recentBrokerLogs;

    expect(logs).toHaveLength(60);
    expect(logs[0]).toMatchObject({
      message: "chat.message.accepted",
      meta: {
        messageId: "om_0"
      }
    });
  });

  it("keeps Feishu all mode degraded until real all-message delivery smoke is verified", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-feishu-unverified-"));
    tempDirs.push(dataRoot);

    const unverifiedConfig = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      FEISHU_ENABLED: "true",
      FEISHU_APP_ID: "cli-test",
      FEISHU_APP_SECRET: "secret-test",
      FEISHU_BOT_OPEN_ID: "ou_bot",
      FEISHU_GROUP_MESSAGE_MODE: "all",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);

    const verifiedConfig = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      FEISHU_ENABLED: "true",
      FEISHU_APP_ID: "cli-test",
      FEISHU_APP_SECRET: "secret-test",
      FEISHU_BOT_OPEN_ID: "ou_bot",
      FEISHU_GROUP_MESSAGE_MODE: "all",
      FEISHU_ALL_MESSAGE_DELIVERY_VERIFIED: "true",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);

    await fs.mkdir(unverifiedConfig.codexHome, { recursive: true });
    await fs.mkdir(unverifiedConfig.logDir, { recursive: true });
    await fs.writeFile(path.join(unverifiedConfig.logDir, "broker.jsonl"), "", "utf8");

    const createService = (config: typeof unverifiedConfig) => new AdminService({
      config,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      sessions: {
        listSessions: () => [],
        listInboundMessages: () => [],
        listBackgroundJobs: () => []
      } as never,
      authProfiles: {
        listProfilesStatus: async () => ({
          managedRoot: path.join(dataRoot, "auth-profiles"),
          profilesRoot: path.join(dataRoot, "auth-profiles", "docker", "profiles"),
          activeProfile: null,
          activeAuthPath: path.join(config.codexHome, "auth.json"),
          profiles: []
        })
      } as never,
      githubAuthorMappings: {
        load: async () => {},
        listMappings: () => []
      } as never,
      runtime: {
        restartRuntime: async () => {},
        readAccountSummary: async () => ({
          account: null,
          requiresOpenaiAuth: true
        }),
        readAccountRateLimits: async () => ({
          rateLimits: null,
          rateLimitsByLimitId: {}
        })
      } as never
    });

    await expect(createService(unverifiedConfig).getStatus()).resolves.toMatchObject({
      platforms: {
        feishu: {
          state: "degraded",
          groupMessageMode: "all",
          allMessageDeliveryVerified: false,
          degradedReason: "all_message_delivery_unverified",
          connection: {
            mode: "long_connection",
            connected: false
          },
          permissions: expect.arrayContaining([
            expect.objectContaining({
              name: "im:message.group_msg",
              status: "configured"
            })
          ])
        }
      }
    });
    await expect(createService(verifiedConfig).getStatus()).resolves.toMatchObject({
      platforms: {
        feishu: {
          state: "ready",
          groupMessageMode: "all",
          allMessageDeliveryVerified: true,
          connection: {
            mode: "long_connection",
            connected: false
          },
          permissions: expect.arrayContaining([
            expect.objectContaining({
              name: "im:message.group_msg",
              status: "verified"
            })
          ])
        }
      }
    });
  });

  it("surfaces recent Feishu events and send failures in platform health", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-feishu-log-health-"));
    tempDirs.push(dataRoot);

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      FEISHU_ENABLED: "true",
      FEISHU_APP_ID: "cli-test",
      FEISHU_APP_SECRET: "secret-test",
      FEISHU_BOT_OPEN_ID: "ou_bot",
      FEISHU_GROUP_MESSAGE_MODE: "all",
      FEISHU_ALL_MESSAGE_DELIVERY_VERIFIED: "true",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);

    await fs.mkdir(config.codexHome, { recursive: true });
    await fs.mkdir(config.logDir, { recursive: true });
    await fs.writeFile(
      path.join(config.logDir, "broker.jsonl"),
      [
        {
          ts: "2026-03-19T00:00:00.500Z",
          type: "log",
          level: "info",
          message: "chat.platform.ready",
          meta: {
            platform: "slack",
            source: "socket_mode",
            durationMs: 8
          }
        },
        {
          ts: "2026-03-19T00:00:00.700Z",
          type: "log",
          level: "info",
          message: "chat.message.accepted",
          meta: {
            platform: "slack",
            conversationId: "C123",
            conversationKind: "channel",
            rootMessageId: "111.222",
            messageId: "111.223",
            eventId: "evt_slack",
            senderKind: "user",
            msgType: "text",
            route: "app_mention"
          }
        },
        {
          ts: "2026-03-19T00:00:00.800Z",
          type: "log",
          level: "info",
          message: "chat.outbound.posted",
          meta: {
            platform: "slack",
            sessionKey: "C123:111.222",
            conversationId: "C123",
            conversationKind: "channel",
            rootMessageId: "111.222",
            messageId: "111.224",
            format: "text",
            durationMs: 4
          }
        },
        {
          ts: "2026-03-19T00:00:01.000Z",
          type: "log",
          level: "info",
          message: "chat.platform.ready",
          meta: {
            platform: "feishu",
            source: "long_connection",
            groupMessageMode: "all",
            durationMs: 15
          }
        },
        {
          ts: "2026-03-19T00:00:02.000Z",
          type: "log",
          level: "info",
          message: "chat.message.accepted",
          meta: {
            platform: "feishu",
            conversationId: "oc_group",
            conversationKind: "group",
            rootMessageId: "om_root",
            messageId: "om_event",
            eventId: "evt_event",
            senderKind: "user",
            msgType: "text",
            route: "group_message"
          }
        },
        {
          ts: "2026-03-19T00:00:03.000Z",
          type: "log",
          level: "warn",
          message: "chat.outbound.failed",
          meta: {
            platform: "feishu",
            sessionKey: "feishu:b2NfZ3JvdXA:b21fcm9vdA",
            conversationId: "oc_group",
            rootMessageId: "om_root",
            format: "text",
            errorClass: "FeishuApiError",
            statusCode: 503,
            attempt: 1
          }
        }
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
      "utf8"
    );

    const status = await createAdminService(config, dataRoot).getStatus();

    expect(status).toMatchObject({
      platforms: {
        slack: {
          state: "ready",
          connection: {
            connected: true,
            lastConnectedAt: "2026-03-19T00:00:00.500Z"
          },
          lastEvent: {
            eventId: "evt_slack",
            messageId: "111.223",
            receivedAt: "2026-03-19T00:00:00.700Z"
          }
        },
        feishu: {
          state: "ready",
          connection: {
            connected: true,
            lastConnectedAt: "2026-03-19T00:00:01.000Z"
          },
          lastEvent: {
            eventId: "evt_event",
            messageId: "om_event",
            receivedAt: "2026-03-19T00:00:02.000Z"
          },
          lastError: {
            at: "2026-03-19T00:00:03.000Z",
            errorClass: "FeishuApiError",
            message: "chat.outbound.failed: 503"
          }
        }
      }
    });
    expect(JSON.stringify(status)).not.toContain("secret-test");
  });

  it("derives Slack platform health from Socket Mode logs", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-slack-log-health-"));
    tempDirs.push(dataRoot);

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);

    await fs.mkdir(config.codexHome, { recursive: true });
    await fs.mkdir(config.logDir, { recursive: true });
    const logFile = path.join(config.logDir, "broker.jsonl");
    await fs.writeFile(
      logFile,
      JSON.stringify({
        ts: "2026-03-19T00:00:01.000Z",
        type: "log",
        level: "info",
        message: "chat.platform.starting",
        meta: {
          platform: "slack",
          source: "socket_mode",
          startupRequired: true
        }
      }) + "\n",
      "utf8"
    );

    await expect(createAdminService(config, dataRoot).getStatus()).resolves.toMatchObject({
      platforms: {
        slack: {
          state: "starting",
          connection: {
            connected: false
          }
        }
      }
    });

    await fs.appendFile(
      logFile,
      JSON.stringify({
        ts: "2026-03-19T00:00:02.000Z",
        type: "log",
        level: "info",
        message: "chat.platform.ready",
        meta: {
          platform: "slack",
          source: "socket_mode",
          durationMs: 15
        }
      }) + "\n",
      "utf8"
    );

    await expect(createAdminService(config, dataRoot).getStatus()).resolves.toMatchObject({
      platforms: {
        slack: {
          state: "ready",
          connection: {
            connected: true,
            lastConnectedAt: "2026-03-19T00:00:02.000Z"
          }
        }
      }
    });

    await fs.appendFile(
      logFile,
      JSON.stringify({
        ts: "2026-03-19T00:00:03.000Z",
        type: "log",
        level: "warn",
        message: "chat.platform.degraded",
        meta: {
          platform: "slack",
          source: "socket_mode",
          startupRequired: true,
          degradedReason: "connection_closed"
        }
      }) + "\n",
      "utf8"
    );

    await expect(createAdminService(config, dataRoot).getStatus()).resolves.toMatchObject({
      platforms: {
        slack: {
          state: "degraded",
          connection: {
            connected: false,
            lastConnectedAt: "2026-03-19T00:00:02.000Z",
            lastDisconnectedAt: "2026-03-19T00:00:03.000Z"
          },
          lastError: {
            at: "2026-03-19T00:00:03.000Z",
            errorClass: "PlatformDegraded",
            message: "chat.platform.degraded: connection_closed"
          }
        }
      }
    });
  });

  it("surfaces Feishu long-connection disconnections separately from permission degradation", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-feishu-disconnected-"));
    tempDirs.push(dataRoot);

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      FEISHU_ENABLED: "true",
      FEISHU_APP_ID: "cli-test",
      FEISHU_APP_SECRET: "secret-test",
      FEISHU_BOT_OPEN_ID: "ou_bot",
      FEISHU_GROUP_MESSAGE_MODE: "all",
      FEISHU_ALL_MESSAGE_DELIVERY_VERIFIED: "true",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);

    await fs.mkdir(config.logDir, { recursive: true });
    await fs.writeFile(
      path.join(config.logDir, "broker.jsonl"),
      [
        {
          ts: "2026-03-19T00:00:01.000Z",
          type: "log",
          level: "info",
          message: "chat.platform.ready",
          meta: {
            platform: "feishu",
            source: "long_connection",
            groupMessageMode: "all",
            durationMs: 15
          }
        },
        {
          ts: "2026-03-19T00:00:02.000Z",
          type: "log",
          level: "warn",
          message: "chat.platform.degraded",
          meta: {
            platform: "feishu",
            source: "long_connection",
            groupMessageMode: "all",
            startupRequired: true,
            degradedReason: "connection_closed"
          }
        }
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
      "utf8"
    );

    await expect(createAdminService(config, dataRoot).getStatus()).resolves.toMatchObject({
      platforms: {
        feishu: {
          state: "degraded",
          degradedReason: undefined,
          connection: {
            connected: false,
            lastConnectedAt: "2026-03-19T00:00:01.000Z",
            lastDisconnectedAt: "2026-03-19T00:00:02.000Z"
          },
          lastError: {
            at: "2026-03-19T00:00:02.000Z",
            errorClass: "PlatformDegraded",
            message: "chat.platform.degraded: connection_closed"
          }
        }
      }
    });
  });

  it("reports Feishu startup progress and startup failure from platform logs", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-feishu-failed-"));
    tempDirs.push(dataRoot);

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      FEISHU_ENABLED: "true",
      FEISHU_APP_ID: "cli-test",
      FEISHU_APP_SECRET: "secret-test",
      FEISHU_BOT_OPEN_ID: "ou_bot",
      FEISHU_GROUP_MESSAGE_MODE: "all",
      FEISHU_ALL_MESSAGE_DELIVERY_VERIFIED: "true",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);

    await fs.mkdir(config.codexHome, { recursive: true });
    await fs.mkdir(config.logDir, { recursive: true });
    await fs.writeFile(
      path.join(config.logDir, "broker.jsonl"),
      [
        {
          ts: "2026-03-19T00:00:01.000Z",
          type: "log",
          level: "info",
          message: "chat.platform.starting",
          meta: {
            platform: "feishu",
            source: "long_connection",
            groupMessageMode: "all",
            startupRequired: true
          }
        }
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
      "utf8"
    );

    await expect(createAdminService(config, dataRoot).getStatus()).resolves.toMatchObject({
      platforms: {
        feishu: {
          state: "starting",
          connection: {
            connected: false
          }
        }
      }
    });

    await fs.appendFile(
      path.join(config.logDir, "broker.jsonl"),
      JSON.stringify(
        {
          ts: "2026-03-19T00:00:02.000Z",
          type: "log",
          level: "warn",
          message: "chat.platform.degraded",
          meta: {
            platform: "feishu",
            source: "long_connection",
            groupMessageMode: "all",
            startupRequired: true,
            degradedReason: "startup_failed",
            errorClass: "Error"
          }
        }
      ) + "\n",
      "utf8"
    );

    await expect(createAdminService(config, dataRoot).getStatus()).resolves.toMatchObject({
      platforms: {
        slack: {
          state: "ready"
        },
        feishu: {
          state: "failed",
          degradedReason: "startup_failed",
          connection: {
            connected: false
          },
          lastError: {
            at: "2026-03-19T00:00:02.000Z",
            errorClass: "Error",
            message: "chat.platform.degraded: startup_failed"
          }
        }
      }
    });
  });

  it("reports Feishu as disabled when FEISHU_ENABLED is false", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-feishu-disabled-"));
    tempDirs.push(dataRoot);

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);

    await fs.mkdir(config.codexHome, { recursive: true });
    await fs.mkdir(config.logDir, { recursive: true });
    await fs.writeFile(path.join(config.logDir, "broker.jsonl"), "", "utf8");

    const service = new AdminService({
      config,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      sessions: {
        listSessions: () => [],
        listInboundMessages: () => [],
        listBackgroundJobs: () => []
      } as never,
      authProfiles: {
        listProfilesStatus: async () => ({
          managedRoot: path.join(dataRoot, "auth-profiles"),
          profilesRoot: path.join(dataRoot, "auth-profiles", "docker", "profiles"),
          activeProfile: null,
          activeAuthPath: path.join(config.codexHome, "auth.json"),
          profiles: []
        })
      } as never,
      githubAuthorMappings: {
        load: async () => {},
        listMappings: () => []
      } as never,
      runtime: {
        restartRuntime: async () => {},
        readAccountSummary: async () => ({
          account: null,
          requiresOpenaiAuth: true
        }),
        readAccountRateLimits: async () => ({
          rateLimits: null,
          rateLimitsByLimitId: {}
        })
      } as never
    });

    await expect(service.getStatus()).resolves.toMatchObject({
      platforms: {
        feishu: {
          platform: "feishu",
          enabled: false,
          state: "disabled",
          startupRequired: true,
          groupMessageMode: "all",
          allMessageDeliveryVerified: false
        }
      }
    });
  });

  it("reloads persisted session state before reporting status", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-state-refresh-"));
    tempDirs.push(dataRoot);

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);

    await fs.mkdir(config.codexHome, { recursive: true });
    await fs.mkdir(config.logDir, { recursive: true });
    await fs.writeFile(path.join(config.logDir, "broker.jsonl"), "", "utf8");

    const stateStore = new StateStore(config.stateDir, config.sessionsRoot);
    const sessions = new SessionManager({
      stateStore,
      sessionsRoot: config.sessionsRoot
    });
    await sessions.load();

    const service = new AdminService({
      config,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      sessions,
      authProfiles: {
        listProfilesStatus: async () => ({
          managedRoot: path.join(dataRoot, "auth-profiles"),
          profilesRoot: path.join(dataRoot, "auth-profiles", "docker", "profiles"),
          activeProfile: null,
          activeAuthPath: path.join(config.codexHome, "auth.json"),
          profiles: []
        })
      } as never,
      githubAuthorMappings: {
        load: async () => {},
        listMappings: () => []
      } as never,
      runtime: {
        restartRuntime: async () => {},
        readAccountSummary: async () => ({
          account: {
            email: "quota@example.com",
            type: "chatgpt",
            planType: "team"
          },
          requiresOpenaiAuth: false
        }),
        readAccountRateLimits: async () => ({
          rateLimits: {
            limitId: "codex",
            limitName: "Codex",
            primary: {
              usedPercent: 42,
              windowDurationMins: 300,
              resetsAt: 1_735_692_000
            },
            secondary: null,
            credits: null,
            planType: "team"
          },
          rateLimitsByLimitId: {}
        })
      } as never
    });

    let status = await service.getStatus();
    expect(status).toMatchObject({
      state: {
        sessionCount: 0,
        activeCount: 0
      }
    });

    const writerStore = new StateStore(config.stateDir, config.sessionsRoot);
    const writerSessions = new SessionManager({
      stateStore: writerStore,
      sessionsRoot: config.sessionsRoot
    });
    await writerSessions.load();
    await writerSessions.ensureSession("C123", "111.222");
    await writerSessions.setActiveTurnId("C123", "111.222", "turn-1");
    await writerSessions.upsertInboundMessage({
      key: "C123:111.222:111.223",
      sessionKey: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      messageTs: "111.223",
      source: "thread_reply",
      userId: "U123",
      text: "follow up",
      status: "pending",
      createdAt: "2026-03-19T00:00:00.000Z",
      updatedAt: "2026-03-19T00:00:00.000Z"
    });

    status = await service.getStatus();
    expect(status).toMatchObject({
      state: {
        sessionCount: 1,
        activeCount: 1,
        openInboundCount: 1
      }
    });
  });

  it("filters session status by chat platform", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "admin-service-platform-filter-"));
    tempDirs.push(dataRoot);

    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      FEISHU_ENABLED: "true",
      FEISHU_APP_ID: "cli-test",
      FEISHU_APP_SECRET: "secret-test",
      FEISHU_BOT_OPEN_ID: "ou_bot",
      DATA_ROOT: dataRoot
    } as NodeJS.ProcessEnv);

    await fs.mkdir(config.codexHome, { recursive: true });
    await fs.mkdir(config.logDir, { recursive: true });
    await fs.writeFile(
      path.join(config.logDir, "broker.jsonl"),
      [
        {
          ts: "2026-03-19T00:00:00.000Z",
          type: "log",
          level: "info",
          message: "chat.message.accepted",
          meta: {
            platform: "slack",
            conversationId: "C123",
            rootMessageId: "111.222",
            messageId: "111.223",
            route: "app_mention"
          }
        },
        {
          ts: "2026-03-19T00:00:01.000Z",
          type: "log",
          level: "info",
          message: "chat.message.accepted",
          meta: {
            platform: "feishu",
            conversationId: "oc_group",
            rootMessageId: "om_root",
            messageId: "om_mention",
            route: "bot_mention"
          }
        }
      ].map((record) => JSON.stringify(record)).join("\n") + "\n",
      "utf8"
    );

    const stateStore = new StateStore(config.stateDir, config.sessionsRoot);
    const sessions = new SessionManager({
      stateStore,
      sessionsRoot: config.sessionsRoot
    });
    await sessions.load();
    await sessions.ensureSession("C123", "111.222");
    const feishuCoordinates = {
      platform: "feishu" as const,
      conversationId: "oc_group",
      rootMessageId: "om_root"
    };
    await sessions.ensureChatSession(feishuCoordinates, {
      conversationKind: "group",
      platformThreadId: "omt_thread"
    });
    await sessions.setChatActiveTurnId(feishuCoordinates, "turn-feishu");
    const githubAuthorMappings = [
      {
        platform: "slack",
        userId: "U_SLACK",
        slackUserId: "U_SLACK",
        githubAuthor: "Slack User <slack@example.com>",
        source: "manual",
        identity: {
          platform: "slack",
          userId: "U_SLACK",
          mention: "<@U_SLACK>"
        },
        slackIdentity: {
          userId: "U_SLACK",
          mention: "<@U_SLACK>"
        },
        updatedAt: "2026-03-19T00:00:00.000Z"
      },
      {
        platform: "feishu",
        userId: "ou_feishu",
        slackUserId: "ou_feishu",
        githubAuthor: "Feishu User <feishu@example.com>",
        source: "manual",
        identity: {
          platform: "feishu",
          userId: "ou_feishu",
          mention: "@ou_feishu"
        },
        slackIdentity: {
          userId: "ou_feishu",
          mention: "<@ou_feishu>"
        },
        updatedAt: "2026-03-19T00:00:01.000Z"
      }
    ];

    const service = new AdminService({
      config,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      sessions,
      authProfiles: {
        listProfilesStatus: async () => ({
          managedRoot: path.join(dataRoot, "auth-profiles"),
          profilesRoot: path.join(dataRoot, "auth-profiles", "docker", "profiles"),
          activeProfile: null,
          activeAuthPath: path.join(config.codexHome, "auth.json"),
          profiles: []
        })
      } as never,
      githubAuthorMappings: {
        load: async () => {},
        listMappings: () => githubAuthorMappings
      } as never,
      runtime: {
        restartRuntime: async () => {},
        readAccountSummary: async () => ({
          account: null,
          requiresOpenaiAuth: true
        }),
        readAccountRateLimits: async () => ({
          rateLimits: null,
          rateLimitsByLimitId: {}
        })
      } as never
    });

    const feishuStatus = await service.getStatus({ platform: "feishu" });
    expect(feishuStatus).toMatchObject({
      githubAuthorMappings: {
        count: 1,
        mappings: [
          expect.objectContaining({
            platform: "feishu",
            userId: "ou_feishu"
          })
        ]
      },
      state: {
        platform: "feishu",
        sessionCount: 1,
        activeCount: 1,
        recentBrokerLogs: expect.arrayContaining([
          expect.objectContaining({
            meta: expect.objectContaining({
              platform: "slack",
              conversationId: "C123"
            })
          }),
          expect.objectContaining({
            meta: expect.objectContaining({
              platform: "feishu",
              conversationId: "oc_group"
            })
          })
        ]),
        sessions: [
          expect.objectContaining({
            platform: "feishu",
            conversationId: "oc_group",
            conversationKind: "group",
            rootMessageId: "om_root",
            platformThreadId: "omt_thread",
            activeTurnId: "turn-feishu"
          })
        ]
      }
    });
    expect(JSON.stringify(feishuStatus)).not.toContain("U_SLACK");

    const slackStatus = await service.getStatus({ platform: "slack" });
    expect(slackStatus).toMatchObject({
      githubAuthorMappings: {
        count: 1,
        mappings: [
          expect.objectContaining({
            platform: "slack",
            userId: "U_SLACK"
          })
        ]
      },
      state: {
        platform: "slack",
        sessionCount: 1,
        activeCount: 0,
        sessions: [
          expect.objectContaining({
            platform: "slack",
            conversationId: "C123",
            rootMessageId: "111.222"
          })
        ]
      }
    });
    expect(JSON.stringify((slackStatus.state as { sessions: unknown[] }).sessions)).not.toContain("oc_group");
    expect(JSON.stringify(slackStatus.githubAuthorMappings)).not.toContain("ou_feishu");
  });
});

function createAdminService(config: ReturnType<typeof loadConfig>, dataRoot: string): AdminService {
  return new AdminService({
    config,
    startedAt: new Date("2026-03-19T00:00:00.000Z"),
    sessions: {
      listSessions: () => [],
      listInboundMessages: () => [],
      listBackgroundJobs: () => []
    } as never,
    authProfiles: {
      listProfilesStatus: async () => ({
        managedRoot: path.join(dataRoot, "auth-profiles"),
        profilesRoot: path.join(dataRoot, "auth-profiles", "docker", "profiles"),
        activeProfile: null,
        activeAuthPath: path.join(config.codexHome, "auth.json"),
        profiles: []
      })
    } as never,
    githubAuthorMappings: {
      load: async () => {},
      listMappings: () => []
    } as never,
    runtime: {
      restartRuntime: async () => {},
      readAccountSummary: async () => ({
        account: null,
        requiresOpenaiAuth: true
      }),
      readAccountRateLimits: async () => ({
        rateLimits: null,
        rateLimitsByLimitId: {}
      })
    } as never
  });
}
