import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

import { logger } from "../logger.js";
import type {
  BackgroundJobEventPayload,
  JsonLike,
  PersistedBackgroundJob
} from "../types.js";
import { ensureDir } from "../utils/fs.js";
import { resolveRuntimeToolPath } from "../utils/runtime-paths.js";
import { SessionManager } from "./session-manager.js";
import type { ChatPlatform } from "./chat/chat-types.js";

interface BackgroundJobCoordinates {
  readonly platform: ChatPlatform;
  readonly conversationId: string;
  readonly rootMessageId: string;
}

interface RuntimeBackgroundJob {
  readonly process: ChildProcessByStdio<null, Readable, Readable>;
  stderrTail: string;
  stopping: boolean;
}

export class JobManager {
  readonly #sessions: SessionManager;
  readonly #jobsRoot: string;
  readonly #reposRoot: string;
  readonly #brokerHttpBaseUrl: string;
  readonly #runtimeJobs = new Map<string, RuntimeBackgroundJob>();
  readonly #onEvent: (event: {
    readonly platform: ChatPlatform;
    readonly conversationId: string;
    readonly rootMessageId: string;
    readonly payload: BackgroundJobEventPayload;
  }) => Promise<void>;

  constructor(options: {
    readonly sessions: SessionManager;
    readonly jobsRoot: string;
    readonly reposRoot: string;
    readonly brokerHttpBaseUrl: string;
    readonly onEvent: (event: {
      readonly platform: ChatPlatform;
      readonly conversationId: string;
      readonly rootMessageId: string;
      readonly payload: BackgroundJobEventPayload;
    }) => Promise<void>;
  }) {
    this.#sessions = options.sessions;
    this.#jobsRoot = options.jobsRoot;
    this.#reposRoot = options.reposRoot;
    this.#brokerHttpBaseUrl = options.brokerHttpBaseUrl;
    this.#onEvent = options.onEvent;
  }

  async start(): Promise<void> {
    await ensureDir(this.#jobsRoot);

    for (const job of this.#sessions.listBackgroundJobs()) {
      if (!job.restartOnBoot) {
        continue;
      }

      if (job.status !== "registered" && job.status !== "running") {
        continue;
      }

      await this.#startExistingJob(job);
    }
  }

  async stop(): Promise<void> {
    await Promise.all(
      [...this.#runtimeJobs.keys()].map(async (jobId) => {
        await this.#stopRuntimeJob(jobId);
      })
    );
  }

  async registerJob(options: {
    readonly platform?: ChatPlatform | undefined;
    readonly conversationId?: string | undefined;
    readonly rootMessageId?: string | undefined;
    readonly channelId?: string | undefined;
    readonly rootThreadTs?: string | undefined;
    readonly kind: string;
    readonly script: string;
    readonly cwd?: string | undefined;
    readonly shell?: string | undefined;
    readonly restartOnBoot?: boolean | undefined;
  }): Promise<PersistedBackgroundJob> {
    const coordinates = resolveBackgroundJobCoordinates(options);
    const session = this.#sessions.getChatSession(coordinates);
    if (!session) {
      throw new Error(`Unknown session: ${coordinates.platform}:${coordinates.conversationId}:${coordinates.rootMessageId}`);
    }

    const id = randomUUID();
    const token = randomBytes(24).toString("hex");
    const createdAt = new Date().toISOString();
    const jobDir = path.join(this.#jobsRoot, id);
    const scriptPath = path.join(jobDir, "run.sh");
    const cwd = resolveJobCwd(session.workspacePath, options.cwd);
    const shell = options.shell?.trim() || "sh";

    await ensureDir(jobDir);
    await fs.writeFile(scriptPath, normalizeScript(options.script, shell), {
      encoding: "utf8",
      mode: 0o755
    });
    await fs.chmod(scriptPath, 0o755);

    const job: PersistedBackgroundJob = {
      id,
      token,
      sessionKey: session.key,
      platform: coordinates.platform,
      conversationId: coordinates.conversationId,
      rootMessageId: coordinates.rootMessageId,
      channelId: session.channelId,
      rootThreadTs: session.rootThreadTs,
      kind: options.kind.trim(),
      shell,
      cwd,
      scriptPath,
      restartOnBoot: options.restartOnBoot ?? true,
      status: "registered",
      createdAt,
      updatedAt: createdAt
    };

    await this.#sessions.upsertBackgroundJob(job);
    await this.#startExistingJob(job);

    return this.#requireJob(id);
  }

  async heartbeatJob(id: string, token: string): Promise<PersistedBackgroundJob> {
    const job = this.#authorizeJob(id, token);
    return await this.#persistJob({
      ...job,
      heartbeatAt: new Date().toISOString()
    });
  }

  async emitJobEvent(
    id: string,
    token: string,
    payload: {
      readonly eventKind: string;
      readonly summary: string;
      readonly detailsText?: string | undefined;
      readonly detailsJson?: JsonLike | undefined;
    }
  ): Promise<PersistedBackgroundJob> {
    const job = this.#authorizeJob(id, token);
    const updated = await this.#persistJob({
      ...job,
      lastEventAt: new Date().toISOString(),
      lastEventKind: payload.eventKind,
      lastEventSummary: payload.summary.trim()
    });

    if (this.#shouldSuppressEventForFinalizedSession(updated)) {
      await this.cancelJob(updated.id, undefined, {
        skipTokenCheck: true,
        skipEvent: true
      });
      return this.#requireJob(updated.id);
    }

    await this.#emitEvent(updated, {
      jobId: updated.id,
      jobKind: updated.kind,
      eventKind: payload.eventKind,
      summary: payload.summary.trim(),
      detailsText: payload.detailsText?.trim() || undefined,
      detailsJson: payload.detailsJson
    });

    return updated;
  }

  async completeJob(
    id: string,
    token: string,
    payload?: {
      readonly summary?: string | undefined;
      readonly detailsText?: string | undefined;
      readonly detailsJson?: JsonLike | undefined;
    }
  ): Promise<PersistedBackgroundJob> {
    const job = this.#authorizeJob(id, token);
    const now = new Date().toISOString();
    const updated = await this.#persistJob({
      ...job,
      status: "completed",
      completedAt: now,
      lastEventKind: payload?.summary?.trim() ? "job_completed" : job.lastEventKind,
      lastEventSummary: payload?.summary?.trim() || job.lastEventSummary
    });

    if (payload?.summary?.trim() && !this.#shouldSuppressEventForFinalizedSession(updated)) {
      await this.#emitEvent(updated, {
        jobId: updated.id,
        jobKind: updated.kind,
        eventKind: "job_completed",
        summary: payload.summary.trim(),
        detailsText: payload.detailsText?.trim() || undefined,
        detailsJson: payload.detailsJson
      });
    }

    await this.#stopRuntimeJob(updated.id);
    return updated;
  }

  async failJob(
    id: string,
    token: string,
    payload: {
      readonly summary?: string | undefined;
      readonly error?: string | undefined;
      readonly detailsText?: string | undefined;
      readonly detailsJson?: JsonLike | undefined;
    }
  ): Promise<PersistedBackgroundJob> {
    const job = this.#authorizeJob(id, token);
    const now = new Date().toISOString();
    const updated = await this.#persistJob({
      ...job,
      status: "failed",
      completedAt: now,
      error: payload.error?.trim() || payload.summary?.trim() || job.error
    });

    await this.#emitEvent(updated, {
      jobId: updated.id,
      jobKind: updated.kind,
      eventKind: "job_failed",
      summary: payload.summary?.trim() || `Background job ${updated.id} failed.`,
      detailsText: payload.detailsText?.trim() || payload.error?.trim() || undefined,
      detailsJson: payload.detailsJson
    });

    await this.#stopRuntimeJob(updated.id);
    return updated;
  }

  async cancelJob(
    id: string,
    token?: string | undefined,
    options?: {
      readonly skipTokenCheck?: boolean | undefined;
      readonly skipEvent?: boolean | undefined;
    }
  ): Promise<PersistedBackgroundJob> {
    const job = options?.skipTokenCheck ? this.#requireJob(id) : this.#authorizeJob(id, token);
    const now = new Date().toISOString();
    const updated = await this.#persistJob({
      ...job,
      status: "cancelled",
      cancelledAt: now,
      completedAt: now
    });

    if (!options?.skipEvent) {
      await this.#emitEvent(updated, {
        jobId: updated.id,
        jobKind: updated.kind,
        eventKind: "job_cancelled",
        summary: `Background job ${updated.id} was cancelled.`
      });
    }

    await this.#stopRuntimeJob(updated.id);
    return updated;
  }

  async #startExistingJob(job: PersistedBackgroundJob): Promise<void> {
    if (this.#runtimeJobs.has(job.id)) {
      return;
    }

    await ensureDir(path.dirname(job.scriptPath));
    const coordinates = coordinatesForJob(job);
    const session = this.#sessions.getSessionByKey(job.sessionKey);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BROKER_JOB_ID: job.id,
      BROKER_JOB_TOKEN: job.token,
      BROKER_API_BASE: this.#brokerHttpBaseUrl,
      BROKER_JOB_HELPER: process.env.BROKER_JOB_HELPER?.trim() || resolveRuntimeToolPath("job-callback.js"),
      CHAT_PLATFORM: coordinates.platform,
      CHAT_CONVERSATION_ID: coordinates.conversationId,
      CHAT_ROOT_MESSAGE_ID: coordinates.rootMessageId,
      SLACK_CHANNEL_ID: coordinates.platform === "slack" ? coordinates.conversationId : undefined,
      SLACK_THREAD_TS: coordinates.platform === "slack" ? coordinates.rootMessageId : undefined,
      SESSION_KEY: job.sessionKey,
      SESSION_WORKSPACE: session?.workspacePath ?? job.cwd,
      REPOS_ROOT: this.#reposRoot,
      WORKTREE_PATH: session?.workspacePath ?? job.cwd,
      BACKGROUND_JOB_KIND: job.kind
    };

    try {
      const child = spawn(job.scriptPath, [], {
        cwd: job.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"]
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
      });

      const runtime: RuntimeBackgroundJob = {
        process: child,
        stderrTail: "",
        stopping: false
      };
      this.#runtimeJobs.set(job.id, runtime);

      child.stdout.on("data", (chunk: Buffer) => {
        logger.debug("background job stdout", {
          jobId: job.id,
          text: chunk.toString()
        });
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        runtime.stderrTail = `${runtime.stderrTail}${text}`.slice(-8_000);
        logger.warn("background job stderr", {
          jobId: job.id,
          text
        });
      });
      child.once("error", (error) => {
        logger.warn("background job process error", {
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error)
        });
      });
      child.once("exit", (code, signal) => {
        void this.#handleJobExit(job.id, code, signal);
      });

      await this.#persistJob({
        ...job,
        status: "running",
        startedAt: new Date().toISOString(),
        exitCode: undefined,
        error: undefined
      });
    } catch (error) {
      const failed = await this.#persistJob({
        ...job,
        status: "failed",
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      });
      await this.#emitEvent(failed, {
        jobId: failed.id,
        jobKind: failed.kind,
        eventKind: "job_failed",
        summary: `Background job ${failed.id} failed to start.`,
        detailsText: failed.error
      });
      throw error;
    }
  }

  async #handleJobExit(
    jobId: string,
    code: number | null,
    signal: NodeJS.Signals | null
  ): Promise<void> {
    const runtime = this.#runtimeJobs.get(jobId);
    this.#runtimeJobs.delete(jobId);

    const job = this.#sessions.getBackgroundJob(jobId);
    if (!job) {
      return;
    }

    const exitCode = code ?? undefined;
    const signalText = signal ?? undefined;

    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      await this.#persistJob({
        ...job,
        exitCode
      });
      return;
    }

    if (runtime?.stopping) {
      return;
    }

    if ((code ?? 0) === 0 && !signalText) {
      await this.#persistJob({
        ...job,
        status: "completed",
        completedAt: new Date().toISOString(),
        exitCode
      });
      return;
    }

    const errorText = [
      exitCode != null ? `exit code ${exitCode}` : undefined,
      signalText ? `signal ${signalText}` : undefined,
      runtime?.stderrTail?.trim() || undefined
    ].filter(Boolean).join("; ");

    const failed = await this.#persistJob({
      ...job,
      status: "failed",
      completedAt: new Date().toISOString(),
      exitCode,
      error: errorText || job.error
    });
    await this.#emitEvent(failed, {
      jobId: failed.id,
      jobKind: failed.kind,
      eventKind: "job_failed",
      summary: `Background job ${failed.id} exited unexpectedly.`,
      detailsText: failed.error
    });
  }

  async #stopRuntimeJob(jobId: string): Promise<void> {
    const runtime = this.#runtimeJobs.get(jobId);
    if (!runtime) {
      return;
    }

    runtime.stopping = true;
    const child = runtime.process;

    if (child.exitCode !== null || child.signalCode !== null) {
      this.#runtimeJobs.delete(jobId);
      return;
    }

    child.kill("SIGTERM");
    const exited = await waitForChildExit(child, 5_000);
    if (exited) {
      this.#runtimeJobs.delete(jobId);
      return;
    }

    child.kill("SIGKILL");
    await waitForChildExit(child, 2_000);
    this.#runtimeJobs.delete(jobId);
  }

  async #emitEvent(
    job: PersistedBackgroundJob,
    payload: BackgroundJobEventPayload
  ): Promise<void> {
    const coordinates = coordinatesForJob(job);
    await this.#onEvent({
      platform: coordinates.platform,
      conversationId: coordinates.conversationId,
      rootMessageId: coordinates.rootMessageId,
      payload
    });
  }

  async #persistJob(job: PersistedBackgroundJob): Promise<PersistedBackgroundJob> {
    const updated: PersistedBackgroundJob = {
      ...job,
      updatedAt: new Date().toISOString()
    };
    await this.#sessions.upsertBackgroundJob(updated);
    return updated;
  }

  #authorizeJob(id: string, token?: string | undefined): PersistedBackgroundJob {
    const job = this.#requireJob(id);
    if (!token || token !== job.token) {
      throw new Error("invalid_job_token");
    }

    return job;
  }

  #requireJob(id: string): PersistedBackgroundJob {
    const job = this.#sessions.getBackgroundJob(id);
    if (!job) {
      throw new Error(`Unknown background job: ${id}`);
    }

    return job;
  }

  #shouldSuppressEventForFinalizedSession(job: PersistedBackgroundJob): boolean {
    const session = this.#sessions.getSessionByKey(job.sessionKey);
    if (!session || session.lastTurnSignalKind !== "final" || !session.lastTurnSignalAt) {
      return false;
    }

    return isIsoOnOrBefore(job.createdAt, session.lastTurnSignalAt);
  }
}

function resolveBackgroundJobCoordinates(options: {
  readonly platform?: ChatPlatform | undefined;
  readonly conversationId?: string | undefined;
  readonly rootMessageId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly rootThreadTs?: string | undefined;
}): BackgroundJobCoordinates {
  const platform = options.platform ?? "slack";
  const conversationId = options.conversationId ?? (platform === "slack" ? options.channelId : undefined);
  const rootMessageId = options.rootMessageId ?? (platform === "slack" ? options.rootThreadTs : undefined);

  if (!conversationId || !rootMessageId) {
    throw new Error("missing_required_body:platform,conversationId,rootMessageId");
  }

  return {
    platform,
    conversationId,
    rootMessageId
  };
}

function coordinatesForJob(job: PersistedBackgroundJob): BackgroundJobCoordinates {
  return {
    platform: job.platform ?? "slack",
    conversationId: job.conversationId ?? job.channelId,
    rootMessageId: job.rootMessageId ?? job.rootThreadTs
  };
}

function normalizeScript(script: string, shell: string): string {
  const normalized = script.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    throw new Error("Background job script was empty");
  }

  if (normalized.startsWith("#!")) {
    return `${normalized}\n`;
  }

  const interpreter = path.basename(shell) || "sh";
  const shebang = interpreter === "sh"
    ? "#!/bin/sh"
    : `#!/usr/bin/env ${interpreter}`;

  return `${shebang}\n${normalized}\n`;
}

function resolveJobCwd(workspacePath: string, cwd?: string | undefined): string {
  if (!cwd?.trim()) {
    return workspacePath;
  }

  const trimmed = cwd.trim();
  return path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(workspacePath, trimmed);
}

async function waitForChildExit(
  child: ChildProcessByStdio<null, Readable, Readable>,
  timeoutMs: number
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);

    const onExit = (): void => {
      cleanup();
      resolve(true);
    };

    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off("exit", onExit);
    };

    child.once("exit", onExit);
  });
}

function isIsoOnOrBefore(left: string, right: string): boolean {
  return Date.parse(left) <= Date.parse(right);
}
