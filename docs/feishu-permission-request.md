# Feishu Permission Request Packet

Use this as the copy-paste source for the internal approval ticket for RFC 0001 Feishu rollout. Replace bracketed rollout details before submitting.

## Request Summary

We are adding China Feishu group support to the existing Slack + Codex broker. This request is for a China Feishu self-built app installed only into intended Feishu groups. Private-chat product support is out of scope: private-chat events must be ignored by the broker and must not create Codex sessions.

Requested capabilities:

- Bot/robot capability for group receive/send workflow.
- Bot identity (`open_id`, `user_id`, or `union_id`) recorded from the app/bot console for reliable @bot matching.
- Long connection event delivery.
- Group @bot receive events, equivalent to `im:message.group_at_msg:readonly` when that is the current API scope.
- All group message delivery, `im:message.group_msg`.
- Bot send/reply permission, equivalent to `im:message:send_as_bot` when that is the current API scope.
- Message read/history permission for bounded active-session recovery.
- Resource download/upload permission for image/file input and output.
- Card callback subscription for interactive cards and co-author confirmation.

## Why `im:message.group_msg` Is Required

The broker is a session agent, not a one-shot command bot. A user starts a Codex session by @mentioning the bot in a Feishu group, but active sessions often need follow-up messages that omit the @mention:

- corrections to the requested task;
- status questions;
- `-stop` or similar control messages;
- extra context while a Codex turn is already running;
- bounded missed-message recovery after a restart.

Without all-group-message delivery, the broker can run only in `FEISHU_GROUP_MESSAGE_MODE=at_only`, which is an explicitly degraded mode. `at_only` is acceptable for development or limited pilot, but it is not production parity and must not be presented as complete Feishu support.

## Data Minimization And Controls

- The app is installed only into intended groups.
- Feishu private chats are unsupported and ignored.
- Only group @bot events can create new sessions.
- Bot identity evidence records only whether an ID is set or missing; the raw ID value is not required in PR summaries.
- Non-@ group messages are used only when they belong to an active Feishu session in an installed group.
- History recovery is bounded and session-scoped.
- Normal info/warn logs exclude message body text, raw rich text JSON, raw card JSON, request headers, tokens, app secrets, file contents, user email, and unredacted display names.
- Raw Feishu event logging is disabled by default and should be enabled only for focused, redacted fixture collection.
- Retained rich/card/resource payloads are referenced by IDs and minimized fixtures, not copied into normal logs.

## Degraded Mode Contract

If `im:message.group_msg` is denied or delayed, the broker can run only with:

```env
FEISHU_GROUP_MESSAGE_MODE=at_only
FEISHU_ALL_MESSAGE_DELIVERY_VERIFIED=false
```

In that mode:

- group @bot can start a session;
- non-@ live follow-ups are not guaranteed;
- history and missed-message recovery are best effort;
- admin health must show degraded context guarantees;
- production parity cannot be claimed.

The full degraded-mode contract is in [RFC 0001 permissions](rfcs/0001-slack-feishu-dual-platform/permissions.md#degraded-mode-contract).

## Real-Smoke Evidence Required Before Production Parity

Before production parity is claimed, save evidence that proves:

- broker starts with Slack and Feishu enabled in one process;
- Feishu bot identity is configured before startup/preflight passes;
- Feishu long connection reaches ready state;
- a Feishu group @bot message emits an ordered `chat.message.accepted route=bot_mention -> chat.session.created|resumed` transition with session coordinates matching admin session state and no same-message ignored log;
- a Feishu private-chat event is ignored and creates no session;
- Codex posts a text reply to the same group @ session's originating Feishu group/root message with session coordinates matching admin session state;
- the same Feishu session emits `chat.turn.completed` with turn/session correlation after its text reply; this must match a non-history-recovery turn log, not only history backfill;
- `-stop` in the same group @ session interrupts the active turn, with an ordered `chat.message.accepted -> chat.session.resumed -> chat.turn.stopped` chain whose stop `messageId` matches and has no same-message ignored log;
- in `FEISHU_GROUP_MESSAGE_MODE=all`, a non-@ follow-up reaches the same active group @ session, with ordered accepted and steered/resumed logs sharing the same `messageId`, matching admin session state, and no same-message ignored log;
- bounded history recovery emits same-session `history_recovery` turn log plus `chat.history.recovered recoveredCount > 0` and session coordinates matching admin session state;
- rich `post`, card, image, and file events are accepted with retained payload/resource metadata, admin-session-matching accepted logs, and no same-message ignored log;
- card callbacks and co-author confirmation emit an ordered same-session `chat.outbound.posted format=card -> chat.card.callback.received -> chat.coauthor.confirmed` chain, with callback `messageId` matching the broker-posted card when Feishu supplies one, or otherwise ordered same-session/root coordinates plus callback `eventId`/`payloadRef`, matching `candidateRevision`, `confirmedCount > 0`, and session coordinates matching admin session state;
- duplicate delivery or replay emits `chat.message.deduped` with the same `messageId` and `conversationId` as an admin-session-matching accepted event with no same-message ignored log, and no later same-message accepted/session/turn dispatch;
- controlled degraded/failure evidence includes `chat.platform.degraded` and one of `chat.outbound.failed`, `chat.handler.failed`, or `chat.attachment.download_failed`; coordinate-bearing send/download failures must match admin session state and carry the required failure fields, and detached handler failures must name a known Feishu handler (`message` or `interactive`) plus `errorClass`;
- admin status shows Slack and Feishu independently;
- recent `broker.jsonl` logs include accepted, ignored, deduped, degraded, failed, and recovered behavior coverage without leaking message body text.

After the real tenant actions are performed, run:

```sh
pnpm manual:feishu-smoke -- --env-file .env --base-url http://127.0.0.1:3000 --setup-evidence-file evidence/feishu-smoke/feishu-setup-evidence.json --output-dir evidence/feishu-smoke
```

Use `-- --env-file .env` when the rollout/admin settings are stored in a local env file through `pnpm`; the first `--` keeps Node's own `--env-file` flag from intercepting the smoke-checker argument. If `BROKER_ADMIN_TOKEN` is configured elsewhere, pass `--admin-token <token>` or export `BROKER_ADMIN_TOKEN` before running the checker.

## Rollout Details To Fill

- Feishu app name: `[fill in]`
- Feishu tenant/workspace: `[fill in]`
- Intended groups: `[fill in]`
- Rollout owner: `[fill in]`
- Requested production date: `[fill in]`
- Approval ticket: `[fill in]`
