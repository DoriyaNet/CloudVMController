import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createRequestHandler } from "../server/app.js";
import { AuthError } from "../server/auth/errors.js";
import { SettingsStoreCore } from "../server/settings-core.js";
import { createMockLinode } from "./helpers/mock-linode.js";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address();
}

async function startStack() {
  const mock = await createMockLinode();
  const localStore = new SettingsStoreCore({ envToken: mock.token });
  const vaultStore = new SettingsStoreCore();
  await vaultStore.addToken({
    label: "Vault token",
    token: mock.altToken,
  });

  const auth = {
    enabled: true,
    async handle(request, response, url) {
      if (url.pathname !== "/api/session") {
        return false;
      }
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          mode: "github",
          configured: true,
          authenticated: request.headers["x-test-auth"] === "1",
          vault: { unlocked: request.headers["x-test-auth"] === "1" },
        }),
      );
      return true;
    },
    async resolve(request) {
      if (request.headers["x-test-auth"] !== "1") {
        throw new AuthError(
          401,
          "not_authenticated",
          "GitHub sign-in is required.",
        );
      }
      return {
        settingsStore: vaultStore,
        session: { user: { id: 1, login: "octocat" } },
        vault: { unlocked: true },
      };
    },
  };

  const handler = createRequestHandler({
    settingsStore: localStore,
    auth,
    apiBase: mock.apiBase,
    logger: { info() {}, error() {} },
  });
  const server = http.createServer(handler);
  const address = await listen(server);

  return {
    mock,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await mock.close();
    },
  };
}

test("blocks protected API routes until auth.resolve succeeds", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());

  const response = await fetch(`${stack.baseUrl}/api/overview`);
  const payload = await response.json();

  assert.equal(response.status, 401);
  assert.equal(payload.code, "not_authenticated");
  assert.equal(
    stack.mock.requests.some((request) =>
      String(request.headers.authorization || "").includes(
        stack.mock.token,
      ),
    ),
    false,
  );
});

test("uses the auth-resolved vault store for cloud API calls", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());

  const overviewResponse = await fetch(`${stack.baseUrl}/api/overview`, {
    headers: { "x-test-auth": "1" },
  });
  const overview = await overviewResponse.json();
  assert.equal(overviewResponse.status, 200);
  assert.ok(Array.isArray(overview.instances));

  const settingsResponse = await fetch(`${stack.baseUrl}/api/settings`, {
    headers: { "x-test-auth": "1" },
  });
  const settings = await settingsResponse.json();
  assert.equal(settingsResponse.status, 200);
  assert.equal(settings.tokens.length, 1);
  assert.equal(settings.tokens[0].label, "Vault token");
  assert.equal(settings.tokens[0].masked.endsWith("-alt"), true);

  assert.equal(
    stack.mock.requests.some(
      (request) =>
        request.headers.authorization === `Bearer ${stack.mock.altToken}`,
    ),
    true,
  );
  assert.equal(
    stack.mock.requests.some(
      (request) =>
        request.headers.authorization === `Bearer ${stack.mock.token}`,
    ),
    false,
  );
});

test("auth routes can answer /api/session before vault resolution", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());

  const response = await fetch(`${stack.baseUrl}/api/session`, {
    headers: { "x-test-auth": "1" },
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.mode, "github");
  assert.equal(payload.authenticated, true);
  assert.equal(payload.vault.unlocked, true);
});
