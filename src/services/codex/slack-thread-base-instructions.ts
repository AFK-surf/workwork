import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { SlackUserIdentity } from "../../types.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.resolve(moduleDir, "prompts", "slack-thread-base-instructions.md");

let templateCache: Promise<string> | undefined;

export interface BuildSlackThreadBaseInstructionsOptions {
  readonly brokerHttpBaseUrl: string;
  readonly platform?: "slack" | "feishu" | undefined;
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly workspacePath: string;
  readonly reposRoot: string;
  readonly slackBotIdentity: SlackUserIdentity | null;
  readonly personalMemory?: string | undefined;
}

export async function buildSlackThreadBaseInstructions(
  options: BuildSlackThreadBaseInstructionsOptions
): Promise<string> {
  const template = await loadTemplate();
  const linearToolsUrl = `${options.brokerHttpBaseUrl}/integrations/mcp-tools?server=linear`;
  const notionToolsUrl = `${options.brokerHttpBaseUrl}/integrations/mcp-tools?server=notion`;
  const platform = options.platform ?? "slack";
  const platformCopy = buildPlatformCopy(platform);
  const messagePayload = JSON.stringify({
    platform,
    conversation_id: options.channelId,
    root_message_id: options.rootThreadTs,
    text: `replace with your ${platformCopy.updateSurface} update`,
    kind: "progress"
  });
  const waitStatePayload = JSON.stringify({
    platform,
    conversation_id: options.channelId,
    root_message_id: options.rootThreadTs,
    kind: "wait",
    reason: "replace with what you are waiting for"
  });
  const finalStatePayload = JSON.stringify({
    platform,
    conversation_id: options.channelId,
    root_message_id: options.rootThreadTs,
    kind: "final"
  });
  const blockStatePayload = JSON.stringify({
    platform,
    conversation_id: options.channelId,
    root_message_id: options.rootThreadTs,
    kind: "block",
    reason: "replace with the blocker"
  });
  const filePayload = JSON.stringify({
    platform,
    conversation_id: options.channelId,
    root_message_id: options.rootThreadTs,
    file_path: "/absolute/path/to/file.png",
    initial_comment: `replace with your ${platformCopy.updateSurface} file caption`
  });
  const linearCallPayload = JSON.stringify({
    server: "linear",
    name: "replace_with_linear_tool_name",
    arguments: {
      replace: "with tool arguments"
    }
  });
  const notionCallPayload = JSON.stringify({
    server: "notion",
    name: "replace_with_notion_tool_name",
    arguments: {
      replace: "with tool arguments"
    }
  });
  const jobPayload = JSON.stringify({
    platform,
    conversation_id: options.channelId,
    root_message_id: options.rootThreadTs,
    kind: "watch_ci",
    cwd: ".",
    script: "#!/usr/bin/env bash\nset -euo pipefail\nnode \"$BROKER_JOB_HELPER\" event --kind \"state_changed\" --summary \"replace with your update\"\nnode \"$BROKER_JOB_HELPER\" complete --summary \"replace with your completion update\""
  });
  const registerJobCommand =
    `curl -sS -X POST ${options.brokerHttpBaseUrl}/jobs/register -H 'content-type: application/json' -d '${jobPayload}'`;

  return renderTemplate(template, {
    session_intro: platformCopy.sessionIntro,
    execution_environment_section: await buildExecutionEnvironmentSection(),
    session_workspace: options.workspacePath,
    shared_repos_root: options.reposRoot,
    coordinates_heading: platformCopy.coordinatesHeading,
    channel_id: options.channelId,
    thread_ts: options.rootThreadTs,
    platform,
    conversation_id: options.channelId,
    root_message_id: options.rootThreadTs,
    legacy_coordinates_section: formatLegacyCoordinatesSection(platform, options.channelId, options.rootThreadTs),
    post_message_command:
      `curl -sS -X POST ${options.brokerHttpBaseUrl}/chat/post-message -H 'content-type: application/json' -d '${messagePayload}'`,
    post_state_final_command:
      `curl -sS -X POST ${options.brokerHttpBaseUrl}/chat/post-state -H 'content-type: application/json' -d '${finalStatePayload}'`,
    post_state_wait_command:
      `curl -sS -X POST ${options.brokerHttpBaseUrl}/chat/post-state -H 'content-type: application/json' -d '${waitStatePayload}'`,
    post_state_block_command:
      `curl -sS -X POST ${options.brokerHttpBaseUrl}/chat/post-state -H 'content-type: application/json' -d '${blockStatePayload}'`,
    post_file_command:
      `curl -sS -X POST ${options.brokerHttpBaseUrl}/chat/post-file -H 'content-type: application/json' -d '${filePayload}'`,
    thread_history_command: buildThreadHistoryCommand({
      brokerHttpBaseUrl: options.brokerHttpBaseUrl,
      platform,
      conversationId: options.channelId,
      rootMessageId: options.rootThreadTs
    }),
    register_job_command: registerJobCommand,
    linear_tools_command: `curl -sS '${linearToolsUrl}'`,
    notion_tools_command: `curl -sS '${notionToolsUrl}'`,
    linear_call_command:
      `curl -sS -X POST ${options.brokerHttpBaseUrl}/integrations/mcp-call -H 'content-type: application/json' -d '${linearCallPayload}'`,
    notion_call_command:
      `curl -sS -X POST ${options.brokerHttpBaseUrl}/integrations/mcp-call -H 'content-type: application/json' -d '${notionCallPayload}'`,
    markdown_delivery_note: platformCopy.markdownDeliveryNote,
    post_file_note: platformCopy.postFileNote,
    terminal_state_note: platformCopy.terminalStateNote,
    background_job_section: formatBackgroundJobSection(platform, registerJobCommand),
    integration_runtime_note: platformCopy.integrationRuntimeNote,
    integration_failure_target: platformCopy.integrationFailureTarget,
    ux_preference_heading: platformCopy.uxPreferenceHeading,
    ux_preference_note: platformCopy.uxPreferenceNote,
    visible_update_phrase: platformCopy.visibleUpdatePhrase,
    silent_final_note: platformCopy.silentFinalNote,
    silent_block_note: platformCopy.silentBlockNote,
    silent_wait_note: platformCopy.silentWaitNote,
    duplicate_state_note: platformCopy.duplicateStateNote,
    message_model_heading: platformCopy.messageModelHeading,
    message_model_note: platformCopy.messageModelNote,
    follow_up_question_note: platformCopy.followUpQuestionNote,
    monitoring_note: platformCopy.monitoringNote,
    coauthor_session_label: platformCopy.coauthorSessionLabel,
    instruction_boundary_role: platformCopy.instructionBoundaryRole,
    slack_bot_identity_section: formatSlackBotIdentitySection(platform, options.slackBotIdentity),
    personal_memory_section: formatPersonalMemorySection(options.personalMemory)
  });
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
    "- Verify platform-specific app/runtime behavior from the runtime you can actually observe. Do not assume a different host environment unless the user explicitly gives you one."
  ].join("\n");
}

function formatSlackBotIdentitySection(
  platform: "slack" | "feishu",
  identity: SlackUserIdentity | null
): string {
  if (platform === "feishu") {
    return "Feishu bot identity: use the broker-provided message source, mentions, and chat coordinates. Do not assume Slack bot IDs apply to this session.";
  }

  if (!identity) {
    return "Slack bot identity: when a Slack message mentions the bot user for this broker, that mention refers to you.";
  }

  const lines = [
    "Slack bot identity in this workspace:",
    `- bot_user_id: ${identity.userId}`,
    `- bot_mention: ${identity.mention}`
  ];

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

function formatBackgroundJobSection(
  platform: "slack" | "feishu",
  registerJobCommand: string
): string {
  const lines = [
    `- Register a broker-managed background job with: ${registerJobCommand}`,
    "- Registered background jobs receive environment variables including BROKER_JOB_ID, BROKER_JOB_TOKEN, BROKER_API_BASE, BROKER_JOB_HELPER, CHAT_PLATFORM, CHAT_CONVERSATION_ID, CHAT_ROOT_MESSAGE_ID, SESSION_KEY, SESSION_WORKSPACE, and REPOS_ROOT.",
    "- Inside a background job script, prefer `node \"$BROKER_JOB_HELPER\" ...` for heartbeat/event/complete/fail/cancel callbacks instead of hand-writing nested curl JSON payloads."
  ];

  if (platform === "slack") {
    lines.splice(2, 0, "- Slack background jobs also receive the legacy aliases SLACK_CHANNEL_ID and SLACK_THREAD_TS.");
  }

  return lines.join("\n");
}

function formatLegacyCoordinatesSection(
  platform: "slack" | "feishu",
  channelId: string,
  rootThreadTs: string
): string {
  if (platform === "feishu") {
    return "";
  }

  return [
    `- channel_id: ${channelId}`,
    `- thread_ts: ${rootThreadTs}`
  ].join("\n");
}

function buildThreadHistoryCommand(options: {
  readonly brokerHttpBaseUrl: string;
  readonly platform: "slack" | "feishu";
  readonly conversationId: string;
  readonly rootMessageId: string;
}): string {
  const params = new URLSearchParams({
    platform: options.platform,
    conversation_id: options.conversationId,
    root_message_id: options.rootMessageId,
    limit: "20",
    format: "text"
  });

  if (options.platform === "feishu") {
    params.set("before_cursor", "older-page-token");
  } else {
    params.set("before_message_id", "older-message-id");
  }

  return `curl -sS '${options.brokerHttpBaseUrl}/chat/thread-history?${params.toString()}'`;
}

function buildPlatformCopy(platform: "slack" | "feishu"): {
  readonly sessionIntro: string;
  readonly coordinatesHeading: string;
  readonly updateSurface: string;
  readonly markdownDeliveryNote: string;
  readonly postFileNote: string;
  readonly terminalStateNote: string;
  readonly integrationRuntimeNote: string;
  readonly integrationFailureTarget: string;
  readonly uxPreferenceHeading: string;
  readonly uxPreferenceNote: string;
  readonly visibleUpdatePhrase: string;
  readonly silentFinalNote: string;
  readonly silentBlockNote: string;
  readonly silentWaitNote: string;
  readonly duplicateStateNote: string;
  readonly messageModelHeading: string;
  readonly messageModelNote: string;
  readonly followUpQuestionNote: string;
  readonly monitoringNote: string;
  readonly coauthorSessionLabel: string;
  readonly instructionBoundaryRole: string;
} {
  if (platform === "feishu") {
    return {
      sessionIntro:
        "You are serving a Feishu group thread. Work from the current session workspace. Keep answers concise and operational. Your commentary and final answer are internal only and are not forwarded to Feishu.",
      coordinatesHeading: "Current chat thread coordinates:",
      updateSurface: "Feishu",
      markdownDeliveryNote:
        "Write normal Markdown in the `text` field. The broker converts markdownish output to Feishu post content before posting. Use Feishu rich text or card output only through broker-supported `/chat/post-message` payloads with `format=rich_text` or `format=card`.",
      postFileNote:
        "For `/chat/post-file`, `initial_comment` also accepts normal Markdown. Feishu uploads local images/files before replying with the corresponding image_key or file_key message.",
      terminalStateNote:
        "When sending a terminal chat state, set kind to final, block, or wait. For block/wait, include a short reason field.",
      integrationRuntimeNote:
        "The main Codex runtime for this chat broker does not load the linear or notion MCPs directly.",
      integrationFailureTarget: "Feishu",
      uxPreferenceHeading: "Feishu UX preference:",
      uxPreferenceNote:
        "do not stay silent for a long stretch if there is a meaningful progress point worth sharing. Use judgment. If you have a concrete update, short plan adjustment, blocker, or partial conclusion that would help the people in the group thread, send a brief Feishu update. If there is nothing meaningful to say yet, keep working and avoid filler. Do not turn routine polling or watcher noise into Feishu chatter.",
      visibleUpdatePhrase: "send a Feishu update",
      silentFinalNote:
        "If the thread already has a clear completion update from you and you only need to settle broker state, record a silent final state through /chat/post-state instead of posting another completion message.",
      silentBlockNote:
        "If your visible Feishu reply already explains the blocker in human language, record a silent block state through /chat/post-state instead of sending a second '[block]' line.",
      silentWaitNote:
        "If you are intentionally waiting because a broker-managed async job is already running and will wake this session later, either send a visible Feishu update with kind=wait or record a silent wait state with /chat/post-state.",
      duplicateStateNote:
        "Do not send one plain Feishu reply and then a second state-only reply just to attach final/block/wait. Either send a single visible message with the appropriate kind attached, or send the human-facing reply once and record the state silently through /chat/post-state.",
      messageModelHeading: "Feishu group thread message model:",
      messageModelNote:
        "A new message arrived in the active Feishu group thread. Feishu private chats are unsupported by this broker and should not be requested or assumed. Feishu message trees are not Slack threads; do not assume Slack thread semantics when reasoning about replies, roots, or follow-ups. In all-message mode, non-mention follow-ups can be context for the active session; in at_only mode, context may be degraded. Carefully inspect message content, mentions, and thread context before deciding whether you should reply or take action.",
      followUpQuestionNote:
        "if someone in the Feishu group thread asks you an explicit status question or direct follow-up such as whether you pushed, replied, finished, or still have updates, bias toward sending a short direct Feishu answer. Do not silently classify that kind of follow-up as a duplicate just because the underlying work topic is unchanged.",
      monitoringNote:
        "if you need to keep watching CI, PRs, external state, or any long-running condition after the current turn may end, register a broker-managed background job with the platform-aware `/jobs/register` command. Do not rely on sleep loops, gh watch commands, or shell background processes that outlive the current turn. Only tell Feishu you will keep monitoring after the job registration succeeds. Once the job is running, do not mirror every watcher update back into Feishu; only speak when the update is materially useful.",
      coauthorSessionLabel: "chat session",
      instructionBoundaryRole: "chat routing behavior"
    };
  }

  return {
    sessionIntro:
      "You are serving a Slack thread. Work from the current session workspace. Keep answers concise and operational. Your commentary and final answer are internal only and are not forwarded to Slack.",
    coordinatesHeading: "Current Slack thread coordinates:",
    updateSurface: "Slack",
    markdownDeliveryNote:
      "Write normal Markdown in the `text` field. Do not handcraft Slack `mrkdwn`; the broker converts markdownish output to `mrkdwn` before posting.",
    postFileNote:
      "For `/chat/post-file`, `initial_comment` also accepts normal Markdown and is converted before posting.",
    terminalStateNote:
      "When sending a terminal Slack state, set kind to final, block, or wait. For block/wait, include a short reason field.",
    integrationRuntimeNote:
      "The main Codex runtime for this Slack broker does not load the linear or notion MCPs directly.",
    integrationFailureTarget: "Slack",
    uxPreferenceHeading: "Slack UX preference:",
    uxPreferenceNote:
      "do not stay silent for a long stretch if there is a meaningful progress point worth sharing. Use judgment. If you have a concrete update, short plan adjustment, blocker, or partial conclusion that would help the people in the thread, send a brief Slack update. If there is nothing meaningful to say yet, keep working and avoid filler. Do not turn routine polling or watcher noise into Slack chatter.",
    visibleUpdatePhrase: "send a Slack update",
    silentFinalNote:
      "If the thread already has a clear completion update from you and you only need to settle broker state, record a silent final state through /slack/post-state instead of posting another completion message.",
    silentBlockNote:
      "If your visible Slack reply already explains the blocker in human language, record a silent block state through /slack/post-state instead of sending a second '[block]' line.",
    silentWaitNote:
      "If you are intentionally waiting because a broker-managed async job is already running and will wake this session later, either send a visible Slack update with kind=wait or record a silent wait state with /slack/post-state.",
    duplicateStateNote:
      "Do not send one plain Slack reply and then a second state-only reply just to attach final/block/wait. Either send a single visible message with the appropriate kind attached, or send the human-facing reply once and record the state silently through /slack/post-state.",
    messageModelHeading: "Slack thread message model:",
    messageModelNote:
      "each forwarded message only means a new message was posted in this Slack thread. Do not assume it is addressed to you. Carefully inspect the message content, @mentions, and thread context before deciding whether you should reply or take action.",
    followUpQuestionNote:
      "if someone in the Slack thread asks you an explicit status question or direct follow-up such as whether you pushed, replied, finished, or still have updates, bias toward sending a short direct Slack answer. Do not silently classify that kind of follow-up as a duplicate just because the underlying work topic is unchanged.",
    monitoringNote:
      "if you need to keep watching CI, PRs, external state, or any long-running condition after the current turn may end, register a broker-managed background job. Do not rely on sleep loops, gh watch commands, or shell background processes that outlive the current turn. Only tell Slack you will keep monitoring after the job registration succeeds. Once the job is running, do not mirror every watcher update back into Slack; only speak when the update is materially useful.",
    coauthorSessionLabel: "Slack session",
    instructionBoundaryRole: "Slack role"
  };
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
