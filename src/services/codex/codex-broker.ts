import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import { AppServerClient } from "./app-server-client.js";
import { AppServerProcess } from "./app-server-process.js";
import type { SlackSessionRecord, SlackUserIdentity } from "../../types.js";
import type { AppServerAccountSummary, CodexInputItem, AppServerRateLimitsResponse, ReadTurnResultOptions, ReadTurnResult, StartedTurn } from "./app-server-client.js";
import { logger } from "../../logger.js";
import { getPersonalMemoryPath } from "./codex-home.js";
import { resolveFinAgentName } from "../chat/fin-agent-name.js";

export { resolveFinAgentName } from "../chat/fin-agent-name.js";

export class CodexBroker extends EventEmitter {
  readonly #defaultSlot: CodexClientSlot;
  readonly #slots = new Map<string, CodexClientSlot>();
  readonly #serviceName: string;
  readonly #brokerHttpBaseUrl: string;
  readonly #openAiApiKey?: string | undefined;
  readonly #reposRoot: string;
  readonly #codexHome: string;
  readonly #teamCodexHomePath?: string | undefined;
  readonly #hostCodexHomePath?: string | undefined;
  readonly #hostGeminiHomePath?: string | undefined;
  readonly #codexAuthJsonPath?: string | undefined;
  readonly #codexDisabledMcpServers: string[];
  readonly #tempadLinkServiceUrl?: string | undefined;
  readonly #geminiHttpProxy?: string | undefined;
  readonly #geminiHttpsProxy?: string | undefined;
  readonly #geminiAllProxy?: string | undefined;
  readonly #codexAppServerUrl?: string | undefined;
  readonly #fin?: CodexBrokerFinOptions | undefined;
  #slackBotIdentity: SlackUserIdentity | null = null;
  #nextPort: number;

  constructor(options: {
    readonly serviceName: string;
    readonly brokerHttpBaseUrl: string;
    readonly codexHome: string;
    readonly teamCodexHomePath?: string | undefined;
    readonly reposRoot: string;
    readonly hostCodexHomePath?: string | undefined;
    readonly hostGeminiHomePath?: string | undefined;
    readonly codexAppServerPort: number;
    readonly codexAppServerUrl?: string | undefined;
    readonly codexAuthJsonPath?: string | undefined;
    readonly codexDisabledMcpServers: string[];
    readonly tempadLinkServiceUrl?: string | undefined;
    readonly geminiHttpProxy?: string | undefined;
    readonly geminiHttpsProxy?: string | undefined;
    readonly geminiAllProxy?: string | undefined;
    readonly openAiApiKey?: string | undefined;
    readonly fin?: CodexBrokerFinOptions | undefined;
  }) {
    super();
    this.#serviceName = options.serviceName;
    this.#brokerHttpBaseUrl = options.brokerHttpBaseUrl;
    this.#openAiApiKey = options.openAiApiKey;
    this.#codexAppServerUrl = options.codexAppServerUrl;
    this.#reposRoot = options.reposRoot;
    this.#codexHome = options.codexHome;
    this.#teamCodexHomePath = options.teamCodexHomePath;
    this.#hostCodexHomePath = options.hostCodexHomePath;
    this.#hostGeminiHomePath = options.hostGeminiHomePath;
    this.#codexAuthJsonPath = options.codexAuthJsonPath;
    this.#codexDisabledMcpServers = options.codexDisabledMcpServers;
    this.#tempadLinkServiceUrl = options.tempadLinkServiceUrl;
    this.#geminiHttpProxy = options.geminiHttpProxy;
    this.#geminiHttpsProxy = options.geminiHttpsProxy;
    this.#geminiAllProxy = options.geminiAllProxy;
    this.#fin = options.fin;
    this.#nextPort = options.codexAppServerPort + (options.codexAppServerUrl ? 0 : 1);
    this.#defaultSlot = this.#createSlot({
      key: "default",
      port: options.codexAppServerPort,
      codexHome: options.codexHome,
      codexAppServerUrl: options.codexAppServerUrl,
      finAgentName: options.fin ? "broker_admin" : undefined,
      finDescription: "Broker admin Codex app-server",
    });
  }

  get client(): AppServerClient {
    return this.#defaultSlot.client;
  }

  async start(): Promise<void> {
    this.#defaultSlot.stopping = false;
    if (this.#fin) {
      return;
    }
    await this.#queueConnectClient(this.#defaultSlot, {
      restartProcess: true,
    });
  }

  async stop(): Promise<void> {
    const slots = [this.#defaultSlot, ...this.#slots.values()];
    this.#slots.clear();
    await Promise.all(
      slots.map(async (slot) => {
        slot.stopping = true;
        await slot.client.close().catch(() => {});
        await slot.appServerProcess?.stop().catch(() => {});
      }),
    );
  }

  setSlackBotIdentity(identity: SlackUserIdentity | null): void {
    this.#slackBotIdentity = identity;
    this.#defaultSlot.client.setSlackBotIdentity(identity);
    for (const slot of this.#slots.values()) {
      slot.client.setSlackBotIdentity(identity);
    }
  }

  async ensureThread(session: SlackSessionRecord): Promise<string> {
    const slot = this.#slotForSession(session);
    if (session.agentSessionId && slot.loadedThreadIds.has(session.agentSessionId)) {
      return session.agentSessionId;
    }

    const threadId = await this.#withRecovery(slot, () => slot.client.ensureThread(session));
    slot.loadedThreadIds.add(threadId);
    return threadId;
  }

  async startTurn(session: SlackSessionRecord, input: readonly CodexInputItem[]): Promise<StartedTurn> {
    if (!session.agentSessionId) {
      throw new Error(`Session ${session.key} has no Codex thread id`);
    }

    const slot = this.#slotForSession(session);
    return await this.#withRecovery(slot, () => slot.client.startTurn(session.agentSessionId!, session.workspacePath, input));
  }

  async steer(session: SlackSessionRecord, input: readonly CodexInputItem[]): Promise<void> {
    if (!session.agentSessionId || !session.activeTurnId) {
      throw new Error(`Session ${session.key} has no active Codex turn to steer`);
    }

    const slot = this.#slotForSession(session);
    await this.#withRecovery(slot, () =>
      slot.client.steerTurn({
        threadId: session.agentSessionId!,
        turnId: session.activeTurnId!,
        input,
      }),
    );
  }

  async interrupt(session: SlackSessionRecord): Promise<void> {
    if (!session.agentSessionId || !session.activeTurnId) {
      return;
    }

    const slot = this.#slotForSession(session);
    await this.#withRecovery(slot, () => slot.client.interruptTurn(session.agentSessionId!, session.activeTurnId!));
  }

  async readTurnResult(session: SlackSessionRecord, turnId: string, options?: ReadTurnResultOptions): Promise<ReadTurnResult | null> {
    if (!session.agentSessionId) {
      return null;
    }

    const slot = this.#slotForSession(session);
    return await this.#withRecovery(slot, () => slot.client.readTurnResult(session.agentSessionId!, turnId, options));
  }

  async readAccountSummary(refreshToken = false): Promise<AppServerAccountSummary> {
    return await this.#withRecovery(this.#defaultSlot, () => this.#defaultSlot.client.readAccountSummary(refreshToken));
  }

  async readAccountRateLimits(): Promise<AppServerRateLimitsResponse> {
    return await this.#withRecovery(this.#defaultSlot, () => this.#defaultSlot.client.readAccountRateLimits());
  }

  async restartRuntime(reason = "admin runtime restart"): Promise<void> {
    for (const slot of [this.#defaultSlot, ...this.#slots.values()]) {
      await this.#queueConnectClient(slot, {
        restartProcess: true,
        reason,
      });
    }
  }

  #createClient(slot: CodexClientSlot, url: string): AppServerClient {
    const client = new AppServerClient({
      url,
      serviceName: this.#serviceName,
      brokerHttpBaseUrl: this.#brokerHttpBaseUrl,
      openAiApiKey: this.#openAiApiKey,
      personalMemoryFilePath: slot.personalMemoryFilePath,
      reposRoot: this.#reposRoot,
      codexGeneratedImagesRoot: slot.codexGeneratedImagesRoot,
      finAgentName: slot.agentName,
      finDir: this.#fin?.finDir,
    });
    client.setSlackBotIdentity(this.#slackBotIdentity);
    return client;
  }

  #bindClient(slot: CodexClientSlot, client: AppServerClient): void {
    client.on("notification", (method, params) => {
      if (client !== slot.client) {
        return;
      }
      this.emit("notification", method, params);
    });

    client.on("disconnected", (error) => {
      if (slot.ignoredDisconnectClients.has(client)) {
        return;
      }

      if (client !== slot.client) {
        return;
      }

      slot.loadedThreadIds.clear();
      if (slot.stopping) {
        return;
      }

      this.#handleClientDisconnect(slot, error instanceof Error ? error : new Error(String(error)));
    });
  }

  #handleClientDisconnect(slot: CodexClientSlot, error: Error): void {
    void this.#recoverClient(slot, error);
  }

  async #withRecovery<T>(slot: CodexClientSlot, operation: () => Promise<T>): Promise<T> {
    await this.#ensureConnected(slot);

    try {
      return await operation();
    } catch (error) {
      if (!isRecoverableCodexConnectionError(error)) {
        throw error;
      }

      await this.#recoverClient(slot, error instanceof Error ? error : new Error(String(error)));
      return await operation();
    }
  }

  async #ensureConnected(slot: CodexClientSlot): Promise<void> {
    if (slot.client.isConnected()) {
      return;
    }

    await this.#recoverClient(slot, new Error("Codex app-server websocket is not connected"));
  }

  async #recoverClient(slot: CodexClientSlot, error: Error): Promise<void> {
    if (!slot.reconnectPromise) {
      logger.warn("Recovering Codex app-server client", {
        slot: slot.key,
        agentName: slot.agentName ?? null,
        reason: error.message,
      });
      slot.reconnectPromise = (async () => {
        try {
          await this.#queueConnectClient(slot, {
            restartProcess: Boolean(slot.appServerProcess && !slot.connectedOnce),
            reason: error.message,
          });
        } catch (reconnectError) {
          logger.warn("Reconnect to existing Codex app-server failed; restarting process", {
            reason: error.message,
            reconnectError: reconnectError instanceof Error ? reconnectError.message : String(reconnectError),
          });
          await this.#queueConnectClient(slot, {
            restartProcess: true,
            reason: error.message,
          });
        }
      })().finally(() => {
        slot.reconnectPromise = undefined;
      });
    }

    await slot.reconnectPromise;
  }

  async #queueConnectClient(slot: CodexClientSlot, options: { readonly restartProcess: boolean; readonly reason?: string | undefined }): Promise<void> {
    const run = slot.connectQueue
      .catch(() => {})
      .then(async () => {
        await this.#performConnectClient(slot, options);
      });
    slot.connectQueue = run.catch(() => {});
    await run;
  }

  async #performConnectClient(slot: CodexClientSlot, options: { readonly restartProcess: boolean; readonly reason?: string | undefined }): Promise<void> {
    slot.loadedThreadIds.clear();
    logger.info("Connecting Codex app-server client", {
      slot: slot.key,
      agentName: slot.agentName ?? null,
      restartProcess: options.restartProcess,
      reason: options.reason ?? null,
    });

    await this.#retireCurrentClient(slot);

    if (options.restartProcess) {
      if (slot.appServerProcess) {
        await slot.appServerProcess.restart();
      }
    } else {
      await slot.appServerProcess?.start();
    }

    const nextClient = this.#createClient(slot, slot.appServerProcess?.url ?? slot.codexAppServerUrl!);
    slot.client = nextClient;
    this.#bindClient(slot, nextClient);
    await nextClient.connect();
    await nextClient.ensureAuthenticated();
    slot.connectedOnce = true;
    logger.info("Codex app-server client connected", {
      slot: slot.key,
      agentName: slot.agentName ?? null,
      url: slot.appServerProcess?.url ?? slot.codexAppServerUrl ?? null,
    });
  }

  async #retireCurrentClient(slot: CodexClientSlot): Promise<void> {
    const previousClient = slot.client;
    if (!previousClient) {
      return;
    }

    slot.ignoredDisconnectClients.add(previousClient);
    try {
      await previousClient.close();
    } catch (error) {
      logger.warn("Failed to close previous Codex app-server client during reconnect", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #slotForSession(session: SlackSessionRecord): CodexClientSlot {
    if (!this.#fin || this.#codexAppServerUrl) {
      return this.#defaultSlot;
    }

    const agentName = resolveFinAgentName(session);
    const existing = this.#slots.get(agentName);
    if (existing) {
      return existing;
    }

    const slot = this.#createSlot({
      key: agentName,
      port: this.#allocatePort(),
      codexHome: path.join(this.#codexHome, "fin-agents", agentName),
      finAgentName: agentName,
      finDescription: describeFinAgent(session),
    });
    this.#slots.set(agentName, slot);
    logger.info("Created Fin Codex app-server slot", {
      agentName,
      platform: session.platform ?? "slack",
      conversationId: session.conversationId ?? session.channelId,
      port: slot.port,
    });
    return slot;
  }

  #createSlot(options: { readonly key: string; readonly port: number; readonly codexHome: string; readonly codexAppServerUrl?: string | undefined; readonly finAgentName?: string | undefined; readonly finDescription?: string | undefined }): CodexClientSlot {
    const appServerProcess = options.codexAppServerUrl
      ? undefined
      : new AppServerProcess({
          brokerHttpBaseUrl: this.#brokerHttpBaseUrl,
          codexHome: options.codexHome,
          teamCodexHomePath: this.#teamCodexHomePath,
          hostCodexHomePath: this.#hostCodexHomePath,
          hostGeminiHomePath: this.#hostGeminiHomePath,
          port: options.port,
          authJsonPath: this.#codexAuthJsonPath,
          disabledMcpServers: this.#codexDisabledMcpServers,
          tempadLinkServiceUrl: this.#tempadLinkServiceUrl,
          geminiHttpProxy: this.#geminiHttpProxy,
          geminiHttpsProxy: this.#geminiHttpsProxy,
          geminiAllProxy: this.#geminiAllProxy,
          openAiApiKey: this.#openAiApiKey,
          fin:
            this.#fin && options.finAgentName
              ? {
                  supervisorPath: this.#fin.supervisorPath,
                  finDir: this.#fin.finDir,
                  agentName: options.finAgentName,
                  description: options.finDescription ?? `Codex agent ${options.finAgentName}`,
                  disableSandbox: this.#fin.disableSandbox,
                }
              : undefined,
        });
    const slot: CodexClientSlot = {
      key: options.key,
      agentName: options.finAgentName,
      port: options.port,
      appServerProcess,
      codexAppServerUrl: options.codexAppServerUrl,
      codexHome: options.codexHome,
      personalMemoryFilePath: choosePersonalMemoryFilePath({
        codexHome: options.codexHome,
        teamCodexHomePath: this.#teamCodexHomePath,
      }),
      codexGeneratedImagesRoot: path.join(options.codexHome, "generated_images"),
      loadedThreadIds: new Set(),
      reconnectPromise: undefined,
      connectQueue: Promise.resolve(),
      stopping: false,
      connectedOnce: false,
      ignoredDisconnectClients: new WeakSet(),
      client: undefined as unknown as AppServerClient,
    };
    slot.client = this.#createClient(slot, appServerProcess?.url ?? options.codexAppServerUrl!);
    this.#bindClient(slot, slot.client);
    return slot;
  }

  #allocatePort(): number {
    const port = this.#nextPort;
    this.#nextPort += 1;
    return port;
  }
}

export interface CodexBrokerFinOptions {
  readonly supervisorPath: string;
  readonly finDir?: string | undefined;
  readonly disableSandbox: boolean;
}

interface CodexClientSlot {
  readonly key: string;
  readonly agentName?: string | undefined;
  readonly port: number;
  readonly appServerProcess?: AppServerProcess | undefined;
  readonly codexAppServerUrl?: string | undefined;
  readonly codexHome: string;
  readonly personalMemoryFilePath: string;
  readonly codexGeneratedImagesRoot: string;
  readonly loadedThreadIds: Set<string>;
  reconnectPromise: Promise<void> | undefined;
  connectQueue: Promise<void>;
  stopping: boolean;
  connectedOnce: boolean;
  readonly ignoredDisconnectClients: WeakSet<AppServerClient>;
  client: AppServerClient;
}

function choosePersonalMemoryFilePath(options: { readonly codexHome: string; readonly teamCodexHomePath?: string | undefined }): string {
  if (!options.teamCodexHomePath) {
    return getPersonalMemoryPath(options.codexHome);
  }

  const teamMemoryPath = getPersonalMemoryPath(options.codexHome, {
    teamCodexHomePath: options.teamCodexHomePath,
  });
  const teamMemory = fs.existsSync(teamMemoryPath) ? fs.readFileSync(teamMemoryPath, "utf8").trim() : "";
  return teamMemory ? teamMemoryPath : getPersonalMemoryPath(options.codexHome);
}

function describeFinAgent(session: SlackSessionRecord): string {
  const platform = session.platform ?? "slack";
  const conversationId = session.conversationId ?? session.channelId;
  const kind = session.conversationKind ?? session.channelType ?? "conversation";
  return `Codex agent for ${platform} ${kind} ${conversationId}`;
}

export function isRecoverableCodexConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return ["Codex app-server websocket is not connected", "WebSocket is not open", "readyState 3", "socket hang up", "ECONNREFUSED", "EPIPE", "closed"].some((pattern) => message.includes(pattern));
}
