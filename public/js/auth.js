import { icon } from "./icons.js";
import { escapeHtml, spinner } from "./utils.js";

function displayName(user) {
  return user?.name || user?.login || "GitHub 用户";
}

function initials(value) {
  const parts = String(value || "")
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (parts.length === 0) {
    return "GH";
  }
  return parts
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function authHeader() {
  return `
    <div class="auth-gate-brand">
      <span class="auth-gate-mark">${icon("shield")}</span>
      <span>
        <strong>CloudVMController</strong>
        <small>GITHUB VAULT</small>
      </span>
    </div>
  `;
}

function loginGate(auth) {
  return `
    <section class="auth-gate">
      <div class="auth-gate-card auth-gate-card-login">
        ${authHeader()}
        <span class="eyebrow">AUTHENTICATION / GITHUB APP</span>
        <h1>先验证身份，<br />再接触云凭据。</h1>
        <p>
          控制台使用 GitHub App 登录。Linode Token、OCI 私钥和代理密码只会保存在
          你自己的 GitHub 私有仓库保险库中，并以 AES-256-GCM 密文存储。
        </p>
        <a
          class="button button-primary auth-github-button"
          href="/api/auth/login?returnTo=%2F"
        >
          ${icon("code")}
          <span>使用 GitHub 登录</span>
        </a>
        ${
          auth?.error
            ? `<div class="form-alert auth-gate-alert">${icon("alert")}<span>${escapeHtml(auth.error)}</span></div>`
            : ""
        }
        <div class="auth-gate-points">
          <span>${icon("check")} 不在服务器本地保存明文凭据</span>
          <span>${icon("check")} 每次启动都需要重新解锁保险库</span>
          <span>${icon("check")} 只允许访问你授权的私有仓库</span>
        </div>
        <p class="auth-gate-foot">
          ${icon("shield")}
          <span>如果这是公网部署，请确保站点已启用 HTTPS。</span>
        </p>
      </div>
    </section>
  `;
}

function configGate(auth) {
  return `
    <section class="auth-gate">
      <div class="auth-gate-card auth-gate-card-login">
        ${authHeader()}
        <span class="eyebrow">CONFIGURATION REQUIRED</span>
        <h1>GitHub App 尚未配置</h1>
        <p>
          服务端已启用 GitHub 保险库模式，但缺少 GitHub App 凭据。请在部署环境中配置
          <code>GITHUB_APP_ID</code>、<code>GITHUB_APP_CLIENT_ID</code>、
          <code>GITHUB_APP_CLIENT_SECRET</code>、<code>GITHUB_APP_PRIVATE_KEY</code>、
          <code>GITHUB_APP_SLUG</code> 和 <code>SESSION_SECRET</code>。
        </p>
        ${
          auth?.error
            ? `<div class="form-alert auth-gate-alert">${icon("alert")}<span>${escapeHtml(auth.error)}</span></div>`
            : ""
        }
        <div class="auth-gate-actions">
          <a class="button button-secondary" href="/">
            ${icon("refresh")} 重新检查
          </a>
        </div>
      </div>
    </section>
  `;
}

function installationOptions(auth) {
  const installations = Array.isArray(auth.installations)
    ? auth.installations
    : [];
  if (installations.length === 0) {
    return "";
  }

  return installations
    .map((installation) => {
      const account = installation.account || {};
      const label = account.login
        ? `${account.login}${account.type === "Organization" ? " · Org" : ""}`
        : `Installation ${installation.id}`;
      return `<option
        value="${escapeHtml(installation.id)}"
        ${String(installation.id) === String(auth.selectedInstallationId) ? "selected" : ""}
      >${escapeHtml(label)}</option>`;
    })
    .join("");
}

function repositoryOptions(auth) {
  const repositories = Array.isArray(auth.repositories)
    ? auth.repositories
    : [];
  if (repositories.length === 0) {
    return "";
  }

  return repositories
    .map((repository) => {
      const fullName = repository.fullName || repository.full_name || "";
      return `<option
        value="${escapeHtml(fullName)}"
        ${fullName === auth.selectedRepository ? "selected" : ""}
      >${escapeHtml(fullName)}</option>`;
    })
    .join("");
}

function vaultGate(auth) {
  const installations = Array.isArray(auth.installations)
    ? auth.installations
    : [];
  const repositories = Array.isArray(auth.repositories)
    ? auth.repositories
    : [];
  const user = auth.user || {};
  const display = displayName(user);
  const creating = auth.vaultExists === false;
  const exists = auth.vaultExists === true;
  const statusUnknown = auth.vaultExists === null;
  const busy = Boolean(auth.busy);
  const loading = Boolean(auth.loading || auth.vaultLoading);
  const selectedRepository = auth.selectedRepository || "";
  const vaultMeta = auth.vaultMeta || {};

  if (auth.loading && installations.length === 0) {
    return `
      <section class="auth-gate">
        <div class="auth-gate-card">
          ${authHeader()}
          <div class="auth-gate-loading">
            ${spinner()}
            <span>正在读取 GitHub App 安装与私有仓库…</span>
          </div>
        </div>
      </section>
    `;
  }

  const accountSetup =
    installations.length === 0
      ? `
        <div class="auth-gate-empty">
          <span class="auth-gate-empty-icon">${icon("code")}</span>
          <div>
            <strong>还没有可用的 GitHub App 安装</strong>
            <p>先安装 GitHub App，并只授权它访问存放保险库的私有仓库。</p>
          </div>
          <a class="button button-primary button-sm" href="/api/github/install">
            ${icon("plus")} 安装 GitHub App
          </a>
        </div>
      `
      : `
        <label class="form-field auth-gate-field">
          <span class="field-label">GitHub App Installation</span>
          <select id="vault-installation" ${busy || loading ? "disabled" : ""}>
            <option value="">选择一个 installation</option>
            ${installationOptions(auth)}
          </select>
        </label>
        ${
          auth.selectedInstallationId && repositories.length === 0 && !loading
            ? `
              <div class="auth-gate-inline-note">
                ${icon("info")}
                <span>该 installation 没有可用的私有仓库。请到 GitHub 授权至少一个私有仓库后重试。</span>
                <a class="text-link" href="/api/github/install">重新配置</a>
              </div>
            `
            : ""
        }
        ${
          repositories.length > 0
            ? `
              <label class="form-field auth-gate-field">
                <span class="field-label">私有保险库仓库</span>
                <select id="vault-repository" ${busy || loading ? "disabled" : ""}>
                  ${repositoryOptions(auth)}
                </select>
                <span class="field-hint">只显示 GitHub App 已授权的私有仓库。</span>
              </label>
            `
            : ""
        }
      `;

  return `
    <section class="auth-gate">
      <div class="auth-gate-card">
        ${authHeader()}
        <div class="auth-gate-user">
          <span class="avatar auth-gate-avatar">${escapeHtml(initials(display))}</span>
          <span class="auth-gate-user-copy">
            <strong>${escapeHtml(display)}</strong>
            <small>@${escapeHtml(user.login || "github")}</small>
          </span>
          <button type="button" class="text-button auth-gate-signout" data-action="logout">
            ${icon("logout")} 退出
          </button>
        </div>

        <span class="eyebrow">VAULT / ${exists ? "UNLOCK" : creating ? "CREATE" : "CHECK"}</span>
        <h1>${exists ? "解锁 GitHub 保险库" : creating ? "创建 GitHub 保险库" : "选择保险库仓库"}</h1>
        <p>
          ${ exists
            ? "输入保险库密码后，本机服务会在内存中解密设置并开始访问云 API。关闭服务或锁定后需要重新输入。"
            : creating
              ? "还没有找到保险库文件。设置一个独立密码后，控制台会在私有仓库中创建加密的 .cloudvm/vault.json。"
              : "选择一个 installation 与私有仓库，控制台会检查其中是否已有加密保险库。"
          }
        </p>

        <form id="vault-unlock-form" class="auth-gate-form" novalidate>
          ${accountSetup}

          ${
            selectedRepository && !statusUnknown
              ? `
                <div class="auth-gate-repo-status">
                  <span class="auth-gate-repo-icon">${icon("shield")}</span>
                  <span>
                    <strong class="mono">${escapeHtml(selectedRepository)}</strong>
                    <small>${exists ? "已找到加密保险库" : "将创建新的加密保险库"}</small>
                  </span>
                  ${
                    vaultMeta.htmlUrl
                      ? `<a class="text-link" href="${escapeHtml(vaultMeta.htmlUrl)}" target="_blank" rel="noreferrer">${icon("external-link")} 查看</a>`
                      : ""
                  }
                </div>
              `
              : ""
          }

          ${
            selectedRepository && !statusUnknown
              ? `
                <label class="form-field auth-gate-field">
                  <span class="field-label">保险库密码</span>
                  <input
                    type="password"
                    id="vault-password"
                    autocomplete="${creating ? "new-password" : "current-password"}"
                    placeholder="${creating ? "设置至少 8 位密码" : "输入保险库密码"}"
                    maxlength="1024"
                    ${creating ? 'minlength="8"' : ""}
                    ${busy ? "disabled" : ""}
                  />
                  <span class="field-hint">密码不会写入 GitHub，也不会保存到磁盘。</span>
                </label>
                ${
                  creating
                    ? `
                      <label class="form-field auth-gate-field">
                        <span class="field-label">确认密码</span>
                        <input
                          type="password"
                          id="vault-password-confirm"
                          autocomplete="new-password"
                          placeholder="再次输入保险库密码"
                          minlength="8"
                          maxlength="1024"
                          ${busy ? "disabled" : ""}
                        />
                      </label>
                    `
                    : ""
                }
              `
              : ""
          }

          ${
            auth.error
              ? `<div class="form-alert auth-gate-alert">${icon("alert")}<span>${escapeHtml(auth.error)}</span></div>`
              : ""
          }

          <div class="auth-gate-actions">
            ${
              statusUnknown
                ? installations.length > 0
                  ? `<button type="button" class="button button-secondary" data-action="refresh-vault-status" ${loading || !selectedRepository ? "disabled" : ""}>
                      ${loading ? spinner() : icon("refresh")} 检查保险库
                    </button>`
                  : ""
                : `<button type="submit" class="button button-primary" ${!selectedRepository || busy || loading ? "disabled" : ""}>
                    ${busy ? spinner() : icon(exists ? "key" : "plus")}
                    <span>${exists ? "解锁保险库" : "创建并解锁保险库"}</span>
                  </button>`
            }
          </div>
        </form>

        <div class="auth-gate-security">
          <span>${icon("shield")} AES-256-GCM</span>
          <span>${icon("key")} PBKDF2-SHA256</span>
          <span>${icon("cloud")} GitHub Private Repo</span>
        </div>
      </div>
    </section>
  `;
}

export function renderAuthGate(state) {
  const auth = state?.auth || {};
  if (auth.mode === "github" && auth.configured === false) {
    return configGate(auth);
  }
  if (!auth.authenticated) {
    return loginGate(auth);
  }
  return vaultGate(auth);
}
