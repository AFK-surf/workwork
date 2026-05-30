# PR 72 review fix plan

## Goal

Fix the Codex review findings so the Feishu implementation can run real Feishu sessions without accidentally using Slack-only instructions or cross-session group history.

## Current state

- New Feishu sessions reuse the Slack base-instruction template, so the agent sees `/slack/*` commands and Slack coordinates even when the session is Feishu-backed.
- Feishu history listing uses chat-wide message history when no Feishu `thread_id` is known and does not filter returned messages to the requested root message.
- The job route docs say legacy Slack `channel_id`/`thread_ts` aliases work when `platform=slack`, but validation only accepts them when `platform` is omitted.

## Proposed changes

1. Make Codex base instructions platform-aware: Slack keeps existing `/slack/*` commands; Feishu sessions get `/chat/*` commands with `platform=feishu`, `conversationId`, and `rootMessageId` coordinates.
2. Filter Feishu chat-container history results to the requested `rootMessageId` before converting them into chat messages.
3. Accept legacy Slack job coordinates when `platform` is explicitly `slack`.

## If we do not change it

- Feishu-started Codex sessions can keep posting or settling state through Slack-only broker APIs.
- Initial Feishu group mentions without a `thread_id` can read unrelated group messages as thread history.
- Users following the documented `platform=slack` job alias contract get a validation error.

## After the change

- New Feishu sessions receive Feishu-aware broker commands and coordinates.
- Feishu chat-wide history recovery is limited to the requested root message.
- Legacy Slack job aliases behave the same whether Slack is implicit or explicit.

## Acceptance criteria

- A Feishu Codex thread start prompt contains `/chat/post-message`, `/chat/post-state`, `/chat/thread-history`, and Feishu coordinates, and does not tell the agent to post through `/slack/post-message`.
- Feishu chat-wide history excludes unrelated group roots when no `platformThreadId` is present.
- `/jobs/register` accepts `platform=slack` plus `channel_id`/`thread_ts`.
- Existing Slack behavior and Feishu mock/e2e tests continue to pass.
