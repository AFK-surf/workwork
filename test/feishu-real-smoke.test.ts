import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  AdminStatusFetchError,
  createFeishuSmokeUnavailableReport,
  evaluateFeishuSmokePreflight,
  evaluateFeishuSmokeStatus,
  evaluateFeishuSmokeStatusFile,
  evaluateFeishuSetupEvidence,
  formatFeishuSmokeCliError,
  loadFeishuSmokeEnv,
  parseFeishuSmokeEnvFile,
  renderFeishuSmokeBundleNotice,
  renderFeishuSmokeHumanReport,
  writeFeishuPreflightEvidenceBundle,
  writeFeishuSmokeEvidenceBundle
} from "./manual/run-real-feishu-smoke.js";

describe("real Feishu smoke evidence evaluator", () => {
  it("passes preflight when rollout environment is ready for production parity smoke", () => {
    const report = evaluateFeishuSmokePreflight({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      FEISHU_ENABLED: "true",
      FEISHU_APP_ID: "cli-test",
      FEISHU_APP_SECRET: "secret-test",
      FEISHU_BOT_OPEN_ID: "ou_bot",
      FEISHU_DOMAIN: "feishu",
      FEISHU_API_BASE_URL: "https://open.feishu.cn/open-apis",
      FEISHU_GROUP_MESSAGE_MODE: "all",
      FEISHU_STARTUP_REQUIRED: "true",
      FEISHU_ALL_MESSAGE_DELIVERY_VERIFIED: "false",
      LOG_RAW_FEISHU_EVENTS: "false",
      BROKER_ADMIN_TOKEN: "admin-test"
    });

    expect(report.ok).toBe(true);
    expect(report.checks.filter((check) => check.required && check.status !== "pass")).toEqual([]);
  });

  it("loads preflight posture from an explicit env file without leaking secret values", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-smoke-env-file-"));
    const envFile = path.join(tempDir, "broker.env");
    await fs.writeFile(envFile, [
      "# rollout smoke environment",
      "SLACK_APP_TOKEN=xapp-env-file-secret",
      "SLACK_BOT_TOKEN=xoxb-env-file-secret",
      "export FEISHU_ENABLED=true",
      "FEISHU_APP_ID=cli_env_file_secret",
      "FEISHU_APP_SECRET=\"feishu-env-file-secret\"",
      "FEISHU_BOT_OPEN_ID='ou_env_file_secret'",
      "FEISHU_DOMAIN=feishu",
      "FEISHU_API_BASE_URL=https://open.feishu.cn/open-apis?secret=query",
      "FEISHU_GROUP_MESSAGE_MODE=at_only",
      "FEISHU_STARTUP_REQUIRED=true",
      "FEISHU_ALL_MESSAGE_DELIVERY_VERIFIED=false",
      "LOG_RAW_FEISHU_EVENTS=false",
      "BROKER_ADMIN_TOKEN=admin-env-file-secret"
    ].join("\n"));

    const env = await loadFeishuSmokeEnv({
      FEISHU_API_BASE_URL: "https://open.feishu.cn/open-apis",
      FEISHU_GROUP_MESSAGE_MODE: "all"
    }, envFile);
    const report = evaluateFeishuSmokePreflight(env);
    const rendered = renderFeishuSmokeHumanReport(report, {
      baseUrl: "environment-preflight"
    });

    expect(report.ok).toBe(true);
    expect(report.checks.filter((check) => check.required && check.status !== "pass")).toEqual([]);
    expect(rendered).toContain("SLACK_APP_TOKEN=set");
    expect(rendered).toContain("FEISHU_APP_ID=set");
    expect(rendered).toContain("FEISHU_GROUP_MESSAGE_MODE=all");
    expect(rendered).not.toContain("xapp-env-file-secret");
    expect(rendered).not.toContain("xoxb-env-file-secret");
    expect(rendered).not.toContain("cli_env_file_secret");
    expect(rendered).not.toContain("feishu-env-file-secret");
    expect(rendered).not.toContain("ou_env_file_secret");
    expect(rendered).not.toContain("admin-env-file-secret");
  });

  it("loads preflight posture through the package-script --env-file path without leaking secret values", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-smoke-cli-env-file-"));
    const envFile = path.join(tempDir, "broker.env");
    await fs.writeFile(envFile, [
      "SLACK_APP_TOKEN=xapp-cli-secret",
      "SLACK_BOT_TOKEN=xoxb-cli-secret",
      "FEISHU_ENABLED=true",
      "FEISHU_APP_ID=cli_cli_secret",
      "FEISHU_APP_SECRET=feishu-cli-secret",
      "FEISHU_BOT_OPEN_ID=ou_cli_secret",
      "FEISHU_DOMAIN=feishu",
      "FEISHU_API_BASE_URL=https://open.feishu.cn/open-apis",
      "FEISHU_GROUP_MESSAGE_MODE=all",
      "FEISHU_STARTUP_REQUIRED=true",
      "FEISHU_ALL_MESSAGE_DELIVERY_VERIFIED=false",
      "LOG_RAW_FEISHU_EVENTS=false",
      "BROKER_ADMIN_TOKEN=admin-cli-secret"
    ].join("\n"));

    const result = await runFeishuSmokeCli([
      "--",
      "--preflight",
      `--env-file=${envFile}`,
      "--json"
    ]);
    const output = `${result.stdout}\n${result.stderr}`;
    const report = JSON.parse(result.stdout) as { readonly ok?: boolean };

    expect(result.exitCode).toBe(0);
    expect(report.ok).toBe(true);
    expect(output).toContain("SLACK_APP_TOKEN=set");
    expect(output).toContain("FEISHU_APP_ID=set");
    expect(output).not.toContain("xapp-cli-secret");
    expect(output).not.toContain("xoxb-cli-secret");
    expect(output).not.toContain("cli_cli_secret");
    expect(output).not.toContain("feishu-cli-secret");
    expect(output).not.toContain("ou_cli_secret");
    expect(output).not.toContain("admin-cli-secret");
  });

  it("rejects missing CLI option values before swallowing the next flag", async () => {
    const result = await runFeishuSmokeCli([
      "--base-url",
      "--json"
    ]);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.exitCode).toBe(1);
    expect(result.stdout.trim()).toBe("");
    expect(output).toContain("Missing value for --base-url");
    expect(output).not.toContain("Unknown argument");
  });

  it("rejects malformed env-file lines without echoing their content", () => {
    expect(() => parseFeishuSmokeEnvFile("FEISHU_APP_SECRET=secret\nnot a valid env secret\n")).toThrow(
      "Invalid env file line 2: expected KEY=value"
    );
  });

  it("accepts the China Feishu origin as an equivalent preflight API base", () => {
    const report = evaluateFeishuSmokePreflight({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      FEISHU_ENABLED: "true",
      FEISHU_APP_ID: "cli-test",
      FEISHU_APP_SECRET: "secret-test",
      FEISHU_BOT_OPEN_ID: "ou_bot",
      FEISHU_DOMAIN: "feishu",
      FEISHU_API_BASE_URL: "https://open.feishu.cn",
      FEISHU_GROUP_MESSAGE_MODE: "all",
      FEISHU_STARTUP_REQUIRED: "true",
      FEISHU_ALL_MESSAGE_DELIVERY_VERIFIED: "false",
      LOG_RAW_FEISHU_EVENTS: "false",
      BROKER_ADMIN_TOKEN: "admin-test"
    });

    expect(report.ok).toBe(true);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "preflight.feishu_api_base_china",
          status: "pass",
          evidence: expect.arrayContaining(["normalized_domain=https://open.feishu.cn"])
        })
      ])
    );
  });

  it("fails preflight with concrete actions for missing rollout environment", () => {
    const report = evaluateFeishuSmokePreflight({
      FEISHU_DOMAIN: "lark",
      FEISHU_API_BASE_URL: "https://open.larksuite.com/open-apis",
      FEISHU_GROUP_MESSAGE_MODE: "at_only",
      FEISHU_STARTUP_REQUIRED: "false",
      LOG_RAW_FEISHU_EVENTS: "true"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "preflight.slack_credentials_present",
          status: "fail"
        }),
        expect.objectContaining({
          id: "preflight.group_message_mode_all",
          status: "fail"
        }),
        expect.objectContaining({
          id: "preflight.feishu_bot_identity_present",
          status: "fail"
        }),
        expect.objectContaining({
          id: "preflight.raw_feishu_events_disabled",
          status: "fail"
        })
      ])
    );
    expect(report.nextActions.join("\n")).toContain("Set FEISHU_GROUP_MESSAGE_MODE=all");
  });

  it("keeps secret environment variable names visible while redacting unsafe evidence values", () => {
    const report = evaluateFeishuSmokePreflight({});
    const output = renderFeishuSmokeHumanReport(report, {
      baseUrl: "environment-preflight"
    });

    expect(output).toContain("FEISHU_APP_SECRET=missing");
    expect(output).toContain("Export FEISHU_APP_ID and FEISHU_APP_SECRET");
    expect(output).not.toContain("[redacted unsafe evidence]=missing");
  });

  it("omits query and hash values from preflight API base evidence", () => {
    const report = evaluateFeishuSmokePreflight({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      FEISHU_ENABLED: "true",
      FEISHU_APP_ID: "cli-test",
      FEISHU_APP_SECRET: "secret-test",
      FEISHU_BOT_OPEN_ID: "ou_bot",
      FEISHU_DOMAIN: "feishu",
      FEISHU_API_BASE_URL: "https://open.feishu.cn/open-apis?access_token=FEISHU_PREFLIGHT_SECRET#FEISHU_PREFLIGHT_HASH",
      FEISHU_GROUP_MESSAGE_MODE: "all",
      FEISHU_STARTUP_REQUIRED: "true",
      FEISHU_ALL_MESSAGE_DELIVERY_VERIFIED: "false",
      LOG_RAW_FEISHU_EVENTS: "false",
      BROKER_ADMIN_TOKEN: "admin-test"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "preflight.feishu_api_base_china",
          status: "fail",
          evidence: expect.arrayContaining([
            "FEISHU_API_BASE_URL=https://open.feishu.cn/open-apis (query/hash omitted)",
            "normalized_domain=invalid"
          ])
        })
      ])
    );
    expect(JSON.stringify(report)).not.toContain("FEISHU_PREFLIGHT_SECRET");
    expect(JSON.stringify(report)).not.toContain("FEISHU_PREFLIGHT_HASH");
  });

  it("does not echo invalid enum or boolean environment values in preflight evidence", () => {
    const report = evaluateFeishuSmokePreflight({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      FEISHU_ENABLED: "FEISHU_PREFLIGHT_ENABLED_SECRET",
      FEISHU_APP_ID: "cli-test",
      FEISHU_APP_SECRET: "secret-test",
      FEISHU_BOT_OPEN_ID: "ou_bot",
      FEISHU_DOMAIN: "FEISHU_PREFLIGHT_DOMAIN_SECRET",
      FEISHU_API_BASE_URL: "not-a-url-FEISHU_PREFLIGHT_API_SECRET",
      FEISHU_GROUP_MESSAGE_MODE: "FEISHU_PREFLIGHT_MODE_SECRET",
      FEISHU_STARTUP_REQUIRED: "FEISHU_PREFLIGHT_STARTUP_SECRET",
      FEISHU_ALL_MESSAGE_DELIVERY_VERIFIED: "FEISHU_PREFLIGHT_ALL_MESSAGES_SECRET",
      LOG_RAW_FEISHU_EVENTS: "FEISHU_PREFLIGHT_RAW_LOG_SECRET",
      BROKER_ADMIN_TOKEN: "admin-test"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "preflight.feishu_enabled",
          evidence: expect.arrayContaining(["FEISHU_ENABLED=invalid"])
        }),
        expect.objectContaining({
          id: "scope.china_feishu",
          evidence: expect.arrayContaining(["FEISHU_DOMAIN=invalid"])
        }),
        expect.objectContaining({
          id: "preflight.feishu_api_base_china",
          evidence: expect.arrayContaining(["FEISHU_API_BASE_URL=invalid_url"])
        }),
        expect.objectContaining({
          id: "preflight.group_message_mode_all",
          evidence: expect.arrayContaining(["FEISHU_GROUP_MESSAGE_MODE=invalid"])
        }),
        expect.objectContaining({
          id: "preflight.startup_required",
          evidence: expect.arrayContaining(["FEISHU_STARTUP_REQUIRED=invalid"])
        }),
        expect.objectContaining({
          id: "preflight.raw_feishu_events_disabled",
          evidence: expect.arrayContaining(["LOG_RAW_FEISHU_EVENTS=invalid"])
        }),
        expect.objectContaining({
          id: "preflight.all_message_delivery_flag",
          evidence: expect.arrayContaining(["FEISHU_ALL_MESSAGE_DELIVERY_VERIFIED=invalid"])
        })
      ])
    );
    expect(JSON.stringify(report)).not.toContain("FEISHU_PREFLIGHT_ENABLED_SECRET");
    expect(JSON.stringify(report)).not.toContain("FEISHU_PREFLIGHT_DOMAIN_SECRET");
    expect(JSON.stringify(report)).not.toContain("FEISHU_PREFLIGHT_API_SECRET");
    expect(JSON.stringify(report)).not.toContain("FEISHU_PREFLIGHT_MODE_SECRET");
    expect(JSON.stringify(report)).not.toContain("FEISHU_PREFLIGHT_STARTUP_SECRET");
    expect(JSON.stringify(report)).not.toContain("FEISHU_PREFLIGHT_ALL_MESSAGES_SECRET");
    expect(JSON.stringify(report)).not.toContain("FEISHU_PREFLIGHT_RAW_LOG_SECRET");
  });

  it("writes a reusable preflight evidence bundle", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-preflight-bundle-"));
    const report = evaluateFeishuSmokePreflight({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      FEISHU_ENABLED: "true",
      FEISHU_APP_ID: "cli-test",
      FEISHU_APP_SECRET: "secret-test",
      FEISHU_BOT_OPEN_ID: "ou_bot",
      FEISHU_DOMAIN: "feishu",
      FEISHU_API_BASE_URL: "https://open.feishu.cn/open-apis",
      FEISHU_GROUP_MESSAGE_MODE: "all",
      FEISHU_STARTUP_REQUIRED: "true",
      FEISHU_ALL_MESSAGE_DELIVERY_VERIFIED: "false",
      LOG_RAW_FEISHU_EVENTS: "false",
      BROKER_ADMIN_TOKEN: "admin-test"
    });

    const bundle = await writeFeishuPreflightEvidenceBundle({
      outputDir: tempDir,
      report
    });

    await expect(fs.readFile(bundle.reportFile, "utf8")).resolves.toContain("\"ok\": true");
    await expect(fs.readFile(bundle.summaryFile, "utf8")).resolves.toContain("environment-preflight");
  });

  it("passes when admin health and recent logs prove the required smoke gates", () => {
    const report = evaluateFeishuSmokeStatus({
      platforms: {
        ...passingPlatforms()
      },
      state: {
        sessions: [
          {
            platform: "feishu",
            key: "feishu:b2M:b20",
            conversationId: "oc",
            rootMessageId: "om"
          }
        ],
        recentBrokerLogs: [
          slackLog("chat.message.accepted"),
          slackLog("chat.outbound.posted"),
          log("chat.platform.ready", { platform: "feishu" }),
          log("chat.message.accepted", { platform: "feishu", route: "bot_mention", msgType: "text" }),
          log("chat.session.created", { platform: "feishu", sessionKey: "feishu:b2M:b20" }),
          log("chat.message.ignored", {
            platform: "feishu",
            conversationId: "oc_direct",
            conversationKind: "direct",
            rootMessageId: "om_direct",
            messageId: "om_direct",
            ignoredReason: "ignored_private_chat"
          }),
          log("chat.message.ignored", {
            platform: "feishu",
            conversationId: "oc",
            conversationKind: "group",
            rootMessageId: "om",
            messageId: "om_self",
            eventId: "evt_self",
            senderKind: "app",
            ignoredReason: "ignored_self",
            route: "ignored_self"
          }),
          log("chat.message.accepted", { platform: "feishu", route: "group_message", messageId: "om_duplicate", eventId: "evt_duplicate" }),
          log("chat.message.deduped", { platform: "feishu", route: "deduped", messageId: "om_duplicate", eventId: "evt_duplicate_replay" }),
          log("chat.platform.degraded", { platform: "feishu", degradedReason: "startup_failed" }),
          log("chat.outbound.failed", { platform: "feishu", errorClass: "Error", statusCode: 503, attempt: 1 }),
          log("chat.turn.started", { platform: "feishu" }),
          log("chat.outbound.posted", { platform: "feishu", format: "text" }),
          log("chat.turn.completed", { platform: "feishu" }),
          ...feishuOutboundRichCardFileLogs(),
          log("chat.message.accepted", { platform: "feishu", route: "group_message", msgType: "text" }),
          log("chat.turn.steered", { platform: "feishu" }),
          log("chat.message.accepted", { platform: "feishu", route: "group_message", msgType: "text", messageId: "om_stop", eventId: "evt_stop" }),
          log("chat.session.resumed", { platform: "feishu", messageId: "om_stop", turnId: "turn-1" }),
          log("chat.turn.stopped", { platform: "feishu", messageId: "om_stop" }),
          log("chat.turn.steered", { platform: "feishu", source: "history_recovery", messageId: "om_recovered", batchId: "history:om_recovered" }),
          log("chat.history.recovered", { platform: "feishu" }),
          log("chat.message.accepted", { platform: "feishu", msgType: "rich_text", messageId: "om_rich" }),
          log("chat.message.accepted", { platform: "feishu", msgType: "card", messageId: "om_card_payload" }),
          log("chat.message.accepted", { platform: "feishu", msgType: "image", messageId: "om_image" }),
          log("chat.message.accepted", { platform: "feishu", msgType: "file", messageId: "om_file" }),
          log("chat.card.callback.received", { platform: "feishu", messageId: "om_card_reply", kind: "coauthor_confirm_all", candidateRevision: 1 }),
          log("chat.coauthor.confirmed", { platform: "feishu", candidateRevision: 1, confirmedCount: 1 })
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(true);
    expect(report.checks.filter((check) => check.required && check.status !== "pass")).toEqual([]);
  });

  it("requires Feishu behavior coverage for deduped, degraded, and failed outcomes", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.filter((record) => {
          const message = (record as { readonly message?: string }).message;
          return message !== "chat.message.deduped" &&
            message !== "chat.platform.degraded" &&
            message !== "chat.outbound.failed";
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "observability.behavior_coverage",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("missing behavior evidence: deduped, degraded, failed")
          ])
        })
      ])
    );
  });

  it("requires degraded behavior coverage to use a known Feishu degradation reason", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.platform.degraded") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              degradedReason: "unknown_fake_reason"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "observability.behavior_coverage",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("missing behavior evidence: degraded")
          ])
        })
      ])
    );
  });

  it("requires accepted behavior coverage to target a known Feishu session", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs.filter((record) => {
            const message = (record as { readonly message?: string }).message;
            return message !== "chat.message.accepted" && message !== "chat.message.deduped";
          }),
          log("chat.message.accepted", {
            platform: "feishu",
            conversationId: "oc_orphan",
            rootMessageId: "om_orphan",
            messageId: "om_orphan",
            eventId: "evt_orphan",
            route: "bot_mention"
          }),
          log("chat.message.deduped", {
            platform: "feishu",
            conversationId: "oc_orphan",
            rootMessageId: "om_orphan",
            messageId: "om_orphan",
            eventId: "evt_orphan",
            route: "deduped"
          })
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.duplicate_deduped",
          status: "fail"
        }),
        expect.objectContaining({
          id: "observability.behavior_coverage",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("missing behavior evidence: accepted, deduped")
          ])
        })
      ])
    );
  });

  it("does not count accepted behavior coverage when accepted messages have ignored twins", () => {
    const status = passingStatus();
    const acceptedIgnoredTwins = status.state.recentBrokerLogs.flatMap((record) => {
      const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
      if (logRecord.message !== "chat.message.accepted" || logRecord.meta?.platform !== "feishu") {
        return [];
      }

      return [
        log("chat.message.ignored", {
          platform: "feishu",
          conversationId: logRecord.meta.conversationId,
          conversationKind: "group",
          rootMessageId: logRecord.meta.rootMessageId,
          messageId: logRecord.meta.messageId,
          eventId: logRecord.meta.eventId,
          ignoredReason: "ignored_no_active_session",
          route: "ignored_no_active_session"
        })
      ];
    });
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs,
          ...acceptedIgnoredTwins
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "observability.behavior_coverage",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("missing behavior evidence: accepted, deduped")
          ])
        })
      ])
    );
  });

  it("requires coordinate-bearing failed behavior evidence to target a known Feishu session", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.outbound.failed") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              sessionKey: "feishu:b3RoZXI:b3RoZXI",
              conversationId: "oc_other",
              rootMessageId: "om_other"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "observability.behavior_coverage",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("missing behavior evidence: failed")
          ])
        })
      ])
    );
  });

  it("reports session-matching failed behavior evidence instead of later unrelated failed logs", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs,
          log("chat.outbound.failed", {
            platform: "feishu",
            sessionKey: "feishu:b3RoZXI:b3RoZXI",
            conversationId: "oc_orphan_failed",
            rootMessageId: "om_orphan_failed",
            messageId: "om_orphan_failed",
            errorClass: "Error",
            statusCode: 503,
            attempt: 1
          })
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    const behaviorCoverage = report.checks.find((check) => check.id === "observability.behavior_coverage");
    const evidence = behaviorCoverage?.evidence.join("\n") ?? "";

    expect(report.ok).toBe(true);
    expect(behaviorCoverage).toMatchObject({
      status: "pass"
    });
    expect(evidence).toContain("outbound_failed: chat.outbound.failed feishu long_connection feishu:b2M:b20 oc om om");
    expect(evidence).not.toContain("oc_orphan_failed");
  });

  it("reports accepted-message-matching deduped behavior evidence instead of later unrelated deduped logs", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs,
          log("chat.message.deduped", {
            platform: "feishu",
            sessionKey: "feishu:b3RoZXI:b3RoZXI",
            conversationId: "oc_orphan_deduped",
            rootMessageId: "om_orphan_deduped",
            messageId: "om_orphan_deduped",
            eventId: "evt_orphan_deduped",
            route: "deduped"
          })
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    const behaviorCoverage = report.checks.find((check) => check.id === "observability.behavior_coverage");
    const evidence = behaviorCoverage?.evidence.join("\n") ?? "";

    expect(report.ok).toBe(true);
    expect(behaviorCoverage).toMatchObject({
      status: "pass"
    });
    expect(evidence).toContain("deduped: chat.message.deduped feishu long_connection feishu:b2M:b20 oc om om_duplicate deduped");
    expect(evidence).not.toContain("oc_orphan_deduped");
  });

  it("requires detached Feishu handler failure evidence to name a known handler", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs.filter((record) =>
            (record as { readonly message?: string }).message !== "chat.outbound.failed"
          ),
          log("chat.handler.failed", {
            platform: "feishu",
            handler: "unknown_handler",
            errorClass: "Error"
          })
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "observability.required_log_fields",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("chat.handler.failed: missing handler=message|interactive")
          ])
        }),
        expect.objectContaining({
          id: "observability.behavior_coverage",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("missing behavior evidence: failed")
          ])
        })
      ])
    );
  });

  it("requires detached Feishu handler failure evidence to include an error class", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs.filter((record) =>
            (record as { readonly message?: string }).message !== "chat.outbound.failed"
          ),
          log("chat.handler.failed", {
            platform: "feishu",
            handler: "message"
          })
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "observability.required_log_fields",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("chat.handler.failed: missing errorClass")
          ])
        }),
        expect.objectContaining({
          id: "observability.behavior_coverage",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("missing behavior evidence: failed")
          ])
        })
      ])
    );
  });

  it("requires duplicate evidence to reference an accepted Feishu message", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.message.deduped") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              messageId: "om_unmatched_duplicate"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.duplicate_deduped",
          status: "fail"
        }),
        expect.objectContaining({
          id: "observability.behavior_coverage",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("missing behavior evidence: deduped")
          ])
        })
      ])
    );
  });

  it("requires duplicate evidence to match the accepted Feishu conversation", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.message.deduped") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              conversationId: "oc_other"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.duplicate_deduped",
          status: "fail"
        }),
        expect.objectContaining({
          id: "observability.behavior_coverage",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("missing behavior evidence: deduped")
          ])
        })
      ])
    );
  });

  it("requires duplicate replay evidence not to create a second turn after dedupe", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs,
          log("chat.turn.started", {
            platform: "feishu",
            messageId: "om_duplicate",
            batchId: "om_duplicate",
            turnId: "turn-duplicate"
          })
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.duplicate_deduped",
          status: "fail"
        }),
        expect.objectContaining({
          id: "observability.behavior_coverage",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("missing behavior evidence: deduped")
          ])
        })
      ])
    );
  });

  it("requires recovered behavior coverage to include delivered history evidence", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.history.recovered") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              recoveredCount: 0
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "observability.behavior_coverage",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("missing behavior evidence: recovered")
          ])
        })
      ])
    );
  });

  it("reports same-session recovered behavior evidence instead of later unrelated recovery logs", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs,
          log("chat.turn.steered", {
            platform: "feishu",
            source: "history_recovery",
            sessionKey: "feishu:b3RoZXI:b3RoZXI",
            conversationId: "oc_orphan_recovered",
            rootMessageId: "om_orphan_recovered",
            messageId: "om_orphan_recovered",
            batchId: "history:om_orphan_recovered"
          }),
          log("chat.history.recovered", {
            platform: "feishu",
            sessionKey: "feishu:b3RoZXI:b3RoZXI",
            conversationId: "oc_orphan_recovered",
            rootMessageId: "om_orphan_recovered",
            messageId: "om_orphan_recovered",
            messageCursor: "1710000999000",
            recoveredCount: 1
          })
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    const behaviorCoverage = report.checks.find((check) => check.id === "observability.behavior_coverage");
    const evidence = behaviorCoverage?.evidence.join("\n") ?? "";

    expect(report.ok).toBe(true);
    expect(behaviorCoverage).toMatchObject({
      status: "pass"
    });
    expect(evidence).toContain("recovered: chat.turn.steered feishu history_recovery feishu:b2M:b20 oc om om_recovered");
    expect(evidence).toContain("recovered: chat.history.recovered feishu long_connection feishu:b2M:b20 oc om om");
    expect(evidence).not.toContain("oc_orphan_recovered");
  });

  it("requires Slack event and reply evidence in the shared runtime", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.filter((record) =>
          (record as { readonly meta?: { readonly platform?: string } }).meta?.platform !== "slack"
        )
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "slack.message_roundtrip",
          status: "fail"
        })
      ])
    );
  });

  it("requires Slack event and reply evidence to target the same session", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.outbound.posted" || logRecord.meta?.platform !== "slack") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              sessionKey: "slack:QzEyMw:OTk5LjAwMA",
              conversationId: "C123",
              rootMessageId: "999.000"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "slack.message_roundtrip",
          status: "fail"
        })
      ])
    );
  });

  it("requires Slack reply evidence to occur after the matching Slack event", () => {
    const status = passingStatus();
    const slackLogs = status.state.recentBrokerLogs.filter((record) =>
      (record as { readonly meta?: { readonly platform?: string } }).meta?.platform === "slack"
    );
    const nonSlackLogs = status.state.recentBrokerLogs.filter((record) => !slackLogs.includes(record));
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...slackLogs.toReversed(),
          ...nonSlackLogs
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "slack.message_roundtrip",
          status: "fail"
        })
      ])
    );
  });

  it("requires Slack accepted event evidence to include a message id", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.message.accepted" || logRecord.meta?.platform !== "slack") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              messageId: undefined
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "slack.message_roundtrip",
          status: "fail"
        })
      ])
    );
  });

  it("requires Slack reply evidence to include the posted message id", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.outbound.posted" || logRecord.meta?.platform !== "slack") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              messageId: undefined
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "slack.message_roundtrip",
          status: "fail"
        })
      ])
    );
  });

  it("reports matching Slack roundtrip evidence instead of later unrelated Slack logs", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs,
          {
            ...slackLog("chat.message.accepted"),
            meta: {
              ...slackLog("chat.message.accepted").meta,
              sessionKey: "slack:Qzk5OQ:MTExLjAwMA",
              conversationId: "C999",
              rootMessageId: "111.000",
              messageId: "111.001"
            }
          },
          {
            ...slackLog("chat.outbound.posted"),
            meta: {
              ...slackLog("chat.outbound.posted").meta,
              sessionKey: "slack:Qzg4OA:MjIyLjAwMA",
              conversationId: "C888",
              rootMessageId: "222.000",
              messageId: "222.001"
            }
          }
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    const roundtrip = report.checks.find((check) => check.id === "slack.message_roundtrip");
    const evidence = roundtrip?.evidence.join("\n") ?? "";

    expect(report.ok).toBe(true);
    expect(roundtrip).toMatchObject({
      status: "pass"
    });
    expect(evidence).toContain("chat.message.accepted slack slack:QzEyMw:MTExLjIyMg C123 111.222");
    expect(evidence).toContain("chat.outbound.posted slack slack:QzEyMw:MTExLjIyMg C123 111.222");
    expect(evidence).not.toContain("C999");
    expect(evidence).not.toContain("C888");
  });

  it("requires Slack Socket Mode ready evidence, not only a ready health state", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      platforms: {
        ...status.platforms,
        slack: {
          state: "ready",
          connection: {
            mode: "socket_mode",
            connected: false
          }
        }
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "slack.socket_mode_ready",
          status: "fail",
          evidence: expect.arrayContaining([
            "platforms.slack.state=ready",
            "connection.mode=socket_mode",
            "connection.connected=false",
            "connection.lastConnectedAt=missing"
          ])
        })
      ])
    );
  });

  it("accepts saved Slack lifecycle log evidence for Socket Mode readiness", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      platforms: {
        ...status.platforms,
        slack: {
          state: "ready",
          connection: {
            mode: "socket_mode",
            connected: true,
            lastConnectedAt: "2026-03-19T00:00:01.000Z"
          }
        }
      },
      state: {
        ...status.state,
        recentBrokerLogs: [
          slackPlatformLog("chat.platform.ready"),
          ...status.state.recentBrokerLogs
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(true);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "slack.socket_mode_ready",
          status: "pass",
          evidence: expect.arrayContaining([
            expect.stringContaining("chat.platform.ready slack socket_mode")
          ])
        })
      ])
    );
  });

  it("requires real Feishu long-connection ready evidence, not only a ready health state", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      platforms: {
        ...status.platforms,
        feishu: {
          enabled: true,
          state: "ready",
          groupMessageMode: "all",
          allMessageDeliveryVerified: true
        }
      },
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.filter((record) =>
          (record as { readonly message?: string }).message !== "chat.platform.ready"
        )
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.long_connection_ready",
          status: "fail",
          evidence: expect.arrayContaining([
            "platforms.feishu.state=ready",
            "connection.mode=unknown",
            "connection.lastConnectedAt=missing"
          ])
        })
      ])
    );
  });

  it("requires current Feishu admin health to be ready, not only an older ready log", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      platforms: {
        ...status.platforms,
        feishu: {
          ...passingPlatforms().feishu,
          enabled: true,
          state: "degraded",
          degradedReason: "connection_closed",
          groupMessageMode: "all",
          allMessageDeliveryVerified: true,
          connection: {
            mode: "long_connection",
            connected: false,
            lastConnectedAt: "2026-03-19T00:00:02.000Z",
            lastDisconnectedAt: "2026-03-19T00:00:03.000Z"
          }
        }
      },
      state: {
        ...status.state,
        recentBrokerLogs: [
          log("chat.platform.ready", { platform: "feishu" }),
          ...status.state.recentBrokerLogs
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "runtime.feishu_ready",
          status: "fail",
          evidence: expect.arrayContaining(["platforms.feishu.state=degraded"])
        })
      ])
    );
  });

  it("accepts saved admin connection evidence for Feishu long-connection readiness", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      platforms: {
        ...passingPlatforms(),
        feishu: {
          ...passingPlatforms().feishu,
          enabled: true,
          state: "ready",
          groupMessageMode: "all",
          allMessageDeliveryVerified: true,
          connection: {
            mode: "long_connection",
            connected: true,
            lastConnectedAt: "2026-03-19T00:00:02.000Z"
          }
        }
      },
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.filter((record) =>
          (record as { readonly message?: string }).message !== "chat.platform.ready"
        )
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(true);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.long_connection_ready",
          status: "pass",
          evidence: expect.arrayContaining([
            "connection.mode=long_connection",
            "connection.connected=true",
            "connection.lastConnectedAt=2026-03-19T00:00:02.000Z"
          ])
        })
      ])
    );
  });

  it("requires admin health to expose platform connection and Feishu permission posture", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      platforms: {
        slack: {
          state: "ready"
        },
        feishu: {
          enabled: true,
          state: "ready",
          groupMessageMode: "all",
          allMessageDeliveryVerified: true
        }
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "admin.platform_health_contract",
          status: "fail",
          evidence: expect.arrayContaining([
            "slack.connection.mode=unknown",
            "feishu.connection.mode=unknown",
            "feishu.permissions=missing",
            expect.stringContaining("platforms.feishu.permissions.im:message.group_msg")
          ])
        })
      ])
    );
  });

  it("requires ready admin health connections to expose connected state and timestamp", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      platforms: {
        ...status.platforms,
        slack: {
          ...passingPlatforms().slack,
          connection: {
            mode: "socket_mode",
            connected: true
          }
        },
        feishu: {
          ...passingPlatforms().feishu,
          connection: {
            mode: "long_connection",
            connected: false,
            lastConnectedAt: "2026-03-19T00:00:02.000Z"
          }
        }
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "admin.platform_health_contract",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("platforms.slack.connection.lastConnectedAt"),
            expect.stringContaining("platforms.feishu.connection.connected=true")
          ])
        })
      ])
    );
  });

  it("requires admin health Feishu permission statuses, not only permission names", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      platforms: {
        ...status.platforms,
        feishu: {
          ...passingPlatforms().feishu,
          permissions: [
            {
              name: "bot_identity",
              requiredFor: "Feishu @bot mention detection",
              status: "missing"
            },
            {
              name: "im:message.group_msg",
              requiredFor: "Feishu active-session non-@ follow-ups and group history",
              status: "configured"
            },
            {
              name: "im:message:send_as_bot",
              requiredFor: "Feishu text, rich text, and card replies",
              status: "unknown"
            }
          ]
        }
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "admin.platform_health_contract",
          status: "fail",
          evidence: expect.arrayContaining([
            "feishu.permissions=bot_identity:missing,im:message.group_msg:configured,im:message:send_as_bot:unknown",
            expect.stringContaining("platforms.feishu.permissions.bot_identity.status=configured"),
            expect.stringContaining("platforms.feishu.permissions.im:message.group_msg.status=verified"),
            expect.stringContaining("platforms.feishu.permissions.im:message:send_as_bot.status=configured")
          ])
        })
      ])
    );
  });


  it("requires group @bot accepted evidence, not only an existing Feishu session", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.filter((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: { readonly route?: string } };
          return logRecord.message !== "chat.message.accepted" || logRecord.meta?.route !== "bot_mention";
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.group_at_created_session",
          status: "fail"
        })
      ])
    );
  });

  it("requires group @bot session creation evidence to come from a text message", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.message.accepted" || logRecord.meta?.route !== "bot_mention") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              msgType: "rich_text"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.group_at_created_session",
          status: "fail"
        })
      ])
    );
  });

  it("requires group @bot session transition to target a known Feishu session", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.session.created") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              sessionKey: "feishu:b3RoZXI:b3RoZXI"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.group_at_created_session",
          status: "fail"
        })
      ])
    );
  });

  it("requires group @bot session transition evidence to occur after the accepted message", () => {
    const status = passingStatus();
    const transitionLogs = status.state.recentBrokerLogs.filter((record) => {
      const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
      return logRecord.message === "chat.session.created" && logRecord.meta?.platform === "feishu";
    });
    const nonTransitionLogs = status.state.recentBrokerLogs.filter((record) => !transitionLogs.includes(record));
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...transitionLogs,
          ...nonTransitionLogs
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.group_at_created_session",
          status: "fail"
        })
      ])
    );
  });

  it("does not count group @bot transition evidence when the accepted message was ignored", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs.map((record) => {
            const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
            if (
              logRecord.message !== "chat.message.accepted" &&
              logRecord.message !== "chat.session.created"
            ) {
              return record;
            }
            if (logRecord.message === "chat.message.accepted" && logRecord.meta?.route !== "bot_mention") {
              return record;
            }

            return {
              ...logRecord,
              meta: {
                ...logRecord.meta,
                messageId: "om_bot"
              }
            };
          }),
          log("chat.session.resumed", {
            platform: "feishu",
            messageId: "om",
            turnId: "turn-1"
          }),
          log("chat.message.ignored", {
            platform: "feishu",
            conversationId: "oc",
            conversationKind: "group",
            rootMessageId: "om",
            messageId: "om_bot",
            ignoredReason: "ignored_no_active_session",
            route: "ignored_no_active_session"
          })
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.group_at_created_session",
          status: "fail"
        })
      ])
    );
  });

  it("requires session-bound Feishu smoke evidence to match admin session coordinates", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        sessions: status.state.sessions.map((session) => ({
          ...session,
          conversationId: "oc_other"
        }))
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.group_at_created_session",
          status: "fail"
        }),
        expect.objectContaining({
          id: "feishu.final_reply_posted",
          status: "fail"
        }),
        expect.objectContaining({
          id: "feishu.non_at_followup",
          status: "fail"
        }),
        expect.objectContaining({
          id: "feishu.stop",
          status: "fail"
        }),
        expect.objectContaining({
          id: "feishu.history_recovered",
          status: "fail"
        }),
        expect.objectContaining({
          id: "feishu.coauthor_card",
          status: "fail"
        }),
        expect.objectContaining({
          id: "observability.behavior_coverage",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("missing behavior evidence: accepted, deduped, failed, recovered")
          ])
        })
      ])
    );
  });

  it("requires private-chat ignore evidence to come from a direct conversation", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.message.ignored" || logRecord.meta?.ignoredReason !== "ignored_private_chat") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              conversationKind: "group"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.private_ignored",
          status: "fail"
        }),
        expect.objectContaining({
          id: "observability.behavior_coverage",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("missing behavior evidence: ignored")
          ])
        })
      ])
    );
  });

  it("requires private-chat ignore evidence to create no persisted Feishu session", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        sessions: [
          ...status.state.sessions,
          {
            platform: "feishu",
            key: "feishu:b2NfZGlyZWN0:b21fZGlyZWN0",
            conversationId: "oc_direct",
            rootMessageId: "om_direct"
          }
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.private_ignored",
          status: "fail"
        }),
        expect.objectContaining({
          id: "observability.behavior_coverage",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("missing behavior evidence: ignored")
          ])
        })
      ])
    );
  });

  it("does not report persisted-session private ignored logs as private-ignore evidence", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        sessions: [
          ...status.state.sessions,
          {
            platform: "feishu",
            key: "feishu:b2NfcHJpdmF0ZV9vcnBoYW4:b21fcHJpdmF0ZV9vcnBoYW4",
            conversationId: "oc_private_orphan",
            rootMessageId: "om_private_orphan"
          }
        ],
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs,
          log("chat.message.ignored", {
            platform: "feishu",
            conversationId: "oc_private_orphan",
            conversationKind: "direct",
            rootMessageId: "om_private_orphan",
            messageId: "om_private_orphan",
            ignoredReason: "ignored_private_chat"
          })
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    const ignored = report.checks.find((check) => check.id === "feishu.private_ignored");
    const behaviorCoverage = report.checks.find((check) => check.id === "observability.behavior_coverage");
    const evidence = [
      ...(ignored?.evidence ?? []),
      ...(behaviorCoverage?.evidence ?? [])
    ].join("\n");

    expect(report.ok).toBe(false);
    expect(ignored).toMatchObject({
      status: "fail"
    });
    expect(evidence).not.toContain("chat.message.ignored feishu long_connection feishu:b2M:b20 oc_private_orphan");
  });

  it("requires bot/app/self sender ignore evidence before final smoke passes", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.filter((record) =>
          (record as { readonly meta?: Record<string, unknown> }).meta?.ignoredReason !== "ignored_self"
        )
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.self_sender_ignored",
          status: "fail"
        })
      ])
    );
  });

  it("reports pre-dispatch self ignore evidence instead of later dispatched self ignored logs", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs,
          log("chat.message.ignored", {
            platform: "feishu",
            conversationId: "oc",
            conversationKind: "group",
            rootMessageId: "om",
            messageId: "om_self_dispatched",
            eventId: "evt_self_dispatched",
            senderKind: "app",
            ignoredReason: "ignored_self",
            route: "ignored_self"
          }),
          log("chat.message.accepted", {
            platform: "feishu",
            conversationId: "oc",
            rootMessageId: "om",
            messageId: "om_self_dispatched",
            eventId: "evt_self_dispatched",
            route: "group_message",
            msgType: "text"
          })
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    const ignored = report.checks.find((check) => check.id === "feishu.self_sender_ignored");
    const evidence = ignored?.evidence.join("\n") ?? "";

    expect(report.ok).toBe(true);
    expect(ignored).toMatchObject({
      status: "pass"
    });
    expect(evidence).toContain("chat.message.ignored feishu long_connection feishu:b2M:b20 oc om om_self");
    expect(evidence).not.toContain("om_self_dispatched");
  });

  it("requires bot/app/self sender ignore evidence to have no accepted twin", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs,
          log("chat.message.accepted", {
            platform: "feishu",
            conversationId: "oc",
            rootMessageId: "om",
            messageId: "om_self",
            eventId: "evt_self_accepted",
            route: "group_message",
            msgType: "text"
          })
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.self_sender_ignored",
          status: "fail"
        })
      ])
    );
  });

  it("requires bot/app/self sender ignore evidence to have no same-message dispatch twin", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs,
          log("chat.session.resumed", {
            platform: "feishu",
            conversationId: "oc",
            rootMessageId: "om",
            messageId: "om_self",
            eventId: "evt_self_resumed",
            turnId: "turn-1"
          }),
          log("chat.turn.steered", {
            platform: "feishu",
            conversationId: "oc",
            rootMessageId: "om",
            messageId: "om_self",
            eventId: "evt_self_steered",
            batchId: "om_self"
          })
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.self_sender_ignored",
          status: "fail"
        })
      ])
    );
  });

  it("requires non-@ follow-up evidence to match the steered or resumed message", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.turn.steered") {
            if (logRecord.message === "chat.turn.started") {
              return {
                ...logRecord,
                meta: {
                  ...logRecord.meta,
                  source: "history_recovery"
                }
              };
            }

            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              messageId: "om_unrelated_followup"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.non_at_followup",
          status: "fail"
        })
      ])
    );
  });

  it("requires non-@ follow-up transition evidence to come from a text message", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (
            logRecord.message !== "chat.message.accepted" ||
            logRecord.meta?.route !== "group_message" ||
            logRecord.meta?.messageId !== "om"
          ) {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              msgType: "rich_text"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.all_message_verified",
          status: "fail",
          evidence: expect.arrayContaining(["sameSessionNonAtFollowup=false"])
        }),
        expect.objectContaining({
          id: "feishu.non_at_followup",
          status: "fail"
        })
      ])
    );
  });

  it("requires non-@ follow-up evidence to target a known Feishu session", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.turn.steered" || logRecord.meta?.source === "history_recovery") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              sessionKey: "feishu:b3RoZXI:b3RoZXI"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.non_at_followup",
          status: "fail"
        })
      ])
    );
  });

  it("requires non-@ follow-up transition evidence to occur after the accepted message", () => {
    const status = passingStatus();
    const followupTransitionLogs = status.state.recentBrokerLogs.filter((record) => {
      const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
      return logRecord.message === "chat.turn.steered" &&
        logRecord.meta?.platform === "feishu" &&
        logRecord.meta?.source !== "history_recovery";
    });
    const nonTransitionLogs = status.state.recentBrokerLogs.filter((record) => !followupTransitionLogs.includes(record));
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...followupTransitionLogs,
          ...nonTransitionLogs
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.non_at_followup",
          status: "fail"
        })
      ])
    );
  });

  it("requires non-@ follow-up evidence to target the group @ session", () => {
    const status = passingStatus();
    const otherSession = {
      platform: "feishu",
      key: "feishu:b3RoZXI:b3RoZXI",
      conversationId: "oc_other",
      rootMessageId: "om_other"
    };
    const followupMessageId = "om_other_followup";
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        sessions: [
          ...status.state.sessions,
          otherSession
        ],
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (
            logRecord.message === "chat.message.accepted" &&
            logRecord.meta?.route === "group_message" &&
            logRecord.meta?.msgType === "text" &&
            logRecord.meta?.messageId !== "om_duplicate" &&
            logRecord.meta?.messageId !== "om_stop"
          ) {
            return {
              ...logRecord,
              meta: {
                ...logRecord.meta,
                conversationId: otherSession.conversationId,
                rootMessageId: otherSession.rootMessageId,
                messageId: followupMessageId,
                eventId: "evt_other_followup"
              }
            };
          }

          if (logRecord.message === "chat.turn.steered" && logRecord.meta?.source !== "history_recovery") {
            return {
              ...logRecord,
              meta: {
                ...logRecord.meta,
                sessionKey: otherSession.key,
                conversationId: otherSession.conversationId,
                rootMessageId: otherSession.rootMessageId,
                messageId: followupMessageId,
                batchId: followupMessageId
              }
            };
          }

          return record;
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.non_at_followup",
          status: "fail"
        })
      ])
    );
  });

  it("accepts rootless non-@ follow-up evidence when the transition targets the group @ session", () => {
    const status = passingStatus();
    const rootlessMessageId = "om_rootless_followup";
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (
            logRecord.message === "chat.message.accepted" &&
            logRecord.meta?.route === "group_message" &&
            logRecord.meta?.msgType === "text" &&
            logRecord.meta?.messageId !== "om_duplicate" &&
            logRecord.meta?.messageId !== "om_stop"
          ) {
            return {
              ...logRecord,
              meta: {
                ...logRecord.meta,
                rootMessageId: rootlessMessageId,
                messageId: rootlessMessageId,
                eventId: "evt_rootless_followup"
              }
            };
          }

          if (logRecord.message === "chat.turn.steered" && logRecord.meta?.source !== "history_recovery") {
            return {
              ...logRecord,
              meta: {
                ...logRecord.meta,
                rootMessageId: "om",
                messageId: rootlessMessageId,
                batchId: rootlessMessageId
              }
            };
          }

          return record;
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(true);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.non_at_followup",
          status: "pass"
        })
      ])
    );
  });

  it("reports group-at-session non-@ follow-up evidence instead of later unrelated follow-up logs", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs,
          log("chat.message.accepted", {
            platform: "feishu",
            route: "group_message",
            msgType: "text",
            conversationId: "oc_orphan_followup",
            rootMessageId: "om_orphan_followup",
            messageId: "om_orphan_followup",
            eventId: "evt_orphan_followup"
          }),
          log("chat.turn.steered", {
            platform: "feishu",
            sessionKey: "feishu:b3RoZXI:b3RoZXI",
            conversationId: "oc_orphan_followup",
            rootMessageId: "om_orphan_followup",
            messageId: "om_orphan_followup",
            turnId: "turn-orphan",
            batchId: "om_orphan_followup"
          })
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    const followup = report.checks.find((check) => check.id === "feishu.non_at_followup");
    const evidence = followup?.evidence.join("\n") ?? "";

    expect(report.ok).toBe(true);
    expect(followup).toMatchObject({
      status: "pass"
    });
    expect(evidence).toContain("chat.message.accepted feishu long_connection feishu:b2M:b20 oc om om");
    expect(evidence).toContain("chat.turn.steered feishu long_connection feishu:b2M:b20 oc om om");
    expect(evidence).not.toContain("oc_orphan_followup");
  });

  it("requires resumed non-@ follow-up evidence to include an active turn id", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs.filter((record) => {
            const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
            return logRecord.message !== "chat.turn.steered" || logRecord.meta?.source === "history_recovery";
          }),
          log("chat.session.resumed", {
            platform: "feishu",
            messageId: "om",
            turnId: undefined
          })
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.non_at_followup",
          status: "fail"
        })
      ])
    );
  });

  it("requires steered non-@ follow-up evidence to include an active turn id", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.turn.steered" || logRecord.meta?.source === "history_recovery") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              turnId: "none"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.non_at_followup",
          status: "fail"
        })
      ])
    );
  });

  it("requires -stop evidence to interrupt an active Feishu turn", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.turn.stopped") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              hadActiveTurn: false
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.stop",
          status: "fail"
        })
      ])
    );
  });

  it("requires -stop evidence to include an active Feishu turn id", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.turn.stopped") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              turnId: "none"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.stop",
          status: "fail"
        }),
        expect.objectContaining({
          id: "observability.required_log_fields",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("chat.turn.stopped: missing active turnId")
          ])
        })
      ])
    );
  });

  it("requires -stop evidence to target a known Feishu session", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.turn.stopped") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              sessionKey: "feishu:b3RoZXI:b3RoZXI"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.stop",
          status: "fail"
        })
      ])
    );
  });

  it("requires -stop evidence to match an accepted transitioned message", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.turn.stopped") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              messageId: "om_unmatched_stop"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.stop",
          status: "fail"
        })
      ])
    );
  });

  it("requires -stop evidence to occur after the accepted stop transition", () => {
    const status = passingStatus();
    const stoppedLogs = status.state.recentBrokerLogs.filter((record) =>
      (record as { readonly message?: string }).message === "chat.turn.stopped"
    );
    const nonStoppedLogs = status.state.recentBrokerLogs.filter((record) => !stoppedLogs.includes(record));
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...stoppedLogs,
          ...nonStoppedLogs
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.stop",
          status: "fail"
        })
      ])
    );
  });

  it("does not count -stop evidence when the accepted stop message was ignored", () => {
    const status = passingStatus();
    const stopMessageId = "om_stop_ignored";
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs.map((record) => {
            const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
            if (logRecord.message !== "chat.turn.stopped") {
              return record;
            }

            return {
              ...logRecord,
              meta: {
                ...logRecord.meta,
                messageId: stopMessageId
              }
            };
          }),
          log("chat.message.accepted", {
            platform: "feishu",
            route: "group_message",
            msgType: "text",
            messageId: stopMessageId,
            eventId: "evt_stop_ignored"
          }),
          log("chat.session.resumed", {
            platform: "feishu",
            messageId: stopMessageId,
            turnId: "turn-1"
          }),
          log("chat.message.ignored", {
            platform: "feishu",
            conversationId: "oc",
            conversationKind: "group",
            rootMessageId: "om",
            messageId: stopMessageId,
            eventId: "evt_stop_ignored",
            ignoredReason: "ignored_no_active_session",
            route: "ignored_no_active_session"
          })
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.stop",
          status: "fail"
        })
      ])
    );
  });

  it("reports group-at-session stop evidence instead of later unrelated stopped logs", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs,
          log("chat.turn.stopped", {
            platform: "feishu",
            sessionKey: "feishu:b3RoZXI:b3RoZXI",
            conversationId: "oc_orphan_stop",
            rootMessageId: "om_orphan_stop",
            messageId: "om_orphan_stop",
            turnId: "turn-orphan",
            hadActiveTurn: true
          })
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    const stop = report.checks.find((check) => check.id === "feishu.stop");
    const evidence = stop?.evidence.join("\n") ?? "";

    expect(report.ok).toBe(true);
    expect(stop).toMatchObject({
      status: "pass"
    });
    expect(evidence).toContain("chat.turn.stopped feishu long_connection feishu:b2M:b20 oc om om_stop");
    expect(evidence).not.toContain("oc_orphan_stop");
  });

  it("requires -stop evidence to target the group @ session", () => {
    const status = passingStatus();
    const otherSession = {
      platform: "feishu",
      key: "feishu:b3RoZXI:b3RoZXI",
      conversationId: "oc_other",
      rootMessageId: "om_other"
    };
    const stopMessageId = "om_other_stop";
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        sessions: [
          ...status.state.sessions,
          otherSession
        ],
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs.map((record) => {
            const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
            if (logRecord.message !== "chat.turn.stopped") {
              return record;
            }

            return {
              ...logRecord,
              meta: {
                ...logRecord.meta,
                sessionKey: otherSession.key,
                conversationId: otherSession.conversationId,
                rootMessageId: otherSession.rootMessageId,
                messageId: stopMessageId
              }
            };
          }),
          log("chat.message.accepted", {
            platform: "feishu",
            conversationId: otherSession.conversationId,
            rootMessageId: otherSession.rootMessageId,
            route: "group_message",
            msgType: "text",
            messageId: stopMessageId,
            eventId: "evt_other_stop"
          }),
          log("chat.session.resumed", {
            platform: "feishu",
            sessionKey: otherSession.key,
            conversationId: otherSession.conversationId,
            rootMessageId: otherSession.rootMessageId,
            messageId: stopMessageId,
            turnId: "turn-1"
          })
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.stop",
          status: "fail"
        })
      ])
    );
  });

  it("requires the final Feishu reply evidence to be a text reply", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.outbound.posted") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              format: "card"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.final_reply_posted",
          status: "fail"
        })
      ])
    );
  });

  it("requires the final Feishu text reply to target a known Feishu session", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.outbound.posted" || logRecord.meta?.format !== "text") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              sessionKey: "feishu:b3RoZXI:b3RoZXI"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.final_reply_posted",
          status: "fail"
        }),
        expect.objectContaining({
          id: "feishu.turn_completed",
          status: "fail"
        })
      ])
    );
  });

  it("requires the final Feishu text reply to target the group @ session", () => {
    const status = passingStatus();
    const otherSession = {
      platform: "feishu",
      key: "feishu:b3RoZXI:b3RoZXI",
      conversationId: "oc_other",
      rootMessageId: "om_other"
    };
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        sessions: [
          ...status.state.sessions,
          otherSession
        ],
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs.map((record) => {
            const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
            if (logRecord.message === "chat.outbound.posted" && logRecord.meta?.format === "text") {
              return {
                ...logRecord,
                meta: {
                  ...logRecord.meta,
                  sessionKey: otherSession.key,
                  conversationId: otherSession.conversationId,
                  rootMessageId: otherSession.rootMessageId,
                  messageId: "om_other_reply"
                }
              };
            }

            if (logRecord.message === "chat.turn.completed") {
              return {
                ...logRecord,
                meta: {
                  ...logRecord.meta,
                  sessionKey: otherSession.key,
                  turnId: "turn-other",
                  codexThreadId: "thread-other",
                  batchId: "om_other"
                }
              };
            }

            return record;
          }),
          log("chat.turn.started", {
            platform: "feishu",
            sessionKey: otherSession.key,
            conversationId: otherSession.conversationId,
            rootMessageId: otherSession.rootMessageId,
            messageId: "om_other",
            turnId: "turn-other",
            codexThreadId: "thread-other",
            batchId: "om_other"
          })
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.final_reply_posted",
          status: "fail"
        }),
        expect.objectContaining({
          id: "feishu.turn_completed",
          status: "fail"
        })
      ])
    );
  });

  it("requires Feishu turn completion evidence for final smoke readiness", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.filter((record) =>
          (record as { readonly message?: string }).message !== "chat.turn.completed"
        )
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.turn_completed",
          required: true,
          status: "fail"
        })
      ])
    );
  });

  it("requires Feishu turn completion evidence to match the reply session", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.turn.completed") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              sessionKey: "feishu:b3RoZXI:b3RoZXI"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.turn_completed",
          status: "fail"
        })
      ])
    );
  });

  it("requires Feishu turn completion evidence to occur after the same-session text reply", () => {
    const status = passingStatus();
    const completionLogs = status.state.recentBrokerLogs.filter((record) =>
      (record as { readonly message?: string }).message === "chat.turn.completed"
    );
    const nonCompletionLogs = status.state.recentBrokerLogs.filter((record) =>
      (record as { readonly message?: string }).message !== "chat.turn.completed"
    );
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...completionLogs,
          ...nonCompletionLogs
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.turn_completed",
          status: "fail"
        })
      ])
    );
  });

  it("reports group-at-session reply and completion evidence instead of later unrelated final logs", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs,
          log("chat.outbound.posted", {
            platform: "feishu",
            sessionKey: "feishu:b3RoZXI:b3RoZXI",
            conversationId: "oc_orphan_reply",
            rootMessageId: "om_orphan_reply",
            messageId: "om_orphan_reply",
            format: "text"
          }),
          log("chat.turn.completed", {
            platform: "feishu",
            sessionKey: "feishu:b3RoZXI:b3RoZXI",
            conversationId: "oc_orphan_reply",
            rootMessageId: "om_orphan_reply",
            messageId: "om_orphan_reply",
            turnId: "turn-orphan",
            codexThreadId: "thread-orphan",
            batchId: "om_orphan_reply"
          })
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    const finalReply = report.checks.find((check) => check.id === "feishu.final_reply_posted");
    const turnCompleted = report.checks.find((check) => check.id === "feishu.turn_completed");
    const finalReplyEvidence = finalReply?.evidence.join("\n") ?? "";
    const turnCompletedEvidence = turnCompleted?.evidence.join("\n") ?? "";

    expect(report.ok).toBe(true);
    expect(finalReply).toMatchObject({
      status: "pass"
    });
    expect(turnCompleted).toMatchObject({
      status: "pass"
    });
    expect(finalReplyEvidence).toContain("chat.outbound.posted feishu long_connection feishu:b2M:b20 oc om om");
    expect(turnCompletedEvidence).toContain("chat.turn.completed feishu long_connection feishu:b2M:b20 oc om om");
    expect(finalReplyEvidence).not.toContain("oc_orphan_reply");
    expect(turnCompletedEvidence).not.toContain("oc_orphan_reply");
  });

  it("requires Feishu turn completion evidence to match a started or steered turn", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.turn.completed") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              batchId: "om_unrelated_completion"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.turn_completed",
          status: "fail"
        })
      ])
    );
  });

  it("does not count history recovery as the final Feishu turn completion source", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message === "chat.turn.started") {
            return {
              ...logRecord,
              meta: {
                ...logRecord.meta,
                batchId: "om_followup"
              }
            };
          }

          if (logRecord.message !== "chat.turn.steered") {
            return record;
          }

          if (logRecord.meta?.source === "history_recovery") {
            return {
              ...logRecord,
              meta: {
                ...logRecord.meta,
                turnId: "turn-1",
                batchId: "om"
              }
            };
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              batchId: "om_followup"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.turn_completed",
          status: "fail"
        })
      ])
    );
  });

  it("requires bounded history recovery to recover at least one message", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.history.recovered") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              recoveredCount: 0
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.history_recovered",
          status: "fail"
        })
      ])
    );
  });

  it("requires bounded history recovery to be delivered back into Codex", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.filter((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          return !(
            (logRecord.message === "chat.turn.steered" || logRecord.message === "chat.turn.started") &&
            logRecord.meta?.source === "history_recovery"
          );
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.history_recovered",
          status: "fail"
        })
      ])
    );
  });

  it("requires bounded history recovery to match delivered and recovered session evidence", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.turn.steered" || logRecord.meta?.source !== "history_recovery") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              sessionKey: "feishu:b3RoZXI:b3RoZXI"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.history_recovered",
          status: "fail"
        }),
        expect.objectContaining({
          id: "observability.behavior_coverage",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("missing behavior evidence: recovered")
          ])
        })
      ])
    );
  });

  it("requires bounded history recovery turn coordinates to match admin session state", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.turn.steered" || logRecord.meta?.source !== "history_recovery") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              conversationId: "oc_other",
              rootMessageId: "om_other"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.history_recovered",
          status: "fail"
        }),
        expect.objectContaining({
          id: "observability.behavior_coverage",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("missing behavior evidence: recovered")
          ])
        })
      ])
    );
  });

  it("does not count history recovery without cursor evidence as recovered behavior", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.history.recovered") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              messageCursor: undefined
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.history_recovered",
          status: "fail"
        }),
        expect.objectContaining({
          id: "observability.behavior_coverage",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("missing behavior evidence: recovered")
          ])
        })
      ])
    );
  });

  it("accepts bounded history recovery that starts a turn for a recently active Feishu session", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.turn.steered" || logRecord.meta?.source !== "history_recovery") {
            return record;
          }

          return {
            ...logRecord,
            message: "chat.turn.started"
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.history_recovered",
          status: "pass"
        })
      ])
    );
  });

  it("requires Feishu co-author card confirmation for final RFC smoke readiness", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.filter((record) =>
          (record as { readonly message?: string }).message !== "chat.coauthor.confirmed"
        )
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.coauthor_card",
          required: true,
          status: "fail"
        })
      ])
    );
  });

  it("requires Feishu co-author confirmation to match the clicked card session", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.card.callback.received") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              sessionKey: "feishu:b3RoZXI:b3RoZXI"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.card_callback",
          status: "fail"
        }),
        expect.objectContaining({
          id: "feishu.coauthor_card",
          required: true,
          status: "fail"
        })
      ])
    );
  });

  it("requires Feishu card callback logs to include admin session coordinates", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.card.callback.received") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              conversationId: undefined,
              rootMessageId: undefined
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.card_callback",
          status: "fail"
        }),
        expect.objectContaining({
          id: "feishu.coauthor_card",
          required: true,
          status: "fail"
        }),
        expect.objectContaining({
          id: "observability.required_log_fields",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("chat.card.callback.received: missing conversationId, rootMessageId")
          ])
        })
      ])
    );
  });

  it("requires Feishu card callback coordinates to match admin session state", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.card.callback.received") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              conversationId: "oc_other",
              rootMessageId: "om_other"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.card_callback",
          status: "fail"
        }),
        expect.objectContaining({
          id: "feishu.coauthor_card",
          required: true,
          status: "fail"
        })
      ])
    );
  });

  it("requires Feishu card callbacks to target the group @ session with a broker-posted card", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        sessions: [
          ...status.state.sessions,
          {
            platform: "feishu",
            key: "feishu:b3RoZXI:b3RoZXI",
            conversationId: "oc_other",
            rootMessageId: "om_other"
          }
        ],
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.card.callback.received") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              sessionKey: "feishu:b3RoZXI:b3RoZXI",
              conversationId: "oc_other",
              rootMessageId: "om_other"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.card_callback",
          status: "fail",
          evidence: expect.arrayContaining([
            "requiredSession=group_at outboundCardSessionCount=1"
          ])
        })
      ])
    );
  });

  it("requires Feishu card callbacks to have a same-session broker-posted card", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.filter((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          return logRecord.message !== "chat.outbound.posted" || logRecord.meta?.format !== "card";
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.card_callback",
          status: "fail",
          evidence: expect.arrayContaining([
            "requiredSession=group_at outboundCardSessionCount=0"
          ])
        })
      ])
    );
  });

  it("requires Feishu card callbacks to match a broker-posted card message", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.card.callback.received") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              messageId: "om_unrelated_card"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.card_callback",
          status: "fail",
          evidence: expect.arrayContaining([
            "requiredSession=group_at outboundCardSessionCount=1",
            "outboundCardMessageCount=1"
          ])
        })
      ])
    );
  });

  it("accepts Feishu card callbacks without a message id when they follow a same-session broker-posted card", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.card.callback.received") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              messageId: "unknown"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(true);
    expect(report.checks.filter((check) => check.required && check.status !== "pass")).toEqual([]);
  });

  it("requires Feishu card callbacks to occur after the matching broker-posted card", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs.filter((record) =>
            (record as { readonly message?: string }).message === "chat.card.callback.received"
          ),
          ...status.state.recentBrokerLogs.filter((record) =>
            (record as { readonly message?: string }).message !== "chat.card.callback.received"
          )
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.card_callback",
          status: "fail",
          evidence: expect.arrayContaining([
            "requiredSession=group_at outboundCardSessionCount=1",
            "outboundCardMessageCount=1"
          ])
        }),
        expect.objectContaining({
          id: "feishu.coauthor_card",
          required: true,
          status: "fail"
        })
      ])
    );
  });

  it("requires Feishu co-author confirmation to target the group @ broker-posted card session", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        sessions: [
          ...status.state.sessions,
          {
            platform: "feishu",
            key: "feishu:b3RoZXI:b3RoZXI",
            conversationId: "oc_other",
            rootMessageId: "om_other"
          }
        ],
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.card.callback.received" && logRecord.message !== "chat.coauthor.confirmed") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              sessionKey: "feishu:b3RoZXI:b3RoZXI",
              conversationId: "oc_other",
              rootMessageId: "om_other"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.coauthor_card",
          status: "fail",
          evidence: expect.arrayContaining([
            "requiredSession=group_at outboundCardSessionCount=1"
          ])
        })
      ])
    );
  });

  it("requires Feishu co-author confirmation to have a same-session broker-posted card", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.filter((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          return logRecord.message !== "chat.outbound.posted" || logRecord.meta?.format !== "card";
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.coauthor_card",
          status: "fail",
          evidence: expect.arrayContaining([
            "requiredSession=group_at outboundCardSessionCount=0"
          ])
        })
      ])
    );
  });

  it("requires Feishu co-author confirmation callbacks to match a broker-posted card message", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.card.callback.received") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              messageId: "om_unrelated_card"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.coauthor_card",
          status: "fail",
          evidence: expect.arrayContaining([
            "requiredSession=group_at outboundCardSessionCount=1",
            "outboundCardMessageCount=1"
          ])
        })
      ])
    );
  });

  it("requires Feishu co-author confirmation to include confirmed candidates", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.coauthor.confirmed") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              confirmedCount: 0
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.coauthor_card",
          required: true,
          status: "fail"
        })
      ])
    );
  });

  it("requires Feishu co-author confirmation to match the clicked card revision", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.card.callback.received") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              candidateRevision: 2
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.coauthor_card",
          required: true,
          status: "fail"
        })
      ])
    );
  });

  it("requires Feishu co-author card callbacks to log the clicked candidate revision", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.card.callback.received") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              candidateRevision: undefined
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.coauthor_card",
          required: true,
          status: "fail"
        }),
        expect.objectContaining({
          id: "observability.required_log_fields",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("chat.card.callback.received: missing candidateRevision when co-author action")
          ])
        })
      ])
    );
  });

  it("requires Feishu co-author confirmation to occur after the clicked card callback", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs.filter((record) =>
            (record as { readonly message?: string }).message === "chat.coauthor.confirmed"
          ),
          ...status.state.recentBrokerLogs.filter((record) =>
            (record as { readonly message?: string }).message !== "chat.coauthor.confirmed"
          )
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.card_callback",
          status: "pass"
        }),
        expect.objectContaining({
          id: "feishu.coauthor_card",
          required: true,
          status: "fail"
        })
      ])
    );
  });

  it("requires Feishu co-author confirmation to target a known Feishu session", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.card.callback.received" && logRecord.message !== "chat.coauthor.confirmed") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              sessionKey: "feishu:b3RoZXI:b3RoZXI"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.card_callback",
          status: "fail"
        }),
        expect.objectContaining({
          id: "feishu.coauthor_card",
          required: true,
          status: "fail"
        })
      ])
    );
  });

  it("reports same-session co-author card evidence instead of later unrelated card logs", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs,
          log("chat.card.callback.received", {
            platform: "feishu",
            sessionKey: "feishu:b3RoZXI:b3RoZXI",
            conversationId: "oc_orphan_coauthor",
            rootMessageId: "om_orphan_coauthor",
            messageId: "om_orphan_card",
            eventId: "evt_orphan_card",
            kind: "coauthor_confirm_all",
            candidateRevision: 2
          }),
          log("chat.coauthor.confirmed", {
            platform: "feishu",
            sessionKey: "feishu:b3RoZXI:b3RoZXI",
            conversationId: "oc_orphan_coauthor",
            rootMessageId: "om_orphan_coauthor",
            messageId: "om_orphan_card",
            candidateRevision: 2,
            confirmedCount: 1
          })
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    const coauthorCard = report.checks.find((check) => check.id === "feishu.coauthor_card");
    const evidence = coauthorCard?.evidence.join("\n") ?? "";

    expect(report.ok).toBe(true);
    expect(coauthorCard).toMatchObject({
      status: "pass"
    });
    expect(evidence).toContain("chat.card.callback.received feishu long_connection feishu:b2M:b20 oc om om");
    expect(evidence).toContain("chat.coauthor.confirmed feishu long_connection feishu:b2M:b20 oc om om");
    expect(evidence).not.toContain("oc_orphan_coauthor");
  });

  it("requires real setup label evidence when checking final smoke readiness", () => {
    const missing = evaluateFeishuSmokeStatus(passingStatus(), {
      FEISHU_DOMAIN: "feishu"
    }, {
      requireSetupEvidence: true
    });

    expect(missing.ok).toBe(false);
    expect(missing.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "setup.console_labels_recorded",
          status: "fail"
        })
      ])
    );

    const complete = evaluateFeishuSmokeStatus(passingStatus(), {
      FEISHU_DOMAIN: "feishu"
    }, {
      requireSetupEvidence: true,
      setupEvidence: passingSetupEvidence()
    });

    expect(complete.ok).toBe(true);
    expect(complete.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "setup.console_labels_recorded",
          status: "pass",
          evidence: expect.arrayContaining([
            "im:message.group_msg=approved",
            "send_message=configured",
            "card.action.trigger=enabled",
            "resource_transfer=configured"
          ])
        })
      ])
    );
  });

  it("validates Feishu setup label evidence shape", () => {
    expect(evaluateFeishuSetupEvidence(passingSetupEvidence())).toEqual(
      expect.objectContaining({
        id: "setup.console_labels_recorded",
        status: "pass",
        evidence: expect.arrayContaining([
          "setup evidence contains no raw secrets, tokens, user emails, or raw bot IDs",
          "send_message.apiName=im:message:send_as_bot",
          "card.action.trigger.eventName=card.action.trigger",
          "resource_transfer.scopeName=获取与上传图片或文件资源"
        ])
      })
    );

    expect(evaluateFeishuSetupEvidence({
      ...passingSetupEvidence(),
      appSecret: "secret-value",
      botId: "ou_realbot123456",
      permissions: {
        imMessageGroupMsg: {
          apiName: "im:message.group_msg",
          status: "approved",
          approvalEvidence: "approved by reviewer@example.com"
        }
      },
      notes: [
        "raw bot open id ou_realbot123456"
      ]
    })).toEqual(
      expect.objectContaining({
        id: "setup.console_labels_recorded",
        status: "fail",
        evidence: expect.arrayContaining([
          expect.stringContaining("setupEvidence.appSecret")
        ]),
        nextAction: expect.stringContaining("Remove raw App Secret/access token/message body/user email/raw bot ID values")
      })
    );

    expect(evaluateFeishuSetupEvidence({
      ...passingSetupEvidence(),
      notes: [
        "tenant label copied from console",
        "raw callback actor ou_realbot123456 should not be stored"
      ]
    })).toEqual(
      expect.objectContaining({
        id: "setup.console_labels_recorded",
        status: "fail",
        evidence: expect.arrayContaining([
          expect.stringContaining("setupEvidence.notes[1]")
        ])
      })
    );

    expect(evaluateFeishuSetupEvidence({
      target: "lark",
      consoleLabels: {
        appType: "custom app"
      },
      permissions: {
        imMessageGroupMsg: {
          status: "pending"
        }
      }
    })).toEqual(
      expect.objectContaining({
        id: "setup.console_labels_recorded",
        status: "fail",
        evidence: expect.arrayContaining([
          "target=lark",
          "im:message.group_msg.apiName=missing",
          "im:message.group_msg=pending",
          "approvalEvidence=missing",
          expect.stringContaining("missing labels:")
        ])
      })
    );

    expect(evaluateFeishuSetupEvidence({
      ...passingSetupEvidence(),
      permissions: {
        imMessageGroupMsg: {
          apiName: "im:message.group_msg",
          status: "approved",
          approvalEvidence: "FEI-PERM-1234 approved 2026-05-29 by platform admin"
        }
      }
    })).toEqual(
      expect.objectContaining({
        id: "setup.console_labels_recorded",
        status: "fail",
        evidence: expect.arrayContaining([
          "send_message.apiName=missing",
          "card.action.trigger.eventName=missing",
          "resource_transfer.scopeName=missing",
          expect.stringContaining("missing permission posture:")
        ])
      })
    );

    expect(evaluateFeishuSetupEvidence({
      ...passingSetupEvidence(),
      permissions: {
        imMessageGroupMsg: {
          status: "approved"
        }
      }
    })).toEqual(
      expect.objectContaining({
        id: "setup.console_labels_recorded",
        status: "fail",
        evidence: expect.arrayContaining([
          "im:message.group_msg.apiName=missing",
          "approvalEvidence=missing",
          "send_message.apiName=missing",
          "card.action.trigger.eventName=missing",
          "resource_transfer.scopeName=missing"
        ])
      })
    );
  });

  it("rejects the setup evidence example until real tenant labels replace placeholders", async () => {
    const example = JSON.parse(
      await fs.readFile(path.join(process.cwd(), "docs", "feishu-setup-evidence.example.json"), "utf8")
    ) as unknown;

    const check = evaluateFeishuSetupEvidence(example);

    expect(check).toEqual(
      expect.objectContaining({
        id: "setup.console_labels_recorded",
        status: "fail",
        evidence: expect.arrayContaining([
          "im:message.group_msg.apiName=im:message.group_msg",
          "im:message.group_msg=pending",
          "approvalEvidence=set",
          "send_message=pending",
          "card.action.trigger=pending",
          "resource_transfer=pending",
          expect.stringContaining("missing permission posture:"),
          expect.stringContaining("placeholder setup evidence:")
        ]),
        nextAction: expect.stringContaining("exact real-tenant console labels")
      })
    );
  });

  it("reports concrete next actions for missing required evidence", () => {
    const report = evaluateFeishuSmokeStatus({
      platforms: {
        slack: {
          state: "ready"
        },
        feishu: {
          enabled: true,
          state: "degraded",
          groupMessageMode: "all",
          allMessageDeliveryVerified: false
        }
      },
      state: {
        sessions: [],
        recentBrokerLogs: []
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.all_message_verified",
          status: "fail",
          evidence: expect.arrayContaining([
            "permission.im:message.group_msg=missing"
          ])
        }),
        expect.objectContaining({
          id: "feishu.group_at_created_session",
          status: "fail"
        })
      ])
    );
    expect(report.nextActions.join("\n")).toContain("non-@ follow-up smoke");
  });

  it("does not count the all-message verified flag without same-session non-@ follow-up evidence", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.filter((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          return !(
            logRecord.message === "chat.turn.steered" &&
            logRecord.meta?.source !== "history_recovery" &&
            logRecord.meta?.messageId === "om"
          );
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.all_message_verified",
          status: "fail",
          evidence: expect.arrayContaining([
            "groupMessageMode=all",
            "allMessageDeliveryVerified=true",
            "sameSessionNonAtFollowup=false",
            "permission.im:message.group_msg=verified"
          ])
        }),
        expect.objectContaining({
          id: "feishu.non_at_followup",
          status: "fail"
        })
      ])
    );
  });

  it("returns structured smoke evidence when the admin status endpoint is unavailable", () => {
    const report = createFeishuSmokeUnavailableReport({
      baseUrl: "http://127.0.0.1:3000/admin?token=FEISHU_ADMIN_SECRET#fragment",
      error: new AdminStatusFetchError(404, true),
      checkedAt: "2026-03-19T00:00:00.000Z"
    });

    expect(report).toEqual({
      ok: false,
      checkedAt: "2026-03-19T00:00:00.000Z",
      checks: [
        {
          id: "admin.status_available",
          label: "Broker admin status endpoint is reachable for Feishu smoke evidence",
          required: true,
          status: "fail",
          evidence: [
            "base_url=http://127.0.0.1:3000/admin",
            "http_status=404",
            "response_payload=present"
          ],
          nextAction: "Start a broker build that exposes /admin/api/status, pass the correct --base-url/--admin-token, then rerun the Feishu smoke checker."
        }
      ],
      nextActions: [
        "admin.status_available: Start a broker build that exposes /admin/api/status, pass the correct --base-url/--admin-token, then rerun the Feishu smoke checker."
      ]
    });
    expect(JSON.stringify(report)).not.toContain("FEISHU_ADMIN_SECRET");
  });

  it("writes explicit unavailable admin status evidence when the live status fetch fails", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-smoke-unavailable-bundle-"));
    const report = createFeishuSmokeUnavailableReport({
      baseUrl: "http://127.0.0.1:3000/admin?token=FEISHU_ADMIN_STATUS_SECRET#fragment",
      error: new AdminStatusFetchError(503, false),
      checkedAt: "2026-03-19T00:00:00.000Z"
    });

    const bundle = await writeFeishuSmokeEvidenceBundle({
      outputDir: tempDir,
      source: "http://127.0.0.1:3000/admin?token=FEISHU_ADMIN_STATUS_SECRET#fragment",
      status: undefined,
      report
    });

    const statusOutput = await fs.readFile(bundle.statusFile, "utf8");
    const parsedStatus = JSON.parse(statusOutput);
    expect(parsedStatus.adminStatus).toEqual({
      available: false,
      checkedAt: "2026-03-19T00:00:00.000Z",
      checkId: "admin.status_available",
      evidence: [
        "base_url=http://127.0.0.1:3000/admin",
        "http_status=503",
        "response_payload=empty"
      ],
      nextAction: "Start a broker build that exposes /admin/api/status, pass the correct --base-url/--admin-token, then rerun the Feishu smoke checker."
    });
    expect(parsedStatus.state).toEqual({
      platform: "feishu",
      sessionCount: 0,
      activeCount: 0,
      sessions: [],
      recentBrokerLogs: []
    });
    expect(statusOutput).not.toContain("FEISHU_ADMIN_STATUS_SECRET");
    const replayedReport = await evaluateFeishuSmokeStatusFile(bundle.statusFile, {
      FEISHU_DOMAIN: "feishu"
    });
    expect(replayedReport).toEqual({
      ok: false,
      checkedAt: "2026-03-19T00:00:00.000Z",
      checks: [
        {
          id: "admin.status_available",
          label: "Broker admin status endpoint is reachable for Feishu smoke evidence",
          required: true,
          status: "fail",
          evidence: [
            "base_url=http://127.0.0.1:3000/admin",
            "http_status=503",
            "response_payload=empty"
          ],
          nextAction: "Start a broker build that exposes /admin/api/status, pass the correct --base-url/--admin-token, then rerun the Feishu smoke checker."
        }
      ],
      nextActions: [
        "admin.status_available: Start a broker build that exposes /admin/api/status, pass the correct --base-url/--admin-token, then rerun the Feishu smoke checker."
      ]
    });
    expect(JSON.stringify(replayedReport)).not.toContain("FEISHU_ADMIN_STATUS_SECRET");
    await expect(fs.readFile(bundle.reportFile, "utf8")).resolves.toContain("admin.status_available");
    await expect(fs.readFile(bundle.summaryFile, "utf8")).resolves.toContain("source: http://127.0.0.1:3000/admin");
  });

  it("redacts unsafe values from human-readable smoke output", () => {
    const output = renderFeishuSmokeHumanReport({
      ok: false,
      checkedAt: "FEISHU_HUMAN_CHECKED_AT_SECRET",
      checks: [
        {
          id: "FEISHU_HUMAN_ID_SECRET",
          label: "operator@example.com human label",
          required: true,
          status: "fail",
          evidence: [
            "Bearer feishu-human-evidence-secret",
            "FEISHU_HUMAN_BODY"
          ],
          nextAction: "xoxb-feishu-human-next-action-secret"
        }
      ],
      nextActions: [
        "xapp-feishu-human-next-action-secret"
      ]
    }, {
      baseUrl: "http://127.0.0.1:3000/admin?token=FEISHU_HUMAN_SOURCE_SECRET#fragment"
    });

    expect(output).toContain("Feishu smoke evidence for http://127.0.0.1:3000/admin");
    expect(output).toContain("[redacted unsafe evidence]");
    expect(output).not.toContain("FEISHU_HUMAN_SOURCE_SECRET");
    expect(output).not.toContain("FEISHU_HUMAN_CHECKED_AT_SECRET");
    expect(output).not.toContain("FEISHU_HUMAN_ID_SECRET");
    expect(output).not.toContain("operator@example.com");
    expect(output).not.toContain("Bearer feishu-human-evidence-secret");
    expect(output).not.toContain("FEISHU_HUMAN_BODY");
    expect(output).not.toContain("xoxb-feishu-human-next-action-secret");
    expect(output).not.toContain("xapp-feishu-human-next-action-secret");
  });

  it("prints sanitized bundle write notices without leaking output directories", () => {
    const evidenceNotice = renderFeishuSmokeBundleNotice(
      "evidence",
      path.join("/tmp", "FEISHU_OUTPUT_PATH_SECRET", "operator@example.com", "feishu-smoke-summary.md")
    );
    const preflightNotice = renderFeishuSmokeBundleNotice(
      "preflight",
      path.join("/tmp", "FEISHU_OUTPUT_PATH_SECRET", "feishu-preflight-summary.md")
    );

    expect(evidenceNotice).toBe("wrote evidence bundle: feishu-smoke-summary.md");
    expect(preflightNotice).toBe("wrote preflight bundle: feishu-preflight-summary.md");
    expect(`${evidenceNotice}\n${preflightNotice}`).not.toContain("FEISHU_OUTPUT_PATH_SECRET");
    expect(`${evidenceNotice}\n${preflightNotice}`).not.toContain("operator@example.com");
  });

  it("redacts unsafe values from early CLI error output", () => {
    const fileError = formatFeishuSmokeCliError(
      new Error("ENOENT: no such file or directory, open '/tmp/FEISHU_CLI_PATH_SECRET/operator@example.com/setup.json'")
    );
    const argumentError = formatFeishuSmokeCliError(
      new Error("Unknown argument: --token=xoxb-feishu-cli-secret")
    );
    const unquotedPathError = formatFeishuSmokeCliError(
      new Error("Unknown argument: --status-file=/tmp/FEISHU_CLI_UNQUOTED_PATH_SECRET/operator@example.com/status.json")
    );
    const bodyError = formatFeishuSmokeCliError("FEISHU_CLI_BODY could not be parsed");

    expect(fileError).toContain("setup.json");
    expect(fileError).not.toContain("/tmp/");
    expect(fileError).not.toContain("FEISHU_CLI_PATH_SECRET");
    expect(fileError).not.toContain("operator@example.com");
    expect(argumentError).toContain("[redacted unsafe evidence]");
    expect(argumentError).not.toContain("xoxb-feishu-cli-secret");
    expect(unquotedPathError).toContain("--status-file=status.json");
    expect(unquotedPathError).not.toContain("/tmp/");
    expect(unquotedPathError).not.toContain("FEISHU_CLI_UNQUOTED_PATH_SECRET");
    expect(unquotedPathError).not.toContain("operator@example.com");
    expect(bodyError).toContain("[redacted unsafe evidence]");
    expect(bodyError).not.toContain("FEISHU_CLI_BODY");
  });

  it("requires rich text, card, image, and file evidence before passing resource smoke", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.filter((record) => {
          const meta = (record as { readonly meta?: { readonly msgType?: string } }).meta;
          return meta?.msgType !== "image";
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.rich_card_resource",
          status: "fail",
          evidence: expect.arrayContaining(["missing msgType: image"])
        })
      ])
    );
  });

  it("requires rich/card/resource evidence to match a known Feishu session", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.message.accepted" || logRecord.meta?.msgType !== "image") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              rootMessageId: "om_untracked_image"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.rich_card_resource",
          status: "fail",
          evidence: expect.arrayContaining(["missing msgType: image"])
        })
      ])
    );
  });

  it("requires rich/card/resource evidence to target the group @ session", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        sessions: [
          ...status.state.sessions,
          {
            platform: "feishu",
            key: "feishu:b3RoZXI:b3RoZXI",
            conversationId: "oc_other",
            rootMessageId: "om_other"
          }
        ],
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.message.accepted" || logRecord.meta?.msgType !== "image") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              sessionKey: "feishu:b3RoZXI:b3RoZXI",
              conversationId: "oc_other",
              rootMessageId: "om_other"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.rich_card_resource",
          status: "fail",
          evidence: expect.arrayContaining([
            "requiredSession=group_at groupAtSessionCount=1",
            "missing msgType: image"
          ])
        })
      ])
    );
  });

  it("accepts rootless rich/card/resource evidence when the message is delivered to a known Feishu session", () => {
    const status = passingStatus();
    const rootlessImageMessageId = "om_rootless_image";
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs.map((record) => {
            const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
            if (logRecord.message !== "chat.message.accepted" || logRecord.meta?.msgType !== "image") {
              return record;
            }

            return {
              ...logRecord,
              meta: {
                ...logRecord.meta,
                rootMessageId: rootlessImageMessageId,
                messageId: rootlessImageMessageId,
                eventId: "evt_rootless_image",
                payloadRef: `feishu-message:${rootlessImageMessageId}`
              }
            };
          }),
          log("chat.session.resumed", {
            platform: "feishu",
            rootMessageId: "om",
            messageId: rootlessImageMessageId,
            turnId: "turn-1"
          }),
          log("chat.turn.steered", {
            platform: "feishu",
            rootMessageId: "om",
            messageId: rootlessImageMessageId,
            batchId: rootlessImageMessageId
          })
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(true);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.rich_card_resource",
          status: "pass"
        })
      ])
    );
  });

  it("does not count rich/card/resource evidence that was later ignored", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs,
          log("chat.message.ignored", {
            platform: "feishu",
            conversationId: "oc",
            conversationKind: "group",
            rootMessageId: "om",
            messageId: "om_image",
            ignoredReason: "ignored_no_active_session",
            route: "ignored_no_active_session"
          })
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.rich_card_resource",
          status: "fail",
          evidence: expect.arrayContaining(["missing msgType: image"])
        })
      ])
    );
  });

  it("requires Feishu outbound rich text, card, and file evidence before final smoke readiness", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.filter((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          return logRecord.message !== "chat.outbound.posted" ||
            logRecord.meta?.platform !== "feishu" ||
            logRecord.meta?.format !== "card";
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.outbound_rich_card_file",
          status: "fail",
          evidence: expect.arrayContaining([
            "requiredSession=group_at groupAtSessionCount=1",
            "missing outbound format: card"
          ])
        })
      ])
    );
  });

  it("requires Feishu outbound rich/card/file evidence to target the group @ session", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (
            logRecord.message !== "chat.outbound.posted" ||
            logRecord.meta?.platform !== "feishu" ||
            logRecord.meta?.format !== "file"
          ) {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              sessionKey: "feishu:b2Nfb3JwaGFu:b21fb3JwaGFu",
              conversationId: "oc_orphan_file",
              rootMessageId: "om_orphan_file"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.outbound_rich_card_file",
          status: "fail",
          evidence: expect.arrayContaining([
            "requiredSession=group_at groupAtSessionCount=1",
            "missing outbound format: file"
          ])
        })
      ])
    );
  });

  it("requires Feishu outbound file/image evidence to include the uploaded file id", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (
            logRecord.message !== "chat.outbound.posted" ||
            logRecord.meta?.platform !== "feishu" ||
            logRecord.meta?.format !== "file"
          ) {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              messageId: "om_file_placeholder",
              fileId: undefined
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "feishu.outbound_rich_card_file",
          status: "fail",
          evidence: expect.arrayContaining([
            "requiredSession=group_at groupAtSessionCount=1",
            "missing outbound format: file"
          ])
        }),
        expect.objectContaining({
          id: "observability.required_log_fields",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("chat.outbound.posted: missing fileId when format=file|image")
          ])
        })
      ])
    );
  });

  it("reports same-session outbound rich/card/file evidence instead of later unrelated outbound logs", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs,
          log("chat.outbound.posted", {
            platform: "feishu",
            sessionKey: "feishu:b2Nfb3JwaGFu:b21fb3JwaGFuX3JpY2g",
            conversationId: "oc_orphan_rich",
            rootMessageId: "om_orphan_rich",
            messageId: "om_orphan_rich_reply",
            format: "markdown"
          }),
          log("chat.outbound.posted", {
            platform: "feishu",
            sessionKey: "feishu:b2Nfb3JwaGFu:b21fb3JwaGFuX2NhcmQ",
            conversationId: "oc_orphan_card",
            rootMessageId: "om_orphan_card",
            messageId: "om_orphan_card_reply",
            format: "card"
          }),
          feishuOutboundFileLog({
            sessionKey: "feishu:b2Nfb3JwaGFu:b21fb3JwaGFuX2ZpbGU",
            conversationId: "oc_orphan_file",
            rootMessageId: "om_orphan_file",
            fileId: "file_orphan"
          })
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    const outbound = report.checks.find((check) => check.id === "feishu.outbound_rich_card_file");
    const evidence = outbound?.evidence.join("\n") ?? "";

    expect(report.ok).toBe(true);
    expect(outbound).toMatchObject({
      status: "pass"
    });
    expect(evidence).toContain("chat.outbound.posted feishu long_connection feishu:b2M:b20 oc om om_rich_reply");
    expect(evidence).toContain("chat.outbound.posted feishu long_connection feishu:b2M:b20 oc om om_card_reply");
    expect(evidence).toContain("chat.outbound.posted feishu long_connection feishu:b2M:b20 oc om file_uploaded");
    expect(evidence).not.toContain("oc_orphan");
    expect(evidence).not.toContain("file_orphan");
  });

  it("fails when observed Feishu logs are missing required observability fields", () => {
    const report = evaluateFeishuSmokeStatus({
      platforms: {
        ...passingPlatforms()
      },
      state: {
        sessions: [
          {
            platform: "feishu",
            key: "feishu:b2M:b20",
            conversationId: "oc",
            rootMessageId: "om"
          }
        ],
        recentBrokerLogs: [
          {
            type: "log",
            level: "info",
            message: "chat.outbound.posted",
            meta: {
              platform: "feishu"
            }
          }
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "observability.required_log_fields",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("chat.outbound.posted: missing sessionKey")
          ])
        })
      ])
    );
  });

  it("requires resumed Feishu session logs to include turnId when they continue an active turn", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs,
          log("chat.session.resumed", {
            platform: "feishu",
            turnId: undefined
          })
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "observability.required_log_fields",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("chat.session.resumed: missing turnId when active")
          ])
        })
      ])
    );
  });

  it("requires Feishu outbound posted logs to include a message or file identifier", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.outbound.posted" || logRecord.meta?.platform !== "feishu") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              messageId: undefined,
              fileId: undefined
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "observability.required_log_fields",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("chat.outbound.posted: missing messageId or fileId")
          ])
        })
      ])
    );
  });

  it("requires payloadRef for accepted Feishu rich, card, image, and file logs", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.message.accepted" || logRecord.meta?.msgType !== "rich_text") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              payloadRef: undefined
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "observability.required_log_fields",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("chat.message.accepted: missing payloadRef")
          ])
        })
      ])
    );
  });

  it("requires retained Feishu message payloadRef to match the accepted messageId", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.message.accepted" || logRecord.meta?.msgType !== "rich_text") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              payloadRef: "feishu-message:wrong"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "observability.required_log_fields",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("chat.message.accepted: missing payloadRef=feishu-message:om_rich")
          ])
        })
      ])
    );
  });

  it("requires Feishu card callback payloadRef to match the callback eventId", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.card.callback.received") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              payloadRef: "feishu-card:wrong"
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "observability.required_log_fields",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("chat.card.callback.received: missing payloadRef=feishu-card:evt")
          ])
        })
      ])
    );
  });

  it("requires fileId for accepted Feishu image and file logs", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.message.accepted" || logRecord.meta?.msgType !== "image") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              fileId: undefined
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "observability.required_log_fields",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("chat.message.accepted: missing fileId")
          ])
        })
      ])
    );
  });

  it("validates detached Feishu handler failure log fields", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs,
          log("chat.handler.failed", {
            platform: "feishu",
            handler: "message"
          })
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "observability.required_log_fields",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("chat.handler.failed: missing errorClass")
          ])
        })
      ])
    );
  });

  it("validates detached Feishu handler failure log handler names", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs,
          log("chat.handler.failed", {
            platform: "feishu",
            handler: "unknown_handler",
            errorClass: "Error"
          })
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "observability.required_log_fields",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("chat.handler.failed: missing handler=message|interactive")
          ])
        })
      ])
    );
  });

  it("requires permission metadata for permission-related Feishu degradation logs", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs,
          log("chat.platform.degraded", {
            platform: "feishu",
            source: "long_connection",
            groupMessageMode: "all",
            degradedReason: "all_message_delivery_unverified"
          })
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "observability.required_log_fields",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("chat.platform.degraded: missing permission")
          ])
        })
      ])
    );
  });

  it("requires degradedReason when Feishu history recovery is partial or failed", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs,
          {
            type: "log",
            level: "warn",
            message: "chat.history.recovered",
            meta: {
              platform: "feishu",
              sessionKey: "feishu:b2M:b20",
              conversationId: "oc",
              rootMessageId: "om",
              messageCursor: "unavailable",
              recoveredCount: 0,
              durationMs: 5
            }
          }
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "observability.required_log_fields",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("chat.history.recovered: missing degradedReason")
          ])
        })
      ])
    );
  });

  it("requires recoveredCount on Feishu history recovery logs", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: status.state.recentBrokerLogs.map((record) => {
          const logRecord = record as { readonly message?: string; readonly meta?: Record<string, unknown> };
          if (logRecord.message !== "chat.history.recovered") {
            return record;
          }

          return {
            ...logRecord,
            meta: {
              ...logRecord.meta,
              recoveredCount: undefined
            }
          };
        })
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "observability.required_log_fields",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("chat.history.recovered: missing recoveredCount")
          ])
        })
      ])
    );
  });

  it("requires Feishu attachment download failure logs to identify the failed resource", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs,
          {
            type: "log",
            level: "warn",
            message: "chat.attachment.download_failed",
            meta: {
              platform: "feishu",
              sessionKey: "feishu:b2M:b20",
              conversationId: "oc",
              rootMessageId: "om",
              messageId: "om_image",
              errorClass: "Error"
            }
          }
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "observability.required_log_fields",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("chat.attachment.download_failed: missing attachmentId, kind")
          ])
        })
      ])
    );
  });

  it("fails when Feishu info or warn logs expose raw body fields", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs,
          log("chat.message.accepted", {
            platform: "feishu",
            msgType: "text",
            route: "group_message",
            content: "SENTINEL_RAW_BODY"
          })
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "observability.no_info_warn_body_leaks",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("forbidden meta field meta.content")
          ])
        })
      ])
    );
  });

  it("fails when Feishu info or warn logs expose nested raw body fields", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs,
          log("chat.message.accepted", {
            platform: "feishu",
            msgType: "text",
            route: "group_message",
            attachmentSummaries: [
              {
                rawPayload: "SENTINEL_RAW_BODY"
              }
            ]
          })
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "observability.no_info_warn_body_leaks",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("forbidden meta field meta.attachmentSummaries[0].rawPayload")
          ])
        })
      ])
    );
  });

  it("fails when Feishu info or warn logs expose token or email-like values", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs,
          log("chat.platform.degraded", {
            platform: "feishu",
            degradedReason: "startup_failed",
            diagnostic: {
              actor: "alice@example.com",
              credentialHint: "Bearer test-token"
            }
          })
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "observability.no_info_warn_body_leaks",
          status: "fail",
          evidence: expect.arrayContaining([
            expect.stringContaining("forbidden meta value meta.diagnostic.actor")
          ])
        })
      ])
    );
  });

  it("accepts Feishu outbound file logs with fileId instead of messageId", () => {
    const status = passingStatus();
    const report = evaluateFeishuSmokeStatus({
      ...status,
      state: {
        ...status.state,
        recentBrokerLogs: [
          ...status.state.recentBrokerLogs,
          {
            type: "log",
            level: "info",
            message: "chat.outbound.posted",
            meta: {
              platform: "feishu",
              sessionKey: "feishu:b2M:b20",
              conversationId: "oc",
              rootMessageId: "om",
              fileId: "file_uploaded",
              format: "file",
              durationMs: 0
            }
          }
        ]
      }
    }, {
      FEISHU_DOMAIN: "feishu"
    });

    expect(report.ok).toBe(true);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "observability.required_log_fields",
          status: "pass"
        })
      ])
    );
  });

  it("can evaluate a saved admin status evidence file", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-smoke-status-"));
    const statusFile = path.join(tempDir, "admin-status.json");
    const setupEvidenceFile = path.join(tempDir, "feishu-setup-evidence.json");
    await fs.writeFile(statusFile, JSON.stringify({
      platforms: {
        ...passingPlatforms()
      },
      state: {
        sessions: [
          {
            platform: "feishu",
            key: "feishu:b2M:b20",
            conversationId: "oc",
            rootMessageId: "om"
          }
        ],
        recentBrokerLogs: [
          slackLog("chat.message.accepted"),
          slackLog("chat.outbound.posted"),
          log("chat.platform.ready", { platform: "feishu" }),
          log("chat.message.accepted", { platform: "feishu", route: "bot_mention", msgType: "text" }),
          log("chat.session.created", { platform: "feishu", sessionKey: "feishu:b2M:b20" }),
          log("chat.message.ignored", {
            platform: "feishu",
            conversationId: "oc_direct",
            conversationKind: "direct",
            rootMessageId: "om_direct",
            messageId: "om_direct",
            ignoredReason: "ignored_private_chat"
          }),
          feishuSelfIgnoredLog(),
          log("chat.message.accepted", { platform: "feishu", route: "group_message", messageId: "om_duplicate", eventId: "evt_duplicate" }),
          log("chat.message.deduped", { platform: "feishu", route: "deduped", messageId: "om_duplicate", eventId: "evt_duplicate_replay" }),
          log("chat.platform.degraded", { platform: "feishu", degradedReason: "startup_failed" }),
          log("chat.outbound.failed", { platform: "feishu", errorClass: "Error", statusCode: 503, attempt: 1 }),
          log("chat.turn.started", { platform: "feishu" }),
          log("chat.outbound.posted", { platform: "feishu" }),
          log("chat.turn.completed", { platform: "feishu" }),
          ...feishuOutboundRichCardFileLogs(),
          log("chat.message.accepted", { platform: "feishu", route: "group_message" }),
          log("chat.turn.steered", { platform: "feishu" }),
          log("chat.message.accepted", { platform: "feishu", route: "group_message", msgType: "text", messageId: "om_stop", eventId: "evt_stop" }),
          log("chat.session.resumed", { platform: "feishu", messageId: "om_stop", turnId: "turn-1" }),
          log("chat.turn.stopped", { platform: "feishu", messageId: "om_stop" }),
          log("chat.turn.steered", { platform: "feishu", source: "history_recovery", messageId: "om_recovered", batchId: "history:om_recovered" }),
          log("chat.history.recovered", { platform: "feishu" }),
          log("chat.message.accepted", { platform: "feishu", msgType: "rich_text", messageId: "om_rich" }),
          log("chat.message.accepted", { platform: "feishu", msgType: "card", messageId: "om_card_payload" }),
          log("chat.message.accepted", { platform: "feishu", msgType: "image", messageId: "om_image" }),
          log("chat.message.accepted", { platform: "feishu", msgType: "file", messageId: "om_file" }),
          log("chat.card.callback.received", { platform: "feishu", messageId: "om_card_reply", kind: "coauthor_confirm_all", candidateRevision: 1 }),
          log("chat.coauthor.confirmed", { platform: "feishu", candidateRevision: 1, confirmedCount: 1 })
        ]
      }
    }));
    await fs.writeFile(setupEvidenceFile, JSON.stringify(passingSetupEvidence()));

    const missingSetupReport = await evaluateFeishuSmokeStatusFile(statusFile, {
      FEISHU_DOMAIN: "feishu"
    });
    expect(missingSetupReport.ok).toBe(false);
    expect(missingSetupReport.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "setup.console_labels_recorded",
          status: "fail"
        })
      ])
    );

    const report = await evaluateFeishuSmokeStatusFile(statusFile, {
      FEISHU_DOMAIN: "feishu"
    }, {
      setupEvidenceFile
    });

    expect(report.ok).toBe(true);
  });

  it("writes a reusable evidence bundle with status, report, and markdown summary", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-smoke-bundle-"));
    const status = {
      ...passingStatus(),
      platforms: {
        ...passingStatus().platforms,
        slack: {
          ...passingStatus().platforms.slack,
          lastError: {
            message: "FEISHU_PLATFORM_TOP_LEVEL_SECRET"
          }
        },
        feishu: {
          ...passingStatus().platforms.feishu,
          rawPayload: "FEISHU_PLATFORM_RAW_PAYLOAD_SECRET",
          connection: {
            ...passingStatus().platforms.feishu.connection,
            token: "Bearer feishu-platform-secret"
          },
          permissions: passingStatus().platforms.feishu.permissions.map((permission) => ({
            ...permission,
            requiredFor: "FEISHU_PERMISSION_REQUIRED_FOR_SECRET"
          })),
          lastError: {
            message: "operator@example.com"
          }
        }
      },
      account: {
        account: {
          email: "operator@example.com"
        }
      },
      authProfiles: {
        profiles: [
          {
            name: "secret-profile"
          }
        ]
      },
      state: {
        ...passingStatus().state,
        openInbound: [
          {
            textPreview: "FEISHU_SECRET_BODY_SENTINEL"
          }
        ],
        sessions: [
          ...passingStatus().state.sessions.map((session) => ({
            ...session,
            sessionKey: "Bearer feishu-session-secret",
            conversationKind: "group",
            platformThreadId: "operator@example.com",
            activeTurnId: "xoxb-feishu-session-secret",
            lastObservedMessageTs: "FEISHU_SESSION_TIMESTAMP_SECRET",
            lastDeliveredMessageTs: "2026-03-19T00:00:04.000Z",
            openInbound: [
              {
                textPreview: "FEISHU_NESTED_SECRET_BODY_SENTINEL"
              }
            ]
          })),
          {
            platform: "slack",
            key: "C123:111.222",
            conversationId: "C123",
            rootMessageId: "111.222",
            activeTurnId: "SLACK_ACTIVE_TURN_SENTINEL"
          }
        ]
      }
    };
    const report = evaluateFeishuSmokeStatus(status, {
      FEISHU_DOMAIN: "feishu"
    });

    const bundle = await writeFeishuSmokeEvidenceBundle({
      outputDir: tempDir,
      source: "status-file:admin-status.json",
      status,
      report,
      setupEvidence: passingSetupEvidence()
    });

    const statusEvidence = await fs.readFile(bundle.statusFile, "utf8");
    expect(statusEvidence).toContain("\"platforms\"");
    expect(statusEvidence).toContain("\"recentBrokerLogs\"");
    expect(statusEvidence).not.toContain("operator@example.com");
    expect(statusEvidence).not.toContain("secret-profile");
    expect(statusEvidence).not.toContain("FEISHU_SECRET_BODY_SENTINEL");
    expect(statusEvidence).not.toContain("FEISHU_NESTED_SECRET_BODY_SENTINEL");
    expect(statusEvidence).not.toContain("SLACK_ACTIVE_TURN_SENTINEL");
    expect(statusEvidence).not.toContain("Bearer feishu-session-secret");
    expect(statusEvidence).not.toContain("xoxb-feishu-session-secret");
    expect(statusEvidence).not.toContain("FEISHU_SESSION_TIMESTAMP_SECRET");
    expect(statusEvidence).not.toContain("FEISHU_PLATFORM_TOP_LEVEL_SECRET");
    expect(statusEvidence).not.toContain("FEISHU_PLATFORM_RAW_PAYLOAD_SECRET");
    expect(statusEvidence).not.toContain("Bearer feishu-platform-secret");
    expect(statusEvidence).not.toContain("FEISHU_PERMISSION_REQUIRED_FOR_SECRET");
    const parsedStatus = JSON.parse(statusEvidence);
    expect(parsedStatus.state).toMatchObject({
      platform: "feishu",
      sessionCount: 1,
      activeCount: 0,
      sessions: [
        expect.objectContaining({
          platform: "feishu",
          conversationId: "oc",
          conversationKind: "group",
          rootMessageId: "om",
          lastDeliveredMessageTs: "2026-03-19T00:00:04.000Z"
        })
      ]
    });
    expect(parsedStatus.platforms.feishu.permissions[0]).toEqual({
      name: "bot_identity",
      status: "configured"
    });
    await expect(fs.readFile(bundle.setupEvidenceFile ?? "", "utf8")).resolves.toContain("china_feishu");
    await expect(fs.readFile(bundle.reportFile, "utf8")).resolves.toContain("\"ok\": true");
    await expect(fs.readFile(bundle.summaryFile, "utf8")).resolves.toContain("Feishu Smoke Evidence");
    await expect(fs.readFile(bundle.summaryFile, "utf8")).resolves.toContain("status-file:admin-status.json");
  });

  it("redacts unsafe values from reusable report and summary evidence", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-smoke-report-bundle-"));
    const status = {
      ...passingStatus(),
      state: {
        ...passingStatus().state,
        sessions: [
          {
            platform: "feishu",
            key: "Bearer feishu-report-secret",
            conversationId: "operator@example.com",
            rootMessageId: "FEISHU_REPORT_BODY"
          }
        ]
      }
    };
    const report = evaluateFeishuSmokeStatus(status, {
      FEISHU_DOMAIN: "feishu"
    });
    const unsafeReport = {
      ...report,
      checkedAt: "FEISHU_REPORT_CHECKED_AT_SECRET",
      checks: report.checks.map((check, index) => index === 0
        ? {
            ...check,
            id: "FEISHU_REPORT_ID_SECRET",
            label: "operator@example.com report label",
            evidence: [
              ...check.evidence,
              "Bearer feishu-report-evidence-secret"
            ],
            nextAction: "FEISHU_REPORT_NEXT_ACTION_BODY"
          }
        : check),
      nextActions: [
        ...report.nextActions,
        "xoxb-feishu-report-next-action-secret"
      ]
    };

    const bundle = await writeFeishuSmokeEvidenceBundle({
      outputDir: tempDir,
      source: "http://127.0.0.1:3000/admin?token=FEISHU_SOURCE_SECRET#fragment",
      status,
      report: unsafeReport,
      setupEvidence: passingSetupEvidence()
    });

    const reportOutput = await fs.readFile(bundle.reportFile, "utf8");
    const summaryOutput = await fs.readFile(bundle.summaryFile, "utf8");
    expect(report.ok).toBe(false);
    expect(`${reportOutput}\n${summaryOutput}`).toContain("[redacted unsafe evidence]");
    expect(`${reportOutput}\n${summaryOutput}`).not.toContain("Bearer feishu-report-secret");
    expect(`${reportOutput}\n${summaryOutput}`).not.toContain("Bearer feishu-report-evidence-secret");
    expect(`${reportOutput}\n${summaryOutput}`).not.toContain("xoxb-feishu-report-next-action-secret");
    expect(`${reportOutput}\n${summaryOutput}`).not.toContain("operator@example.com");
    expect(`${reportOutput}\n${summaryOutput}`).not.toContain("FEISHU_REPORT_CHECKED_AT_SECRET");
    expect(`${reportOutput}\n${summaryOutput}`).not.toContain("FEISHU_REPORT_ID_SECRET");
    expect(`${reportOutput}\n${summaryOutput}`).not.toContain("FEISHU_REPORT_BODY");
    expect(`${reportOutput}\n${summaryOutput}`).not.toContain("FEISHU_REPORT_NEXT_ACTION_BODY");
    expect(summaryOutput).toContain("source: http://127.0.0.1:3000/admin");
    expect(summaryOutput).not.toContain("FEISHU_SOURCE_SECRET");
  });

  it("allowlists recent broker log metadata in reusable evidence bundles", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-smoke-bundle-"));
    const status = {
      ...passingStatus(),
      state: {
        ...passingStatus().state,
        recentBrokerLogs: [
          ...passingStatus().state.recentBrokerLogs,
          {
            ts: "2026-03-19T00:00:03.000Z",
            type: "log",
            level: "info",
            message: "chat.message.accepted",
            content: "FEISHU_TOP_LEVEL_SECRET_BODY",
            meta: {
              platform: "feishu",
              conversationId: "oc",
              conversationKind: "group",
              rootMessageId: "om",
              messageId: "om",
              eventId: "evt-secret",
              jobId: "job-1",
              payloadRef: "Bearer feishu-secret",
              fileId: "xoxb-feishu-secret",
              senderKind: "user",
              route: "group_message",
              msgType: "text",
              content: "FEISHU_RECENT_LOG_SECRET_BODY",
              rawPayload: "FEISHU_RECENT_RAW_PAYLOAD",
              email: "operator@example.com",
              attachmentSummaries: [
                {
                  rawPayload: "FEISHU_NESTED_RAW_PAYLOAD"
                }
              ],
              headers: {
                authorization: "Bearer feishu-secret"
              }
            }
          },
          {
            ts: "FEISHU_TIMESTAMP_SECRET_BODY",
            type: "log",
            level: "info",
            message: "FEISHU_RECENT_TOP_LEVEL_SECRET_BODY",
            meta: {
              platform: "feishu",
              conversationId: "oc"
            }
          }
        ]
      }
    };
    const report = evaluateFeishuSmokeStatus(status, {
      FEISHU_DOMAIN: "feishu"
    });

    const bundle = await writeFeishuSmokeEvidenceBundle({
      outputDir: tempDir,
      source: "status-file:admin-status.json",
      status,
      report
    });

    const statusEvidence = await fs.readFile(bundle.statusFile, "utf8");
    const parsedStatus = JSON.parse(statusEvidence);
    const sanitizedLog = parsedStatus.state.recentBrokerLogs.find(
      (record: { meta?: { eventId?: string } }) => record.meta?.eventId === "evt-secret"
    );

    expect(sanitizedLog).toMatchObject({
      ts: "2026-03-19T00:00:03.000Z",
      type: "log",
      level: "info",
      message: "chat.message.accepted",
      meta: {
        platform: "feishu",
        conversationId: "oc",
        conversationKind: "group",
        rootMessageId: "om",
        messageId: "om",
        eventId: "evt-secret",
        jobId: "job-1",
        senderKind: "user",
        route: "group_message",
        msgType: "text"
      }
    });
    expect(sanitizedLog).not.toHaveProperty("content");
    expect(sanitizedLog.meta).not.toHaveProperty("content");
    expect(sanitizedLog.meta).not.toHaveProperty("rawPayload");
    expect(sanitizedLog.meta).not.toHaveProperty("payloadRef");
    expect(sanitizedLog.meta).not.toHaveProperty("fileId");
    expect(sanitizedLog.meta).not.toHaveProperty("email");
    expect(sanitizedLog.meta).not.toHaveProperty("attachmentSummaries");
    expect(sanitizedLog.meta).not.toHaveProperty("headers");
    expect(statusEvidence).not.toContain("FEISHU_TOP_LEVEL_SECRET_BODY");
    expect(statusEvidence).not.toContain("FEISHU_RECENT_LOG_SECRET_BODY");
    expect(statusEvidence).not.toContain("FEISHU_RECENT_RAW_PAYLOAD");
    expect(statusEvidence).not.toContain("xoxb-feishu-secret");
    expect(statusEvidence).not.toContain("FEISHU_NESTED_RAW_PAYLOAD");
    expect(statusEvidence).not.toContain("FEISHU_TIMESTAMP_SECRET_BODY");
    expect(statusEvidence).not.toContain("FEISHU_RECENT_TOP_LEVEL_SECRET_BODY");
    expect(statusEvidence).not.toContain("operator@example.com");
    expect(statusEvidence).not.toContain("Bearer feishu-secret");
  });

  it("sanitizes setup evidence copied into reusable evidence bundles", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-smoke-bundle-"));
    const setupEvidence = {
      ...passingSetupEvidence(),
      appSecret: "FEISHU_SETUP_SECRET_SENTINEL",
      botOpenId: "ou_realbot123456",
      permissions: {
        imMessageGroupMsg: {
          apiName: "im:message.group_msg",
          status: "approved",
          approvalEvidence: "approved by operator@example.com"
        }
      },
      notes: [
        "safe redacted ticket reference",
        "raw callback actor ou_realbot123456 should not be stored",
        "Bearer feishu-setup-secret"
      ]
    };
    const report = evaluateFeishuSmokeStatus(passingStatus(), {
      FEISHU_DOMAIN: "feishu"
    }, {
      requireSetupEvidence: true,
      setupEvidence
    });

    const bundle = await writeFeishuSmokeEvidenceBundle({
      outputDir: tempDir,
      source: "status-file:admin-status.json",
      status: passingStatus(),
      report,
      setupEvidence
    });

    const setupEvidenceOutput = await fs.readFile(bundle.setupEvidenceFile ?? "", "utf8");
    expect(setupEvidenceOutput).toContain("\"target\": \"china_feishu\"");
    expect(setupEvidenceOutput).toContain("\"apiName\": \"im:message.group_msg\"");
    expect(setupEvidenceOutput).toContain("\"status\": \"approved\"");
    expect(setupEvidenceOutput).toContain("safe redacted ticket reference");
    expect(setupEvidenceOutput).toContain("[redacted unsafe setup evidence]");
    expect(setupEvidenceOutput).not.toContain("appSecret");
    expect(setupEvidenceOutput).not.toContain("botOpenId");
    expect(setupEvidenceOutput).not.toContain("FEISHU_SETUP_SECRET_SENTINEL");
    expect(setupEvidenceOutput).not.toContain("operator@example.com");
    expect(setupEvidenceOutput).not.toContain("ou_realbot123456");
    expect(setupEvidenceOutput).not.toContain("Bearer feishu-setup-secret");
  });
});

function log(message: string, meta: Record<string, unknown>) {
  const defaultMessageId = typeof meta.messageId === "string" && meta.messageId.trim()
    ? meta.messageId
    : "om";
  const defaultEventId = typeof meta.eventId === "string" && meta.eventId.trim()
    ? meta.eventId
    : "evt";
  const normalizedMeta = meta.platform === "feishu"
    ? {
        platform: "feishu",
        source: "long_connection",
        groupMessageMode: "all",
        startupRequired: true,
        durationMs: 0,
        sessionKey: "feishu:b2M:b20",
        conversationId: "oc",
        conversationKind: "group",
        rootMessageId: "om",
        messageId: "om",
        eventId: "evt",
        senderKind: "user",
        ignoredReason: "ignored_private_chat",
        route: "group_message",
        msgType: "text",
        format: "text",
        recoveredCount: message === "chat.history.recovered" ? 1 : undefined,
        turnId: "turn-1",
        codexThreadId: "thread-1",
        batchId: "om",
        payloadRef: message === "chat.card.callback.received"
          ? `feishu-card:${defaultEventId}`
          : `feishu-message:${defaultMessageId}`,
        fileId: meta.msgType === "image" || meta.msgType === "file" ? "feishu-resource-key" : undefined,
        ackDurationMs: 0,
        hadActiveTurn: true,
        messageCursor: "1710000000000",
        ...meta
      }
    : meta;

  return {
    type: "log",
    level: "info",
    message,
    meta: normalizedMeta
  };
}

function slackLog(message: string) {
  return {
    type: "log",
    level: "info",
    message,
    meta: {
      platform: "slack",
      sessionKey: "slack:QzEyMw:MTExLjIyMg",
      conversationId: "C123",
      conversationKind: "channel",
      rootMessageId: "111.222",
      messageId: message === "chat.outbound.posted" ? "111.224" : "111.223",
      eventId: "111.223",
      senderKind: "user",
      msgType: "text",
      route: "app_mention",
      format: "text",
      durationMs: 0
    }
  };
}

function slackPlatformLog(message: string) {
  return {
    type: "log",
    level: "info",
    message,
    meta: {
      platform: "slack",
      source: "socket_mode",
      durationMs: 0
    }
  };
}

function feishuSelfIgnoredLog() {
  return log("chat.message.ignored", {
    platform: "feishu",
    conversationId: "oc",
    conversationKind: "group",
    rootMessageId: "om",
    messageId: "om_self",
    eventId: "evt_self",
    senderKind: "app",
    ignoredReason: "ignored_self",
    route: "ignored_self"
  });
}

function feishuOutboundRichCardFileLogs() {
  return [
    log("chat.outbound.posted", {
      platform: "feishu",
      messageId: "om_rich_reply",
      format: "markdown"
    }),
    log("chat.outbound.posted", {
      platform: "feishu",
      messageId: "om_card_reply",
      format: "card"
    }),
    feishuOutboundFileLog()
  ];
}

function feishuOutboundFileLog(overrides: Record<string, unknown> = {}) {
  return {
    type: "log",
    level: "info",
    message: "chat.outbound.posted",
    meta: {
      platform: "feishu",
      source: "long_connection",
      sessionKey: "feishu:b2M:b20",
      conversationId: "oc",
      rootMessageId: "om",
      fileId: "file_uploaded",
      format: "file",
      durationMs: 0,
      ...overrides
    }
  };
}

function passingPlatforms() {
  return {
    slack: {
      state: "ready",
      connection: {
        mode: "socket_mode",
        connected: true,
        lastConnectedAt: "2026-03-19T00:00:01.000Z"
      }
    },
    feishu: {
      enabled: true,
      state: "ready",
      groupMessageMode: "all",
      allMessageDeliveryVerified: true,
      connection: {
        mode: "long_connection",
        connected: true,
        lastConnectedAt: "2026-03-19T00:00:02.000Z"
      },
      permissions: [
        {
          name: "bot_identity",
          requiredFor: "Feishu @bot mention detection",
          status: "configured"
        },
        {
          name: "im:message.group_msg",
          requiredFor: "Feishu active-session non-@ follow-ups and group history",
          status: "verified"
        },
        {
          name: "im:message:send_as_bot",
          requiredFor: "Feishu text, rich text, and card replies",
          status: "configured"
        }
      ]
    }
  };
}

function passingStatus() {
  return {
    platforms: passingPlatforms(),
    state: {
      sessions: [
        {
          platform: "feishu",
          key: "feishu:b2M:b20",
          conversationId: "oc",
          rootMessageId: "om"
        }
      ],
      recentBrokerLogs: [
        slackLog("chat.message.accepted"),
        slackLog("chat.outbound.posted"),
        log("chat.platform.ready", { platform: "feishu" }),
        log("chat.message.accepted", { platform: "feishu", route: "bot_mention", msgType: "text" }),
        log("chat.session.created", { platform: "feishu", sessionKey: "feishu:b2M:b20" }),
        log("chat.message.ignored", {
          platform: "feishu",
          conversationId: "oc_direct",
          conversationKind: "direct",
          rootMessageId: "om_direct",
          messageId: "om_direct",
          ignoredReason: "ignored_private_chat"
        }),
        feishuSelfIgnoredLog(),
        log("chat.message.accepted", { platform: "feishu", route: "group_message", messageId: "om_duplicate", eventId: "evt_duplicate" }),
        log("chat.message.deduped", { platform: "feishu", route: "deduped", messageId: "om_duplicate", eventId: "evt_duplicate_replay" }),
        log("chat.platform.degraded", { platform: "feishu", degradedReason: "startup_failed" }),
        log("chat.outbound.failed", { platform: "feishu", errorClass: "Error", statusCode: 503, attempt: 1 }),
        log("chat.turn.started", { platform: "feishu" }),
        log("chat.outbound.posted", { platform: "feishu" }),
        log("chat.turn.completed", { platform: "feishu" }),
        ...feishuOutboundRichCardFileLogs(),
        log("chat.message.accepted", { platform: "feishu", route: "group_message" }),
        log("chat.turn.steered", { platform: "feishu" }),
        log("chat.message.accepted", { platform: "feishu", route: "group_message", msgType: "text", messageId: "om_stop", eventId: "evt_stop" }),
        log("chat.session.resumed", { platform: "feishu", messageId: "om_stop", turnId: "turn-1" }),
        log("chat.turn.stopped", { platform: "feishu", messageId: "om_stop" }),
        log("chat.turn.steered", { platform: "feishu", source: "history_recovery", messageId: "om_recovered", batchId: "history:om_recovered" }),
        log("chat.history.recovered", { platform: "feishu" }),
        log("chat.message.accepted", { platform: "feishu", msgType: "rich_text", messageId: "om_rich" }),
        log("chat.message.accepted", { platform: "feishu", msgType: "card", messageId: "om_card_payload" }),
        log("chat.message.accepted", { platform: "feishu", msgType: "image", messageId: "om_image" }),
        log("chat.message.accepted", { platform: "feishu", msgType: "file", messageId: "om_file" }),
        log("chat.card.callback.received", { platform: "feishu", messageId: "om_card_reply", kind: "coauthor_confirm_all", candidateRevision: 1 }),
        log("chat.coauthor.confirmed", { platform: "feishu", candidateRevision: 1, confirmedCount: 1 })
      ]
    }
  };
}

function passingSetupEvidence() {
  return {
    target: "china_feishu",
    consoleLabels: {
      appType: "China Feishu self-built/custom app",
      botCapability: "机器人能力",
      eventDelivery: "使用长连接接收事件",
      receiveMessageEvent: "接收消息",
      groupMessagePermission: "获取群组中所有消息",
      sendMessagePermission: "以应用的身份发消息",
      cardCallback: "卡片回传交互",
      resourcePermission: "获取与上传图片或文件资源",
      botIdentitySource: "Tenant console identity tab, redacted screenshot FS-2026-05-29-01"
    },
    permissions: {
      imMessageGroupMsg: {
        apiName: "im:message.group_msg",
        status: "approved",
        approvalEvidence: "FEI-PERM-1234 approved 2026-05-29 by platform admin"
      },
      sendMessage: {
        apiName: "im:message:send_as_bot",
        status: "configured",
        evidence: "messages create/reply scope enabled in tenant console"
      },
      cardCallback: {
        eventName: "card.action.trigger",
        status: "enabled",
        evidence: "card callback event subscription enabled in tenant console"
      },
      resourceTransfer: {
        scopeName: "获取与上传图片或文件资源",
        status: "configured",
        evidence: "image/file resource scope enabled in tenant console"
      }
    }
  };
}

async function runFeishuSmokeCli(args: readonly string[]): Promise<{
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "test/manual/run-real-feishu-smoke.ts",
    ...args
  ], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "test"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
  }, 10_000);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  clearTimeout(timeout);
  return {
    exitCode,
    stdout,
    stderr
  };
}
