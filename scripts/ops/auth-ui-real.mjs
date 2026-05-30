#!/usr/bin/env node

import { createServer } from "node:http";

import fs from "node:fs/promises";

import os from "node:os";

import path from "node:path";

import { spawn } from "node:child_process";

import { getAuthRealStatus, replaceAuthInRealContainer } from "./auth-real-lib.mjs";
import { renderPage } from "./auth-ui-page.mjs";

function parseArgs(argv) {
  const options = {
    containerName: "slack-codex-broker-real",
    port: 3071,
    openBrowser: true,
    openInboundLimit: 20,
    logLineLimit: 20,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      continue;
    }

    switch (argument) {
      case "--container":
        options.containerName = argv[index + 1];
        index += 1;
        break;
      case "--port":
        options.port = Number(argv[index + 1]);
        index += 1;
        break;
      case "--open-inbound-limit":
        options.openInboundLimit = Number(argv[index + 1]);
        index += 1;
        break;
      case "--log-lines":
        options.logLineLimit = Number(argv[index + 1]);
        index += 1;
        break;
      case "--no-open":
        options.openBrowser = false;
        break;
      case "--help":
      case "-h":
        console.log("Usage: node scripts/ops/auth-ui-real.mjs [--container <name>] [--port <n>] [--open-inbound-limit <n>] [--log-lines <n>] [--no-open]");
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!Number.isFinite(options.port) || options.port < 1) {
    throw new Error("--port must be a positive number");
  }

  return options;
}

function json(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function html(response, body) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function notFound(response) {
  response.writeHead(404, {
    "content-type": "text/plain; charset=utf-8",
  });
  response.end("Not found\n");
}

async function requestToFormData(request, url) {
  const webRequest = new Request(url, {
    method: request.method,
    headers: request.headers,
    body: request,
    duplex: "half",
  });
  return webRequest.formData();
}

async function saveUploadedFile(tempDir, file) {
  if (!file || typeof file.arrayBuffer !== "function" || file.size === 0) {
    return undefined;
  }
  const target = path.join(tempDir, file.name || "upload.bin");
  const buffer = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(target, buffer);
  return target;
}

function maybeOpenBrowser(url) {
  try {
    if (process.platform === "darwin") {
      const child = spawn("open", [url], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    }
  } catch {}
}

const options = parseArgs(process.argv.slice(2));

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${options.port}`);

    if (request.method === "GET" && url.pathname === "/") {
      html(response, renderPage(options));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      json(
        response,
        200,
        await getAuthRealStatus({
          containerName: options.containerName,
          openInboundLimit: options.openInboundLimit,
          logLineLimit: options.logLineLimit,
        }),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/replace-auth") {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-auth-ui-"));
      try {
        const form = await requestToFormData(request, url.toString());
        const authJsonFile = form.get("authJson");
        const credentialsJsonFile = form.get("credentialsJson");
        const configTomlFile = form.get("configToml");
        const allowActive = form.get("allowActive") === "on";

        const authJsonPath = await saveUploadedFile(tempDir, authJsonFile);
        if (!authJsonPath) {
          json(response, 400, {
            ok: false,
            error: "auth.json is required",
          });
          return;
        }

        const credentialsJsonPath = await saveUploadedFile(tempDir, credentialsJsonFile);
        const configTomlPath = await saveUploadedFile(tempDir, configTomlFile);

        const result = await replaceAuthInRealContainer({
          containerName: options.containerName,
          authJsonPath,
          credentialsJsonPath,
          configTomlPath,
          restart: true,
          allowActive,
        });
        json(response, 200, result);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
      return;
    }

    notFound(response);
  } catch (error) {
    json(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(options.port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${options.port}`;
  console.log(`Broker auth admin listening on ${url}`);
  if (options.openBrowser) {
    maybeOpenBrowser(url);
  }
});
