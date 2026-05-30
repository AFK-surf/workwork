# RFC 0001 Deep Dive: Feishu permissions and degraded modes

This file contains the Feishu permission contract for [RFC 0001](../0001-slack-feishu-dual-platform.md). Re-check Feishu Open Platform docs when applying permissions because names and product limits can change.

## One-Screen Summary

| Permission topic     | Current contract                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target               | China Feishu self-built/custom app for group sessions only.                                                                                        |
| Sensitive permission | `im:message.group_msg` is required for production parity because active sessions need non-@ follow-ups.                                            |
| Degraded mode        | `FEISHU_GROUP_MESSAGE_MODE=at_only` is allowed for development/limited pilot only and must be visible in admin/runtime output.                     |
| Setup proof          | Console labels are not enough; real setup evidence plus behavior smoke must prove group @, non-@, send/reply, card callback, and resource posture. |
| Data minimization    | Evidence records labels, set/missing posture, and redacted approvals without raw secrets, message bodies, user emails, or raw bot IDs.             |

## Read Layers

| Layer | Use when                                | Expand                                   |
| ----- | --------------------------------------- | ---------------------------------------- |
| 1     | You need the permission decision.       | Read this summary.                       |
| 2     | You need to request tenant permissions. | Expand "Request contract".               |
| 3     | You are verifying setup or smoke.       | Expand "Verification and degraded mode". |
| 4     | You are refreshing external references. | Expand "Source notes".                   |

<details>
<summary>Layer 2: Request contract</summary>

## Permission Strategy

Private chat product support is out of scope, but some Feishu message APIs use broad permission groups. Request the minimum permissions needed for group operation and document why each one exists.

`im:message.group_msg` is the key sensitive permission. The broker is a session agent, not a one-shot command bot. Once a group has an active Codex session, follow-up messages often omit @mentions. Without all-group-message delivery, Codex may miss corrections, stop requests, or context needed to finish safely.

Therefore:

- [x] Production parity requires all-group-message delivery.
- [x] `at_only` exists for development and limited pilot only.
- [x] Admin/runtime surfaces must make `at_only` degradation visible.
- [x] Real non-@ smoke is required before claiming production readiness.

## Permission Request Packet

Use this packet in setup docs or the internal permission request ticket.

| Permission / setup                                               | Request justification                                                                                   | Data minimization and controls                                                                                                                                                                                                                      | If denied                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Robot capability and published app version                       | Required for bot receive/send workflow.                                                                 | Install app only into intended groups.                                                                                                                                                                                                              | Feishu disabled.                                       |
| Bot identity (`open_id`, `user_id`, or `union_id`)               | Required for the broker to recognize real @bot mentions reliably.                                       | Config and evidence record only set/missing posture, not raw IDs.                                                                                                                                                                                   | Feishu group sessions cannot start reliably.           |
| `im:message.group_at_msg:readonly` or current @bot receive scope | Needed to start sessions from explicit group @bot requests.                                             | Only group @bot events can create sessions.                                                                                                                                                                                                         | Feishu group sessions cannot start.                    |
| `im:message.group_msg`                                           | Needed for active-session non-@ follow-ups, missed-message recovery, and Slack-like context continuity. | Private chats unsupported; info/warn logs omit message bodies; raw payloads require fixture/debug paths.                                                                                                                                            | `at_only` degraded mode; no production parity claim.   |
| `im:message:send_as_bot` or current send scope                   | Needed to post Codex text/rich/card replies.                                                            | Broker posts only to originating group/root coordinates.                                                                                                                                                                                            | Receive-only; cannot reply.                            |
| Message read/history scope                                       | Needed for bounded recovery and context backfill.                                                       | Fetch bounded windows only; retain raw payloads by reference.                                                                                                                                                                                       | History recovery degraded or disabled.                 |
| Resource download/upload scopes                                  | Needed for image/file input and output after text MVP.                                                  | Enforce size/type restrictions before transfer: downloaded message image inputs and outbound message images up to 10 MB, file/resource transfers up to 30 MB, and larger outbound images fall back to file upload when still within the file limit. | Resource messages are summarized and visibly degraded. |
| `card.action.trigger` callback subscription                      | Needed for interactive cards and co-author confirmation.                                                | Callback values carry routing IDs, not secrets or message bodies.                                                                                                                                                                                   | Cards remain static.                                   |

Request acceptance criteria:

- [x] Request states this is group-only China Feishu support, not private-chat monitoring.
- [x] Request explains `im:message.group_msg` is needed only for groups where the bot is installed and active sessions may receive non-@ follow-ups.
- [x] Request documents that info/warn logs exclude message body text and raw rich/card payloads.
- [x] Request links to the degraded mode contract.
- [x] Request names the real-smoke proof required before production parity is claimed.

Copy-paste request text lives in [Feishu permission request](../../feishu-permission-request.md).

</details>

<details>
<summary>Layer 3: Verification and degraded mode</summary>

## Permission Verification Packet

Verify permissions with behavior, not only console checkboxes.

| Capability                  | Verification action                                                                                            | Passing evidence                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| China Feishu target         | Start broker with China Feishu config/domain.                                                                  | `chat.platform.ready` or admin health reports `platform=feishu` and expected config mode.                                                                                                                                                                                                                                                                                                                                                                |
| Bot identity                | Start broker/preflight with at least one `FEISHU_BOT_OPEN_ID`, `FEISHU_BOT_USER_ID`, or `FEISHU_BOT_UNION_ID`. | Preflight passes `preflight.feishu_bot_identity_present`; admin health lists `bot_identity=configured`.                                                                                                                                                                                                                                                                                                                                                  |
| Group @ delivery            | Send a text group message that @mentions the bot.                                                              | Ordered `chat.message.accepted route=bot_mention msgType=text -> chat.session.created\|resumed`; the transition coordinates match admin session state and the accepted message has no same-message ignored log.                                                                                                                                                                                                                                          |
| Private-chat exclusion      | Send a private-chat fixture or event.                                                                          | `chat.message.ignored` with `ignoredReason=ignored_private_chat`; no session.                                                                                                                                                                                                                                                                                                                                                                            |
| All group messages          | In the active group @ session, send a non-@ text follow-up.                                                    | Admin health lists `im:message.group_msg=verified`; ordered accepted and steered/resumed logs share the same `messageId`, include `msgType=text`, target the same group @ admin session coordinates, and have no same-message ignored log.                                                                                                                                                                                                               |
| History read                | Trigger bounded history recovery.                                                                              | `chat.history.recovered` includes `recoveredCount > 0` and cursor range, paired by `sessionKey` with a `history_recovery` turn log and session coordinates matching admin state; otherwise degraded health explains the missing permission or cursor.                                                                                                                                                                                                    |
| Send/reply                  | Post a text reply.                                                                                             | `chat.outbound.posted` includes Feishu reply `messageId`, `format=text`, and session coordinates matching the same group @ session in admin state.                                                                                                                                                                                                                                                                                                       |
| Rich/card readiness         | Replay `post`, `interactive`, and callback fixtures.                                                           | Raw payload retained by `payloadRef`; accepted logs match admin session state with no same-message ignored log; callback emits `chat.card.callback.received` after a same group @ session broker-posted card, matching `messageId` when Feishu supplies one and otherwise retaining callback `eventId`/`payloadRef` for correlation.                                                                                                                     |
| Co-author card confirmation | Trigger a commit from a Feishu session with candidate authors and click the confirmation card.                 | Ordered same-session `chat.outbound.posted format=card -> chat.card.callback.received -> chat.coauthor.confirmed`; callback `messageId` matches the broker-posted card when Feishu supplies one, otherwise ordered same-session/root coordinates plus callback `eventId`/`payloadRef` prove the tie, callback and confirmation share `candidateRevision`, confirmation includes `confirmedCount > 0`, and session coordinates match admin session state. |

Verification output should be captured in PR evidence, setup docs, or smoke checklists. A console screenshot alone is not enough for all-group-message readiness.

For test/audit wording, group @ delivery still means: Ordered `chat.message.accepted route=bot_mention msgType=text -> chat.session.created|resumed` transition with session coordinates matching admin session state and no same-message ignored log.

## Degraded Mode Contract

`FEISHU_GROUP_MESSAGE_MODE=at_only` allows development and limited rollout when `im:message.group_msg` is not approved. It is not equivalent to the intended production behavior.

| Behavior                               | `all` mode                                 | `at_only` mode                                                                      |
| -------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| Group @bot starts session              | Required                                   | Required                                                                            |
| Non-@ live follow-up in active session | Required                                   | Not guaranteed                                                                      |
| History backfill                       | Required when permissions allow            | Best effort                                                                         |
| Missed-message recovery                | Required when permissions allow            | Best effort                                                                         |
| Admin warning                          | Only on failed smoke or missing capability | Always visible                                                                      |
| Real smoke pass condition              | Must include non-@ follow-up               | Limited-pilot checks may omit non-@ follow-up, but cannot certify production parity |

Implementation requirements:

- [x] Add setup docs with the current documented Feishu console/API label map.
- [x] During real app setup, confirm the exact tenant console labels in sanitized rollout notes or PR evidence, without raw App Secret, access tokens, message bodies, user emails, or raw bot IDs.
- [x] Add startup health output listing granted/assumed capabilities where feasible.
- [x] Add `FEISHU_GROUP_MESSAGE_MODE=all | at_only`.
- [x] When mode is `all`, warn loudly if non-@ follow-up smoke fails.
- [x] When mode is `at_only`, do not claim complete context recovery.

</details>

<details>
<summary>Layer 4: Source notes</summary>

## Source Notes

Last checked: 2026-05-28.

- [Receive message event](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive?lang=zh-CN)
- [Use long connection to receive events](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case?lang=zh-CN)
- [Message overview](https://open.feishu.cn/document/server-docs/im-v1/introduction?lang=zh-CN)
- [Send message](https://open.feishu.cn/document/server-docs/im-v1/message/create?lang=zh-CN)
- [Reply message](https://open.feishu.cn/document/server-docs/im-v1/message/reply?lang=zh-CN)
- [List message history](https://open.feishu.cn/document/server-docs/im-v1/message/list?lang=zh-CN)
- [Get message resource](https://open.feishu.cn/document/server-docs/im-v1/message/get-2?lang=zh-CN)
- [Card callback](https://open.feishu.cn/document/feishu-cards/card-callback-communication?lang=zh-CN)
- [`@larksuiteoapi/node-sdk`](https://www.npmjs.com/package/%40larksuiteoapi/node-sdk)

</details>
