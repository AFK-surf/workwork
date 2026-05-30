import { afterEach, describe, expect, it } from "vitest";

import { AppServerClient } from "../src/services/codex/app-server-client.js";
import { MockCodexAppServer } from "./helpers/mock-codex-app-server.js";

describe("MockCodexAppServer", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      await cleanup?.();
    }
  });

  it("records callback failures as failed turns instead of leaking unhandled rejections", async () => {
    const mockServer = new MockCodexAppServer({
      onTurnStart: async () => {
        throw new Error("callback boom");
      },
    });
    const url = await mockServer.start();
    cleanups.push(() => mockServer.stop());

    const client = new AppServerClient({
      url,
      serviceName: "test",
      brokerHttpBaseUrl: "http://127.0.0.1:3000",
      reposRoot: "/tmp/repos",
    });
    await client.connect();
    cleanups.push(() => client.close());

    const startedThread = (await client.request("thread/start", { cwd: "/tmp" })) as {
      readonly thread: { readonly id: string };
    };
    const startedTurn = await client.startTurn(startedThread.thread.id, "/tmp", [{ type: "text", text: "hello", text_elements: [] }]);

    const snapshot = await waitForTurnSnapshot(async () => {
      const result = await client.readTurnResult(startedThread.thread.id, startedTurn.turnId, {
        syncActiveTurn: true,
      });
      return result?.status === "failed" ? result : null;
    });

    expect(snapshot.errorMessage).toBe("callback boom");
    await expect(startedTurn.completion).rejects.toThrow("callback boom");
  });
});

async function waitForTurnSnapshot<T>(read: () => Promise<T | null>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const snapshot = await read();
    if (snapshot) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Timed out waiting for turn snapshot");
}
