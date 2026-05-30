import http from "node:http";
import vm from "node:vm";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createHttpHandler } from "../src/http/router.js";

describe("admin routes", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("requires the configured admin token for admin api requests", async () => {
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      BROKER_ADMIN_TOKEN: "secret-token"
    } as NodeJS.ProcessEnv);
    const adminService = {
      getStatus: async () => ({ ok: true, status: "admin-ok" }),
      addAuthProfile: async () => ({ ok: true }),
      upsertGitHubAuthorMapping: async () => ({ ok: true }),
      deleteGitHubAuthorMapping: async () => ({ ok: true }),
      deleteAuthProfile: async () => ({ ok: true }),
      activateAuthProfile: async () => ({ ok: true }),
      deployWorker: async () => ({ ok: true }),
      rollbackWorker: async () => ({ ok: true })
    };

    const server = http.createServer(
      createHttpHandler({
        adminService: adminService as never,
        bridge: {} as never,
        isolatedMcp: {} as never,
        jobManager: {} as never,
        config
      })
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start test server");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const unauthorized = await fetch(`${baseUrl}/admin/api/status`);
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${baseUrl}/admin/api/status`, {
      headers: {
        "x-admin-token": "secret-token"
      }
    });
    expect(authorized.status).toBe(200);
    await expect(authorized.json()).resolves.toMatchObject({
      ok: true,
      status: "admin-ok"
    });
  });

  it("renders auth profile management and session console sections in the admin page", async () => {
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test"
    } as NodeJS.ProcessEnv);
    const adminService = {
      getStatus: async () => ({ ok: true, status: "admin-ok" }),
      addAuthProfile: async () => ({ ok: true }),
      upsertGitHubAuthorMapping: async () => ({ ok: true }),
      deleteGitHubAuthorMapping: async () => ({ ok: true }),
      deleteAuthProfile: async () => ({ ok: true }),
      activateAuthProfile: async () => ({ ok: true }),
      deployWorker: async () => ({ ok: true }),
      rollbackWorker: async () => ({ ok: true })
    };

    const server = http.createServer(
      createHttpHandler({
        adminService: adminService as never,
        bridge: {} as never,
        isolatedMcp: {} as never,
        jobManager: {} as never,
        config
      })
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start test server");
    }

    const page = await fetch(`http://127.0.0.1:${address.port}/admin`);
    expect(page.status).toBe(200);
    const html = await page.text();

    expect(html).toContain("open-add-profile-dialog");
    expect(html).toContain("auth-profiles-panel");
    expect(html).toContain("Auth Profiles");
    expect(html).toContain("github-authors-panel");
    expect(html).toContain("GitHub Authors");
    expect(html).toContain("Deploy");
    expect(html).toContain("deploy-release-button");
    expect(html).toContain("Runtime Info");
    expect(html).toContain("add-profile-dialog");
    expect(html).toContain("session-search");
    expect(html).toContain("value=\"platform:slack\"");
    expect(html).toContain("value=\"platform:feishu\"");
    expect(html).toContain("System Logs");
    expect(html).not.toContain("profile-name-input");
    expect(html).not.toContain("Account Quota");
    expect(html).not.toContain("Control");
    expect(html).not.toContain("ADMIN TOKEN");
    expect(html).not.toContain("/admin/api/runtime-files");
  });

  it("passes platform filters to the admin status service", async () => {
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test",
      BROKER_ADMIN_TOKEN: "secret-token"
    } as NodeJS.ProcessEnv);
    const calls: unknown[] = [];
    const adminService = {
      getStatus: async (options: unknown) => {
        calls.push(options);
        return {
          ok: true,
          state: {
            platform: "feishu",
            sessionCount: 0
          }
        };
      },
      addAuthProfile: async () => ({ ok: true }),
      upsertGitHubAuthorMapping: async () => ({ ok: true }),
      deleteGitHubAuthorMapping: async () => ({ ok: true }),
      deleteAuthProfile: async () => ({ ok: true }),
      activateAuthProfile: async () => ({ ok: true }),
      deployWorker: async () => ({ ok: true }),
      rollbackWorker: async () => ({ ok: true })
    };

    const server = http.createServer(
      createHttpHandler({
        adminService: adminService as never,
        bridge: {} as never,
        isolatedMcp: {} as never,
        jobManager: {} as never,
        config
      })
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start test server");
    }
    const response = await fetch(`http://127.0.0.1:${address.port}/admin/api/status?platform=feishu`, {
      headers: {
        "x-admin-token": "secret-token"
      }
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      state: {
        platform: "feishu"
      }
    });
    expect(calls).toEqual([{ platform: "feishu" }]);

    const invalid = await fetch(`http://127.0.0.1:${address.port}/admin/api/status?platform=lark`, {
      headers: {
        "x-admin-token": "secret-token"
      }
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      ok: false,
      error: "invalid_platform",
      allowed: ["slack", "feishu"]
    });
    expect(calls).toEqual([{ platform: "feishu" }]);
  });

  it("accepts auth profile creation without an explicit name", async () => {
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test"
    } as NodeJS.ProcessEnv);
    const calls: Array<Record<string, unknown>> = [];
    const adminService = {
      getStatus: async () => ({ ok: true, status: "admin-ok" }),
      addAuthProfile: async (payload: Record<string, unknown>) => {
        calls.push(payload);
        return { ok: true, status: { ok: true } };
      },
      upsertGitHubAuthorMapping: async () => ({ ok: true }),
      deleteGitHubAuthorMapping: async () => ({ ok: true }),
      deleteAuthProfile: async () => ({ ok: true }),
      activateAuthProfile: async () => ({ ok: true }),
      deployWorker: async () => ({ ok: true }),
      rollbackWorker: async () => ({ ok: true })
    };

    const server = http.createServer(
      createHttpHandler({
        adminService: adminService as never,
        bridge: {} as never,
        isolatedMcp: {} as never,
        jobManager: {} as never,
        config
      })
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start test server");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/admin/api/auth-profiles`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        auth_json_content: "{\"tokens\":{\"account_id\":\"acc-1\"}}"
      })
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        name: undefined,
        authJsonContent: "{\"tokens\":{\"account_id\":\"acc-1\"}}"
      }
    ]);
  });

  it("forwards GitHub author mapping upserts to the admin service", async () => {
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test"
    } as NodeJS.ProcessEnv);
    const calls: Array<Record<string, unknown>> = [];
    const adminService = {
      getStatus: async () => ({ ok: true }),
      addAuthProfile: async () => ({ ok: true }),
      upsertGitHubAuthorMapping: async (payload: Record<string, unknown>) => {
        calls.push(payload);
        return { ok: true, status: { ok: true } };
      },
      deleteGitHubAuthorMapping: async () => ({ ok: true }),
      deleteAuthProfile: async () => ({ ok: true }),
      activateAuthProfile: async () => ({ ok: true }),
      deployWorker: async () => ({ ok: true }),
      rollbackWorker: async () => ({ ok: true })
    };

    const server = http.createServer(
      createHttpHandler({
        adminService: adminService as never,
        bridge: {} as never,
        isolatedMcp: {} as never,
        jobManager: {} as never,
        config
      })
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start test server");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/admin/api/github-authors`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        slack_user_id: "U123",
        github_author: "Alice Example <alice@example.com>"
      })
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        slackUserId: "U123",
        githubAuthor: "Alice Example <alice@example.com>"
      }
    ]);

    const feishuResponse = await fetch(`http://127.0.0.1:${address.port}/admin/api/github-authors`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        platform: "feishu",
        user_id: "ou_123",
        github_author: "Feishu User <feishu@example.com>"
      })
    });
    expect(feishuResponse.status).toBe(200);
    expect(calls).toEqual([
      {
        slackUserId: "U123",
        githubAuthor: "Alice Example <alice@example.com>"
      },
      {
        platform: "feishu",
        userId: "ou_123",
        slackUserId: "ou_123",
        githubAuthor: "Feishu User <feishu@example.com>"
      }
    ]);

    const invalidPlatformResponse = await fetch(`http://127.0.0.1:${address.port}/admin/api/github-authors`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        platform: "lark",
        user_id: "ou_ignored",
        github_author: "Ignored User <ignored@example.com>"
      })
    });
    expect(invalidPlatformResponse.status).toBe(400);
    await expect(invalidPlatformResponse.json()).resolves.toMatchObject({
      ok: false,
      error: "invalid_platform",
      allowed: ["slack", "feishu"]
    });

    const nonStringPlatformResponse = await fetch(`http://127.0.0.1:${address.port}/admin/api/github-authors`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        platform: 123,
        user_id: "ou_number",
        github_author: "Numeric Platform <numeric@example.com>"
      })
    });
    expect(nonStringPlatformResponse.status).toBe(400);
    await expect(nonStringPlatformResponse.json()).resolves.toMatchObject({
      ok: false,
      error: "invalid_platform",
      allowed: ["slack", "feishu"]
    });
    expect(calls).toEqual([
      {
        slackUserId: "U123",
        githubAuthor: "Alice Example <alice@example.com>"
      },
      {
        platform: "feishu",
        userId: "ou_123",
        slackUserId: "ou_123",
        githubAuthor: "Feishu User <feishu@example.com>"
      }
    ]);
  });

  it("forwards platform-aware GitHub author mapping deletes to the admin service", async () => {
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test"
    } as NodeJS.ProcessEnv);
    const calls: Array<Record<string, unknown>> = [];
    const adminService = {
      getStatus: async () => ({ ok: true }),
      addAuthProfile: async () => ({ ok: true }),
      upsertGitHubAuthorMapping: async () => ({ ok: true }),
      deleteGitHubAuthorMapping: async (payload: Record<string, unknown>) => {
        calls.push(payload);
        return { ok: true, status: { ok: true } };
      },
      deleteAuthProfile: async () => ({ ok: true }),
      activateAuthProfile: async () => ({ ok: true }),
      deployWorker: async () => ({ ok: true }),
      rollbackWorker: async () => ({ ok: true })
    };

    const server = http.createServer(
      createHttpHandler({
        adminService: adminService as never,
        bridge: {} as never,
        isolatedMcp: {} as never,
        jobManager: {} as never,
        config
      })
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start test server");
    }

    const response = await fetch(
      `http://127.0.0.1:${address.port}/admin/api/github-authors/${encodeURIComponent("ou_123")}?platform=feishu`,
      {
        method: "DELETE"
      }
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        platform: "feishu",
        slackUserId: "ou_123"
      }
    ]);

    const invalidPlatformResponse = await fetch(
      `http://127.0.0.1:${address.port}/admin/api/github-authors/${encodeURIComponent("ou_ignored")}?platform=lark`,
      {
        method: "DELETE"
      }
    );
    expect(invalidPlatformResponse.status).toBe(400);
    await expect(invalidPlatformResponse.json()).resolves.toMatchObject({
      ok: false,
      error: "invalid_platform",
      allowed: ["slack", "feishu"]
    });
    expect(calls).toEqual([
      {
        platform: "feishu",
        slackUserId: "ou_123"
      }
    ]);
  });

  it("emits admin page inline script without syntax errors", async () => {
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test"
    } as NodeJS.ProcessEnv);
    const adminService = {
      getStatus: async () => ({ ok: true, status: "admin-ok" }),
      addAuthProfile: async () => ({ ok: true }),
      upsertGitHubAuthorMapping: async () => ({ ok: true }),
      deleteGitHubAuthorMapping: async () => ({ ok: true }),
      deleteAuthProfile: async () => ({ ok: true }),
      activateAuthProfile: async () => ({ ok: true }),
      deployWorker: async () => ({ ok: true }),
      rollbackWorker: async () => ({ ok: true })
    };

    const server = http.createServer(
      createHttpHandler({
        adminService: adminService as never,
        bridge: {} as never,
        isolatedMcp: {} as never,
        jobManager: {} as never,
        config
      })
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start test server");
    }

    const page = await fetch(`http://127.0.0.1:${address.port}/admin`);
    const html = await page.text();
    const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
    expect(scriptMatch?.[1]).toBeTruthy();
    const scriptSource = scriptMatch?.[1];
    if (!scriptSource) {
      throw new Error("missing admin inline script");
    }
    expect(() => new vm.Script(scriptSource)).not.toThrow();
  });

  it("forwards deploy requests to the admin service", async () => {
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test"
    } as NodeJS.ProcessEnv);
    const calls: Array<Record<string, unknown>> = [];
    const adminService = {
      getStatus: async () => ({ ok: true }),
      addAuthProfile: async () => ({ ok: true }),
      upsertGitHubAuthorMapping: async () => ({ ok: true }),
      deleteGitHubAuthorMapping: async () => ({ ok: true }),
      deleteAuthProfile: async () => ({ ok: true }),
      activateAuthProfile: async () => ({ ok: true }),
      deployWorker: async (payload: Record<string, unknown>) => {
        calls.push(payload);
        return { ok: true };
      },
      rollbackWorker: async () => ({ ok: true })
    };

    const server = http.createServer(
      createHttpHandler({
        adminService: adminService as never,
        config
      })
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start test server");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/admin/api/deploy`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ref: "deadbeef",
        allow_active: true
      })
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        ref: "deadbeef",
        allowActive: true
      }
    ]);
  });

  it("forwards rollback requests to the admin service", async () => {
    const config = loadConfig({
      SLACK_APP_TOKEN: "xapp-test",
      SLACK_BOT_TOKEN: "xoxb-test"
    } as NodeJS.ProcessEnv);
    const calls: Array<Record<string, unknown>> = [];
    const adminService = {
      getStatus: async () => ({ ok: true }),
      addAuthProfile: async () => ({ ok: true }),
      upsertGitHubAuthorMapping: async () => ({ ok: true }),
      deleteGitHubAuthorMapping: async () => ({ ok: true }),
      deleteAuthProfile: async () => ({ ok: true }),
      activateAuthProfile: async () => ({ ok: true }),
      deployWorker: async () => ({ ok: true }),
      rollbackWorker: async (payload: Record<string, unknown>) => {
        calls.push(payload);
        return { ok: true };
      }
    };

    const server = http.createServer(
      createHttpHandler({
        adminService: adminService as never,
        config
      })
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start test server");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/admin/api/rollback`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ref: "abc123",
        allow_active: false
      })
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        ref: "abc123",
        allowActive: false
      }
    ]);
  });
});
