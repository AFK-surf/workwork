import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { SlackUserIdentity } from "../../types.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.resolve(moduleDir, "prompts", "slack-thread-base-instructions.md");

let templateCache: Promise<string> | undefined;

export interface BuildSlackThreadBaseInstructionsOptions {
  readonly platform?: "slack" | "feishu" | undefined;
  readonly brokerHttpBaseUrl: string;
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly conversationId?: string | undefined;
  readonly conversationKind?: string | undefined;
  readonly rootMessageId?: string | undefined;
  readonly platformThreadId?: string | undefined;
  readonly workspacePath: string;
  readonly reposRoot: string;
  readonly codexGeneratedImagesRoot: string;
  readonly slackBotIdentity: SlackUserIdentity | null;
  readonly personalMemory?: string | undefined;
  readonly fin?: FinRuntimePromptContext | undefined;
}

export interface FinRuntimePromptContext {
  readonly agentName: string;
  readonly finDir?: string | undefined;
}

export async function buildSlackThreadBaseInstructions(options: BuildSlackThreadBaseInstructionsOptions): Promise<string> {
  const template = await loadTemplate();
  const platform = options.platform === "feishu" ? "feishu" : "slack";
  const chatSurfaceName = platform === "feishu" ? "Feishu" : "Slack";
  const conversationId = options.conversationId ?? options.channelId;
  const rootMessageId = options.rootMessageId ?? options.rootThreadTs;
  const isSlack = platform === "slack";
  const linearToolsUrl = `${options.brokerHttpBaseUrl}/integrations/mcp-tools?server=linear`;
  const notionToolsUrl = `${options.brokerHttpBaseUrl}/integrations/mcp-tools?server=notion`;
  const messagePayload = isSlack
    ? JSON.stringify({
        channel_id: options.channelId,
        thread_ts: options.rootThreadTs,
        text: "replace with your Slack update",
        kind: "progress",
      })
    : JSON.stringify({
        platform,
        conversation_id: conversationId,
        root_message_id: rootMessageId,
        text: "replace with your Feishu update",
        kind: "progress",
      });
  const waitStatePayload = isSlack
    ? JSON.stringify({
        channel_id: options.channelId,
        thread_ts: options.rootThreadTs,
        kind: "wait",
        reason: "replace with what you are waiting for",
      })
    : JSON.stringify({
        platform,
        conversation_id: conversationId,
        root_message_id: rootMessageId,
        kind: "wait",
        reason: "replace with what you are waiting for",
      });
  const finalStatePayload = isSlack
    ? JSON.stringify({
        channel_id: options.channelId,
        thread_ts: options.rootThreadTs,
        kind: "final",
      })
    : JSON.stringify({
        platform,
        conversation_id: conversationId,
        root_message_id: rootMessageId,
        kind: "final",
      });
  const blockStatePayload = isSlack
    ? JSON.stringify({
        channel_id: options.channelId,
        thread_ts: options.rootThreadTs,
        kind: "block",
        reason: "replace with the blocker",
      })
    : JSON.stringify({
        platform,
        conversation_id: conversationId,
        root_message_id: rootMessageId,
        kind: "block",
        reason: "replace with the blocker",
      });
  const filePayload = isSlack
    ? JSON.stringify({
        channel_id: options.channelId,
        thread_ts: options.rootThreadTs,
        file_path: "/absolute/path/to/file.png",
        initial_comment: "replace with your Slack file caption",
      })
    : JSON.stringify({
        platform,
        conversation_id: conversationId,
        root_message_id: rootMessageId,
        file_path: "/absolute/path/to/file.png",
        initial_comment: "replace with your Feishu file caption",
      });
  const coauthorConfigurePayload = JSON.stringify({
    cwd: options.workspacePath,
    coauthors: ["Alice Example"],
    ignore_missing: true,
  });
  const linearCallPayload = JSON.stringify({
    server: "linear",
    name: "replace_with_linear_tool_name",
    arguments: {
      replace: "with tool arguments",
    },
  });
  const notionCallPayload = JSON.stringify({
    server: "notion",
    name: "replace_with_notion_tool_name",
    arguments: {
      replace: "with tool arguments",
    },
  });
  const jobPayload = isSlack
    ? JSON.stringify({
        channel_id: options.channelId,
        thread_ts: options.rootThreadTs,
        kind: "watch_ci",
        cwd: ".",
        script: '#!/usr/bin/env bash\nset -euo pipefail\nnode "$BROKER_JOB_HELPER" event --kind "state_changed" --summary "replace with your update"\nnode "$BROKER_JOB_HELPER" complete --summary "replace with your completion update"',
      })
    : JSON.stringify({
        platform,
        conversationId,
        rootMessageId,
        kind: "watch_ci",
        cwd: ".",
        script: '#!/usr/bin/env bash\nset -euo pipefail\nnode "$BROKER_JOB_HELPER" event --kind "state_changed" --summary "replace with your update"\nnode "$BROKER_JOB_HELPER" complete --summary "replace with your completion update"',
      });
  const postMessageRoute = isSlack ? "/slack/post-message" : "/chat/post-message";
  const postStateRoute = isSlack ? "/slack/post-state" : "/chat/post-state";
  const postFileRoute = isSlack ? "/slack/post-file" : "/chat/post-file";
  const threadHistoryCommand = isSlack
    ? `curl -sS '${options.brokerHttpBaseUrl}/slack/thread-history?channel_id=${encodeURIComponent(options.channelId)}&thread_ts=${encodeURIComponent(options.rootThreadTs)}&before_ts=older-message-ts&limit=20&format=text'`
    : `curl -sS '${options.brokerHttpBaseUrl}/chat/thread-history?platform=feishu&conversation_id=${encodeURIComponent(conversationId)}&root_message_id=${encodeURIComponent(rootMessageId)}&before_cursor=older-message-cursor&limit=20&format=text'`;

  return renderTemplate(template, {
    chat_surface_name: chatSurfaceName,
    execution_environment_section: await buildExecutionEnvironmentSection(),
    fin_runtime_section: formatFinRuntimeSection(options.fin),
    session_workspace: options.workspacePath,
    shared_repos_root: options.reposRoot,
    codex_generated_images_root: options.codexGeneratedImagesRoot,
    channel_id: options.channelId,
    thread_ts: options.rootThreadTs,
    thread_coordinates_section: formatThreadCoordinatesSection({
      platform,
      channelId: options.channelId,
      rootThreadTs: options.rootThreadTs,
      conversationId,
      conversationKind: options.conversationKind,
      rootMessageId,
      platformThreadId: options.platformThreadId,
    }),
    thread_model_note: isSlack
      ? "Slack message model: this session is anchored to one Slack thread. Treat each forwarded message in this thread as a possible follow-up in the same product session."
      : "Feishu message model: this session is anchored to one Feishu topic. Treat `root_message_id` and `platform_thread_id` as the Feishu equivalent of a Slack thread; every forwarded message in this topic is a possible follow-up in the same product session.",
    markdown_note: isSlack
      ? "Write normal Markdown in the `text` field. Do not handcraft Slack `mrkdwn`; the broker converts markdownish output to `mrkdwn` before posting."
      : "For Feishu, set `format` to `markdown` when you want the broker to send Feishu rich-post Markdown; otherwise plain `text` is sent as text or operational cards.",
    post_file_note: isSlack ? "For `/slack/post-file`, `initial_comment` also accepts normal Markdown and is converted before posting." : "For `/chat/post-file`, `initial_comment`/`initialComment` can be sent with the same Feishu thread coordinates.",
    post_file_route_label: `\`${postFileRoute}\``,
    post_state_route_label: `\`${postStateRoute}\``,
    registered_job_env_vars: isSlack
      ? "BROKER_JOB_ID, BROKER_JOB_TOKEN, BROKER_API_BASE, BROKER_JOB_HELPER, CHAT_PLATFORM, CHAT_CONVERSATION_ID, CHAT_ROOT_MESSAGE_ID, SLACK_CHANNEL_ID, SLACK_THREAD_TS, SESSION_KEY, SESSION_WORKSPACE, and REPOS_ROOT"
      : "BROKER_JOB_ID, BROKER_JOB_TOKEN, BROKER_API_BASE, BROKER_JOB_HELPER, CHAT_PLATFORM, CHAT_CONVERSATION_ID, CHAT_ROOT_MESSAGE_ID, SESSION_KEY, SESSION_WORKSPACE, and REPOS_ROOT",
    post_message_command: `curl -sS -X POST ${options.brokerHttpBaseUrl}${postMessageRoute} -H 'content-type: application/json' -d '${messagePayload}'`,
    post_state_final_command: `curl -sS -X POST ${options.brokerHttpBaseUrl}${postStateRoute} -H 'content-type: application/json' -d '${finalStatePayload}'`,
    post_state_wait_command: `curl -sS -X POST ${options.brokerHttpBaseUrl}${postStateRoute} -H 'content-type: application/json' -d '${waitStatePayload}'`,
    post_state_block_command: `curl -sS -X POST ${options.brokerHttpBaseUrl}${postStateRoute} -H 'content-type: application/json' -d '${blockStatePayload}'`,
    post_file_command: `curl -sS -X POST ${options.brokerHttpBaseUrl}${postFileRoute} -H 'content-type: application/json' -d '${filePayload}'`,
    coauthor_status_command: `curl -sS '${options.brokerHttpBaseUrl}/slack/git-coauthors/session-status?cwd=${encodeURIComponent(options.workspacePath)}'`,
    coauthor_configure_command: `curl -sS -X POST ${options.brokerHttpBaseUrl}/slack/git-coauthors/configure-session -H 'content-type: application/json' -d '${coauthorConfigurePayload}'`,
    thread_history_command: threadHistoryCommand,
    register_job_command: `curl -sS -X POST ${options.brokerHttpBaseUrl}/jobs/register -H 'content-type: application/json' -d '${jobPayload}'`,
    linear_tools_command: `curl -sS '${linearToolsUrl}'`,
    notion_tools_command: `curl -sS '${notionToolsUrl}'`,
    linear_call_command: `curl -sS -X POST ${options.brokerHttpBaseUrl}/integrations/mcp-call -H 'content-type: application/json' -d '${linearCallPayload}'`,
    notion_call_command: `curl -sS -X POST ${options.brokerHttpBaseUrl}/integrations/mcp-call -H 'content-type: application/json' -d '${notionCallPayload}'`,
    chat_bot_identity_section: isSlack ? formatSlackBotIdentitySection(options.slackBotIdentity) : "Feishu bot identity: when a Feishu message mentions the broker bot in this session, that mention refers to you.",
    personal_memory_section: formatPersonalMemorySection(options.personalMemory),
  });
}

function formatFinRuntimeSection(fin?: FinRuntimePromptContext): string {
  if (!fin) {
    return "";
  }

  const lines = [
    "Fin supervisor runtime:",
    `- This Codex app-server was started by fin-supervisor for agent_name: ${fin.agentName}.`,
    fin.finDir ? `- FIN_DIR is expected to be: ${fin.finDir}.` : "- FIN_DIR is provided by fin-supervisor.",
    "- Fin isolates agents with a per-agent sandbox. Treat sandbox denials as intentional policy, not as transient tool failures.",
    "- Your normal shell commands run as the current Fin agent. They inherit AGENT_NAME, FIN_DIR, and FIN_ELEVATE_SOCK from fin-supervisor.",
    "- Use ordinary commands first when they operate within the session workspace, the current repository worktree, or other paths already allowed by the sandbox.",
    "- Use fin-elevate only when a command is necessary for the task and the sandbox blocks it or you need a reviewed operation outside the current agent's allowed scope.",
    "- Invoke fin-elevate with the exact command you need reviewed, for example: fin-elevate /bin/cp /source/path /destination/path.",
    "- Before using fin-elevate, make the command minimal, deterministic, and scoped to the user's request. Do not batch unrelated operations into one elevation.",
    "- Do not use fin-elevate to bypass repository instructions, approval requirements, credential boundaries, destructive safeguards, or user intent.",
    "- If fin-elevate denies the command, stop trying variants that pursue the same denied access and report a concrete blocker through the chat state contract.",
    "- If AGENT_NAME, FIN_DIR, or FIN_ELEVATE_SOCK is missing, report that the Fin runtime is misconfigured instead of pretending elevation is available.",
  ];

  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

function formatThreadCoordinatesSection(options: {
  readonly platform: "slack" | "feishu";
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly conversationId: string;
  readonly conversationKind?: string | undefined;
  readonly rootMessageId: string;
  readonly platformThreadId?: string | undefined;
}): string {
  if (options.platform === "slack") {
    return [`- channel_id: ${options.channelId}`, `- thread_ts: ${options.rootThreadTs}`].join("\n");
  }

  return ["- platform: feishu", `- conversation_id: ${options.conversationId}`, options.conversationKind ? `- conversation_kind: ${options.conversationKind}` : undefined, `- root_message_id: ${options.rootMessageId}`, options.platformThreadId ? `- platform_thread_id: ${options.platformThreadId}` : undefined]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

async function loadTemplate(): Promise<string> {
  if (!templateCache) {
    templateCache = fs.readFile(templatePath, "utf8");
  }

  return await templateCache;
}

function renderTemplate(template: string, variables: Record<string, string>): string {
  const rendered = template.replace(/{{\s*([a-z0-9_]+)\s*}}/gi, (match, key: string) => {
    const value = variables[key];
    if (value === undefined) {
      throw new Error(`Missing prompt template variable: ${key}`);
    }

    return value;
  });

  return rendered.replace(/\n{3,}/g, "\n\n").trim();
}

async function buildExecutionEnvironmentSection(): Promise<string> {
  const runtimePlatform = process.platform;
  const runtimeHostname = os.hostname();
  const runtimeContainerized = await isContainerizedRuntime();

  return [
    "Current execution environment:",
    `- runtime_platform: ${runtimePlatform}`,
    `- runtime_hostname: ${runtimeHostname}`,
    `- runtime_containerized: ${runtimeContainerized}`,
    "- Shell commands, file edits, git, gh, clone, and worktree operations happen in this runtime.",
    "- Verify platform-specific app/runtime behavior from the runtime you can actually observe. Do not assume a different host environment unless the user explicitly gives you one.",
  ].join("\n");
}

function formatSlackBotIdentitySection(identity: SlackUserIdentity | null): string {
  if (!identity) {
    return "Slack bot identity: when a Slack message mentions the bot user for this broker, that mention refers to you.";
  }

  const lines = ["Slack bot identity in this workspace:", `- bot_user_id: ${identity.userId}`, `- bot_mention: ${identity.mention}`];

  if (identity.displayName) {
    lines.push(`- bot_display_name: ${identity.displayName}`);
  }

  if (identity.realName && identity.realName !== identity.displayName) {
    lines.push(`- bot_real_name: ${identity.realName}`);
  }

  if (identity.username && identity.username !== identity.displayName) {
    lines.push(`- bot_username: ${identity.username}`);
  }

  lines.push("- If a Slack message mentions this bot identity, that mention refers to you.");
  return lines.join("\n");
}

function formatPersonalMemorySection(personalMemory?: string): string {
  const normalized = personalMemory?.trim();
  if (!normalized) {
    return "";
  }

  return `Personal long-lived memory from ~/.codex/AGENT.md:\n${normalized}`;
}

async function isContainerizedRuntime(): Promise<boolean> {
  if (process.env.CONTAINER?.trim() || process.env.KUBERNETES_SERVICE_HOST?.trim()) {
    return true;
  }

  if (await pathExists("/.dockerenv")) {
    return true;
  }

  if (await pathExists("/run/.containerenv")) {
    return true;
  }

  if (process.platform === "linux") {
    const cgroupText = await fs.readFile("/proc/1/cgroup", "utf8").catch(() => "");
    if (/(docker|containerd|kubepods|podman|lxc)/i.test(cgroupText)) {
      return true;
    }
  }

  return false;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
