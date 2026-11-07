import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRequestHandler } from "../server/app.js";
import { openSettingsStore } from "../server/settings-store.js";
import {
  renderCreate,
  renderDrawer,
  renderIpRenewModal,
  renderIpSwapModal,
  renderInstances,
  renderOverview,
  renderSettings,
} from "../public/js/views.js";
import { createMockLinode } from "./helpers/mock-linode.js";
import { createSocks5Server } from "./helpers/socks5-server.js";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address();
}

async function startStack({ envToken } = {}) {
  const mock = await createMockLinode();
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "linode-pilot-test-"));
  const settingsStore = openSettingsStore({
    dataDir,
    envToken: envToken === undefined ? mock.token : envToken,
  });
  const handler = createRequestHandler({
    settingsStore,
    apiBase: mock.apiBase,
    logger: { info() {}, error() {} },
  });
  const server = http.createServer(handler);
  const address = await listen(server);

  return {
    mock,
    settingsStore,
    dataDir,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await mock.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test("requires a token when no env credential is configured", async (t) => {
  const stack = await startStack({ envToken: "" });
  t.after(() => stack.close());

  const response = await fetch(`${stack.baseUrl}/api/overview`);
  const payload = await response.json();

  assert.equal(response.status, 401);
  assert.equal(payload.code, "TOKEN_REQUIRED");
});

test("stores multiple web-managed tokens and switches the active credential", async (t) => {
  const stack = await startStack({ envToken: "" });
  t.after(() => stack.close());

  const headers = {
    "Content-Type": "application/json",
    "X-Linode-Pilot": "1",
  };
  const first = await fetch(`${stack.baseUrl}/api/settings/tokens`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      label: "Primary",
      token: stack.mock.token,
    }),
  });
  const firstPayload = await first.json();
  assert.equal(first.status, 201);
  assert.equal(firstPayload.settings.credentialSource, "web");
  assert.equal(firstPayload.settings.tokens.length, 1);
  assert.equal(firstPayload.settings.tokens[0].label, "Primary");
  assert.equal("token" in firstPayload.settings.tokens[0], false);

  const second = await fetch(`${stack.baseUrl}/api/settings/tokens`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      label: "Backup",
      token: stack.mock.altToken,
    }),
  });
  const secondPayload = await second.json();
  assert.equal(second.status, 201);
  assert.equal(secondPayload.settings.tokens.length, 2);
  assert.equal(secondPayload.settings.poolSize, 2);
  assert.equal(secondPayload.settings.credentials.length, 2);
  assert.equal(secondPayload.settings.activeTokenId, firstPayload.tokenId);

  const activate = await fetch(
    `${stack.baseUrl}/api/settings/tokens/${secondPayload.tokenId}/activate`,
    { method: "POST", headers: { "X-Linode-Pilot": "1" } },
  );
  const activated = await activate.json();
  assert.equal(activate.status, 200);
  assert.equal(activated.settings.activeTokenId, secondPayload.tokenId);
  assert.equal(activated.settings.credentialLabel, "Backup");

  const overview = await fetch(`${stack.baseUrl}/api/overview`);
  assert.equal(overview.status, 200);
  const overviewPayload = await overview.json();
  assert.equal(overviewPayload.instances.length, 8);
  assert.equal(overviewPayload.accounts.length, 2);
  assert.ok(
    overviewPayload.instances.some(
      (instance) =>
        instance.label === "tokyo-batch" &&
        instance.tokenId === secondPayload.tokenId,
    ),
  );
  assert.ok(Math.abs(overviewPayload.transfer.used - 233.4) < 0.001);
  assert.ok(Math.abs(overviewPayload.account.balance - 54.68) < 0.001);

  const remove = await fetch(
    `${stack.baseUrl}/api/settings/tokens/${secondPayload.tokenId}`,
    {
      method: "DELETE",
      headers: { "X-Linode-Pilot": "1" },
    },
  );
  const removed = await remove.json();
  assert.equal(remove.status, 200);
  assert.equal(removed.settings.tokens.length, 1);
  assert.equal(removed.settings.activeTokenId, firstPayload.tokenId);
});

test("routes instance operations and creation to the owning account", async (t) => {
  const stack = await startStack({ envToken: "" });
  t.after(() => stack.close());
  const headers = {
    "Content-Type": "application/json",
    "X-Linode-Pilot": "1",
  };

  const primary = await fetch(`${stack.baseUrl}/api/settings/tokens`, {
    method: "POST",
    headers,
    body: JSON.stringify({ label: "Primary", token: stack.mock.token }),
  }).then((response) => response.json());
  const backup = await fetch(`${stack.baseUrl}/api/settings/tokens`, {
    method: "POST",
    headers,
    body: JSON.stringify({ label: "Orbit", token: stack.mock.altToken }),
  }).then((response) => response.json());

  const initial = await fetch(`${stack.baseUrl}/api/overview`).then((response) =>
    response.json(),
  );
  assert.equal(initial.instances.length, 8);
  assert.equal(initial.accounts.length, 2);
  const altInstance = initial.instances.find(
    (instance) => instance.label === "tokyo-batch",
  );
  assert.equal(altInstance.tokenId, backup.tokenId);
  assert.equal(altInstance.accountLabel, "Rina Sato");

  const detail = await fetch(
    `${stack.baseUrl}/api/instances/72000001/detail?tokenId=${backup.tokenId}`,
  );
  const detailPayload = await detail.json();
  assert.equal(detail.status, 200);
  assert.equal(detailPayload.instance.tokenId, backup.tokenId);
  assert.equal(detailPayload.instance.accountLabel, "Rina Sato");

  const resolvedInstance = await fetch(
    `${stack.baseUrl}/api/instances/72000001`,
  ).then((response) => response.json());
  assert.equal(resolvedInstance.tokenId, backup.tokenId);
  assert.equal(resolvedInstance.accountLabel, "Rina Sato");

  const diagnostic = await fetch(
    `${stack.baseUrl}/api/settings/test-connection`,
    { method: "POST", headers: { "X-Linode-Pilot": "1" } },
  ).then((response) => response.json());
  assert.equal(diagnostic.ok, true);
  assert.equal(diagnostic.tokens.length, 2);
  assert.equal(diagnostic.token.okCount, 2);

  const shutdown = await fetch(
    `${stack.baseUrl}/api/instances/72000001/actions/shutdown`,
    { method: "POST", headers: { "X-Linode-Pilot": "1" } },
  );
  assert.equal(shutdown.status, 200);
  const afterAction = await fetch(`${stack.baseUrl}/api/overview`).then(
    (response) => response.json(),
  );
  assert.equal(
    afterAction.instances.find((instance) => instance.id === 72000001).status,
    "offline",
  );

  const created = await fetch(`${stack.baseUrl}/api/instances`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      tokenId: backup.tokenId,
      label: "orbit-new",
      region: "ap-northeast",
      type: "g6-standard-1",
      image: "linode/debian12",
      root_pass: "long-enough-password",
    }),
  });
  const createdPayload = await created.json();
  assert.equal(created.status, 201);
  assert.equal(createdPayload.instance.tokenId, backup.tokenId);
  assert.equal(createdPayload.instance.accountLabel, "Rina Sato");

  const createRequest = [...stack.mock.requests]
    .reverse()
    .find(
      (entry) =>
        entry.method === "POST" && entry.path === "/linode/instances",
    );
  assert.equal(
    createRequest.headers.authorization,
    `Bearer ${stack.mock.altToken}`,
  );
  assert.notEqual(backup.tokenId, primary.tokenId);
});

test("renders multi-account views with account filtering and create selector", async (t) => {
  const stack = await startStack({ envToken: "" });
  t.after(() => stack.close());
  const headers = {
    "Content-Type": "application/json",
    "X-Linode-Pilot": "1",
  };
  const primary = await fetch(`${stack.baseUrl}/api/settings/tokens`, {
    method: "POST",
    headers,
    body: JSON.stringify({ label: "Northstar", token: stack.mock.token }),
  }).then((response) => response.json());
  const backup = await fetch(`${stack.baseUrl}/api/settings/tokens`, {
    method: "POST",
    headers,
    body: JSON.stringify({ label: "Orbit", token: stack.mock.altToken }),
  }).then((response) => response.json());

  const overview = await fetch(`${stack.baseUrl}/api/overview`).then(
    (response) => response.json(),
  );
  const catalog = await fetch(
    `${stack.baseUrl}/api/catalog?tokenId=${primary.tokenId}`,
  ).then((response) => response.json());
  const settings = await fetch(`${stack.baseUrl}/api/settings`).then(
    (response) => response.json(),
  );
  const state = {
    overview,
    overviewError: null,
    settings,
    catalog,
    filters: {
      query: "",
      status: "all",
      region: "all",
      account: "all",
    },
    prefs: { autoRefresh: true },
    create: {
      tokenId: primary.tokenId,
      label: "orbit-demo",
      region: "ap-south",
      type: "g6-standard-1",
      image: "linode/ubuntu24.04",
      rootPass: "",
      tags: "",
      sshKeys: "",
      userData: "",
      backups: false,
      privateIp: false,
      booted: true,
      passwordVisible: false,
      advancedOpen: false,
    },
    availability: {
      loading: false,
      region: "ap-south",
      plans: null,
      error: "",
    },
    creating: false,
    createError: "",
    session: {
      apiBase: stack.mock.apiBase,
      version: "1.0.0",
    },
    busyActions: new Set(),
    refreshing: false,
    authInvalid: false,
  };

  const overviewHtml = renderOverview(state);
  assert.match(overviewHtml, /2 个账户同时工作/);
  assert.match(overviewHtml, /Orbit Works|Rina Sato/);

  const instancesHtml = renderInstances(state);
  assert.match(instancesHtml, /id="account-filter"/);
  assert.match(instancesHtml, /tokyo-batch/);
  assert.match(instancesHtml, /Rina Sato/);

  state.filters.account = backup.tokenId;
  const filteredHtml = renderInstances(state);
  assert.match(filteredHtml, /tokyo-batch/);
  assert.doesNotMatch(filteredHtml, /pilot-edge-01/);

  const createHtml = renderCreate(state);
  assert.match(createHtml, /id="create-token"/);
  assert.match(createHtml, new RegExp(`value="${backup.tokenId}"`));
  assert.match(createHtml, /所有令牌会同时读取实例/);

  const settingsHtml = renderSettings(state);
  assert.match(settingsHtml, /2 个令牌同时工作/);
  assert.match(settingsHtml, /所有令牌会并行读取/);
  assert.match(settingsHtml, /设为默认/);
});

test("encrypts tokens at rest and can reopen saved settings", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "linode-pilot-store-"));
  try {
    const store = openSettingsStore({ dataDir });
    store.addToken({
      label: "Encrypted",
      token: "test-linode-token",
      accountLabel: "Test Account",
    });
    const raw = readFileSync(path.join(dataDir, "settings.json"), "utf8");
    assert.equal(raw.includes("test-linode-token"), false);
    assert.match(raw, /"encrypted"/);

    const reopened = openSettingsStore({ dataDir });
    assert.equal(reopened.getCredential().token, "test-linode-token");
    assert.equal(reopened.getPublicSettings().tokens[0].label, "Encrypted");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("never returns token or proxy password through public settings", async (t) => {
  const stack = await startStack({ envToken: "" });
  t.after(() => stack.close());
  const proxyPassword = ["test", "proxy", "secret"].join("-");

  const headers = {
    "Content-Type": "application/json",
    "X-Linode-Pilot": "1",
  };
  const created = await fetch(`${stack.baseUrl}/api/settings/tokens`, {
    method: "POST",
    headers,
    body: JSON.stringify({ label: "Private", token: stack.mock.token }),
  });
  assert.equal(created.status, 201);

  const proxyResponse = await fetch(`${stack.baseUrl}/api/settings/proxy`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      enabled: true,
      url: "socks5h://127.0.0.1:1080",
      username: "proxy-user",
      password: proxyPassword,
    }),
  });
  assert.equal(proxyResponse.status, 200);

  const settingsResponse = await fetch(`${stack.baseUrl}/api/settings`);
  const settings = await settingsResponse.json();
  const serialized = JSON.stringify(settings);

  assert.equal(settingsResponse.status, 200);
  assert.equal(serialized.includes(stack.mock.token), false);
  assert.equal(serialized.includes(proxyPassword), false);
  assert.equal(settings.proxy.hasPassword, true);
  assert.equal(settings.tokens[0].masked.endsWith(stack.mock.token.slice(-4)), true);
});

test("imports the env fallback token and falls back after deleting it", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());

  const imported = await fetch(
    `${stack.baseUrl}/api/settings/tokens/import-env`,
    { method: "POST", headers: { "X-Linode-Pilot": "1" } },
  );
  const payload = await imported.json();

  assert.equal(imported.status, 201);
  assert.equal(payload.settings.credentialSource, "web");
  assert.equal(payload.settings.tokens.length, 1);
  assert.equal(payload.settings.tokens[0].label, "从 .env 导入");

  const removed = await fetch(
    `${stack.baseUrl}/api/settings/tokens/${payload.tokenId}`,
    { method: "DELETE", headers: { "X-Linode-Pilot": "1" } },
  );
  const removedPayload = await removed.json();
  assert.equal(removed.status, 200);
  assert.equal(removedPayload.settings.credentialSource, "env");
  assert.equal(removedPayload.settings.tokenConfigured, true);
});

test("routes Linode requests through a local SOCKS5 proxy", async (t) => {
  const socks = await createSocks5Server();
  t.after(() => socks.close());
  const stack = await startStack({ envToken: "" });
  t.after(() => stack.close());

  await fetch(`${stack.baseUrl}/api/settings/tokens`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Linode-Pilot": "1",
    },
    body: JSON.stringify({
      label: "Proxy account",
      token: stack.mock.token,
    }),
  });

  const proxyTest = await fetch(`${stack.baseUrl}/api/settings/proxy/test`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Linode-Pilot": "1",
    },
    body: JSON.stringify({
      enabled: true,
      url: socks.url,
    }),
  });
  const proxyResult = await proxyTest.json();
  assert.equal(proxyTest.status, 200);
  assert.equal(proxyResult.ok, true);
  assert.ok(socks.connections > 0);

  const saveProxy = await fetch(`${stack.baseUrl}/api/settings/proxy`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Linode-Pilot": "1",
    },
    body: JSON.stringify({
      enabled: true,
      url: socks.url,
      username: "",
      password: "",
    }),
  });
  assert.equal(saveProxy.status, 200);

  const connectionsBefore = socks.connections;
  const overview = await fetch(`${stack.baseUrl}/api/overview`);
  assert.equal(overview.status, 200);
  assert.ok(socks.connections > connectionsBefore);
  assert.equal((await overview.json()).instances.length, 6);
});

test("serves the control panel with restrictive security headers", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());

  const response = await fetch(`${stack.baseUrl}/`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(html, /CloudVMController/);
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
});

test("reports auth configuration and proxies the account overview", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());

  const session = await fetch(`${stack.baseUrl}/api/session`).then((response) =>
    response.json(),
  );
  assert.equal(session.tokenConfigured, true);

  const response = await fetch(`${stack.baseUrl}/api/overview`);
  const overview = await response.json();

  assert.equal(response.status, 200);
  assert.equal(overview.account.first_name, "Ming");
  assert.equal(overview.instances.length, 6);
  assert.equal(overview.transfer.quota, 5000);
  assert.ok(overview.events.length >= 5);
});

test("validates actions and forwards allowed power operations", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());

  const blocked = await fetch(
    `${stack.baseUrl}/api/instances/58120442/actions/shutdown`,
    { method: "POST" },
  );
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).code, "CSRF_CHECK_FAILED");

  const invalid = await fetch(
    `${stack.baseUrl}/api/instances/58120442/actions/wipe`,
    { method: "POST", headers: { "X-Linode-Pilot": "1" } },
  );
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, "UNSUPPORTED_ACTION");

  const shutdown = await fetch(
    `${stack.baseUrl}/api/instances/58120442/actions/shutdown`,
    { method: "POST", headers: { "X-Linode-Pilot": "1" } },
  );
  assert.equal(shutdown.status, 200);
  assert.equal((await shutdown.json()).ok, true);

  const overview = await fetch(`${stack.baseUrl}/api/overview`).then((response) =>
    response.json(),
  );
  assert.equal(
    overview.instances.find((instance) => instance.id === 58120442).status,
    "offline",
  );
});

test("normalizes create payloads and never forwards unknown fields", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());

  const response = await fetch(`${stack.baseUrl}/api/instances`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Linode-Pilot": "1",
    },
    body: JSON.stringify({
      label: "pilot-test-01",
      region: "ap-south",
      type: "g6-standard-2",
      image: "linode/ubuntu24.04",
      root_pass: "A-strong-password-2026!",
      tags: ["test", " control-panel ", ""],
      backups_enabled: true,
      private_ip: false,
      booted: true,
      cloud_init: "#cloud-config\npackages:\n  - nginx",
      authorized_keys: ["ssh-ed25519 AAAATEST test@example"],
      unexpected: "must-not-be-forwarded",
    }),
  });
  const result = await response.json();

  assert.equal(response.status, 201);
  assert.equal(result.instance.label, "pilot-test-01");

  const createRequest = stack.mock.requests.find(
    (entry) => entry.method === "POST" && entry.path === "/linode/instances",
  );
  assert.deepEqual(createRequest.body.tags, ["test", "control-panel"]);
  assert.equal(createRequest.body.unexpected, undefined);
  assert.equal(
    Buffer.from(createRequest.body.metadata.user_data, "base64").toString("utf8"),
    "#cloud-config\npackages:\n  - nginx",
  );
});

test("requires root authentication when creating an image-backed instance", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());

  const response = await fetch(`${stack.baseUrl}/api/instances`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Linode-Pilot": "1",
    },
    body: JSON.stringify({
      label: "pilot-test-02",
      region: "ap-south",
      type: "g6-standard-2",
      image: "linode/ubuntu24.04",
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.code, "ROOT_AUTH_REQUIRED");
});

test("serves instance detail with filtered events and stats", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());

  const response = await fetch(
    `${stack.baseUrl}/api/instances/58120442/detail`,
  );
  const detail = await response.json();

  assert.equal(response.status, 200);
  assert.equal(detail.instance.label, "pilot-edge-01");
  assert.ok(detail.stats.cpu.length > 10);
  assert.ok(detail.events.every((event) => event.entity.id === 58120442));
});

test("exposes swappable IPv4 and routed IPv6 metadata", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());

  const source = await fetch(
    `${stack.baseUrl}/api/instances/58120442/ips`,
  ).then((response) => response.json());
  const target = await fetch(
    `${stack.baseUrl}/api/instances/55190332/ips`,
  ).then((response) => response.json());

  assert.equal(source.publicIpv4, "172.104.55.21");
  assert.match(source.ipv6Slaac, /^2400:8907::/);
  assert.deepEqual(source.ipv6Ranges, [
    {
      range: "2400:8907:aa01::/64",
      prefix: 64,
      routeTarget: "2400:8907::f03c:95ff:fe90:3a21",
    },
  ]);
  assert.equal(source.ipv4Swappable, true);
  assert.equal(source.ipv6Swappable, true);

  assert.equal(target.publicIpv4, "172.104.61.119");
  assert.equal(target.ipv6Ranges[0].range, "2400:8907:bb02::/64");
});

test("swaps public IPv4 addresses between same-region instances", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());

  const response = await fetch(
    `${stack.baseUrl}/api/instances/58120442/ip-swap`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Linode-Pilot": "1",
      },
      body: JSON.stringify({
        targetId: 55190332,
        kind: "ipv4",
      }),
    },
  );
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.kind, "ipv4");
  assert.equal(result.region, "ap-south");
  assert.equal(result.source.address, "172.104.55.21");
  assert.equal(result.source.newAddress, "172.104.61.119");
  assert.equal(result.target.address, "172.104.61.119");
  assert.equal(result.target.newAddress, "172.104.55.21");
  assert.equal(result.requiresReboot, true);

  const sourceAfter = await fetch(
    `${stack.baseUrl}/api/instances/58120442/ips`,
  ).then((ips) => ips.json());
  const targetAfter = await fetch(
    `${stack.baseUrl}/api/instances/55190332/ips`,
  ).then((ips) => ips.json());
  assert.equal(sourceAfter.publicIpv4, "172.104.61.119");
  assert.equal(targetAfter.publicIpv4, "172.104.55.21");

  const assignRequest = stack.mock.requests.find(
    (entry) =>
      entry.method === "POST" && entry.path === "/networking/ips/assign",
  );
  assert.deepEqual(assignRequest.body, {
    region: "ap-south",
    assignments: [
      { address: "172.104.55.21", linode_id: 55190332 },
      { address: "172.104.61.119", linode_id: 58120442 },
    ],
  });
});

test("swaps routed IPv6 ranges between same-region instances", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());

  const response = await fetch(
    `${stack.baseUrl}/api/instances/58120442/ip-swap`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Linode-Pilot": "1",
      },
      body: JSON.stringify({
        targetId: 55190332,
        kind: "ipv6",
      }),
    },
  );
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.kind, "ipv6");
  assert.equal(result.source.address, "2400:8907:aa01::/64");
  assert.equal(result.source.newAddress, "2400:8907:bb02::/64");
  assert.equal(result.target.address, "2400:8907:bb02::/64");
  assert.equal(result.target.newAddress, "2400:8907:aa01::/64");

  const sourceAfter = await fetch(
    `${stack.baseUrl}/api/instances/58120442/ips`,
  ).then((ips) => ips.json());
  const targetAfter = await fetch(
    `${stack.baseUrl}/api/instances/55190332/ips`,
  ).then((ips) => ips.json());
  assert.equal(sourceAfter.ipv6Ranges[0].range, "2400:8907:bb02::/64");
  assert.equal(targetAfter.ipv6Ranges[0].range, "2400:8907:aa01::/64");
  assert.match(sourceAfter.ipv6Slaac, /^2400:8907::/);
});

test("validates IP swap kind, region, and IPv6 range availability", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());
  const headers = {
    "Content-Type": "application/json",
    "X-Linode-Pilot": "1",
  };

  const invalidKind = await fetch(
    `${stack.baseUrl}/api/instances/58120442/ip-swap`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ targetId: 55190332, kind: "ipv5" }),
    },
  );
  assert.equal(invalidKind.status, 400);
  assert.equal((await invalidKind.json()).code, "INVALID_IP_SWAP_KIND");

  const crossRegion = await fetch(
    `${stack.baseUrl}/api/instances/58120442/ip-swap`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ targetId: 57910311, kind: "ipv4" }),
    },
  );
  assert.equal(crossRegion.status, 400);
  assert.equal(
    (await crossRegion.json()).code,
    "INSTANCE_REGION_MISMATCH",
  );

  const missingIpv6 = await fetch(
    `${stack.baseUrl}/api/instances/56492010/ip-swap`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ targetId: 49780310, kind: "ipv6" }),
    },
  );
  assert.equal(missingIpv6.status, 400);
  assert.equal((await missingIpv6.json()).code, "NO_IPV6_RANGE");
});

test("renews a public IPv4 address and releases the old address", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());

  const response = await fetch(
    `${stack.baseUrl}/api/instances/58120442/ip-renew`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Linode-Pilot": "1",
      },
      body: JSON.stringify({ kind: "ipv4" }),
    },
  );
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.kind, "ipv4");
  assert.equal(result.region, "ap-south");
  assert.equal(result.oldAddress, "172.104.55.21");
  assert.equal(result.newAddress, "172.104.90.10");
  assert.equal(result.requiresReboot, true);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.requiresManualCleanup, undefined);

  const rawIps = await fetch(
    `${stack.mock.apiBase}/linode/instances/58120442/ips`,
    {
      headers: { Authorization: `Bearer ${stack.mock.token}` },
    },
  ).then((entry) => entry.json());
  const addresses = rawIps.ipv4.public.map((entry) => entry.address);
  assert.equal(addresses.includes("172.104.55.21"), false);
  assert.equal(addresses.includes("172.104.90.10"), true);
  assert.equal(
    rawIps.ipv4.public.find(
      (entry) => entry.address === "172.104.90.10",
    ).reserved,
    false,
  );

  const reserveRequest = stack.mock.requests.find(
    (entry) =>
      entry.method === "POST" && entry.path === "/networking/reserved/ips",
  );
  assert.deepEqual(reserveRequest.body, { region: "ap-south" });
  const unreserveRequest = stack.mock.requests.find(
    (entry) =>
      entry.method === "PUT" &&
      entry.path === "/networking/ips/172.104.90.10",
  );
  assert.deepEqual(unreserveRequest.body, { reserved: false });
  assert.ok(
    stack.mock.requests.some(
      (entry) =>
        entry.method === "DELETE" &&
        entry.path ===
          "/linode/instances/58120442/ips/172.104.55.21",
    ),
  );
});

test("replaces an IPv6 routed range without changing SLAAC", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());

  const before = await fetch(
    `${stack.baseUrl}/api/instances/58120442/ips`,
  ).then((response) => response.json());
  const response = await fetch(
    `${stack.baseUrl}/api/instances/58120442/ip-renew`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Linode-Pilot": "1",
      },
      body: JSON.stringify({ kind: "ipv6", ipv6Prefix: 64 }),
    },
  );
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.kind, "ipv6");
  assert.equal(result.region, "ap-south");
  assert.equal(result.oldRange, "2400:8907:aa01::/64");
  assert.equal(result.newRange, "2400:8907:cc03::/64");
  assert.equal(result.prefix, 64);
  assert.equal(result.requiresReboot, true);
  assert.deepEqual(result.warnings, []);

  const after = await fetch(
    `${stack.baseUrl}/api/instances/58120442/ips`,
  ).then((entry) => entry.json());
  assert.equal(after.ipv6Slaac, before.ipv6Slaac);
  assert.deepEqual(after.ipv6Ranges, [
    {
      range: "2400:8907:cc03::/64",
      prefix: 64,
      routeTarget: "2400:8907::f03c:95ff:fe90:3a21",
    },
  ]);

  const deleteIndex = stack.mock.requests.findIndex(
    (entry) =>
      entry.method === "DELETE" &&
      entry.path ===
        `/networking/ipv6/ranges/${encodeURIComponent("2400:8907:aa01::")}`,
  );
  const createIndex = stack.mock.requests.findIndex(
    (entry) =>
      entry.method === "POST" && entry.path === "/networking/ipv6/ranges",
  );
  assert.ok(deleteIndex >= 0);
  assert.ok(createIndex > deleteIndex);
  assert.deepEqual(stack.mock.requests[createIndex].body, {
    prefix_length: 64,
    linode_id: 58120442,
  });
});

test("keeps the new IPv4 and warns when old address cleanup fails", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());
  stack.mock.setFailNextIpDelete();

  const response = await fetch(
    `${stack.baseUrl}/api/instances/58120442/ip-renew`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Linode-Pilot": "1",
      },
      body: JSON.stringify({ kind: "ipv4" }),
    },
  );
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.newAddress, "172.104.90.10");
  assert.equal(result.requiresManualCleanup, true);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /旧 IPv4 172\.104\.55\.21 未能自动释放/);

  const rawIps = await fetch(
    `${stack.mock.apiBase}/linode/instances/58120442/ips`,
    {
      headers: { Authorization: `Bearer ${stack.mock.token}` },
    },
  ).then((entry) => entry.json());
  const addresses = rawIps.ipv4.public.map((entry) => entry.address);
  assert.equal(addresses.includes("172.104.90.10"), true);
  assert.equal(addresses.includes("172.104.55.21"), true);
});

test("reports when a failed IPv4 assignment cannot roll back its reservation", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());
  stack.mock.setFailNextIpv4Assign();
  stack.mock.setFailNextReservedDelete();

  const response = await fetch(
    `${stack.baseUrl}/api/instances/58120442/ip-renew`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Linode-Pilot": "1",
      },
      body: JSON.stringify({ kind: "ipv4" }),
    },
  );
  const payload = await response.json();

  assert.equal(response.status, 502);
  assert.equal(payload.code, "IPV4_ASSIGN_CLEANUP_FAILED");
  assert.match(payload.error, /172\.104\.90\.10/);
  assert.match(payload.error, /手动删除/);
  assert.ok(
    stack.mock.requests.some(
      (entry) =>
        entry.method === "DELETE" &&
        entry.path === "/networking/reserved/ips/172.104.90.10",
    ),
  );
});

test("rejects IP renewal while the instance is transitional", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());
  stack.mock.setInstanceStatus(58120442, "rebooting");

  const response = await fetch(
    `${stack.baseUrl}/api/instances/58120442/ip-renew`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Linode-Pilot": "1",
      },
      body: JSON.stringify({ kind: "ipv4" }),
    },
  );
  const payload = await response.json();

  assert.equal(response.status, 409);
  assert.equal(payload.code, "INSTANCE_TRANSITIONAL");
  assert.equal(
    stack.mock.requests.some(
      (entry) =>
        entry.method === "POST" && entry.path === "/networking/reserved/ips",
    ),
    false,
  );
});

test("does not replace an IPv6 range when deleting the old range fails", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());
  const before = await fetch(
    `${stack.baseUrl}/api/instances/58120442/ips`,
  ).then((response) => response.json());
  stack.mock.setFailNextIpv6RangeDelete();

  const response = await fetch(
    `${stack.baseUrl}/api/instances/58120442/ip-renew`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Linode-Pilot": "1",
      },
      body: JSON.stringify({ kind: "ipv6", ipv6Prefix: 64 }),
    },
  );
  const payload = await response.json();

  assert.equal(response.status, 502);
  assert.equal(payload.code, "IPV6_RANGE_DELETE_FAILED");

  const after = await fetch(
    `${stack.baseUrl}/api/instances/58120442/ips`,
  ).then((entry) => entry.json());
  assert.deepEqual(after.ipv6Ranges, before.ipv6Ranges);
  assert.equal(
    stack.mock.requests.some(
      (entry) =>
        entry.method === "POST" && entry.path === "/networking/ipv6/ranges",
    ),
    false,
  );
});

test("rejects unsupported IPv6 renewal prefixes before changing ranges", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());
  const headers = {
    "Content-Type": "application/json",
    "X-Linode-Pilot": "1",
  };

  for (const ipv6Prefix of [48, 32]) {
    const response = await fetch(
      `${stack.baseUrl}/api/instances/58120442/ip-renew`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ kind: "ipv6", ipv6Prefix }),
      },
    );
    const payload = await response.json();
    assert.equal(response.status, 400);
    assert.equal(payload.code, "INVALID_IPV6_PREFIX");
  }

  assert.equal(
    stack.mock.requests.some(
      (entry) =>
        entry.method === "DELETE" &&
        entry.path.startsWith("/networking/ipv6/ranges/"),
    ),
    false,
  );
  assert.equal(
    stack.mock.requests.some(
      (entry) =>
        entry.method === "POST" && entry.path === "/networking/ipv6/ranges",
    ),
    false,
  );
});

test("rejects IPv4 renewal when the instance has no public IPv4", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());
  stack.mock.setInstanceIpv4(58120442, ["192.168.144.12"]);

  const response = await fetch(
    `${stack.baseUrl}/api/instances/58120442/ip-renew`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Linode-Pilot": "1",
      },
      body: JSON.stringify({ kind: "ipv4" }),
    },
  );
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.code, "NO_PUBLIC_IPV4");
  assert.equal(
    stack.mock.requests.some(
      (entry) =>
        entry.method === "POST" && entry.path === "/networking/reserved/ips",
    ),
    false,
  );
});

test("reports the released old range when IPv6 replacement creation fails", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());
  const before = await fetch(
    `${stack.baseUrl}/api/instances/58120442/ips`,
  ).then((response) => response.json());
  stack.mock.setFailNextIpv6RangeCreate();

  const response = await fetch(
    `${stack.baseUrl}/api/instances/58120442/ip-renew`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Linode-Pilot": "1",
      },
      body: JSON.stringify({ kind: "ipv6", ipv6Prefix: 64 }),
    },
  );
  const payload = await response.json();

  assert.equal(response.status, 502);
  assert.equal(payload.code, "IPV6_RANGE_REPLACE_FAILED");
  assert.match(payload.error, /旧 IPv6 路由段已释放/);

  const after = await fetch(
    `${stack.baseUrl}/api/instances/58120442/ips`,
  ).then((entry) => entry.json());
  assert.deepEqual(after.ipv6Ranges, []);
  assert.equal(after.ipv6Slaac, before.ipv6Slaac);
});

test("renders the IP swap modal and routed IPv6 ranges in the drawer", () => {
  const instance = {
    id: 58120442,
    label: "pilot-edge-01",
    status: "running",
    region: "ap-south",
    type: "g6-standard-2",
    image: "linode/ubuntu24.04",
    ipv4: ["172.104.55.21"],
    ipv6: "2400:8907::f03c:95ff:fe90:3a21/128",
    specs: { disk: 81920, memory: 4096, vcpus: 2, transfer: 4000 },
    tags: [],
    created: "2026-08-12T09:24:00",
    updated: "2026-11-07T00:00:00",
    tokenId: "token-1",
    accountLabel: "Northstar Labs",
  };
  const sourceInfo = {
    publicIpv4: "172.104.55.21",
    ipv6Slaac: "2400:8907::f03c:95ff:fe90:3a21",
    ipv6Ranges: [{ range: "2400:8907:aa01::/64", prefix: 64 }],
    ipv4Swappable: true,
    ipv6Swappable: true,
  };
  const targetInfo = {
    publicIpv4: "172.104.61.119",
    ipv6Slaac: "2400:8907::f03c:95ff:fe2b:4188",
    ipv6Ranges: [{ range: "2400:8907:bb02::/64", prefix: 64 }],
    ipv4Swappable: true,
    ipv6Swappable: true,
  };

  const drawer = renderDrawer({
    catalog: null,
    busyActions: new Set(),
    detail: {
      open: true,
      id: String(instance.id),
      tokenId: instance.tokenId,
      loading: false,
      error: null,
      data: {
        instance,
        stats: null,
        backups: null,
        events: [],
        ips: sourceInfo,
      },
    },
  });
  assert.match(drawer, /data-action="open-ip-swap"/);
  assert.match(drawer, /data-action="open-ip-renew"/);
  assert.match(drawer, /2400:8907:aa01::\/64/);
  assert.match(drawer, /IPv6 段/);

  const modal = renderIpSwapModal({
    modal: {
      type: "ip-swap",
      instance,
      candidates: [
        {
          id: "55190332",
          label: "analytics-db",
          region: "ap-south",
        },
      ],
      sourceInfo,
      targetInfo,
      kind: "ipv6",
      targetId: "55190332",
      sourceLoading: false,
      targetLoading: false,
      error: "",
      busy: false,
    },
  });
  assert.match(modal, /id="ip-swap-form"/);
  assert.match(modal, /id="ip-swap-target"/);
  assert.match(modal, /2400:8907:aa01::\/64/);
  assert.match(modal, /2400:8907:bb02::\/64/);
  assert.match(modal, /默认 SLAAC/);
  assert.match(modal, /确认交换/);
});

test("renders IPv4, IPv6 /56, and unavailable renewal states", () => {
  const instance = {
    id: 58120442,
    label: "pilot-edge-01",
    status: "running",
    region: "ap-south",
    tokenId: "token-1",
  };
  const sourceInfo = {
    publicIpv4: "172.104.55.21",
    ipv6Slaac: "2400:8907::f03c:95ff:fe90:3a21",
    ipv6Ranges: [{ range: "2400:8907:aa01::/64", prefix: 64 }],
  };
  const baseModal = {
    type: "ip-renew",
    instance,
    sourceInfo,
    sourceLoading: false,
    kind: "ipv4",
    ipv6Prefix: 64,
    confirmed: false,
    error: "",
    busy: false,
  };

  const ipv4 = renderIpRenewModal({ modal: baseModal });
  assert.match(ipv4, /id="ip-renew-form"/);
  assert.match(ipv4, /172\.104\.55\.21/);
  assert.match(ipv4, /申请新 IPv4/);
  assert.match(ipv4, /Reserved IP/);
  assert.match(
    ipv4,
    /<button type="submit" class="button button-primary" disabled>/,
  );

  const ipv6 = renderIpRenewModal({
    modal: {
      ...baseModal,
      kind: "ipv6",
      ipv6Prefix: 56,
      confirmed: true,
      busy: true,
    },
  });
  assert.match(ipv6, /data-prefix="56"/);
  assert.match(ipv6, /data-prefix="64"/);
  assert.match(ipv6, /2400:8907:aa01::\/64/);
  assert.match(ipv6, /默认 SLAAC/);
  assert.match(ipv6, /不可变/);
  assert.match(ipv6, /先释放当前路由段/);
  assert.match(ipv6, /正在换新/);
  assert.match(ipv6, /data-action="close-modal"[^>]*disabled/);

  const unavailable = renderIpRenewModal({
    modal: {
      ...baseModal,
      sourceInfo: { ...sourceInfo, publicIpv4: "" },
    },
  });
  assert.match(unavailable, /无法执行 IPv4 换新/);
});
