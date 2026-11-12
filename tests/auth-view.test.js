import assert from "node:assert/strict";
import test from "node:test";

import { renderAuthGate } from "../public/js/auth.js";
import { renderSettings } from "../public/js/views.js";

function authState(overrides = {}) {
  return {
    auth: {
      mode: "github",
      configured: true,
      authenticated: true,
      user: {
        id: 101,
        login: "octocat",
        name: "Octo Cat",
        avatarUrl: "https://example.test/avatar.png",
      },
      gate: "vault",
      installations: [
        {
          id: 123,
          account: { login: "octocat", type: "User" },
        },
      ],
      repositories: [
        {
          id: 55,
          fullName: "octocat/cloudvm-vault",
          private: true,
        },
      ],
      selectedInstallationId: "123",
      selectedRepository: "octocat/cloudvm-vault",
      vaultExists: true,
      vaultUnlocked: false,
      vaultMeta: {
        exists: true,
        repository: "octocat/cloudvm-vault",
        htmlUrl:
          "https://github.com/octocat/cloudvm-vault/blob/main/.cloudvm/vault.json",
      },
      loading: false,
      vaultLoading: false,
      busy: false,
      error: "",
      ...overrides,
    },
  };
}

test("renders a GitHub login gate when unauthenticated", () => {
  const html = renderAuthGate(
    authState({
      authenticated: false,
      gate: "login",
      user: null,
      installations: [],
      repositories: [],
      selectedInstallationId: "",
      selectedRepository: "",
      vaultExists: null,
    }),
  );

  assert.match(html, /使用 GitHub 登录/);
  assert.match(html, /href="\/api\/auth\/login\?returnTo=%2F"/);
  assert.match(html, /AES-256-GCM/);
  assert.doesNotMatch(html, /id="vault-password"/);
});

test("renders the unlock form for an existing vault", () => {
  const html = renderAuthGate(authState());

  assert.match(html, /解锁 GitHub 保险库/);
  assert.match(html, /id="vault-installation"/);
  assert.match(html, /id="vault-repository"/);
  assert.match(html, /id="vault-password"/);
  assert.match(html, /解锁保险库/);
  assert.doesNotMatch(html, /id="vault-password-confirm"/);
  assert.match(html, /octocat\/cloudvm-vault/);
});

test("renders a confirmation field when creating a new vault", () => {
  const html = renderAuthGate(
    authState({
      vaultExists: false,
      vaultMeta: { exists: false, repository: "octocat/cloudvm-vault" },
    }),
  );

  assert.match(html, /创建 GitHub 保险库/);
  assert.match(html, /id="vault-password-confirm"/);
  assert.match(html, /创建并解锁保险库/);
  assert.match(html, /autocomplete="new-password"/);
});

test("offers the GitHub App installation link when no installation exists", () => {
  const html = renderAuthGate(
    authState({
      installations: [],
      repositories: [],
      selectedInstallationId: "",
      selectedRepository: "",
      vaultExists: null,
    }),
  );

  assert.match(html, /还没有可用的 GitHub App 安装/);
  assert.match(html, /href="\/api\/github\/install"/);
  assert.doesNotMatch(html, /data-action="refresh-vault-status"/);
});

test("shows a loading gate while GitHub resources are being read", () => {
  const html = renderAuthGate(
    authState({
      installations: [],
      repositories: [],
      selectedInstallationId: "",
      selectedRepository: "",
      vaultExists: null,
      loading: true,
    }),
  );

  assert.match(html, /正在读取 GitHub App 安装与私有仓库/);
  assert.doesNotMatch(html, /还没有可用的 GitHub App 安装/);
});

test("shows a configuration error when the GitHub App is missing", () => {
  const html = renderAuthGate(
    authState({
      configured: false,
      authenticated: false,
      gate: "login",
    }),
  );

  assert.match(html, /GitHub App 尚未配置/);
  assert.match(html, /GITHUB_APP_ID/);
  assert.match(html, /SESSION_SECRET/);
  assert.doesNotMatch(html, /href="\/api\/auth\/login/);
});

test("escapes user, repository, and error content", () => {
  const html = renderAuthGate(
    authState({
      user: {
        id: 101,
        login: "octo<script>",
        name: '<img src=x onerror="alert(1)">',
      },
      selectedRepository: 'octocat/<repo>"',
      repositories: [
        { fullName: 'octocat/<repo>"', private: true },
      ],
      error: "<b>bad password</b>",
    }),
  );

  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<b>bad password<\/b>/);
  assert.doesNotMatch(html, /octocat\/<repo>/);
  assert.match(html, /&lt;img src=x/);
  assert.match(html, /&lt;b&gt;bad password&lt;\/b&gt;/);
});

test("renders loading and error states without exposing secrets", () => {
  const html = renderAuthGate(
    authState({
      vaultExists: null,
      loading: true,
      error: "GitHub 暂时不可用",
    }),
  );

  assert.match(html, /检查保险库/);
  assert.match(html, /GitHub 暂时不可用/);
  assert.doesNotMatch(html, /ghu_/);
});

function settingsState(auth) {
  return {
    settings: {
      tokenConfigured: false,
      credentialSource: "none",
      credentialLabel: "",
      envTokenConfigured: false,
      poolSize: 0,
      tokens: [],
      oracleAccounts: [],
      oracleConfigured: false,
      proxy: {
        enabled: false,
        url: "socks5h://127.0.0.1:7890",
        username: "",
        hasPassword: false,
      },
    },
    auth,
    session: { apiBase: "https://api.linode.com/v4", version: "1.1.0" },
    prefs: { autoRefresh: true },
    authInvalid: false,
  };
}

test("shows the GitHub vault panel in settings when auth mode is github", () => {
  const html = renderSettings(
    settingsState({
      mode: "github",
      authenticated: true,
      vaultUnlocked: true,
      user: { id: 101, login: "octocat", name: "Octo Cat" },
      selectedRepository: "octocat/cloudvm-vault",
      vaultMeta: {
        repository: "octocat/cloudvm-vault",
        htmlUrl:
          "https://github.com/octocat/cloudvm-vault/blob/main/.cloudvm/vault.json",
      },
    }),
  );

  assert.match(html, /GitHub 保险库/);
  assert.match(html, /octocat\/cloudvm-vault/);
  assert.match(html, /data-action="lock-vault"/);
  assert.match(html, /data-action="logout"/);
  assert.match(html, /\.cloudvm\/vault\.json/);
  assert.doesNotMatch(html, /保存到 <code>data\/settings\.json/);
});

test("keeps the local settings note in local mode", () => {
  const html = renderSettings(
    settingsState({
      mode: "local",
      authenticated: false,
    }),
  );

  assert.doesNotMatch(html, /GitHub 保险库/);
  assert.match(html, /data\/settings\.json/);
});
