# RFC 0001 Deep Dive: Review gates and completion audit

This file contains the approval, MVP, and completion checklists for [RFC 0001](../0001-slack-feishu-dual-platform.md). Keep the entry RFC short; update this file when a decision gate, rollout gate, or completion definition changes.

## One-Screen Summary

| Gate | Meaning |
| --- | --- |
| RFC approval | The design and execution contract are clear enough to keep implementing. It is not a completion claim. |
| MVP acceptance | Phase 3 text/session behavior is user-visible and safe enough only when Slack regression, Feishu group @, private/self ignore, stop, reply, history, and degraded-mode evidence pass. |
| Completion audit | Feishu support is not complete until real tenant setup, real smoke, Slack+Feishu shared-runtime evidence, rich/card/resource behavior, co-author cards, and observability gates pass. |
| Evidence ledger | Local tests can prove broker behavior; real tenant gates prove permissions, client delivery, and rollout runtime posture. |

## Read Layers

| Layer | Use when | Expand |
| --- | --- | --- |
| 1 | You need the ship/no-ship picture. | Read this summary and the [Completion Evidence Ledger](#completion-evidence-ledger). |
| 2 | You are approving direction or MVP scope. | Expand "Decision and acceptance gates". |
| 3 | You are auditing whether the RFC is actually complete. | Expand "Completion audit and evidence ledger". |

<details>
<summary>Layer 2: Decision and acceptance gates</summary>

## Objective Traceability

| Original objective | Where the contract lives | Completion evidence |
| --- | --- | --- |
| Progressive disclosure | [Entry RFC](../0001-slack-feishu-dual-platform.md) and this deep-dive split | Product, engineering, QA, rollout, and debugging readers each have a short entry point. |
| TDD | [implementation](implementation.md#tdd-contract) | PRs name RED, GREEN, OBSERVE, and REGRESSION. |
| Logs for self-iteration | [observability](observability.md) | Log tests cover required fields and prove info/warn logs omit message bodies. |
| China Feishu first | [architecture](architecture.md#feishu-product-scope), [permissions](permissions.md) | Config/docs/smoke target China Feishu and defer global Lark. |
| No private chat support | [architecture](architecture.md#event-routing-rules) | Private-chat fixtures emit ignored route/log and create no session. |
| Prefer all group messages | [permissions](permissions.md#degraded-mode-contract) | Admin health lists `im:message.group_msg=verified`; real non-@ follow-up smoke passes in `all` mode before production parity is claimed. |
| Rich text and cards | [architecture](architecture.md#content-model), [implementation Phase 4](implementation.md#phase-4-rich-text-cards-and-files) | Raw `post`/`interactive` payloads are preserved; formatter/card callback tests pass by Phase 4; real outbound rich/card/file or image smoke passes and callback smoke matches the same group @ session after a broker-posted card, using `messageId` when Feishu supplies one and callback `eventId`/`payloadRef` otherwise. |
| Slack + Feishu simultaneously | [architecture](architecture.md#target-architecture) | Dual-platform mock e2e and Slack regression prove independent state in one runtime. |

## Reviewer Decisions

Approve these before implementation continues beyond foundation work:

- [ ] China Feishu is the only Feishu-family target for the first implementation.
- [ ] Feishu behavior is group-only; private chats are ignored, not partially supported.
- [ ] `im:message.group_msg` is the intended production permission.
- [ ] `FEISHU_GROUP_MESSAGE_MODE=at_only` is a visible degraded mode, not production parity.
- [ ] Text MVP can ship before full rich/card parity if raw rich/card payloads are preserved and degradation is visible.
- [ ] Slack and Feishu run in one shared broker runtime rather than a separate Feishu-only process.
- [ ] Startup policy: default production behavior is strict when `FEISHU_ENABLED=true`; development or limited rollout may set `FEISHU_STARTUP_REQUIRED=false` to keep Slack running with Feishu degraded.

## Approval Gate

Approving this RFC means the design and execution contract are clear enough to start or continue implementation. It does not mean Feishu support is complete.

Approve when:

- [ ] Product direction is accepted: China Feishu, group-only, all-group-message target, rich/card preservation, Slack kept live.
- [ ] Architecture is accepted: shared runtime, platform-aware session identity, platform isolation, Slack compatibility.
- [ ] Execution plan is accepted: vertical TDD slices, phase gates, log field matrix, JSONL log harness, issue-ready backlog.
- [ ] Evidence plan is accepted: mock e2e vs real smoke boundaries, permission verification, open-question gates, RFC drift rules.
- [ ] Every unresolved question has a default assumption and a "must decide before" gate.

Do not treat RFC approval as proof that:

- [ ] Feishu has connected to a real tenant.
- [ ] `im:message.group_msg` has been approved.
- [ ] Non-@ follow-up works in a real group.
- [ ] Rich/card/file phases are implemented.
- [ ] Slack + Feishu have passed dual-platform runtime verification.

## MVP Acceptance

Phase 3 is the first user-visible Feishu MVP. It is acceptable only when:

- [ ] Slack still starts, receives events, posts replies, emits ordered Slack `chat.message.accepted -> chat.outbound.posted format=text` with accepted/reply `messageId` values plus matching `sessionKey`, `conversationId`, and `rootMessageId`, and passes existing Slack mock e2e.
- [ ] Feishu is configured for China Feishu and connects via long connection.
- [ ] Feishu bot identity is configured so real @bot mentions can be matched, and admin health lists `bot_identity=configured`.
- [ ] A Feishu group @bot text message emits an ordered `chat.message.accepted route=bot_mention msgType=text -> chat.session.created|resumed` transition whose `sessionKey`, `conversationId`, and `rootMessageId` match admin session state, with no same-message ignored log.
- [ ] A Feishu private-chat event is ignored with `conversationKind=direct` and leaves no persisted session; bot/app/self sender events are ignored before dispatch.
- [ ] A Feishu bot/app/self sender fixture or captured event emits `chat.message.ignored ignoredReason=ignored_self` with no same-message accepted/session/turn dispatch log.
- [ ] A Feishu `-stop` in the same group @ session interrupts the active Codex turn and targets session coordinates matching admin session state, with an ordered `chat.message.accepted -> chat.session.resumed -> chat.turn.stopped` chain whose stop `messageId` matches, active `turnId` evidence, and no same-message ignored log.
- [ ] A Feishu text reply posts to the same group @ session and emits `chat.outbound.posted format=text` with session coordinates matching admin session state.
- [ ] A Feishu turn emits an ordered same-session `chat.turn.started|steered -> chat.outbound.posted format=text -> chat.turn.completed` chain, with completion after the text reply and `turnId` / `batchId` matching the non-history-recovery turn start/steer log.
- [ ] With `FEISHU_GROUP_MESSAGE_MODE=all`, admin health lists `im:message.group_msg=verified`, and a non-@ text follow-up reaches the same active group @ session through an ordered `chat.message.accepted route=group_message msgType=text -> chat.turn.steered|chat.session.resumed` transition, with matching `messageId`, transition session coordinates matching admin session state, and no same-message ignored log.
- [ ] With `FEISHU_GROUP_MESSAGE_MODE=at_only`, admin/runtime surfaces clearly report reduced context guarantees.
- [ ] Bounded history recovery emits same-session `chat.turn.steered source=history_recovery` for active turns or `chat.turn.started source=history_recovery` for recently active sessions, plus `chat.history.recovered` with `recoveredCount > 0` and session coordinates matching admin session state.
- [ ] Rich text, cards, images, and files are not silently discarded; at minimum they are summarized, raw payloads are preserved for later phases, accepted logs match admin session state, and no same-message ignored log is present.

## Open Question Gates

These defaults let implementation continue without silently making product decisions.

| Question | Default | Must decide before |
| --- | --- | --- |
| Feishu startup failure policy | Production strict; development/limited rollout may mark Feishu degraded. | Production startup behavior and real rollout. |
| Feishu co-author confirmation timing | Implemented after text MVP through Feishu cards; real callback smoke still required before production parity. | Production co-author parity claim. |
| Operational card style | Minimal static cards first. | Polished outbound cards or product-facing co-author cards. |
| `at_only` in production | Limited pilot only; production parity requires `all` mode and real non-@ smoke. | Any production parity claim. |
| Global Lark | Out of scope. | Any PR adding Lark domain/config/docs. |
| Exact console permission labels | Use the setup-doc label map as a starting point; record exact tenant UI labels during real setup. | Final setup evidence and real-smoke signoff. |

</details>

<details>
<summary>Layer 3: Completion audit and evidence ledger</summary>

## Completion Audit

Do not mark Feishu support complete until:

- [ ] China Feishu is the configured and documented target.
- [ ] Feishu bot identity setup is documented, preflighted, and wired into runtime mention parsing.
- [ ] Private chats and bot/app/self sender events are ignored in parser, runtime, tests, and docs.
- [ ] All-group-message mode is implemented, documented, and verified by a real non-@ follow-up smoke.
- [ ] Rich text and card support is implemented or explicitly phased with raw preservation and user-visible degradation.
- [ ] Slack and Feishu run simultaneously in one process.
- [ ] Slack regression tests pass.
- [ ] Feishu mock e2e passes.
- [ ] Feishu co-author card confirmation passes in mock e2e and real-smoke evidence, with ordered outbound card, callback, and confirmation logs sharing `candidateRevision` plus session coordinates that match admin session state.
- [ ] Real Feishu smoke passes.
- [ ] TDD slices cover each user-visible Feishu behavior.
- [ ] Logs/admin health explain accepted, ignored, deduped, degraded, failed, and recovered Feishu events; accepted and deduped behavior evidence must reference admin-session-matching accepted Feishu logs with no same-message ignored log, and deduped evidence must have no later same-message accepted/session/turn dispatch.
- [ ] Real-smoke or saved rollout evidence passes `observability.behavior_coverage` for accepted, ignored, deduped, degraded, failed, and recovered outcomes; recovered requires delivered-to-Codex history evidence, not only a degraded recovery log.
- [ ] Log tests cover the required log field matrix and prove info/warn logs omit message body content.

## Completion Evidence Ledger

Use this ledger to read the unchecked audit without losing local progress. The middle column is what local code/docs/tests can prove today; the right column is the real tenant gate that must pass before the audit box can be checked. `pnpm rfc:feishu-audit` gives the same split as a local command: local RFC assets, implementation surfaces, test slices, behavior evidence probes, and script gates can pass while real setup/preflight/smoke evidence remains missing. `pnpm rfc:feishu-audit:local` is only a local gate. Do not turn audit boxes into checked boxes until the real tenant gate still required column is satisfied.

| Area | Local evidence now | Real tenant gate still required |
| --- | --- | --- |
| China Feishu target | Config, setup docs, permission docs, and preflight checks point at China Feishu and defer global Lark. | Tenant setup evidence must show exact China Feishu console labels, approved `im:message.group_msg`, and send/card/resource permission posture. |
| Bot identity and ignored events | Parser/runtime/mock tests cover group @, private-chat ignore, and bot/app/self sender ignore before dispatch. | Real @bot mention must match configured bot identity, and captured ignore evidence must leave no persisted Feishu session. |
| All group messages | `all` mode is implemented in mock e2e, while `at_only` reports degraded context. | Real non-@ follow-up must reach the same active group @ session with admin-session-matching accepted and steered/resumed logs. |
| Rich, cards, images, and files | Raw `post`/`interactive` payloads are preserved; formatter, card callback, and resource tests cover local behavior. | Real client smoke must prove inbound rich/card/resource acceptance in the same group @ session, outbound rich text/card/file or image posting in that session with uploaded `fileId` for file/image logs, visible resource status, and callback matching the same group @ session after a broker-posted card, using `messageId` when Feishu supplies one and callback `eventId`/`payloadRef` otherwise. |
| Shared runtime | `pnpm test:e2e:feishu-mock` covers Feishu bridge, Feishu adapter, and Slack+Feishu same-process readiness in mock runtime. | Rollout runtime must show Slack Socket Mode and Feishu long connection ready in the same process. |
| Slack regression | `pnpm test` keeps Slack compatibility green locally, including legacy `/slack/*` wrappers delegated through platform-aware chat coordinates. | Real smoke must include ordered Slack accepted/reply evidence with message IDs from the same rollout process. |
| Co-author cards | Mock e2e covers Feishu card callback confirmation with `candidateRevision`. | Real Feishu card callback must occur after a same-session broker-posted card, matching the card `messageId` when Feishu supplies one and otherwise retaining callback `eventId`/`payloadRef`; callback and confirmation must share `candidateRevision`, confirmation must occur after callback, and all coordinates must match admin session state. |
| Observability and safety | Log matrix, redaction, admin status, setup evidence, and smoke-checker tests cover leak safety and behavior classification. | `pnpm manual:feishu-smoke` must pass against live or saved rollout evidence with accepted, ignored, deduped, degraded, failed, and recovered coverage. |

</details>
