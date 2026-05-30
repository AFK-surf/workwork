import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import type {
  PersistedAdminAuditEvent,
  PersistedAdminEvent,
  PersistedAdminOperation,
  PersistedAgentSessionTraceSummary,
  PersistedAgentSessionUsageSummary,
  PersistedAgentTraceEvent,
  JsonLike,
  PersistedBackgroundJob,
  PersistedAgentTurnUsage,
  PersistedInboundMessage,
  PersistedInboundMessageStatus,
  PersistedInboundSource,
  PersistedSlackEvent,
  SlackUserIdentity,
  SlackSessionRecord,
} from "../types.js";
import { ensureDir } from "../utils/fs.js";

export const STATE_DATABASE_FILENAME = "broker.sqlite";
export const CURRENT_STATE_SCHEMA_VERSION = 16;
export const STATE_STORE_BUSY_TIMEOUT_MS = 5_000;
const ADMIN_EVENT_RETENTION_LIMIT = 20_000;
const ADMIN_EVENT_PRUNE_INTERVAL = 500;
const PROCESSED_EVENT_RETENTION_LIMIT = 2_000;
const PROCESSED_EVENT_PRUNE_INTERVAL = 500;
const SLACK_DONE_EVENT_RETENTION_LIMIT = 2_000;
const SLACK_DONE_EVENT_PRUNE_INTERVAL = 500;

type SqlValue = string | number | bigint | null;
type SqlRow = Record<string, unknown>;

interface StateMigration {
  readonly version: number;
  readonly name: string;
  readonly up: (database: DatabaseSync) => void;
}

const STATE_MIGRATIONS: readonly StateMigration[] = [
  {
    version: 1,
    name: "initial_sqlite_state",
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          key TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL,
          channel_name TEXT,
          channel_type TEXT,
          root_thread_ts TEXT NOT NULL,
          workspace_path TEXT NOT NULL,
          initiator_user_id TEXT,
          initiator_message_ts TEXT,
          initiator_captured_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          agent_session_id TEXT,
          active_turn_id TEXT,
          active_turn_started_at TEXT,
          last_observed_message_ts TEXT,
          last_delivered_message_ts TEXT,
          last_slack_reply_at TEXT,
          session_page_link_posted_at TEXT,
          auth_profile_name TEXT,
          auth_profile_bound_at TEXT,
          auth_blocked_at TEXT,
          auth_block_reason TEXT,
          auth_blocked_notice_posted_at TEXT,
          last_turn_signal_turn_id TEXT,
          last_turn_signal_kind TEXT,
          last_turn_signal_reason TEXT,
          last_turn_signal_at TEXT,
          co_author_candidate_user_ids TEXT,
          co_author_candidate_revision INTEGER,
          co_author_confirmed_user_ids TEXT,
          co_author_confirmed_revision INTEGER,
          co_author_ignore_missing_revision INTEGER,
          co_author_prompt_revision INTEGER,
          co_author_prompted_at TEXT,
          UNIQUE(channel_id, root_thread_ts)
        );

        CREATE TABLE IF NOT EXISTS inbound_messages (
          key TEXT NOT NULL UNIQUE,
          session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
          channel_id TEXT NOT NULL,
          channel_type TEXT,
          root_thread_ts TEXT NOT NULL,
          message_ts TEXT NOT NULL,
          source TEXT NOT NULL,
          user_id TEXT NOT NULL,
          text TEXT NOT NULL,
          sender_kind TEXT,
          bot_id TEXT,
          app_id TEXT,
          sender_username TEXT,
          mentioned_user_ids TEXT,
          mentioned_users TEXT,
          context_text TEXT,
          images TEXT,
          slack_message TEXT,
          background_job TEXT,
          unexpected_turn_stop TEXT,
          status TEXT NOT NULL,
          batch_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(session_key, message_ts)
        );

        CREATE TABLE IF NOT EXISTS background_jobs (
          id TEXT PRIMARY KEY,
          token TEXT NOT NULL,
          session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
          channel_id TEXT NOT NULL,
          root_thread_ts TEXT NOT NULL,
          kind TEXT NOT NULL,
          shell TEXT NOT NULL,
          cwd TEXT NOT NULL,
          script_path TEXT NOT NULL,
          restart_on_boot INTEGER NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          heartbeat_at TEXT,
          completed_at TEXT,
          cancelled_at TEXT,
          exit_code INTEGER,
          error TEXT,
          last_event_at TEXT,
          last_event_kind TEXT,
          last_event_summary TEXT
        );

        CREATE TABLE IF NOT EXISTS processed_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE
        );

        CREATE TABLE IF NOT EXISTS slack_events (
          event_id TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_activity ON sessions(updated_at);
        CREATE INDEX IF NOT EXISTS idx_inbound_session_status ON inbound_messages(session_key, status, batch_id);
        CREATE INDEX IF NOT EXISTS idx_inbound_source ON inbound_messages(session_key, source, message_ts);
        CREATE INDEX IF NOT EXISTS idx_inbound_source_message_ts ON inbound_messages(source, message_ts);
        CREATE INDEX IF NOT EXISTS idx_inbound_mention_backfill
          ON inbound_messages(source, mentioned_user_ids, mentioned_users, message_ts);
        CREATE INDEX IF NOT EXISTS idx_jobs_session_status ON background_jobs(session_key, status);
        CREATE INDEX IF NOT EXISTS idx_slack_events_status ON slack_events(status, created_at);
        CREATE INDEX IF NOT EXISTS idx_slack_events_done_updated ON slack_events(status, updated_at);
      `);
    },
  },
  {
    version: 2,
    name: "admin_operations",
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS admin_operations (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          request TEXT NOT NULL,
          result TEXT,
          error TEXT,
          actor TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT
        );

        CREATE TABLE IF NOT EXISTS admin_audit_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          operation_id TEXT REFERENCES admin_operations(id) ON DELETE SET NULL,
          action TEXT NOT NULL,
          status TEXT NOT NULL,
          detail TEXT,
          actor TEXT,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_admin_operations_updated ON admin_operations(updated_at);
        CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_events(sequence);
        CREATE INDEX IF NOT EXISTS idx_admin_audit_operation ON admin_audit_events(operation_id, sequence);
      `);
    },
  },
  {
    version: 3,
    name: "agent_turn_usage",
    up(database) {
      createAgentTurnUsageSchema(database);
    },
  },
  {
    version: 4,
    name: "agent_trace_events",
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS agent_trace_events (
          id TEXT PRIMARY KEY,
          session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
          source TEXT NOT NULL,
          type TEXT NOT NULL,
          at TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          detail TEXT,
          status TEXT,
          role TEXT,
          tool_name TEXT,
          call_id TEXT,
          turn_id TEXT,
          detail_truncated INTEGER NOT NULL DEFAULT 0,
          detail_original_chars INTEGER,
          metadata TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_agent_trace_events_session_sequence ON agent_trace_events(session_key, sequence);
        CREATE INDEX IF NOT EXISTS idx_agent_trace_events_session_at ON agent_trace_events(session_key, at);
        CREATE INDEX IF NOT EXISTS idx_agent_trace_events_turn ON agent_trace_events(session_key, turn_id);
      `);
    },
  },
  {
    version: 5,
    name: "agent_schema_repair",
    up(database) {
      createAgentTurnUsageSchema(database);

      if (!tableExists(database, "codex_turn_usage")) {
        return;
      }

      const columns = tableColumns(database, "codex_turn_usage");
      const agentSessionColumn = columns.has("codex_thread_id") ? "codex_thread_id" : columns.has("agent_session_id") ? "agent_session_id" : "NULL";
      database.exec(`
        INSERT OR IGNORE INTO agent_turn_usage (
          turn_id, session_key, channel_id, root_thread_ts, agent_session_id,
          status, source, model, effort,
          input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, total_tokens,
          raw_usage, started_at, completed_at, created_at, updated_at
        )
        SELECT
          turn_id, session_key, channel_id, root_thread_ts, ${agentSessionColumn},
          status, source, model, effort,
          input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, total_tokens,
          raw_usage, started_at, completed_at, created_at, updated_at
        FROM codex_turn_usage;

        DROP TABLE codex_turn_usage;
      `);
    },
  },
  {
    version: 6,
    name: "session_agent_schema_repair",
    up(database) {
      repairSessionAgentSchema(database);
    },
  },
  {
    version: 7,
    name: "session_channel_metadata",
    up(database) {
      repairSessionChannelMetadataSchema(database);
    },
  },
  {
    version: 8,
    name: "inbound_mentioned_users",
    up(database) {
      repairInboundMentionedUsersSchema(database);
    },
  },
  {
    version: 9,
    name: "admin_realtime_events",
    up(database) {
      createAdminEventsSchema(database);
    },
  },
  {
    version: 10,
    name: "session_page_link_announcement",
    up(database) {
      repairSessionPageLinkAnnouncementSchema(database);
    },
  },
  {
    version: 11,
    name: "session_auth_profile_binding",
    up(database) {
      repairSessionAuthProfileSchema(database);
    },
  },
  {
    version: 12,
    name: "agent_activity_bindings",
    up(database) {
      createAgentActivityBindingSchema(database);
    },
  },
  {
    version: 13,
    name: "session_initiator",
    up(database) {
      repairSessionInitiatorSchema(database);
    },
  },
  {
    version: 14,
    name: "agent_session_derived_summaries",
    up(database) {
      createAgentSessionDerivedSummarySchema(database);
      rebuildAllAgentSessionUsageSummaries(database);
      rebuildAllAgentSessionTraceSummaries(database);
    },
  },
  {
    version: 15,
    name: "slack_event_retention_indexes",
    up(database) {
      createSlackEventRetentionIndexes(database);
    },
  },
  {
    version: 16,
    name: "inbound_mention_backfill_indexes",
    up(database) {
      createInboundMentionBackfillIndexes(database);
    },
  },
];

function createAgentSessionDerivedSummarySchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_session_usage_summaries (
      session_key TEXT PRIMARY KEY REFERENCES sessions(key) ON DELETE CASCADE,
      channel_id TEXT NOT NULL,
      root_thread_ts TEXT NOT NULL,
      turn_count INTEGER NOT NULL,
      exact_turns INTEGER NOT NULL,
      estimated_turns INTEGER NOT NULL,
      missing_turns INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      cached_input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      reasoning_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      last_turn_at TEXT,
      model TEXT,
      effort TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_agent_session_usage_total ON agent_session_usage_summaries(total_tokens);
    CREATE INDEX IF NOT EXISTS idx_agent_session_usage_last_turn ON agent_session_usage_summaries(last_turn_at);

    CREATE TABLE IF NOT EXISTS agent_session_trace_summaries (
      session_key TEXT PRIMARY KEY REFERENCES sessions(key) ON DELETE CASCADE,
      event_count INTEGER NOT NULL,
      model_request_count INTEGER NOT NULL,
      categories TEXT NOT NULL,
      sources TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_session_trace_updated ON agent_session_trace_summaries(updated_at);
  `);
}

function createAgentActivityBindingSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_session_bindings (
      agent_session_id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
      channel_id TEXT NOT NULL,
      root_thread_ts TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_turn_bindings (
      turn_id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
      channel_id TEXT NOT NULL,
      root_thread_ts TEXT NOT NULL,
      agent_session_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_session_bindings_session ON agent_session_bindings(session_key);
    CREATE INDEX IF NOT EXISTS idx_agent_turn_bindings_session ON agent_turn_bindings(session_key);
    CREATE INDEX IF NOT EXISTS idx_agent_turn_bindings_agent_session ON agent_turn_bindings(agent_session_id);

    INSERT OR IGNORE INTO agent_session_bindings (
      agent_session_id, session_key, channel_id, root_thread_ts, created_at, updated_at
    )
    SELECT
      agent_session_id, key, channel_id, root_thread_ts, updated_at, updated_at
    FROM sessions
    WHERE agent_session_id IS NOT NULL;

    INSERT OR IGNORE INTO agent_turn_bindings (
      turn_id, session_key, channel_id, root_thread_ts, agent_session_id, created_at, updated_at
    )
    SELECT
      active_turn_id, key, channel_id, root_thread_ts, agent_session_id, updated_at, updated_at
    FROM sessions
    WHERE active_turn_id IS NOT NULL;
  `);
}

function createAdminEventsSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS admin_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      scope TEXT NOT NULL,
      session_key TEXT,
      entity_id TEXT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_admin_events_sequence ON admin_events(sequence);
    CREATE INDEX IF NOT EXISTS idx_admin_events_session_sequence ON admin_events(session_key, sequence);
  `);
}

function createSlackEventRetentionIndexes(database: DatabaseSync): void {
  if (!tableExists(database, "slack_events")) {
    return;
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_slack_events_done_updated ON slack_events(status, updated_at);
  `);
}

function createInboundMentionBackfillIndexes(database: DatabaseSync): void {
  if (!tableExists(database, "inbound_messages")) {
    return;
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_inbound_source_message_ts
      ON inbound_messages(source, message_ts);
    CREATE INDEX IF NOT EXISTS idx_inbound_mention_backfill
      ON inbound_messages(source, mentioned_user_ids, mentioned_users, message_ts);
  `);
}

function repairInboundMentionedUsersSchema(database: DatabaseSync): void {
  if (!tableExists(database, "inbound_messages")) {
    return;
  }

  const columns = tableColumns(database, "inbound_messages");
  if (!columns.has("mentioned_users")) {
    database.exec("ALTER TABLE inbound_messages ADD COLUMN mentioned_users TEXT");
  }
}

function repairSessionChannelMetadataSchema(database: DatabaseSync): void {
  if (!tableExists(database, "sessions")) {
    return;
  }

  const columns = tableColumns(database, "sessions");
  if (!columns.has("channel_name")) {
    database.exec("ALTER TABLE sessions ADD COLUMN channel_name TEXT");
  }
  if (!columns.has("channel_type")) {
    database.exec("ALTER TABLE sessions ADD COLUMN channel_type TEXT");
  }
}

function repairSessionPageLinkAnnouncementSchema(database: DatabaseSync): void {
  if (!tableExists(database, "sessions")) {
    return;
  }

  const columns = tableColumns(database, "sessions");
  if (!columns.has("session_page_link_posted_at")) {
    database.exec("ALTER TABLE sessions ADD COLUMN session_page_link_posted_at TEXT");
  }
}

function repairSessionInitiatorSchema(database: DatabaseSync): void {
  if (!tableExists(database, "sessions")) {
    return;
  }

  const columns = tableColumns(database, "sessions");
  if (!columns.has("initiator_user_id")) {
    database.exec("ALTER TABLE sessions ADD COLUMN initiator_user_id TEXT");
  }
  if (!columns.has("initiator_message_ts")) {
    database.exec("ALTER TABLE sessions ADD COLUMN initiator_message_ts TEXT");
  }
  if (!columns.has("initiator_captured_at")) {
    database.exec("ALTER TABLE sessions ADD COLUMN initiator_captured_at TEXT");
  }
}

function repairSessionAuthProfileSchema(database: DatabaseSync): void {
  if (!tableExists(database, "sessions")) {
    return;
  }

  const columns = tableColumns(database, "sessions");
  if (!columns.has("auth_profile_name")) {
    database.exec("ALTER TABLE sessions ADD COLUMN auth_profile_name TEXT");
  }
  if (!columns.has("auth_profile_bound_at")) {
    database.exec("ALTER TABLE sessions ADD COLUMN auth_profile_bound_at TEXT");
  }
  if (!columns.has("auth_blocked_at")) {
    database.exec("ALTER TABLE sessions ADD COLUMN auth_blocked_at TEXT");
  }
  if (!columns.has("auth_block_reason")) {
    database.exec("ALTER TABLE sessions ADD COLUMN auth_block_reason TEXT");
  }
  if (!columns.has("auth_blocked_notice_posted_at")) {
    database.exec("ALTER TABLE sessions ADD COLUMN auth_blocked_notice_posted_at TEXT");
  }
}

function repairSessionAgentSchema(database: DatabaseSync): void {
  if (!tableExists(database, "sessions")) {
    return;
  }

  const columns = tableColumns(database, "sessions");
  if (!columns.has("agent_session_id")) {
    database.exec("ALTER TABLE sessions ADD COLUMN agent_session_id TEXT");
  }

  if (columns.has("codex_thread_id")) {
    database.exec(`
      UPDATE sessions
      SET agent_session_id = COALESCE(agent_session_id, codex_thread_id)
      WHERE codex_thread_id IS NOT NULL
    `);
  }
}

function createAgentTurnUsageSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_turn_usage (
      turn_id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
      channel_id TEXT NOT NULL,
      root_thread_ts TEXT NOT NULL,
      agent_session_id TEXT,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      model TEXT,
      effort TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      raw_usage TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_turn_usage_session ON agent_turn_usage(session_key, completed_at);
    CREATE INDEX IF NOT EXISTS idx_agent_turn_usage_completed ON agent_turn_usage(completed_at);
    CREATE INDEX IF NOT EXISTS idx_agent_turn_usage_total ON agent_turn_usage(total_tokens);
  `);
}

function tableExists(database: DatabaseSync, tableName: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function tableColumns(database: DatabaseSync, tableName: string): Set<string> {
  return new Set((database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((row: { name: string }) => row.name));
}

import { StateStoreLayer24 } from "./state-store-layer24.js";
export class StateStoreLayer25 extends StateStoreLayer24 {
  privateNormalizeAgentTurnUsage(raw: Partial<PersistedAgentTurnUsage>): PersistedAgentTurnUsage {
    if (!raw.turnId || !raw.sessionKey || !raw.channelId || !raw.rootThreadTs || !raw.status || !raw.source) {
      throw new Error(`Invalid Agent turn usage: ${raw.turnId ?? "unknown"}`);
    }

    const now = new Date().toISOString();
    return {
      turnId: String(raw.turnId),
      sessionKey: String(raw.sessionKey),
      channelId: String(raw.channelId),
      rootThreadTs: String(raw.rootThreadTs),
      agentSessionId: typeof raw.agentSessionId === "string" ? raw.agentSessionId : undefined,
      status: raw.status,
      source: raw.source,
      model: typeof raw.model === "string" ? raw.model : undefined,
      effort: typeof raw.effort === "string" ? raw.effort : undefined,
      inputTokens: normalizeTokenCount(raw.inputTokens),
      cachedInputTokens: normalizeTokenCount(raw.cachedInputTokens),
      outputTokens: normalizeTokenCount(raw.outputTokens),
      reasoningTokens: normalizeTokenCount(raw.reasoningTokens),
      totalTokens: normalizeTokenCount(raw.totalTokens),
      rawUsage: raw.rawUsage,
      startedAt: typeof raw.startedAt === "string" ? raw.startedAt : undefined,
      completedAt: typeof raw.completedAt === "string" ? raw.completedAt : undefined,
      createdAt: String(raw.createdAt ?? now),
      updatedAt: String(raw.updatedAt ?? raw.createdAt ?? now),
    };
  }

  privateNormalizeAgentTraceEvent(raw: Partial<PersistedAgentTraceEvent>): PersistedAgentTraceEvent {
    if (!raw.id || !raw.sessionKey || !raw.source || !raw.type || !raw.at || !raw.title) {
      throw new Error(`Invalid agent trace event: ${raw.id ?? "unknown"}`);
    }

    const now = new Date().toISOString();
    return {
      id: String(raw.id),
      sessionKey: String(raw.sessionKey),
      source: raw.source,
      type: String(raw.type),
      at: String(raw.at),
      sequence: normalizeFiniteNumber(raw.sequence) ?? timestampSequence(raw.at),
      title: String(raw.title),
      summary: String(raw.summary ?? ""),
      detail: typeof raw.detail === "string" ? raw.detail : undefined,
      status: typeof raw.status === "string" ? raw.status : undefined,
      role: typeof raw.role === "string" ? raw.role : undefined,
      toolName: typeof raw.toolName === "string" ? raw.toolName : undefined,
      callId: typeof raw.callId === "string" ? raw.callId : undefined,
      turnId: typeof raw.turnId === "string" ? raw.turnId : undefined,
      detailTruncated: raw.detailTruncated,
      detailOriginalChars: normalizeFiniteNumber(raw.detailOriginalChars),
      metadata: raw.metadata,
      createdAt: String(raw.createdAt ?? now),
      updatedAt: String(raw.updatedAt ?? raw.createdAt ?? now),
    };
  }

  privateDatabaseRequired(): DatabaseSync {
    if (!this.privateDatabase) {
      throw new Error("StateStore has not been loaded");
    }
    return this.privateDatabase;
  }

  privateTransaction<T>(operation: () => T): T {
    const db = this.privateDatabaseRequired();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

function ensureSchemaMigrationsTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      applied_at TEXT NOT NULL
    );
  `);

  const columns = new Set((database.prepare("PRAGMA table_info(schema_migrations)").all() as Array<{ name: string }>).map((row: { name: string }) => row.name));
  if (!columns.has("name")) {
    database.exec("ALTER TABLE schema_migrations ADD COLUMN name TEXT NOT NULL DEFAULT ''");
  }
}

function rebuildAllAgentSessionUsageSummaries(database: DatabaseSync): void {
  if (!tableExists(database, "agent_turn_usage")) {
    return;
  }
  const rows = database.prepare("SELECT DISTINCT session_key FROM agent_turn_usage").all() as SqlRow[];
  for (const row of rows) {
    rebuildAgentSessionUsageSummary(database, stringColumn(row, "session_key"));
  }
}

function rebuildAgentSessionUsageSummary(database: DatabaseSync, sessionKey: string): void {
  if (!tableExists(database, "agent_turn_usage")) {
    return;
  }
  const records = database
    .prepare(`
      SELECT * FROM agent_turn_usage
      WHERE session_key = ?
      ORDER BY COALESCE(completed_at, updated_at, created_at) ASC, updated_at ASC
    `)
    .all(sessionKey) as SqlRow[];
  if (!records.length) {
    database.prepare("DELETE FROM agent_session_usage_summaries WHERE session_key = ?").run(sessionKey);
    return;
  }

  let turnCount = 0;
  let exactTurns = 0;
  let estimatedTurns = 0;
  let missingTurns = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let totalTokens = 0;
  let latest = records[0]!;
  let latestMs = usageRowTimestampMs(latest);

  for (const row of records) {
    turnCount += 1;
    const source = stringColumn(row, "source");
    if (source === "exact") {
      exactTurns += 1;
    } else if (source === "estimated") {
      estimatedTurns += 1;
    } else {
      missingTurns += 1;
    }
    inputTokens += optionalNumberColumn(row, "input_tokens") ?? 0;
    cachedInputTokens += optionalNumberColumn(row, "cached_input_tokens") ?? 0;
    outputTokens += optionalNumberColumn(row, "output_tokens") ?? 0;
    reasoningTokens += optionalNumberColumn(row, "reasoning_tokens") ?? 0;
    totalTokens += optionalNumberColumn(row, "total_tokens") ?? 0;
    const timestampMs = usageRowTimestampMs(row);
    if (timestampMs >= latestMs) {
      latest = row;
      latestMs = timestampMs;
    }
  }

  database
    .prepare(`
    INSERT INTO agent_session_usage_summaries (
      session_key, channel_id, root_thread_ts, turn_count, exact_turns,
      estimated_turns, missing_turns, input_tokens, cached_input_tokens,
      output_tokens, reasoning_tokens, total_tokens, updated_at, last_turn_at,
      model, effort
    ) VALUES (${placeholders(16)})
    ON CONFLICT(session_key) DO UPDATE SET
      channel_id = excluded.channel_id,
      root_thread_ts = excluded.root_thread_ts,
      turn_count = excluded.turn_count,
      exact_turns = excluded.exact_turns,
      estimated_turns = excluded.estimated_turns,
      missing_turns = excluded.missing_turns,
      input_tokens = excluded.input_tokens,
      cached_input_tokens = excluded.cached_input_tokens,
      output_tokens = excluded.output_tokens,
      reasoning_tokens = excluded.reasoning_tokens,
      total_tokens = excluded.total_tokens,
      updated_at = excluded.updated_at,
      last_turn_at = excluded.last_turn_at,
      model = excluded.model,
      effort = excluded.effort
  `)
    .run(
      sessionKey,
      stringColumn(latest, "channel_id"),
      stringColumn(latest, "root_thread_ts"),
      turnCount,
      exactTurns,
      estimatedTurns,
      missingTurns,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningTokens,
      totalTokens,
      stringColumn(latest, "updated_at"),
      optionalStringColumn(latest, "completed_at") ?? stringColumn(latest, "updated_at"),
      optionalStringColumn(latest, "model") ?? null,
      optionalStringColumn(latest, "effort") ?? null,
    );
}

function rebuildAllAgentSessionTraceSummaries(database: DatabaseSync): void {
  if (!tableExists(database, "agent_trace_events")) {
    return;
  }
  const rows = database.prepare("SELECT DISTINCT session_key FROM agent_trace_events").all() as SqlRow[];
  for (const row of rows) {
    rebuildAgentSessionTraceSummary(database, stringColumn(row, "session_key"));
  }
}

interface TraceSummaryContribution {
  eventCount: number;
  modelRequestCount: number;
  categories: Record<string, number>;
  sources: Record<string, number>;
}

function emptyTraceSummaryContribution(): TraceSummaryContribution {
  return {
    eventCount: 0,
    modelRequestCount: 0,
    categories: {},
    sources: {},
  };
}

function traceSummaryContribution(event: PersistedAgentTraceEvent, hiddenByCompletedToolResult: boolean): TraceSummaryContribution {
  const contribution = emptyTraceSummaryContribution();
  if (event.type === "agent_token_count") {
    contribution.modelRequestCount = 1;
  }
  if (isVisibleTraceSummaryRow(event.type, event.status) && !(event.type === "agent_tool_call" && hiddenByCompletedToolResult)) {
    contribution.eventCount = 1;
    contribution.categories[event.type] = 1;
    contribution.sources[event.source] = 1;
  }
  return contribution;
}

function subtractTraceSummaryContribution(next: TraceSummaryContribution, previous: TraceSummaryContribution): TraceSummaryContribution {
  const delta = emptyTraceSummaryContribution();
  applyTraceSummaryDelta(delta, next, 1);
  applyTraceSummaryDelta(delta, previous, -1);
  return delta;
}

function applyTraceSummaryDelta(target: TraceSummaryContribution, source: TraceSummaryContribution, multiplier: 1 | -1): void {
  target.eventCount += source.eventCount * multiplier;
  target.modelRequestCount += source.modelRequestCount * multiplier;
  for (const [key, value] of Object.entries(source.categories)) {
    target.categories[key] = (target.categories[key] ?? 0) + value * multiplier;
  }
  for (const [key, value] of Object.entries(source.sources)) {
    target.sources[key] = (target.sources[key] ?? 0) + value * multiplier;
  }
}

function mergeCountMaps(existing: Record<string, number>, delta: Record<string, number>): Record<string, number> {
  const merged: Record<string, number> = { ...existing };
  for (const [key, value] of Object.entries(delta)) {
    const nextValue = (merged[key] ?? 0) + value;
    if (nextValue <= 0) {
      delete merged[key];
    } else {
      merged[key] = nextValue;
    }
  }
  return merged;
}

function rebuildAgentSessionTraceSummary(database: DatabaseSync, sessionKey: string): void {
  if (!tableExists(database, "agent_trace_events")) {
    return;
  }
  const rows = database
    .prepare(`
      SELECT type, source, status, updated_at, turn_id, call_id, tool_name
      FROM agent_trace_events
      WHERE session_key = ?
    `)
    .all(sessionKey) as SqlRow[];
  if (!rows.length) {
    database.prepare("DELETE FROM agent_session_trace_summaries WHERE session_key = ?").run(sessionKey);
    return;
  }

  const categories: Record<string, number> = {};
  const sources: Record<string, number> = {};
  let eventCount = 0;
  let modelRequestCount = 0;
  let updatedAt = stringColumn(rows[0]!, "updated_at");
  const completedToolCallKeys = new Set(
    rows
      .filter((row) => stringColumn(row, "type") === "agent_tool_result")
      .map(traceToolRowKey)
      .filter(Boolean),
  );

  for (const row of rows) {
    const type = stringColumn(row, "type");
    const source = stringColumn(row, "source");
    if (type === "agent_token_count") {
      modelRequestCount += 1;
    }
    if (isVisibleTraceSummaryRow(type, optionalStringColumn(row, "status")) && !(type === "agent_tool_call" && completedToolCallKeys.has(traceToolRowKey(row)))) {
      eventCount += 1;
      categories[type] = (categories[type] ?? 0) + 1;
      sources[source] = (sources[source] ?? 0) + 1;
    }
    const rowUpdatedAt = stringColumn(row, "updated_at");
    if (rowUpdatedAt > updatedAt) {
      updatedAt = rowUpdatedAt;
    }
  }

  database
    .prepare(`
    INSERT INTO agent_session_trace_summaries (
      session_key, event_count, model_request_count, categories, sources, updated_at
    ) VALUES (${placeholders(6)})
    ON CONFLICT(session_key) DO UPDATE SET
      event_count = excluded.event_count,
      model_request_count = excluded.model_request_count,
      categories = excluded.categories,
      sources = excluded.sources,
      updated_at = excluded.updated_at
  `)
    .run(sessionKey, eventCount, modelRequestCount, JSON.stringify(categories), JSON.stringify(sources), updatedAt);
}

function traceToolRowKey(row: SqlRow): string {
  const callId = optionalStringColumn(row, "call_id");
  const turnId = optionalStringColumn(row, "turn_id") ?? "";
  if (callId) {
    return [turnId, callId].join("\u001f");
  }
  const toolName = optionalStringColumn(row, "tool_name");
  if (!turnId && !toolName) {
    return "";
  }
  return [turnId, toolName ?? ""].join("\u001f");
}

function traceToolEventKeyParts(event: PersistedAgentTraceEvent):
  | {
      readonly turnId: string;
      readonly callId?: string | undefined;
      readonly toolName?: string | undefined;
    }
  | undefined {
  const turnId = event.turnId ?? "";
  if (event.callId) {
    return {
      turnId,
      callId: event.callId,
    };
  }
  if (!turnId && !event.toolName) {
    return undefined;
  }
  return {
    turnId,
    toolName: event.toolName ?? "",
  };
}

function traceToolEventKey(event: PersistedAgentTraceEvent): string {
  const key = traceToolEventKeyParts(event);
  if (!key) {
    return "";
  }
  return key.callId ? [key.turnId, key.callId].join("\u001f") : [key.turnId, key.toolName ?? ""].join("\u001f");
}

function isVisibleTraceSummaryRow(type: string, status?: string | undefined): boolean {
  if (type === "agent_token_count") {
    return false;
  }
  if (type === "agent_input_delivered" || type === "agent_turn_started") {
    return false;
  }
  if (type === "agent_turn_completed" && status === "completed") {
    return false;
  }
  return true;
}

function usageRowTimestampMs(row: SqlRow): number {
  return timestampMs(optionalStringColumn(row, "completed_at") ?? optionalStringColumn(row, "updated_at") ?? optionalStringColumn(row, "created_at"));
}

function timestampMs(value: unknown): number {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function clampPositiveInteger(value: unknown, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function arrayOption<T>(value: T | readonly T[] | undefined): readonly T[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) ? (value as readonly T[]) : [value as T];
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function readJsonColumn<T>(row: SqlRow, column: string, fallback: T): T {
  const value = row[column];
  if (typeof value !== "string") {
    return fallback;
  }
  return JSON.parse(value) as T;
}

function stringColumn(row: SqlRow, column: string): string {
  return String(row[column]);
}

function optionalStringColumn(row: SqlRow, column: string): string | undefined {
  const value = row[column];
  return value === null || value === undefined ? undefined : String(value);
}

function optionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function optionalNumberColumn(row: SqlRow, column: string): number | undefined {
  const value = row[column];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return undefined;
}

function sqlChanges(result: unknown): number {
  const changes = (result as { readonly changes?: unknown }).changes;
  if (typeof changes === "number" && Number.isFinite(changes)) {
    return changes;
  }
  if (typeof changes === "bigint") {
    return Number(changes);
  }
  return 0;
}

function sqlLastInsertRowid(result: unknown): number {
  const lastInsertRowid = (result as { readonly lastInsertRowid?: unknown }).lastInsertRowid;
  if (typeof lastInsertRowid === "number" && Number.isFinite(lastInsertRowid)) {
    return lastInsertRowid;
  }
  if (typeof lastInsertRowid === "bigint") {
    return Number(lastInsertRowid);
  }
  return 0;
}

function booleanColumn(row: SqlRow, column: string, fallback: boolean): boolean {
  const value = row[column];
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "bigint") {
    return value !== 0n;
  }
  return fallback;
}

function compareInboundMessages(left: PersistedInboundMessage, right: PersistedInboundMessage): number {
  return Number(left.messageTs) - Number(right.messageTs);
}

function normalizeSessionDirectoryName(channelId: string, rootThreadTs: string): string {
  return `${channelId}-${rootThreadTs}`.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function normalizeStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function normalizeTokenCount(value: unknown): number {
  const parsed = normalizeFiniteNumber(value) ?? 0;
  return Math.max(0, Math.trunc(parsed));
}

function timestampSequence(value: unknown): number {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}
