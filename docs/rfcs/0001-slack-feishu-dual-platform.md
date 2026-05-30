# RFC 0001: Slack + China Feishu dual-platform broker

Status: Draft for review
Last updated: 2026-05-29

This is the 2-minute entry point. It states the decision shape and points each reader to the next layer. Implementation checklists, rollout gates, and evidence rules live in the linked deep dives.

## TL;DR

Add China Feishu beside Slack in one broker runtime. Keep platform state, APIs, permissions, health, and failures isolated.

Non-negotiables:

- China Feishu first; global Lark is out of scope.
- Feishu groups only; private chats are ignored before session creation.
- Production parity requires `im:message.group_msg`; `at_only` is degraded.
- Rich/card/image/file payloads are preserved, even when UX ships in phases.
- Slack `/slack/*`, persisted sessions, and e2e behavior stay compatible.

## Progressive Reading Path

| Reader need            | Read next                                                           | Stop when                                                    |
| ---------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| Approve direction      | This file                                                           | Non-negotiables and ship blockers are acceptable.            |
| Review architecture    | [Architecture](0001-slack-feishu-dual-platform/architecture.md)     | Session identity, routing, content, and isolation are clear. |
| Implement a slice      | [Implementation](0001-slack-feishu-dual-platform/implementation.md) | You have the phase, red test, and evidence target.           |
| Debug or audit logs    | [Observability](0001-slack-feishu-dual-platform/observability.md)   | Required events, fields, and leak rules are clear.           |
| Verify Feishu setup    | [Permissions](0001-slack-feishu-dual-platform/permissions.md)       | Permission rationale and real-smoke proof are clear.         |
| Decide whether to ship | [Review gates](0001-slack-feishu-dual-platform/review-gates.md)     | Approval, MVP, and completion checklists pass.               |

## Decision Snapshot

| Question               | Answer                                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| First milestone        | Feishu group text MVP: @bot starts/resumes a Codex session, replies post back, Slack still works.                                      |
| Why all group messages | Active Codex sessions often need non-@ follow-ups. Without `im:message.group_msg`, Feishu is explicitly degraded to `at_only`.         |
| What can wait          | Polished rich/card UX, full file transfer rollout, and Feishu card-based co-author confirmation. Raw payload preservation cannot wait. |
| How PRs stay safe      | Every slice names RED, GREEN, OBSERVE, and REGRESSION evidence.                                                                        |

## Ship Blockers

Do not claim production Feishu parity until [Review gates](0001-slack-feishu-dual-platform/review-gates.md) passes:

- real Feishu long-connection smoke passes against the rollout runtime;
- `im:message.group_msg` is approved and a real non-@ follow-up reaches the same active session;
- Slack and Feishu are both ready in one process, with behavior and leak-safety evidence.

## Deep Dives

Use the Progressive Reading Path above as the index: [Architecture](0001-slack-feishu-dual-platform/architecture.md), [Implementation](0001-slack-feishu-dual-platform/implementation.md), [Observability](0001-slack-feishu-dual-platform/observability.md), [Permissions](0001-slack-feishu-dual-platform/permissions.md), and [Review gates](0001-slack-feishu-dual-platform/review-gates.md).
