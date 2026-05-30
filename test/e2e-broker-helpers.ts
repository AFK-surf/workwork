import fs from "node:fs/promises";

import http from "node:http";

import os from "node:os";

import path from "node:path";

import { once } from "node:events";

import { spawn } from "node:child_process";

import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { CodexInputItem } from "../src/services/codex/app-server-client.js";

import { SessionManager } from "../src/services/session-manager.js";

import { StateStore } from "../src/store/state-store.js";

import type { PersistedAgentTraceEvent, PersistedInboundMessage, SlackSessionRecord } from "../src/types.js";

import { MockCodexAppServer } from "./helpers/mock-codex-app-server.js";

import { MockSlackServer } from "./manual/mock-slack-server.js";

export const brokerRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

export const DEFAULT_E2E_TIMEOUT_MS = 30_000;

export const DAY_MS = 24 * 60 * 60 * 1000;

export async function startBrokerProcess(options: { readonly port: number; readonly slackPort: number; readonly codexUrl: string; readonly tempRoot: string; readonly extraEnv?: Record<string, string> }): Promise<{
  readonly baseUrl: string;
  readonly stop: () => Promise<void>;
  readonly logs: readonly string[];
}> {
  const logs: string[] = [];
  const child = spawn("pnpm", ["exec", "tsx", "src/index.ts"], {
    cwd: brokerRoot,
    env: {
      ...process.env,
      ...options.extraEnv,
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_API_BASE_URL: `http://127.0.0.1:${options.slackPort}/api`,
      SLACK_SOCKET_OPEN_URL: "apps.connections.open",
      SLACK_INITIAL_THREAD_HISTORY_COUNT: "8",
      SLACK_HISTORY_API_MAX_LIMIT: "50",
      STATE_DIR: path.join(options.tempRoot, "state"),
      SESSIONS_ROOT: path.join(options.tempRoot, "sessions"),
      REPOS_ROOT: path.join(options.tempRoot, "repos"),
      JOBS_ROOT: path.join(options.tempRoot, "jobs"),
      LOG_DIR: path.join(options.tempRoot, "logs"),
      CODEX_HOME: path.join(options.tempRoot, "codex-home"),
      PORT: String(options.port),
      BROKER_HTTP_BASE_URL: `http://127.0.0.1:${options.port}`,
      CODEX_APP_SERVER_URL: options.codexUrl,
      DEBUG: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    logs.push(chunk.toString());
  });
  child.stderr.on("data", (chunk) => {
    logs.push(chunk.toString());
  });

  await waitForHttpReady(`http://127.0.0.1:${options.port}`, logs);

  return {
    baseUrl: `http://127.0.0.1:${options.port}`,
    logs,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }

      child.kill("SIGTERM");
      const graceful = await Promise.race([once(child, "exit").then(() => true), delay(5_000).then(() => false)]);
      if (graceful) {
        return;
      }

      child.kill("SIGKILL");
      await once(child, "exit");
    },
  };
}

export async function waitForHttpReady(url: string, logs: readonly string[], timeoutMs = DEFAULT_E2E_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // ignore and retry
    }

    await delay(200);
  }

  throw new Error(`Timed out waiting for broker readiness: ${url}\n${logs.join("")}`);
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = DEFAULT_E2E_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) {
        return;
      }
    } catch (error) {
      if (!isTransientSqliteLock(error)) {
        throw error;
      }
    }
    await delay(100);
  }

  throw new Error(`Timed out waiting for ${label}`);
}

export function isTransientSqliteLock(error: unknown): boolean {
  return error instanceof Error && /database is locked/i.test(error.message);
}

export async function waitForSessionIdle(tempRoot: string, sessionKey: string, timeoutMs = DEFAULT_E2E_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastSession: SlackSessionRecord | undefined;

  while (Date.now() < deadline) {
    try {
      const session = await readSessionRecord(tempRoot, sessionKey);
      lastSession = session;
      if (!session.activeTurnId) {
        return;
      }
    } catch {
      // session file may not exist yet
    }

    await delay(100);
  }

  throw new Error(
    `Timed out waiting for session idle: ${sessionKey}; lastSession=${JSON.stringify({
      activeTurnId: lastSession?.activeTurnId ?? null,
      lastTurnSignalKind: lastSession?.lastTurnSignalKind ?? null,
      lastTurnSignalTurnId: lastSession?.lastTurnSignalTurnId ?? null,
    })}`,
  );
}

export async function waitForSessionActive(tempRoot: string, sessionKey: string, timeoutMs = DEFAULT_E2E_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const session = await readSessionRecord(tempRoot, sessionKey);
      if (session.activeTurnId) {
        return;
      }
    } catch {
      // session file may not exist yet
    }

    await delay(100);
  }

  throw new Error(`Timed out waiting for session active: ${sessionKey}`);
}

export async function readSessionRecord(tempRoot: string, sessionKey: string): Promise<SlackSessionRecord> {
  const store = new StateStore(path.join(tempRoot, "state"), path.join(tempRoot, "sessions"));
  await store.load();
  try {
    const session = store.getSession(sessionKey);
    if (!session) {
      throw new Error(`Unknown session: ${sessionKey}`);
    }
    return session;
  } finally {
    store.close();
  }
}

export async function readInboundMessages(tempRoot: string, sessionKey: string): Promise<PersistedInboundMessage[]> {
  const store = new StateStore(path.join(tempRoot, "state"), path.join(tempRoot, "sessions"));
  await store.load();
  try {
    return store.listInboundMessages({ sessionKey });
  } finally {
    store.close();
  }
}

export async function readAgentTraceEvents(tempRoot: string, sessionKey: string): Promise<PersistedAgentTraceEvent[]> {
  const store = new StateStore(path.join(tempRoot, "state"), path.join(tempRoot, "sessions"));
  await store.load();
  try {
    return store.listAgentTraceEvents(sessionKey);
  } finally {
    store.close();
  }
}

export async function delay(timeoutMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function removeTempRoot(tempRoot: string): Promise<void> {
  let lastError: unknown = undefined;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(tempRoot, { force: true, recursive: true });
      return;
    } catch (error) {
      lastError = error;
      await delay(100 * (attempt + 1));
    }
  }

  throw lastError;
}

export async function getFreePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to allocate free port");
  }

  const port = address.port;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return port;
}

export function collectTextInput(input: readonly CodexInputItem[]): string {
  return input
    .filter((item): item is Extract<CodexInputItem, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

export function findStartedTurnTextContaining(mockCodex: MockCodexAppServer, needle: string): string | undefined {
  return mockCodex.turnsStarted.map((turn) => collectTextInput(turn.input)).find((text) => text.includes(needle));
}

export async function postJson(url: string, payload: Record<string, unknown>): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}: ${await response.text()}`);
  }
}

export function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return {
    promise,
    resolve,
    reject,
  };
}
