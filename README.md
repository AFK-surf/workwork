# slack-codex-broker

Slack + China Feishu bridge for routing chat sessions into Codex app-server workflows.

It connects to Slack over Socket Mode and, when `FEISHU_ENABLED=true`, to China Feishu over long connection in the same broker process. Each Slack thread or Feishu group session starts or resumes one Codex app-server thread and gets an isolated workspace directory. The Codex session always starts in that neutral workspace instead of being pinned to a specific repository. If code work is needed, the agent is expected to use a shared `repos/` cache for canonical clones and create any task-specific git worktrees under the current session workspace. Normal thread or group follow-up replies continue the same Codex thread when the platform supports that context. Sending `-stop` in the active session interrupts the current Codex turn.

On the first `@bot` inside an existing Slack thread, the broker backfills a bounded slice of earlier thread history into Codex. Feishu group sessions use bounded history and recovery when the needed permissions/cursors are available, and surface degraded context when they are not. If Codex needs older context than the initial backfill, it can query the broker's local chat-history HTTP API from inside its shell.

## What It Expects

- A Slack app using Socket Mode
- Optional China Feishu self-built app for dual-platform rollout
- Codex authentication via either:
  - `OPENAI_API_KEY`
  - a mounted `auth.json` plus `CODEX_AUTH_JSON_PATH`

## Slack App Setup

Create a Slack app with:

- Socket Mode enabled
- Interactivity enabled
- App-level token with `connections:write`
- Bot token scopes:
  - `app_mentions:read`
  - `chat:write`
  - `channels:history`
  - `files:read` if you want Codex to receive image attachments from Slack messages
  - `files:write` if you want Codex to upload images/files back into Slack threads
  - `users:read` if you want Codex to see Slack display names instead of only raw user IDs
  - `users:read.email` if you want the broker to infer GitHub co-author mappings from Slack profile email

Event subscriptions needed for the current broker flow:

- `app_mention`
- `message.channels`
- `message.im` for direct-message sessions

If you want to support private channels or DMs, add the corresponding `groups:history`, `im:history`, or `mpim:history` scopes plus matching message events.

The broker's Slack co-author flow uses Socket Mode interactive envelopes, thread ephemerals, and modals. With Socket Mode enabled, you do not need a separate public interactivity Request URL for this flow.

## Feishu Setup

China Feishu support is feature-flagged and runs beside Slack in the same broker process. Use [docs/feishu-setup.md](docs/feishu-setup.md) for the app setup, permission request, environment variables, and real smoke checklist.

## Environment

Copy `.env.example` to `.env` and fill in:

Slack:

- `SLACK_APP_TOKEN`
- `SLACK_BOT_TOKEN`
- optional `SLACK_INITIAL_THREAD_HISTORY_COUNT`
- optional `SLACK_HISTORY_API_MAX_LIMIT`

Feishu rollout:

- `FEISHU_ENABLED=true` when enabling the China Feishu long-connection bridge
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- at least one Feishu bot identity: `FEISHU_BOT_OPEN_ID`, `FEISHU_BOT_USER_ID`, or `FEISHU_BOT_UNION_ID`
- `FEISHU_GROUP_MESSAGE_MODE=all` for production parity; `at_only` is degraded
- `FEISHU_ALL_MESSAGE_DELIVERY_VERIFIED=true` only after the real non-@ follow-up smoke passes
- optional `FEISHU_INITIAL_THREAD_HISTORY_COUNT`
- optional `FEISHU_HISTORY_API_MAX_LIMIT`

Service storage and logging:

- optional `SESSIONS_ROOT`
- optional `REPOS_ROOT`
- optional `LOG_DIR`
- optional `LOG_LEVEL`
- optional `LOG_RAW_SLACK_EVENTS`
- keep `LOG_RAW_FEISHU_EVENTS=false` unless collecting a focused, redacted fixture
- optional `LOG_RAW_CODEX_RPC`
- optional `LOG_RAW_HTTP_REQUESTS`

Codex runtime:

- one Codex auth mode
- optional host Codex home mount if you want the container to inherit your global `~/.codex` memory/instructions

## Codex Auth Modes

### 1. API key

Set:

```env
OPENAI_API_KEY=sk-...
```

This is the simplest automation setup.

### 2. Reuse Codex/ChatGPT OAuth

Mount an existing `auth.json` into the container and set:

```env
CODEX_AUTH_JSON_PATH=/auth/auth.json
```

Then add a read-only volume to `docker-compose.yml`:

```yaml
volumes:
  - ~/.codex/auth.json:/auth/auth.json:ro
```

At startup the broker copies that file into its own `CODEX_HOME`/data directory and uses it to authenticate the embedded Codex app-server.

The main Codex runtime disables all built-in MCP servers by default. Keep tool access outside the main runtime and use broker-managed integrations instead. This only removes those MCP servers from the broker's container-local Codex config. It does not modify your host `~/.codex/config.toml`.

## Reuse Global Codex Memory

If you want the containerized Codex to see your global `~/.codex` files such as:

- `AGENT.md`
- `AGENTS.md`
- `memory.md`
- `memories/`
- `skills/`
- `superpowers/`

mount your host Codex home and point the runtime at it:

```env
CODEX_HOST_HOME_PATH=/Users/you/.codex
CODEX_HOST_HOME_PATH_HOST=/Users/you/.codex
HOST_AGENTS_PATH_HOST=/Users/you/.agents
HOST_AGENTS_CONTAINER_PATH=/Users/you/.agents
```

Recommended behavior:

- `AGENT.md` is the broker's canonical personal memory file; it is bootstrapped once from your host `~/.codex/AGENT.md` if present, then persisted inside the broker state
- new Slack sessions inject that personal memory once at `thread/start`; later turns reuse the existing session context instead of re-sending it
- the runtime shell path `~/.codex/AGENT.md` is wired back to the broker-managed personal memory file, so agent-written memory updates persist without touching your host home directly
- `AGENTS.md` is bootstrapped from your host `~/.codex` once and then lives independently inside the broker container state, so host and broker instructions can diverge
- `memory.md` is still linked back to your host `~/.codex`, so durable notes continue to persist across restarts
- directories like `skills/` and `superpowers/` are copied into the container `CODEX_HOME`
- `HOST_AGENTS_PATH_HOST` plus `HOST_AGENTS_CONTAINER_PATH` lets relative skill symlinks like `../../.agents/...` resolve correctly during that copy
- if your host skills contain relative symlinks, set `CODEX_HOST_HOME_PATH` to the same absolute path as the host so those symlinks keep resolving inside the container
- for docker-side skills that need to call a host-local helper service, either set an explicit container-safe URL such as `TEMPAD_LINK_SERVICE_URL=http://host.docker.internal:4320`, or leave it unset and let the broker probe the common host-local tempad endpoints automatically

This keeps personal memory on the familiar `~/.codex/AGENT.md` path inside the broker runtime, while allowing broker-specific repo instructions (`AGENTS.md`) to fork away from your personal host setup without sharing the container's sqlite/log/session state.

## Run With Docker Compose

```bash
cp .env.example .env
docker compose up --build
```

Operational scripts for the real container:

```bash
pnpm ops:check:real
pnpm ops:rollout:real
pnpm ops:resume:real -- --channel-id C123 --thread-ts 111.222
pnpm ops:status:real
pnpm ops:auth:real status
pnpm ops:auth:profiles bootstrap
pnpm ops:auth:profiles status
pnpm ops:auth:profiles list
pnpm ops:auth:profiles import-host --name backup-account
pnpm ops:auth:profiles use backup-account
pnpm ops:ui:real
```

`ops:rollout:real` reuses the current `slack-codex-broker-real` container's env vars and bind mounts, refuses to restart while active turns exist unless you pass `--allow-active`, rebuilds the image, recreates the container, and then runs the fixed post-update checks. When the inspected container has `FEISHU_ENABLED=true`, rollout also runs Feishu preflight for credentials, bot identity, China Feishu mode, and logging posture, then writes `feishu-preflight-report.json` plus `feishu-preflight-summary.md` under the rollout backup directory; use `--skip-feishu-preflight` only for a non-parity emergency rollout. Each rollout also writes sanitized metadata plus a sanitized pre-rollout log snapshot under `.backups/rollouts/`; metadata recursively redacts unsafe string fields while preserving safe posture text such as `FEISHU_APP_SECRET=missing`, and the log snapshot allowlists structured event/meta fields and redacts non-structured lines instead of copying raw Docker log text. Rollout JSON and metadata use repo-relative backup coordinates instead of full host filesystem paths.
`ops:check:real` verifies the live container health endpoints, embedded Codex readiness, runtime paths, startup log markers, and a sanitized `/admin/api/status` platform-health summary for Slack and Feishu.
`ops:status:real` prints a structured runtime snapshot for the live container, including health plus sanitized active sessions, open inbound message summaries, background jobs, and allowlisted recent broker logs. Raw message bodies, job tokens/scripts, malformed log lines, and non-allowlisted log metadata are not echoed; use `--open-inbound-limit` and `--log-lines` to tune output volume.
`ops:auth:real status` prints the live container's Codex auth files, runtime account identity, any quota/usage fields exposed by `account/read`, plus the current session state snapshot. Operator-facing auth status and replacement output summarize filesystem paths instead of echoing full host paths.
`ops:auth:profiles` manages a local auth-profile directory under the live data root. The host auth is kept as a reference copy, while the docker auth points at a selectable `active` profile. Use `bootstrap` once, then `import-host --name <profile>` or `import --name <profile> --from <path>` to add more docker-side auth profiles, and `use <profile>` to switch the live container. Profile command output also summarizes auth/profile paths without full host filesystem paths.
`ops:ui:real` starts a local-only admin page on `127.0.0.1` so you can inspect sessions/account state and upload a replacement `auth.json` without using CLI flags directly.
`ops:resume:real` manually re-queues a stuck Slack session that still has pending inbound backlog but no active Codex turn. Use it as an operator fallback while debugging a broken thread.

## Local Verification

Use `pnpm test` for the full local suite. RFC 0001's Feishu mock e2e gate is exposed as `pnpm test:e2e:feishu-mock`; it runs the Feishu bridge, Feishu long-connection adapter, fixture replay, and dual-platform runtime mock tests that prove group @ start/resume, non-@ follow-up, private/self ignore, stop, history recovery, text/rich/card/file behavior, co-author card callbacks, and Slack+Feishu same-process readiness without requiring a real tenant. Run `pnpm rfc:feishu-audit` to summarize local RFC assets, implementation surfaces, test slices, behavior evidence probes, package-script gates, preflight readiness, and the remaining real-tenant evidence gaps without sending Feishu messages. `pnpm rfc:feishu-audit:local` exits on the local gate only for CI/local readiness; its JSON still keeps `ok=false` until real tenant gates pass. Run `pnpm manual:feishu-smoke -- --preflight --env-file .env` before rollout when credentials live in a local env file; the `--` keeps Node's own `--env-file` flag from intercepting the smoke-checker argument, value flags also accept `--flag=value`, missing values fail before another flag is swallowed, and the checker reports secret-bearing values only as set/missing. Real tenant parity still requires `pnpm manual:feishu-smoke` after the Feishu app setup actions are performed.

## Run On a macOS VM

The preferred macOS deployment model is now GitHub-first:

- clone this repository directly on the VM
- run the bootstrap script from inside that clone
- upload `auth.json` later through the admin page
- do all later deploy / rollback operations from the admin page by Git ref

There is no host-side code sync step in the normal path anymore.

### First bootstrap on the VM

```bash
git clone https://github.com/zzj3720/slack-codex-broker.git ~/services/slack-codex-broker
cd ~/services/slack-codex-broker
node scripts/ops/macos-bootstrap.mjs --start-worker
```

The bootstrap script expects to run inside the VM's long-lived clone and uses that clone as the stable admin/control repo.

Before running it, make sure the Slack app credentials are available through one of these sources:

- the current shell environment, for example `SLACK_APP_TOKEN=... SLACK_BOT_TOKEN=... node scripts/ops/macos-bootstrap.mjs --start-worker`
- an existing `config/broker.env` in the service root, which the bootstrap script will reuse for the new admin / worker env files

What it prepares:

- `releases/<sha>` worktrees for worker releases
- `current`, `previous`, and `failed` release links
- shared runtime state under `.data/`
- support homes under `runtime-support/`
- launchd agents for:
  - `com.zzj3720.slack-codex-broker` (admin/control plane)
  - `com.zzj3720.slack-codex-broker.worker` (Slack/Codex worker)

What it does not do:

- it does not copy `auth.json`; import auth profiles later through `/admin`
- it does not copy historical sessions, logs, jobs, or repo caches from another machine
- it does not require `pnpm` to already be installed globally; it uses Corepack and the repo-pinned pnpm version

### Runtime layout on the VM

The fixed clone is both the admin code root and the Git source of truth for worker releases.

- `<service-root>/`:
  - long-lived git clone
  - admin launchd working directory
- `<service-root>/releases/<sha>/`:
  - worker build for a specific commit
- `<service-root>/current`:
  - symlink to the active worker release
- `<service-root>/previous`:
  - symlink to the last good worker release
- `<service-root>/failed`:
  - symlink to the most recent failed cutover
- `<service-root>/.data/`:
  - shared broker state, sessions, jobs, logs, repos, auth profiles, codex home

### Deploy and rollback

The admin service fetches from the VM's local Git clone and deploys a selected ref into a new worker release directory.

- deploy:
  - `git fetch origin`
  - resolve commit / branch / tag
  - create or reuse `releases/<sha>`
  - build there
  - switch `current` to the new release
  - restart only the worker launchd service
  - run health + Codex-ready checks
  - auto-rollback on failed cutover
- rollback:
  - switch `current` back to `previous`, or to an explicitly selected ref
  - restart the worker
  - run the same health checks

Because old releases stay on disk, rollback is a pointer switch instead of a rebuild.

### Admin surface

```text
GET /admin
GET /admin/api/status?platform=slack|feishu
POST /admin/api/auth-profiles
POST /admin/api/auth-profiles/:name/activate
DELETE /admin/api/auth-profiles/:name
POST /admin/api/github-authors
DELETE /admin/api/github-authors/:userId?platform=slack|feishu
POST /admin/api/deploy
POST /admin/api/rollback
```

Typical first-run flow:

1. Open `/admin`.
2. Upload one or more `auth.json` files into Auth Profiles.
3. Activate the profile you want the worker to use.
4. Later, deploy a commit / branch / tag from the Deploy panel.
5. Roll back from the same panel when needed.

The same admin page also exposes a `GitHub Authors` panel for manually maintaining platform-aware `Slack/Feishu user -> GitHub author` mappings. Manual Slack entries override Slack-inferred mappings; Feishu mappings are manual and keyed by the Feishu user identity used in that session. `GET /admin/api/status?platform=...` filters sessions, jobs, and GitHub author mappings to that platform while still returning independent Slack/Feishu platform health; allowlisted `recentBrokerLogs` remain cross-platform so Feishu smoke can prove same-runtime Slack readiness and reply evidence. Platform query/body values must be `slack` or `feishu`; invalid values return 400 `invalid_platform` instead of falling back to Slack.

If `BROKER_ADMIN_TOKEN` is set, `/admin/api/*` requires that token via `x-admin-token` or `Authorization: Bearer ...`. If it is unset, the admin API is still enabled, so only expose the broker port in environments you trust.

The container image:

- uses Node 22
- installs `git`
- installs `gh`
- installs `rg` via `ripgrep`
- installs the Codex CLI globally via `@openai/codex`
- runs the broker with `node dist/src/index.js`

## Runtime Layout

Inside the container:

- broker state lives under `/app/.data`
- Codex state defaults to `/app/.data/codex-home`
- session workspaces default to `/app/.data/sessions/<channel-thread>/workspace`
- shared canonical repositories live under `/app/.data/repos`
- structured logs default to `/app/.data/logs`

In practice, `.data` is the broker's runtime data root. It contains both durable broker-owned identity/config data and disposable runtime state.

Durable broker-owned identity/config data:

- `codex-home/`
- `auth-profiles/`

Disposable runtime state:

- `state/`
- `sessions/`
- `jobs/`
- `logs/`
- `repos/`

The macOS bare-run deploy path only reuses the durable broker-owned subset that defines behavior and identity. It intentionally leaves the disposable runtime state behind and starts the VM with a clean `sessions/`, `jobs/`, `logs/`, and `repos/`.

## Logging

The broker now keeps a layered JSONL log set intended for postmortem debugging.

Default layout under `LOG_DIR`:

- `broker.jsonl`
  Global structured application log for every `info` / `warn` / `error` / `debug` event.
- `sessions/<session-key>.jsonl`
  Per-session fan-out log. Useful when one Slack thread goes bad and you want only its history.
- `jobs/<job-id>.jsonl`
  Per-background-job fan-out log.
- `raw/slack-events.jsonl`
  Raw Socket Mode envelopes from Slack.
- `raw/feishu-events.jsonl`
  Raw Feishu event envelopes. Disabled by default; enable only for focused
  fixture capture/debugging because normal structured logs must not become
  message archives.
- `raw/codex-rpc.jsonl`
  Raw Codex app-server RPC requests, responses, and notifications.
- `raw/http-requests.jsonl`
  Raw local broker HTTP traffic for `/slack/*`, `/chat/*`, `/jobs/*`, and `/integrations/*`.

Supported environment knobs:

- `LOG_LEVEL=debug|info|warn|error`
- `LOG_RAW_SLACK_EVENTS=true|false`
- `LOG_RAW_FEISHU_EVENTS=true|false`
- `LOG_RAW_CODEX_RPC=true|false`
- `LOG_RAW_HTTP_REQUESTS=true|false`

Notes:

- Raw logs are intentionally verbose and can grow quickly during long sessions.
- `/slack/*` and `/chat/*` request logging redact message text, state reasons, file comments/alt text, rich/card payloads, and inline `content_base64` payloads into size markers instead of writing chat bodies or blobs.
- `/jobs/*` request logging redacts job scripts, callback tokens, summaries, details, and errors before writing raw HTTP JSONL.
- `/integrations/*` request logging redacts MCP call `arguments` before writing raw HTTP JSONL.
- Session and job log files are written independently, so one noisy thread no longer forces the entire broker state or log history into one giant file.

## Current Interaction Model

- Slack first `@bot ...` in a thread: create or resume the session, ensure the session workspace exists, send the message to Codex
- Slack first `@bot ...` inside an already active human thread: also backfill the most recent earlier thread messages before that mention
- Slack later plain thread replies: continue the same Codex thread
- Slack direct message root message: create a session keyed by that DM thread and send it to Codex
- Feishu group `@bot ...`: create or resume a group session; private chats are ignored
- Feishu non-@ group follow-ups: continue an active group session only in `FEISHU_GROUP_MESSAGE_MODE=all`; `at_only` is a visible degraded mode
- Feishu rich text, cards, images, and files: keep structured/raw payload references and visible transfer status; image/file transfer is bounded by the Feishu limits in [docs/feishu-setup.md](docs/feishu-setup.md)
- `-stop`: interrupt the current Codex turn for the active platform session
- If the task needs code, Codex should use `/app/.data/repos` for canonical clones and create any worktrees or task directories inside the current session workspace

## Thread History APIs

The broker exposes a local-only helper endpoint on the same port as the health check:

```bash
curl "http://127.0.0.1:3000/slack/thread-history?channel_id=C123&thread_ts=111.222&before_ts=111.223&limit=20&format=text"
```

Query params:

- `channel_id` (required)
- `thread_ts` (required)
- `before_ts` (optional, exclusive upper bound)
- `limit` (optional positive integer, clamped by `SLACK_HISTORY_API_MAX_LIMIT`; invalid values return 400 `invalid_limit`)
- `channel_type` (optional)
- `format=text|json` (default `json`; invalid values return 400 `invalid_format`)

This is meant for Codex itself to pull older Slack context when the initial backfill window is not enough.

The generic chat-history endpoint uses platform coordinates and also supports Feishu bounded history:

```bash
curl "http://127.0.0.1:3000/chat/thread-history?platform=feishu&conversation_id=oc_xxx&root_message_id=om_xxx&before_cursor=page_token&limit=20&format=json"
```

For Feishu, `before_cursor` is passed to the Open Platform history API as `page_token`; JSON responses include `hasMore` and `nextCursor` when another bounded page is available.
Generic chat history `limit` uses the same positive-integer validation and is clamped by the target platform's max history limit. Generic chat history `format` uses the same `text|json` validation before broker delegation.

## Post APIs

The broker exposes Slack compatibility endpoints and generic platform-aware chat endpoints for Codex. Prefer `/chat/*` when the session already has platform coordinates; `/slack/*` remains available for Slack compatibility.

Generic `/chat/*` JSON/query contracts use canonical `conversationId` and `rootMessageId` fields. The broker also accepts `conversation_id` and `root_message_id` aliases for curl-friendly examples. Invalid `platform` values return 400 `invalid_platform` with allowed values `slack` and `feishu`, rather than being reported as missing coordinates. Generic file uploads use canonical `filePath` or `contentBase64`, with `file_path` and `content_base64` aliases accepted and named in validation errors. Inline `contentBase64`/`content_base64` uploads require `filename` and must decode to non-empty file content before Slack or Feishu upload is attempted.

### Post Slack text

```bash
curl -sS -X POST http://127.0.0.1:3000/slack/post-message \
  -H 'content-type: application/json' \
  -d '{"channel_id":"C123","thread_ts":"111.222","text":"working on it"}'
```

`text` accepts normal Markdown/markdownish input. The broker converts it to Slack `mrkdwn` before posting.

### Post platform-aware chat text

```bash
curl -sS -X POST http://127.0.0.1:3000/chat/post-message \
  -H 'content-type: application/json' \
  -d '{"platform":"feishu","conversation_id":"oc_xxx","root_message_id":"om_xxx","format":"markdown","text":"working on it"}'
```

For Slack, `/chat/post-message` delegates to the Slack delivery path. For Feishu, `format=markdown` or `format=rich_text` is rendered as a Feishu `post`; `format=card` sends an interactive card when `card` JSON is supplied, with safe text fallback handled by the bridge. `richText`/`rich_text` and `card` can be structured JSON values or JSON strings; invalid JSON strings return 400 with only the field name, not the raw payload.

### Upload a local image or file to Slack

```bash
curl -sS -X POST http://127.0.0.1:3000/slack/post-file \
  -H 'content-type: application/json' \
  -d '{"channel_id":"C123","thread_ts":"111.222","file_path":"/absolute/path/to/report.png","initial_comment":"latest screenshot"}'
```

`/slack/post-file` accepts either:

- `file_path` pointing at a local file visible to the broker process
- or non-empty `content_base64` plus `filename`

Optional fields:

- `title`
- `initial_comment` (or `text` as an alias)
- `alt_text`
- `snippet_type`
- `content_type`

`initial_comment` accepts normal Markdown/markdownish input and is converted to Slack `mrkdwn` before upload completion.

### Upload a platform-aware chat file

```bash
curl -sS -X POST http://127.0.0.1:3000/chat/post-file \
  -H 'content-type: application/json' \
  -d '{"platform":"feishu","conversation_id":"oc_xxx","root_message_id":"om_xxx","content_base64":"...","filename":"report.pdf","content_type":"application/pdf","initial_comment":"latest report"}'
```

For Feishu, outbound message images up to 10 MB are uploaded as image messages. Larger outbound images fall back to file upload when still within the 30 MB file/resource limit; larger transfers are rejected locally before posting or uploading.

## Background Job API

Long-running watcher jobs can be registered against generic chat coordinates:

```bash
curl -sS -X POST http://127.0.0.1:3000/jobs/register \
  -H 'content-type: application/json' \
  -d '{"platform":"feishu","conversation_id":"oc_xxx","root_message_id":"om_xxx","kind":"watch_ci","cwd":".","script":"node \"$BROKER_JOB_HELPER\" event --kind state_changed --summary ready"}'
```

`/jobs/register` also accepts legacy Slack `channel_id` and `thread_ts` aliases only for Slack compatibility when `platform` is omitted or set to `slack`; Feishu jobs must use generic `conversationId`/`rootMessageId` coordinates. Invalid generic job `platform` values return 400 `invalid_platform` before coordinate validation. Registered jobs receive `CHAT_PLATFORM`, `CHAT_CONVERSATION_ID`, and `CHAT_ROOT_MESSAGE_ID`; Slack jobs also receive `SLACK_CHANNEL_ID` and `SLACK_THREAD_TS` for compatibility.

Job callback `detailsJson`/`details_json` fields and `/integrations/mcp-call` `arguments` can be structured JSON values or JSON strings. Invalid JSON strings return 400 with only the field name, not the raw payload.

## Slack Recovery API

The broker also exposes a local-only operator endpoint for manually resuming a stuck session:

```bash
curl -sS -X POST http://127.0.0.1:3000/slack/resume-pending-session \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode 'channel_id=C123' \
  --data-urlencode 'thread_ts=111.222'
```

Optional fields:

- `force_reset=true|false` (defaults to `true`)

## Notes

- This compose file is intentionally minimal and does not pre-mount or pre-select any single target repository.
- The runtime image already includes `gh`, `git`, and `rg`.
- The broker no longer manages repo selection or git worktree naming. That is now an agent-level responsibility inside the shared `repos/` cache and the current session workspace.

## GitHub Support

If you want Codex to push branches or open PRs with `gh`:

- set `GH_TOKEN` (and optionally `GITHUB_TOKEN`) to a token with `repo` scope
- mount an SSH agent socket if your repo remote uses `git@github.com:...`

Example:

```env
GH_TOKEN=gho_***
SSH_AUTH_SOCK_HOST=/run/host-services/ssh-auth.sock
SSH_AUTH_SOCK_CONTAINER=/ssh-agent
```

The runtime image includes `gh`, exports your GitHub token to the process environment, and configures git to:

- use `gh auth git-credential` as the credential helper
- rewrite `git@github.com:...` remotes to `https://github.com/...`

That means `gh` and ordinary `git push` can both work with a GitHub token, even if the checked-out repo still uses an SSH-style origin URL.

## License

[MIT](LICENSE)
