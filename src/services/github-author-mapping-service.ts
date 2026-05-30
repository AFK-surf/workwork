import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { GitHubAuthorMappingIdentity, GitHubAuthorMappingPlatform, GitHubAuthorMappingRecord, GitHubAuthorMappingSource, SlackUserIdentity } from "../types.js";
import { ensureDir } from "../utils/fs.js";
import { inferGitHubAuthorFromSlackIdentity } from "./git/github-author-utils.js";

export class GitHubAuthorMappingService {
  readonly #rootDir: string;
  readonly #mappingsDir: string;
  #mappings = new Map<string, GitHubAuthorMappingRecord>();

  constructor(options: { readonly stateDir: string }) {
    this.#rootDir = path.join(options.stateDir, "github-author-mappings");
    this.#mappingsDir = this.#rootDir;
  }

  async load(): Promise<void> {
    await ensureDir(this.#mappingsDir);
    const entries = await fs.readdir(this.#mappingsDir, { withFileTypes: true });
    const next = new Map<string, GitHubAuthorMappingRecord>();

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const filePath = path.join(this.#mappingsDir, entry.name);
      const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as Partial<GitHubAuthorMappingRecord>;
      const normalized = normalizeMapping(raw);
      if (!normalized) {
        continue;
      }

      next.set(mappingKey(normalized.platform, normalized.userId), normalized);
    }

    this.#mappings = next;
  }

  listMappings(): GitHubAuthorMappingRecord[] {
    return [...this.#mappings.values()].sort((left, right) => {
      return String(right.updatedAt).localeCompare(String(left.updatedAt));
    });
  }

  getMapping(slackUserId: string): GitHubAuthorMappingRecord | undefined {
    return this.getMappingForUser({
      platform: "slack",
      userId: slackUserId,
    });
  }

  getMappingForUser(options: { readonly platform: GitHubAuthorMappingPlatform; readonly userId: string }): GitHubAuthorMappingRecord | undefined {
    return this.#mappings.get(mappingKey(options.platform, options.userId));
  }

  async upsertManualMapping(options: {
    readonly platform?: GitHubAuthorMappingPlatform | undefined;
    readonly userId?: string | undefined;
    readonly slackUserId?: string | undefined;
    readonly githubAuthor: string;
    readonly slackIdentity?: SlackUserIdentity | undefined;
    readonly identity?: GitHubAuthorMappingIdentity | undefined;
  }): Promise<GitHubAuthorMappingRecord> {
    const platform = options.platform ?? "slack";
    const userId = normalizeOptionalString(options.userId ?? options.slackUserId);
    if (!userId) {
      throw new Error("GitHub author mapping requires a user id");
    }

    const existing = (await this.#readRecord(platform, userId)) ?? this.#mappings.get(mappingKey(platform, userId));
    const identity = normalizeMappingIdentity(options.identity, platform) ?? slackIdentityToMappingIdentity(normalizeSlackIdentity(options.slackIdentity), platform) ?? existing?.identity ?? defaultMappingIdentity(platform, userId);

    const record = this.#buildRecord({
      platform,
      userId,
      githubAuthor: options.githubAuthor,
      source: "manual",
      identity,
    });
    await this.#writeRecord(record);
    return record;
  }

  async deleteMapping(slackUserId: string): Promise<void> {
    await this.deleteMappingForUser({
      platform: "slack",
      userId: slackUserId,
    });
  }

  async deleteMappingForUser(options: { readonly platform: GitHubAuthorMappingPlatform; readonly userId: string }): Promise<void> {
    this.#mappings.delete(mappingKey(options.platform, options.userId));
    await fs.rm(this.#recordPath(options.platform, options.userId), {
      force: true,
    });
    if (options.platform === "slack") {
      await fs.rm(this.#legacySlackRecordPath(options.userId), {
        force: true,
      });
    }
  }

  async recordObservedIdentity(identity: SlackUserIdentity): Promise<GitHubAuthorMappingRecord | null> {
    const normalizedIdentity = normalizeSlackIdentity(identity);
    if (!normalizedIdentity) {
      return null;
    }

    const inferredAuthor = inferGitHubAuthorFromSlackIdentity(normalizedIdentity);
    const existing = (await this.#readRecord("slack", normalizedIdentity.userId)) ?? this.#mappings.get(mappingKey("slack", normalizedIdentity.userId));
    const mappingIdentity = slackIdentityToMappingIdentity(normalizedIdentity, "slack")!;

    if (existing?.source === "manual") {
      if (!sameMappingIdentity(existing.identity, mappingIdentity)) {
        const updated = this.#buildRecord({
          platform: existing.platform,
          userId: existing.userId,
          githubAuthor: existing.githubAuthor,
          source: existing.source,
          identity: mappingIdentity,
        });
        await this.#writeRecord(updated);
        return updated;
      }

      return existing;
    }

    if (!inferredAuthor) {
      return existing ?? null;
    }

    if (existing && existing.source === "slack_inferred" && existing.githubAuthor === inferredAuthor && sameMappingIdentity(existing.identity, mappingIdentity)) {
      return existing;
    }

    const record = this.#buildRecord({
      platform: "slack",
      userId: normalizedIdentity.userId,
      githubAuthor: inferredAuthor,
      source: "slack_inferred",
      identity: mappingIdentity,
    });
    await this.#writeRecord(record);
    return record;
  }

  #buildRecord(options: { readonly platform: GitHubAuthorMappingPlatform; readonly userId: string; readonly githubAuthor: string; readonly source: GitHubAuthorMappingSource; readonly identity: GitHubAuthorMappingIdentity }): GitHubAuthorMappingRecord {
    const identity = {
      ...options.identity,
      platform: options.platform,
      userId: options.userId,
    };

    return {
      platform: options.platform,
      userId: options.userId,
      slackUserId: options.userId,
      githubAuthor: options.githubAuthor.trim(),
      source: options.source,
      identity,
      slackIdentity: mappingIdentityToSlackIdentity(identity),
      updatedAt: new Date().toISOString(),
    };
  }

  async #writeRecord(record: GitHubAuthorMappingRecord): Promise<void> {
    this.#mappings.set(mappingKey(record.platform, record.userId), record);
    await ensureDir(this.#mappingsDir);
    const filePath = this.#recordPath(record.platform, record.userId);
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(record, null, 2));
    await fs.rename(tempPath, filePath);
    if (record.platform === "slack") {
      await fs.rm(this.#legacySlackRecordPath(record.userId), {
        force: true,
      });
    }
  }

  async #readRecord(platform: GitHubAuthorMappingPlatform, userId: string): Promise<GitHubAuthorMappingRecord | null> {
    const paths = [this.#recordPath(platform, userId), ...(platform === "slack" ? [this.#legacySlackRecordPath(userId)] : [])];

    for (const filePath of paths) {
      try {
        const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as Partial<GitHubAuthorMappingRecord>;
        const normalized = normalizeMapping(raw);
        if (normalized) {
          this.#mappings.set(mappingKey(normalized.platform, normalized.userId), normalized);
        }
        return normalized;
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          continue;
        }
        throw error;
      }
    }

    return null;
  }

  #recordPath(platform: GitHubAuthorMappingPlatform, userId: string): string {
    return path.join(this.#mappingsDir, `${encodeKey(mappingKey(platform, userId))}.json`);
  }

  #legacySlackRecordPath(slackUserId: string): string {
    return path.join(this.#mappingsDir, `${encodeKey(slackUserId)}.json`);
  }
}

function normalizeMapping(raw: Partial<GitHubAuthorMappingRecord>): GitHubAuthorMappingRecord | null {
  const platform = normalizePlatform(raw.platform) ?? "slack";
  const rawIdentity = normalizeMappingIdentity(raw.identity, platform);
  const slackIdentity = normalizeSlackIdentity(raw.slackIdentity);
  const userId = normalizeOptionalString(raw.userId) ?? normalizeOptionalString(raw.slackUserId) ?? rawIdentity?.userId ?? slackIdentity?.userId ?? "";
  const githubAuthor = typeof raw.githubAuthor === "string" ? raw.githubAuthor.trim() : "";
  const source = raw.source === "manual" || raw.source === "slack_inferred" ? raw.source : undefined;
  const identity = rawIdentity ?? slackIdentityToMappingIdentity(slackIdentity, platform) ?? (userId ? defaultMappingIdentity(platform, userId) : null);

  if (!userId || !githubAuthor || !source || !identity) {
    return null;
  }

  return {
    platform,
    userId,
    slackUserId: userId,
    githubAuthor,
    source,
    identity,
    slackIdentity: slackIdentity ?? mappingIdentityToSlackIdentity(identity),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
  };
}

function normalizePlatform(value: unknown): GitHubAuthorMappingPlatform | undefined {
  return value === "slack" || value === "feishu" ? value : undefined;
}

function normalizeMappingIdentity(identity: GitHubAuthorMappingIdentity | null | undefined, platform: GitHubAuthorMappingPlatform): GitHubAuthorMappingIdentity | null {
  if (!identity?.userId?.trim()) {
    return null;
  }

  const userId = identity.userId.trim();
  return {
    platform,
    userId,
    mention: identity.mention?.trim() || defaultMention(platform, userId),
    username: normalizeOptionalString(identity.username),
    displayName: normalizeOptionalString(identity.displayName),
    realName: normalizeOptionalString(identity.realName),
    email: normalizeOptionalString(identity.email)?.toLowerCase(),
  };
}

function normalizeSlackIdentity(identity: SlackUserIdentity | null | undefined): SlackUserIdentity | null {
  if (!identity?.userId?.trim()) {
    return null;
  }

  return {
    userId: identity.userId.trim(),
    mention: identity.mention?.trim() || `<@${identity.userId.trim()}>`,
    username: normalizeOptionalString(identity.username),
    displayName: normalizeOptionalString(identity.displayName),
    realName: normalizeOptionalString(identity.realName),
    email: normalizeOptionalString(identity.email)?.toLowerCase(),
  };
}

function slackIdentityToMappingIdentity(identity: SlackUserIdentity | null, platform: GitHubAuthorMappingPlatform): GitHubAuthorMappingIdentity | null {
  if (!identity) {
    return null;
  }

  return {
    platform,
    userId: identity.userId,
    mention: identity.mention || defaultMention(platform, identity.userId),
    username: identity.username,
    displayName: identity.displayName,
    realName: identity.realName,
    email: identity.email,
  };
}

function mappingIdentityToSlackIdentity(identity: GitHubAuthorMappingIdentity): SlackUserIdentity {
  return {
    userId: identity.userId,
    mention: identity.platform === "slack" ? identity.mention : defaultMention("slack", identity.userId),
    username: identity.username,
    displayName: identity.displayName,
    realName: identity.realName,
    email: identity.email,
  };
}

function defaultMappingIdentity(platform: GitHubAuthorMappingPlatform, userId: string): GitHubAuthorMappingIdentity {
  return {
    platform,
    userId,
    mention: defaultMention(platform, userId),
  };
}

function defaultMention(platform: GitHubAuthorMappingPlatform, userId: string): string {
  return platform === "slack" ? `<@${userId}>` : `@${userId}`;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function sameMappingIdentity(left: GitHubAuthorMappingIdentity, right: GitHubAuthorMappingIdentity): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mappingKey(platform: GitHubAuthorMappingPlatform, userId: string): string {
  return `${platform}:${userId}`;
}

function encodeKey(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
