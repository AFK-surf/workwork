import http from "node:http";

import fs from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

import { stableSessionOrder } from "../src/admin-ui/session-order.js";

import { renderAdminPage } from "../src/http/admin-page.js";

import { deferUntilResponseFinished } from "../src/http/response-deferred-tasks.js";

import { createHttpHandler } from "../src/http/router.js";

export async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
