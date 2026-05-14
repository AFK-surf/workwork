# Agent Session UI

## Goal

Make the session surface feel like a real agent session product UI, not an
admin database inspector.

The page should answer these questions first:

1. What is the agent working on?
2. Is it running, waiting, blocked, or done?
3. What has happened in the agent timeline?
4. What can the user do now: open the Slack thread, continue, switch account,
   bind GitHub, cancel work, or reset the session?

Operational and debug metadata still exists, but it should not be the primary
reading path.

## Current State

The current React page already has the right data and core controls, but the
information architecture still reads like admin tooling:

- the left column is labeled `会话索引`;
- the detail panel is labeled `会话详情`;
- the selected session header is a compact table-like row;
- the timeline title is `Agent 活动时间线`;
- the right rail uses backend-oriented section names such as `操作`,
  `运行状态`, `消息 / 任务`, `活动构成`, and `调试信息`;
- the visual hierarchy is mostly panel borders and table separators.

That makes the UI useful for operators, but weak for someone following one
agent run from a Slack thread.

## Target Design

The session page is an agent workbench:

- Left: `Agent 会话` stream, optimized for selecting a session quickly.
- Right top: `Agent 工作台` with a hero summary showing the current task, current
  state, channel, latest activity time, token usage, and active job count.
- Main axis: `工作时间线`. This is the primary artifact and should occupy the
  largest area.
- Right rail: action and context panels:
  - `接管 / 链接` for Slack thread, standalone view, account switch, GitHub
    binding, and reset;
  - `当前状态` for active turn, pending input, and running jobs;
  - `用量` for token consumption;
  - `等待输入 / 后台任务` only when there is pending input or jobs;
  - `时间线统计` for collapsed activity composition;
  - `技术上下文` for channel id, root ts, agent id, session key, auth profile,
    and other debug data.

The UI keeps the existing controls and APIs. This is an information-architecture
and visual hierarchy refactor, not a behavior rewrite.

## Acceptance Criteria

- Session list title is `Agent 会话`, not `会话索引`.
- Session detail title is `Agent 工作台`, not `会话详情`.
- The selected session has an agent-session hero with task title, Slack request,
  state, channel, latest activity, token usage, and job count.
- Timeline is labeled `工作时间线` and remains the main scrollable region.
- The right rail uses product/session language: `接管 / 链接`, `当前状态`,
  `用量`, `等待输入 / 后台任务`, `时间线统计`, and `技术上下文`.
- Backend/admin-oriented labels such as `操作`, `运行状态`, `消息 / 任务`,
  `活动构成`, and `调试信息` are not used as session detail section headings.
- Existing session behavior remains available: open Slack thread, standalone
  session page, auth profile switch/auto allocation, GitHub binding, reset,
  job cancellation, timeline loading, and token usage.
- Mobile layout keeps a single page scroll with the timeline before secondary
  context.
- `pnpm test` and `pnpm build` pass.
