import { ApiError, createApi } from "./api.js";
import { icon, mountIcons } from "./icons.js";
import { enhanceSelects } from "./select.js";
import {
  copyToClipboard,
  debounce,
  escapeHtml,
  generatePassword,
  getPlanPrice,
  isTransitional,
  passwordStrength,
  randomInstanceLabel,
  relativeTime,
  spinner,
} from "./utils.js";
import {
  renderCreate,
  renderCreateSkeleton,
  renderCreateSummary,
  renderDisconnected,
  renderDrawer as renderDrawerView,
  renderIpRenewModal,
  renderIpSwapModal,
  renderInstances,
  renderInstancesSkeleton,
  renderOverview,
  renderOverviewSkeleton,
  renderSettings,
} from "./views.js";

const PREFS_KEY = "cloudvm:prefs";
const LEGACY_PREFS_KEY = "linode-pilot:prefs";
const AUTO_REFRESH_INTERVAL = 30_000;
const VIEW_META = {
  overview: { title: "概览" },
  instances: { title: "实例" },
  create: { title: "部署实例" },
  settings: { title: "连接与设置" },
};
const OPERATION_LABELS = {
  boot: "启动",
  shutdown: "关闭",
  reboot: "重启",
};

function readPreferences() {
  try {
    const stored = JSON.parse(
      localStorage.getItem(PREFS_KEY) ||
        localStorage.getItem(LEGACY_PREFS_KEY) ||
        "{}",
    );
    return { autoRefresh: stored.autoRefresh !== false };
  } catch {
    return { autoRefresh: true };
  }
}

function savePreferences(preferences) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(preferences));
  } catch {
    // Local storage can be disabled; preferences simply won't persist.
  }
}

function newCreateState() {
  return {
    tokenId: "",
    label: randomInstanceLabel(),
    region: "",
    type: "",
    image: "",
    rootPass: "",
    tags: "",
    sshKeys: "",
    userData: "",
    backups: false,
    privateIp: false,
    booted: true,
    passwordVisible: false,
    advancedOpen: false,
  };
}

const state = {
  session: { tokenConfigured: false, apiBase: "", version: "1.0.0" },
  settings: null,
  sessionError: "",
  authInvalid: false,
  initialised: false,
  loading: true,
  refreshing: false,
  catalogLoading: false,
  overview: null,
  overviewError: null,
  catalog: null,
  catalogTokenId: "",
  catalogError: "",
  view: "overview",
  filters: { query: "", status: "all", region: "all", account: "all" },
  prefs: readPreferences(),
  detail: {
    open: false,
    id: null,
    tokenId: null,
    loading: false,
    error: null,
    data: null,
    returnFocus: null,
  },
  modal: null,
  create: newCreateState(),
  availability: {
    loading: false,
    region: "",
    plans: null,
    error: "",
  },
  creating: false,
  createError: "",
  busyActions: new Set(),
  mobileNavOpen: false,
};

const elements = {
  viewRoot: document.querySelector("#view-root"),
  drawerRoot: document.querySelector("#drawer-root"),
  modalRoot: document.querySelector("#modal-root"),
  toastRoot: document.querySelector("#toast-root"),
  topbarTitle: document.querySelector("#topbar-title"),
  connectionStatus: document.querySelector("#connection-status"),
  refreshButton: document.querySelector("#refresh-button"),
  tokenButton: document.querySelector("#token-button"),
  topbarAvatarText: document.querySelector("#topbar-avatar-text"),
  sidebarAvatar: document.querySelector("#sidebar-avatar"),
  sidebarAccountName: document.querySelector("#sidebar-account-name"),
  sidebarAccountEmail: document.querySelector("#sidebar-account-email"),
  navInstanceCount: document.querySelector("#nav-instance-count"),
  sidebar: document.querySelector("#sidebar"),
  mobileMenuButton: document.querySelector("#mobile-menu-button"),
  mobileScrim: document.querySelector("#mobile-scrim"),
  appShell: document.querySelector("#app-shell"),
};

const api = createApi({ onUnauthorized: handleUnauthorized });

let availabilitySequence = 0;
let isComposingSearch = false;

function hasCredentials() {
  const configured =
    state.settings?.tokenConfigured ?? state.session.tokenConfigured;
  return Boolean(configured && !state.authInvalid);
}

function accountName(account) {
  if (!account) {
    return "Linode 账户";
  }
  return (
    [account.first_name, account.last_name].filter(Boolean).join(" ") ||
    account.company ||
    account.email ||
    "Linode 账户"
  );
}

function initials(value) {
  const parts = String(value || "Linode")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) {
    return "CV";
  }
  return parts
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function tokenSourceLabel() {
  const poolSize = Number(state.settings?.poolSize || 0);
  if (poolSize > 1) {
    return `${poolSize} 个令牌 · 多账户模式`;
  }
  const source =
    state.settings?.credentialSource ||
    state.session.credentialSource ||
    "none";
  if (source === "web") {
    return state.settings?.credentialLabel || state.session.credentialLabel || "Web 管理令牌";
  }
  if (source === "env") {
    return "服务端 .env 令牌";
  }
  return "未配置令牌";
}

function viewFromHash() {
  const candidate = window.location.hash.replace(/^#\/?/, "").split("?")[0];
  return Object.hasOwn(VIEW_META, candidate) ? candidate : "overview";
}

function friendlyError(error) {
  if (!error) {
    return "发生未知错误。";
  }
  if (error.status === 401) {
    return "API 令牌无效或已过期，请重新连接。";
  }
  if (error.status === 403) {
    const reason = error.details?.[0]?.reason;
    return reason
      ? `令牌权限不足：${reason}`
      : "令牌权限不足，请确认已授予 Linodes 读写权限。";
  }
  if (error.status === 429) {
    return "Linode API 请求频率超限，请稍后再试。";
  }
  if (error.status === 504) {
    return "Linode API 响应超时，请稍后重试。";
  }
  if (error.status === 0 || error.code === "NETWORK_ERROR") {
    return "无法连接本地服务，请确认 Node 服务仍在运行。";
  }
  return error.message || "请求失败，请稍后重试。";
}

function updateShell() {
  const activeView = VIEW_META[state.view] ? state.view : "overview";
  elements.topbarTitle.textContent = VIEW_META[activeView].title;
  document.title = `${VIEW_META[activeView].title} · CloudVMController`;

  document.querySelectorAll("[data-nav]").forEach((element) => {
    const active = element.dataset.nav === activeView;
    element.classList.toggle("is-active", active);
    if (active) {
      element.setAttribute("aria-current", "page");
    } else {
      element.removeAttribute("aria-current");
    }
  });

  const instances = state.overview?.instances || [];
  elements.navInstanceCount.textContent = state.overview
    ? String(instances.length)
    : "—";

  const account = state.overview?.account;
  const accountCount = state.overview?.accounts?.length || (account ? 1 : 0);
  const multiAccount = accountCount > 1;
  const name = multiAccount
    ? `${accountCount} 个 Linode 账户`
    : accountName(account);
  const email = multiAccount
    ? `${state.overview?.poolSize || accountCount} 个令牌同时工作`
    : account?.email || tokenSourceLabel();
  const avatar = multiAccount ? "MA" : account ? initials(name) : "CV";
  elements.sidebarAvatar.textContent = avatar;
  elements.topbarAvatarText.textContent = avatar;
  elements.sidebarAccountName.textContent =
    account || multiAccount
      ? name
      : state.overview
        ? "Linode 账户"
        : "未连接";
  elements.sidebarAccountEmail.textContent =
    account || multiAccount ? email : tokenSourceLabel();
  elements.tokenButton.title = `API 凭据：${tokenSourceLabel()}`;
  elements.tokenButton.classList.toggle("has-credentials", hasCredentials());

  let statusClass = "is-idle";
  let statusLabel = "未连接";

  if (hasCredentials() && state.loading && !state.overview) {
    statusClass = "is-loading";
    statusLabel = "连接中";
  } else if (state.overviewError) {
    statusClass = "is-error";
    statusLabel = "连接异常";
  } else if (state.overview) {
    statusClass = "is-connected";
    statusLabel = "已连接";
  }

  elements.connectionStatus.className = `connection-pill ${statusClass}`;
  elements.connectionStatus.innerHTML = `
    <span class="connection-dot"></span>
    <span class="connection-label">${statusLabel}</span>
  `;
  elements.refreshButton.classList.toggle("is-spinning", state.refreshing);
  elements.refreshButton.setAttribute(
    "aria-label",
    state.refreshing ? "正在刷新数据" : "刷新数据",
  );
  syncBodyLock();
}

function syncBodyLock() {
  document.body.classList.toggle(
    "is-locked",
    Boolean(state.modal) || state.detail.open,
  );
}

function paintView(html) {
  elements.viewRoot.innerHTML = html;
  enhanceSelects(elements.viewRoot);
}

function renderView() {
  updateShell();

  if (!state.initialised) {
    return;
  }

  if (state.view === "settings") {
    paintView(renderSettings(state));
    return;
  }

  if (!hasCredentials()) {
    paintView(renderDisconnected(state));
    return;
  }

  if (
    state.overviewError &&
    !state.overview &&
    state.view !== "settings" &&
    state.view !== "create"
  ) {
    paintView(`
      <section class="page page-failure">
        <div class="failure-card">
          <span class="failure-icon">${icon("alert")}</span>
          <span class="eyebrow">CONNECTION ERROR</span>
          <h1>暂时无法读取 Linode 账户</h1>
          <p>${escapeHtml(state.overviewError)}</p>
          <div class="failure-actions">
            <button type="button" class="button button-primary" data-action="refresh-overview">${icon("refresh")}重试</button>
            <button type="button" class="button button-secondary" data-action="open-token">${icon("key")}检查令牌</button>
          </div>
          <p class="failure-hint">${icon("shield")} ${escapeHtml(tokenSourceLabel())}</p>
        </div>
      </section>
    `);
    return;
  }

  if (state.view === "create") {
    ensureCreateSelections();
    paintView(state.catalog
      ? renderCreate(state)
      : renderCreateSkeleton(state));
    return;
  }

  if (state.loading && !state.overview) {
    paintView(
      state.view === "instances"
        ? renderInstancesSkeleton()
        : renderOverviewSkeleton(),
    );
    return;
  }

  if (state.view === "instances") {
    paintView(renderInstances(state));
    return;
  }

  paintView(renderOverview(state));
}

function ensureCreateSelections() {
  ensureCreateToken();
  const catalog = state.catalog;
  if (!catalog) {
    return;
  }

  const regions = (catalog.regions || [])
    .filter((region) => !region.status || region.status === "ok")
    .slice()
    .sort((left, right) =>
      String(left.label || left.id).localeCompare(String(right.label || right.id)),
    );
  if (regions.length === 0) {
    return;
  }

  if (!state.create.region || !regions.some((region) => region.id === state.create.region)) {
    const preferredRegions = ["ap-south", "ap-northeast", "ap-west", "us-east"];
    const usedRegion = state.overview?.instances?.find((instance) => instance.region)?.region;
    const selected =
      regions.find((region) => region.id === usedRegion) ||
      preferredRegions.map((id) => regions.find((region) => region.id === id)).find(Boolean) ||
      regions[0];
    state.create.region = selected?.id || "";
  }

  if (!state.create.type || !catalog.types?.some((plan) => plan.id === state.create.type)) {
    state.create.type = chooseDefaultPlan(state.create.region);
  }

  if (state.availability.plans && state.create.type) {
    const typeAvailable = state.availability.plans[state.create.type] !== false;
    if (!typeAvailable) {
      state.create.type = chooseDefaultPlan(state.create.region, true);
    }
  }

  if (
    !state.create.image ||
    !catalog.images?.some((image) => image.id === state.create.image)
  ) {
    state.create.image = chooseDefaultImage();
  }
}

function chooseDefaultPlan(regionId, respectAvailability = false) {
  const plans = (state.catalog?.types || []).filter((plan) => !plan.deprecated);
  if (plans.length === 0) {
    return "";
  }

  const availablePlans =
    respectAvailability && state.availability.region === regionId && state.availability.plans
      ? plans.filter((plan) => state.availability.plans[plan.id] !== false)
      : plans;
  const standardPlans = availablePlans.filter((plan) => plan.class === "standard");
  const candidates = standardPlans.length > 0 ? standardPlans : availablePlans;

  return candidates
    .slice()
    .sort((left, right) => {
      const leftPrice = getPlanPrice(left, regionId).monthly;
      const rightPrice = getPlanPrice(right, regionId).monthly;
      if (leftPrice !== rightPrice) return leftPrice - rightPrice;
      return (left.memory || 0) - (right.memory || 0);
    })[0]?.id || "";
}

function chooseDefaultImage() {
  const images = (state.catalog?.images || []).filter(
    (image) => image && image.deprecated !== true && image.status !== "disabled",
  );
  const priority = [
    "linode/ubuntu24.04",
    "linode/ubuntu22.04",
    "linode/debian12",
    "linode/alpine3.20",
  ];
  for (const id of priority) {
    if (images.some((image) => image.id === id)) {
      return id;
    }
  }
  return images[0]?.id || "";
}

async function startAvailabilityCheck(region, tokenId = state.create.tokenId) {
  if (!region || !hasCredentials()) {
    return;
  }
  const sequence = ++availabilitySequence;
  state.availability = {
    loading: true,
    region,
    plans: null,
    error: "",
  };
  if (state.view === "create") {
    renderView();
  }

  try {
    const result = await api.availability(region, tokenId);
    if (
      sequence !== availabilitySequence ||
      state.create.region !== region ||
      state.create.tokenId !== tokenId
    ) {
      return;
    }
    state.availability = {
      loading: false,
      region,
      plans: result.plans || {},
      error: "",
    };
    ensureCreateSelections();
  } catch (error) {
    if (
      sequence !== availabilitySequence ||
      state.create.region !== region ||
      state.create.tokenId !== tokenId
    ) {
      return;
    }
    state.availability = {
      loading: false,
      region,
      plans: null,
      error: friendlyError(error),
    };
    ensureCreateSelections();
  }

  if (state.view === "create") {
    renderView();
  }
}

function activateCreateView() {
  if (!hasCredentials()) {
    renderView();
    return;
  }
  if (!state.catalog || state.catalogTokenId !== state.create.tokenId) {
    if (!state.catalogLoading && !state.catalogError) {
      void loadCatalog({ tokenId: state.create.tokenId });
    }
    renderView();
    return;
  }
  ensureCreateSelections();
  const region = state.create.region;
  if (
    region &&
    state.availability.region !== region &&
    !state.availability.loading
  ) {
    void startAvailabilityCheck(region, state.create.tokenId);
  } else {
    renderView();
  }
}

async function loadOverview({ silent = false, suppressRender = false } = {}) {
  if (!silent) {
    state.loading = true;
  }

  try {
    const overview = await api.overview();
    state.overview = overview;
    state.overviewError =
      Array.isArray(overview.errors) && overview.errors.length > 0
        ? overview.errors
            .map((entry) => `${entry.tokenLabel}: ${entry.message}`)
            .join("；")
        : null;
    state.authInvalid = false;
  } catch (error) {
    if (error.status === 401) {
      state.authInvalid = true;
    }
    state.overviewError = friendlyError(error);
  } finally {
    if (!silent) {
      state.loading = false;
    }
    updateShell();
    if (!suppressRender) {
      renderView();
    }
  }
}

async function loadCatalog({
  suppressRender = false,
  tokenId = state.create.tokenId,
} = {}) {
  if (state.catalogLoading && state.catalogTokenId === tokenId) {
    return;
  }
  state.catalogLoading = true;
  state.catalogTokenId = tokenId;
  state.catalogError = "";

  try {
    state.catalog = await api.catalog(tokenId);
    ensureCreateSelections();
  } catch (error) {
    state.catalogError = friendlyError(error);
  } finally {
    state.catalogLoading = false;
    updateShell();
    if (!suppressRender) {
      if (state.view === "create") {
        activateCreateView();
      } else {
        renderView();
      }
    }
  }
}

function applySettings(settings) {
  state.settings = settings;
  state.session.tokenConfigured = Boolean(settings?.tokenConfigured);
  state.session.credentialSource = settings?.credentialSource || "none";
  state.session.credentialLabel = settings?.credentialLabel || "";
  state.session.envTokenConfigured = Boolean(settings?.envTokenConfigured);
  if (settings?.tokenConfigured) {
    state.authInvalid = false;
  }
  ensureCreateToken();
  updateShell();
}

function ensureCreateToken() {
  const credentials = Array.isArray(state.settings?.credentials)
    ? state.settings.credentials
    : [];
  if (
    !state.create.tokenId ||
    !credentials.some((entry) => entry.id === state.create.tokenId)
  ) {
    state.create.tokenId =
      credentials.find((entry) => entry.active)?.id ||
      credentials[0]?.id ||
      "";
  }
}

async function loadSettings({ suppressRender = false } = {}) {
  try {
    applySettings(await api.settings());
  } catch (error) {
    showToast(friendlyError(error), "error");
  }
  if (!suppressRender && state.view === "settings") {
    renderView();
  }
}

async function refreshAfterSettingsChange() {
  await loadSettings({ suppressRender: true });
  if (!hasCredentials()) {
    state.loading = false;
    state.overview = null;
    state.catalog = null;
    state.overviewError = null;
    renderView();
    updateShell();
    return;
  }
  await loadInitialData();
}

async function loadInitialData() {
  if (!hasCredentials()) {
    state.loading = false;
    renderView();
    updateShell();
    return;
  }
  state.loading = true;
  renderView();
  await Promise.all([
    loadOverview({ suppressRender: true }),
    loadCatalog({ suppressRender: true }),
  ]);
  state.loading = false;
  updateShell();

  if (state.view === "create") {
    activateCreateView();
  } else {
    renderView();
  }
}

async function refreshAll({ silent = false, includeCatalog = false } = {}) {
  if (!hasCredentials()) {
    openTokenModal();
    return;
  }
  if (state.refreshing) {
    return;
  }

  state.refreshing = true;
  updateShell();

  const tasks = [loadOverview({ silent: true, suppressRender: true })];
  if (includeCatalog) {
    tasks.push(loadCatalog({ suppressRender: true }));
  }
  await Promise.all(tasks);
  state.refreshing = false;

  if (!silent) {
    if (state.view === "create") {
      activateCreateView();
    } else if (state.view !== "settings") {
      renderView();
    }
    if (state.overviewError) {
      showToast(state.overviewError, "error");
    } else {
      showToast("数据已刷新", "success");
    }
  } else if (
    !state.detail.open &&
    state.view !== "create" &&
    state.view !== "settings"
  ) {
    renderView();
  }
  updateShell();
}

function showToast(message, type = "success") {
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  const iconName =
    type === "error" ? "alert" : type === "info" ? "info" : "check";
  toast.innerHTML = `
    <span class="toast-icon">${icon(iconName)}</span>
    <span class="toast-message">${escapeHtml(message)}</span>
    <button type="button" class="toast-close" aria-label="关闭通知">${icon("x")}</button>
  `;
  toast.querySelector(".toast-close").addEventListener("click", () => dismissToast(toast));
  elements.toastRoot.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("is-visible"));
  setTimeout(() => dismissToast(toast), type === "error" ? 6500 : 4200);
}

function dismissToast(toast) {
  if (!toast.isConnected) return;
  toast.classList.remove("is-visible");
  setTimeout(() => toast.remove(), 220);
}

function openTokenModal({ error = "" } = {}) {
  if (state.modal && state.modal.type !== "token") {
    return;
  }
  state.modal = {
    type: "token",
    error,
    busy: false,
  };
  renderModal();
  requestAnimationFrame(() => {
    document.querySelector("#token-input")?.focus();
  });
}

function closeModal() {
  if (state.modal?.busy) {
    return;
  }
  state.modal = null;
  renderModal();
  updateShell();
}

function renderModal() {
  if (!state.modal) {
    elements.modalRoot.innerHTML = "";
    syncBodyLock();
    return;
  }

  if (state.modal.type === "token") {
    const hasServerToken = Boolean(state.settings?.tokenConfigured);
    elements.modalRoot.innerHTML = `
      <div class="modal-layer">
        <div class="modal-backdrop" data-action="close-modal"></div>
        <section class="modal-card modal-token" role="dialog" aria-modal="true" aria-labelledby="token-modal-title">
          <button type="button" class="icon-button modal-close" data-action="close-modal" aria-label="关闭">${icon("x")}</button>
          <span class="modal-mark">${icon("key")}</span>
          <span class="eyebrow">SECURE CONNECTION</span>
          <h2 id="token-modal-title">${hasServerToken ? "添加 Linode 令牌" : "连接你的 Linode 账户"}</h2>
          <p>令牌会加密保存在本地 Node 服务中，可用于多个实例和浏览器会话。</p>

          <div class="form-alert${state.modal.error ? "" : " is-hidden"}" id="token-error" role="alert">
            ${icon("alert")}
            <span>${escapeHtml(state.modal.error)}</span>
          </div>

          <form id="token-form" novalidate>
            <label class="form-field">
              <span class="field-label">令牌名称 <em>可选</em></span>
              <input type="text" id="token-label" name="label" placeholder="例如 生产账户、备用账户" maxlength="64" autocomplete="off" />
            </label>
            <label class="form-field">
              <span class="field-label">Personal Access Token</span>
              <span class="input-action-wrap">
                <span class="input-leading">${icon("key")}</span>
                <input
                  type="password"
                  id="token-input"
                  name="token"
                  placeholder="粘贴以 linode_ 开头的令牌"
                  autocomplete="off"
                  spellcheck="false"
                  aria-describedby="token-help"
                />
                <button type="button" class="input-action" data-action="toggle-token-visibility" aria-label="显示令牌">
                  ${icon("eye")}
                </button>
              </span>
              <span class="field-hint" id="token-help">服务端使用 AES-256-GCM 加密保存；浏览器不会接收或持久化令牌。</span>
            </label>

            <div class="scope-box">
              <span class="scope-title">${icon("shield")} 推荐权限</span>
              <span class="scope-list">
                <span>Linodes <strong>Read / Write</strong></span>
                <span>IPs <strong>Read / Write</strong></span>
                <span>Account <strong>Read Only</strong></span>
                <span>Images <strong>Read Only</strong></span>
                <span>Events <strong>Read Only</strong></span>
              </span>
            </div>

            <label class="simple-checkbox token-activate-row">
              <input type="checkbox" id="token-activate" checked />
              <span>${icon("check")}</span>
              <span>保存后设为默认令牌</span>
            </label>

            <button type="submit" class="button button-primary button-block token-submit">
              ${icon("zap")} <span>保存并连接</span>
            </button>
          </form>

          <div class="modal-foot">
            <span>${icon("shield")} 保存在本机 data/settings.json</span>
            <a href="https://cloud.linode.com/profile/tokens" target="_blank" rel="noreferrer">
              创建令牌 ${icon("external-link")}
            </a>
          </div>
        </section>
      </div>
    `;
  } else if (state.modal.type === "delete-token") {
    const token = state.modal.token;
    elements.modalRoot.innerHTML = `
      <div class="modal-layer">
        <div class="modal-backdrop" data-action="close-modal"></div>
        <section class="modal-card modal-delete" role="dialog" aria-modal="true" aria-labelledby="delete-token-title">
          <button type="button" class="icon-button modal-close" data-action="close-modal" aria-label="关闭">${icon("x")}</button>
          <span class="modal-mark modal-mark-danger">${icon("key")}</span>
          <span class="eyebrow eyebrow-danger">REMOVE CREDENTIAL</span>
          <h2 id="delete-token-title">删除本地令牌</h2>
          <p>将从本机加密存储中删除 <strong>${escapeHtml(token.label)}</strong>（${escapeHtml(token.masked)}）。这不会撤销 Linode 上的 Personal Access Token。</p>
          <form id="delete-token-form">
            <div class="form-alert is-hidden" id="delete-token-error" role="alert">${icon("alert")}<span></span></div>
            <div class="modal-actions">
              <button type="button" class="button button-secondary" data-action="close-modal">取消</button>
              <button type="submit" class="button button-danger delete-token-submit">${icon("trash")} 删除令牌</button>
            </div>
          </form>
        </section>
      </div>
    `;
  } else if (state.modal.type === "delete") {
    const instance = state.modal.instance;
    elements.modalRoot.innerHTML = `
      <div class="modal-layer">
        <div class="modal-backdrop" data-action="close-modal"></div>
        <section class="modal-card modal-delete" role="dialog" aria-modal="true" aria-labelledby="delete-modal-title">
          <button type="button" class="icon-button modal-close" data-action="close-modal" aria-label="关闭">${icon("x")}</button>
          <span class="modal-mark modal-mark-danger">${icon("trash")}</span>
          <span class="eyebrow eyebrow-danger">DESTRUCTIVE ACTION</span>
          <h2 id="delete-modal-title">永久删除实例</h2>
          <p>即将删除 <strong>${escapeHtml(instance.label || `linode-${instance.id}`)}</strong>（ID ${escapeHtml(instance.id)}）。磁盘、配置、公网地址和未备份数据都将永久丢失。</p>
          <form id="delete-form" novalidate>
            <label class="form-field">
              <span class="field-label">输入实例名称 <code>${escapeHtml(instance.label || `linode-${instance.id}`)}</code> 以确认</span>
              <input type="text" id="delete-confirm" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(instance.label || `linode-${instance.id}`)}" />
            </label>
            <div class="form-alert is-hidden" id="delete-error" role="alert">${icon("alert")}<span></span></div>
            <div class="modal-actions">
              <button type="button" class="button button-secondary" data-action="close-modal">取消</button>
              <button type="submit" class="button button-danger delete-submit">${icon("trash")} 永久删除</button>
            </div>
          </form>
        </section>
      </div>
    `;
  } else if (state.modal.type === "ip-swap") {
    elements.modalRoot.innerHTML = renderIpSwapModal(state);
  } else if (state.modal.type === "ip-renew") {
    elements.modalRoot.innerHTML = renderIpRenewModal(state);
  }

  enhanceSelects(elements.modalRoot);
  syncBodyLock();
  requestAnimationFrame(() => {
    elements.modalRoot.querySelector(".modal-card")?.classList.add("is-open");
  });
}

async function connectWithToken(rawToken, { label = "", activate = true } = {}) {
  const token = rawToken.trim();
  if (!token) {
    throw new ApiError("请输入 API 令牌。", { status: 400, code: "TOKEN_REQUIRED" });
  }

  const created = await api.addToken({ label, token });
  let publicSettings = created.settings;

  if (activate && created.tokenId) {
    try {
      const activated = await api.activateToken(created.tokenId);
      publicSettings = activated.settings;
    } catch (error) {
      showToast(`令牌已保存，但切换失败：${friendlyError(error)}`, "error");
    }
  }

  applySettings(publicSettings);
  state.authInvalid = false;
  state.modal = null;
  renderModal();
  updateShell();
  await refreshAfterSettingsChange();
  showToast("API 令牌已加密保存", "success");
}

function handleUnauthorized(error) {
  state.authInvalid = true;
  state.overviewError = friendlyError(error);
  updateShell();

  const errorElement = document.querySelector("#token-error");
  if (state.modal?.type === "token" && errorElement) {
    errorElement.classList.remove("is-hidden");
    errorElement.querySelector("span").textContent =
      "令牌无效或权限不足，请检查后重试。";
  } else if (!state.modal) {
    if (state.view === "settings") {
      renderView();
      showToast("当前令牌无效或已过期，请切换或添加新令牌。", "error");
    } else {
      openTokenModal({ error: "当前令牌无效或已过期，请重新连接。" });
    }
  }
}

async function handleTokenSubmit(event) {
  event.preventDefault();
  if (state.modal?.busy) {
    return;
  }
  const form = event.currentTarget;
  const input = form.querySelector("#token-input");
  const labelInput = form.querySelector("#token-label");
  const activateInput = form.querySelector("#token-activate");
  const errorElement = document.querySelector("#token-error");
  const submit = form.querySelector(".token-submit");
  const token = input.value.trim();

  if (!token) {
    errorElement.classList.remove("is-hidden");
    errorElement.querySelector("span").textContent = "请输入 API 令牌。";
    input.focus();
    return;
  }

  state.modal.busy = true;
  errorElement.classList.add("is-hidden");
  input.disabled = true;
  labelInput.disabled = true;
  activateInput.disabled = true;
  submit.disabled = true;
  submit.innerHTML = `${spinner()}<span>正在验证…</span>`;

  try {
    await connectWithToken(token, {
      label: labelInput.value.trim(),
      activate: activateInput.checked,
    });
  } catch (error) {
    if (state.modal?.type === "token") {
      errorElement.classList.remove("is-hidden");
      errorElement.querySelector("span").textContent = friendlyError(error);
      state.modal.busy = false;
      input.disabled = false;
      labelInput.disabled = false;
      activateInput.disabled = false;
      submit.disabled = false;
      submit.innerHTML = `${icon("zap")}<span>保存并连接</span>`;
      input.focus();
      input.select();
    }
  }
}

function openDeleteTokenModal(token) {
  if (!token) {
    return;
  }
  state.modal = { type: "delete-token", token, busy: false };
  renderModal();
}

async function handleDeleteTokenSubmit(event) {
  event.preventDefault();
  if (state.modal?.type !== "delete-token" || state.modal.busy) {
    return;
  }
  const token = state.modal.token;
  const errorElement = document.querySelector("#delete-token-error");
  const submit = document.querySelector(".delete-token-submit");

  state.modal.busy = true;
  errorElement.classList.add("is-hidden");
  submit.disabled = true;
  submit.innerHTML = `${spinner()}<span>正在删除…</span>`;

  try {
    const result = await api.deleteToken(token.id);
    applySettings(result.settings);
    state.modal = null;
    renderModal();
    await refreshAfterSettingsChange();
    showToast(`令牌 ${token.label} 已从本机删除`, "success");
  } catch (error) {
    if (state.modal?.type === "delete-token") {
      errorElement.classList.remove("is-hidden");
      errorElement.querySelector("span").textContent = friendlyError(error);
      state.modal.busy = false;
      submit.disabled = false;
      submit.innerHTML = `${icon("trash")} 删除令牌`;
    }
  }
}

function openDeleteModal(instance) {
  if (!instance) {
    return;
  }
  state.modal = { type: "delete", instance, busy: false };
  renderModal();
  requestAnimationFrame(() => {
    document.querySelector("#delete-confirm")?.focus();
  });
}

async function handleDeleteSubmit(event) {
  event.preventDefault();
  if (state.modal?.type !== "delete" || state.modal.busy) {
    return;
  }
  const instance = state.modal.instance;
  const input = document.querySelector("#delete-confirm");
  const errorElement = document.querySelector("#delete-error");
  const submit = document.querySelector(".delete-submit");
  const expected = instance.label || `linode-${instance.id}`;

  if (input.value.trim() !== expected) {
    errorElement.classList.remove("is-hidden");
    errorElement.querySelector("span").textContent = "实例名称不匹配，请准确输入。";
    input.focus();
    input.select();
    return;
  }

  state.modal.busy = true;
  errorElement.classList.add("is-hidden");
  input.disabled = true;
  submit.disabled = true;
  submit.innerHTML = `${spinner()}<span>正在删除…</span>`;

  try {
    await api.remove(instance.id, instance.tokenId);
    state.modal = null;
    renderModal();
    closeDrawer();
    state.overview = state.overview
      ? {
          ...state.overview,
          instances: (state.overview.instances || []).filter(
            (entry) =>
              !(
                String(entry.id) === String(instance.id) &&
                (!instance.tokenId ||
                  String(entry.tokenId) === String(instance.tokenId))
              ),
          ),
        }
      : null;
    renderView();
    showToast(`实例 ${expected} 已删除`, "success");
    await loadOverview({ silent: true, suppressRender: true });
    renderView();
  } catch (error) {
    if (state.modal?.type === "delete") {
      errorElement.classList.remove("is-hidden");
      errorElement.querySelector("span").textContent = friendlyError(error);
      state.modal.busy = false;
      input.disabled = false;
      submit.disabled = false;
      submit.innerHTML = `${icon("trash")} 永久删除`;
      input.focus();
    }
  }
}

function ipSwapCandidates(instance) {
  const tokenId = instance?.tokenId || "";
  return (state.overview?.instances || [])
    .filter(
      (entry) =>
        String(entry.id) !== String(instance.id) &&
        String(entry.tokenId || "") === String(tokenId) &&
        entry.region === instance.region &&
        !isTransitional(entry.status),
    )
    .map((entry) => ({
      id: String(entry.id),
      label: entry.label || `linode-${entry.id}`,
      region: entry.region,
    }))
    .sort((left, right) =>
      left.label.localeCompare(right.label, "zh-CN"),
    );
}

async function openIpSwapModal(instance) {
  if (!instance || isTransitional(instance.status)) {
    return;
  }

  state.modal = {
    type: "ip-swap",
    instance,
    candidates: ipSwapCandidates(instance),
    sourceInfo: null,
    sourceLoading: true,
    targetInfo: null,
    targetId: "",
    targetLoading: false,
    kind: "ipv4",
    error: "",
    busy: false,
  };
  renderModal();
  updateShell();

  try {
    const info = await api.instanceIps(instance.id, instance.tokenId);
    if (
      state.modal?.type !== "ip-swap" ||
      String(state.modal.instance?.id) !== String(instance.id)
    ) {
      return;
    }
    state.modal.sourceInfo = info;
    state.modal.sourceLoading = false;
    if (!info.ipv4Swappable && info.ipv6Swappable) {
      state.modal.kind = "ipv6";
    }
  } catch (error) {
    if (
      state.modal?.type !== "ip-swap" ||
      String(state.modal.instance?.id) !== String(instance.id)
    ) {
      return;
    }
    state.modal.sourceLoading = false;
    state.modal.error = friendlyError(error);
  }

  renderModal();
}

async function loadIpSwapTarget(targetId) {
  if (state.modal?.type !== "ip-swap") {
    return;
  }
  const modal = state.modal;
  modal.targetId = targetId ? String(targetId) : "";
  modal.targetInfo = null;
  modal.error = "";

  const candidate = modal.candidates.find(
    (entry) => String(entry.id) === String(targetId),
  );
  if (!candidate) {
    modal.targetLoading = false;
    renderModal();
    return;
  }

  modal.targetLoading = true;
  renderModal();

  try {
    const info = await api.instanceIps(candidate.id, modal.instance.tokenId);
    if (
      state.modal?.type !== "ip-swap" ||
      String(state.modal.targetId) !== String(candidate.id)
    ) {
      return;
    }
    state.modal.targetInfo = info;
    state.modal.targetLoading = false;
  } catch (error) {
    if (
      state.modal?.type !== "ip-swap" ||
      String(state.modal.targetId) !== String(candidate.id)
    ) {
      return;
    }
    state.modal.targetLoading = false;
    state.modal.error = friendlyError(error);
  }

  renderModal();
}

async function handleIpSwapSubmit(event) {
  event.preventDefault();
  if (state.modal?.type !== "ip-swap" || state.modal.busy) {
    return;
  }

  const modal = state.modal;
  const info = modal.sourceInfo;
  const targetInfo = modal.targetInfo;
  const kind = modal.kind === "ipv6" ? "ipv6" : "ipv4";
  const sourceAddress =
    kind === "ipv6"
      ? info?.ipv6Ranges?.[0]?.range
      : info?.publicIpv4;
  const targetAddress =
    kind === "ipv6"
      ? targetInfo?.ipv6Ranges?.[0]?.range
      : targetInfo?.publicIpv4;

  if (!modal.targetId || !targetInfo || !sourceAddress || !targetAddress) {
    modal.error =
      kind === "ipv6"
        ? "双方都必须拥有 /56 或 /64 IPv6 路由段，且目标实例已加载完成。"
        : "双方都必须拥有可交换的公网 IPv4 地址，且目标实例已加载完成。";
    renderModal();
    return;
  }

  modal.busy = true;
  modal.error = "";
  renderModal();

  try {
    const sourceId = modal.instance.id;
    const tokenId = modal.instance.tokenId;
    await api.swapIp(sourceId, tokenId, {
      targetId: Number(modal.targetId),
      kind,
    });

    state.modal = null;
    renderModal();
    updateShell();
    showToast(
      `已交换${kind === "ipv4" ? " IPv4 公网地址" : " IPv6 路由段"}，请重启两台实例后生效`,
      "success",
    );

    await loadOverview({ silent: true, suppressRender: true });
    if (
      state.detail.open &&
      String(state.detail.id) === String(sourceId)
    ) {
      await loadDetail(sourceId, tokenId, { silent: true });
    } else if (state.view !== "create") {
      renderView();
    }
    updateShell();
  } catch (error) {
    if (state.modal?.type === "ip-swap") {
      state.modal.busy = false;
      state.modal.error = friendlyError(error);
      renderModal();
    }
  }
}

async function openIpRenewModal(instance) {
  if (!instance || isTransitional(instance.status)) {
    return;
  }

  state.modal = {
    type: "ip-renew",
    instance,
    sourceInfo: null,
    sourceLoading: true,
    kind: "ipv4",
    ipv6Prefix: 64,
    confirmed: false,
    error: "",
    busy: false,
  };
  renderModal();
  updateShell();

  try {
    const info = await api.instanceIps(instance.id, instance.tokenId);
    if (
      state.modal?.type !== "ip-renew" ||
      String(state.modal.instance?.id) !== String(instance.id)
    ) {
      return;
    }
    state.modal.sourceInfo = info;
    state.modal.sourceLoading = false;
    if (!info.publicIpv4) {
      state.modal.kind = "ipv6";
    }
  } catch (error) {
    if (
      state.modal?.type !== "ip-renew" ||
      String(state.modal.instance?.id) !== String(instance.id)
    ) {
      return;
    }
    state.modal.sourceLoading = false;
    state.modal.error = friendlyError(error);
  }

  renderModal();
}

async function handleIpRenewSubmit(event) {
  event.preventDefault();
  if (state.modal?.type !== "ip-renew" || state.modal.busy) {
    return;
  }

  const modal = state.modal;
  const info = modal.sourceInfo;
  const kind = modal.kind === "ipv6" ? "ipv6" : "ipv4";
  if (!info) {
    modal.error = "尚未读取到实例的当前网络信息，请稍后重试。";
    renderModal();
    return;
  }
  if (!modal.confirmed) {
    modal.error = "请先确认旧 IP 会释放且实例需要重启。";
    renderModal();
    return;
  }
  if (kind === "ipv4" && !info.publicIpv4) {
    modal.error = "当前实例没有可替换的公网 IPv4 地址。";
    renderModal();
    return;
  }

  modal.busy = true;
  modal.error = "";
  renderModal();

  try {
    const sourceId = modal.instance.id;
    const tokenId = modal.instance.tokenId;
    const payload =
      kind === "ipv6"
        ? { kind, ipv6Prefix: Number(modal.ipv6Prefix) === 56 ? 56 : 64 }
        : { kind };
    const result = await api.renewIp(sourceId, tokenId, payload);

    state.modal = null;
    renderModal();
    updateShell();

    const newValue =
      kind === "ipv4" ? result?.newAddress || "" : result?.newRange || "";
    showToast(
      newValue
        ? `已获取新${kind === "ipv4" ? " IPv4 地址" : " IPv6 路由段"} ${newValue}，请重启实例后生效`
        : "IP 已换新，请重启实例后生效",
      "success",
    );

    const warnings = Array.isArray(result?.warnings)
      ? result.warnings
          .filter((warning) => typeof warning === "string" && warning.trim())
          .map((warning) => warning.trim())
      : [];
    if (warnings.length > 0) {
      showToast(`换新 IP 警告：${warnings.join("；")}`, "error");
    }

    await loadOverview({ silent: true, suppressRender: true });
    if (
      state.detail.open &&
      String(state.detail.id) === String(sourceId)
    ) {
      await loadDetail(sourceId, tokenId, { silent: true });
    } else if (state.view !== "create") {
      renderView();
    }
    updateShell();
    setTimeout(() => {
      void refreshAfterAction(sourceId, tokenId);
    }, 4_000);
  } catch (error) {
    if (state.modal?.type === "ip-renew") {
      state.modal.busy = false;
      state.modal.error = friendlyError(error);
      renderModal();
    }
  }
}

async function loadDetail(instanceId, tokenId, { silent = false } = {}) {
  const requestedTokenId = tokenId || null;
  if (!silent) {
    state.detail.loading = true;
    state.detail.error = null;
    renderDrawer();
  }

  try {
    const [detailResult, ipsResult] = await Promise.allSettled([
      api.detail(instanceId, requestedTokenId),
      api.instanceIps(instanceId, requestedTokenId),
    ]);
    if (detailResult.status !== "fulfilled") {
      throw detailResult.reason;
    }
    const data = detailResult.value;
    if (ipsResult.status === "fulfilled") {
      data.ips = ipsResult.value;
    }
    if (
      !state.detail.open ||
      String(state.detail.id) !== String(instanceId) ||
      state.detail.tokenId !== requestedTokenId
    ) {
      return;
    }
    state.detail.data = data;
    state.detail.loading = false;
    state.detail.error = null;
    mergeInstance(data.instance);
  } catch (error) {
    if (
      !state.detail.open ||
      String(state.detail.id) !== String(instanceId) ||
      state.detail.tokenId !== requestedTokenId
    ) {
      return;
    }
    state.detail.loading = false;
    state.detail.error = friendlyError(error);
  }

  renderDrawer();
  updateShell();
}

function mergeInstance(instance) {
  if (!instance || !state.overview?.instances) {
    return;
  }
  const index = state.overview.instances.findIndex(
    (entry) =>
      String(entry.id) === String(instance.id) &&
      (!instance.tokenId ||
        String(entry.tokenId) === String(instance.tokenId)),
  );
  if (index >= 0) {
    state.overview.instances[index] = {
      ...state.overview.instances[index],
      ...instance,
    };
  }
}

function openDetail(instanceId, tokenId) {
  state.detail = {
    open: true,
    id: String(instanceId),
    tokenId: tokenId || null,
    loading: true,
    error: null,
    data: null,
    returnFocus: document.activeElement,
  };
  renderDrawer();
  syncBodyLock();
  void loadDetail(instanceId, tokenId);
  requestAnimationFrame(() => {
    document.querySelector(".drawer-close")?.focus();
  });
}

function closeDrawer() {
  const returnFocus = state.detail.returnFocus;
  state.detail = {
    open: false,
    id: null,
    tokenId: null,
    loading: false,
    error: null,
    data: null,
    returnFocus: null,
  };
  renderDrawer();
  syncBodyLock();
  if (returnFocus && typeof returnFocus.focus === "function" && returnFocus.isConnected) {
    returnFocus.focus();
  }
}

function renderDrawer() {
  elements.drawerRoot.innerHTML = renderDrawerView(state);
  if (state.detail.open) {
    document.body.classList.add("drawer-open");
  } else {
    document.body.classList.remove("drawer-open");
  }
}

async function runInstanceAction(instanceId, operation, tokenId) {
  const instance =
    state.overview?.instances?.find(
      (entry) => String(entry.id) === String(instanceId),
    ) || state.detail.data?.instance;
  if (!instance || isTransitional(instance.status)) {
    return;
  }

  const operationLabel = OPERATION_LABELS[operation] || operation;
  const busyKey = `${instanceId}:${operation}`;
  if (state.busyActions.has(busyKey)) {
    return;
  }
  state.busyActions.add(busyKey);
  refreshCurrentSurface();

  try {
    await api.action(instanceId, operation, tokenId);
    showToast(`已向 ${instance.label || instanceId} 发送${operationLabel}请求`, "success");
    await loadOverview({ silent: true, suppressRender: true });
    if (state.detail.open && String(state.detail.id) === String(instanceId)) {
      await loadDetail(instanceId, tokenId, { silent: true });
    } else if (state.view !== "create") {
      renderView();
    }
    setTimeout(() => {
      void refreshAfterAction(instanceId, tokenId);
    }, 4_000);
  } catch (error) {
    showToast(friendlyError(error), "error");
  } finally {
    state.busyActions.delete(busyKey);
    refreshCurrentSurface();
    updateShell();
  }
}

async function refreshAfterAction(instanceId, tokenId) {
  if (!hasCredentials()) {
    return;
  }
  await loadOverview({ silent: true, suppressRender: true });
  if (state.detail.open && String(state.detail.id) === String(instanceId)) {
    await loadDetail(instanceId, tokenId, { silent: true });
  } else if (state.view !== "create") {
    renderView();
  } else {
    updateShell();
  }
}

function refreshCurrentSurface() {
  if (state.detail.open) {
    renderDrawer();
  } else if (state.view !== "create") {
    renderView();
  } else {
    updateShell();
  }
}

function parseTags(value) {
  return [
    ...new Set(
      String(value || "")
        .split(",")
        .map((tag) => tag.trim().replace(/^#/, ""))
        .filter(Boolean),
    ),
  ].slice(0, 10);
}

function parseSshKeys(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((key) => key.trim())
    .filter(Boolean)
    .slice(0, 10);
}

function validateCreateForm() {
  if (!state.create.tokenId) {
    return "请选择用于部署的 Linode 账户。";
  }
  if (!state.create.label.trim()) {
    return "请填写实例名称。";
  }
  if (!state.create.region) {
    return "请选择部署区域。";
  }
  if (!state.create.type) {
    return "请选择计算规格。";
  }
  if (!state.create.image) {
    return "请选择系统镜像。";
  }
  if (
    state.availability.region === state.create.region &&
    state.availability.plans?.[state.create.type] === false
  ) {
    return "所选规格在当前区域不可用，请更换规格或区域。";
  }
  const sshKeys = parseSshKeys(state.create.sshKeys);
  if (!state.create.rootPass && sshKeys.length === 0) {
    return "请设置 Root 密码或至少提供一个 SSH 公钥。";
  }
  if (state.create.rootPass && state.create.rootPass.length < 12) {
    return "Root 密码至少需要 12 个字符。";
  }
  if (state.create.rootPass.length > 128) {
    return "Root 密码不能超过 128 个字符。";
  }
  if (parseTags(state.create.tags).length > 10) {
    return "最多添加 10 个标签。";
  }
  return "";
}

function setCreateFormBusy(busy) {
  const form = document.querySelector("#create-form");
  form?.querySelectorAll("input, select, textarea, button").forEach((element) => {
    element.disabled = busy;
  });
  const summaryButton = document.querySelector("#create-summary-content .create-submit");
  if (summaryButton) {
    summaryButton.disabled = busy;
  }
}

function updateCreateSummary() {
  const container = document.querySelector("#create-summary-content");
  if (!container) {
    return;
  }
  container.innerHTML = renderCreateSummary(state);
}

function updatePasswordMeter() {
  const score = passwordStrength(state.create.rootPass);
  const meter = document.querySelector(".password-meter");
  if (!meter) {
    return;
  }
  meter.dataset.score = String(score);
  const labels = ["建议使用 16 位以上随机密码", "较弱", "一般", "良好", "很强"];
  const label = document.querySelector("#password-strength-label");
  if (label) {
    label.textContent = state.create.rootPass
      ? `密码强度：${labels[score]}`
      : labels[0];
  }
}

function updateSearchResults() {
  renderView();
  const input = document.querySelector("#instance-search");
  if (input) {
    input.focus();
    input.setSelectionRange(state.filters.query.length, state.filters.query.length);
  }
}

const debouncedSearch = debounce(updateSearchResults, 160);
const debouncedSummary = debounce(updateCreateSummary, 80);

async function handleCreateSubmit(event) {
  event.preventDefault();
  if (state.creating) {
    return;
  }

  const validationError = validateCreateForm();
  if (validationError) {
    state.createError = validationError;
    updateCreateSummary();
    document.querySelector("#create-summary-content")?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
    return;
  }

  state.creating = true;
  state.createError = "";
  setCreateFormBusy(true);
  updateCreateSummary();

  const payload = {
    tokenId: state.create.tokenId,
    label: state.create.label.trim(),
    region: state.create.region,
    type: state.create.type,
    image: state.create.image,
    tags: parseTags(state.create.tags),
    backups_enabled: state.create.backups,
    private_ip: state.create.privateIp,
    booted: state.create.booted,
    authorized_keys: parseSshKeys(state.create.sshKeys),
  };
  if (state.create.rootPass) {
    payload.root_pass = state.create.rootPass;
  }
  if (state.create.userData.trim()) {
    payload.cloud_init = state.create.userData;
  }

  try {
    const result = await api.createInstance(payload);
    const created = result.instance;
    showToast(
      `实例 ${created?.label || state.create.label} 已提交创建`,
      "success",
    );
    state.creating = false;
    const createdTokenId = state.create.tokenId;
    state.create = newCreateState();
    state.create.tokenId = createdTokenId;
    state.createError = "";
    state.availability = {
      loading: false,
      region: "",
      plans: null,
      error: "",
    };
    await loadOverview({ silent: true, suppressRender: true });
    ensureCreateSelections();
    if (window.location.hash === "#instances") {
      renderView();
    } else {
      window.location.hash = "#instances";
    }
  } catch (error) {
    state.creating = false;
    state.createError = friendlyError(error);
    setCreateFormBusy(false);
    updateCreateSummary();
  }
}

async function activateSettingsToken(tokenId) {
  const token = state.settings?.tokens?.find((entry) => entry.id === tokenId);
  try {
    const result = await api.activateToken(tokenId);
    applySettings(result.settings);
    await refreshAfterSettingsChange();
    showToast(`已将 ${token?.label || "该令牌"} 设为默认令牌`, "success");
  } catch (error) {
    showToast(friendlyError(error), "error");
  }
}

async function testSettingsToken(tokenId) {
  const token = state.settings?.tokens?.find((entry) => entry.id === tokenId);
  try {
    const result = await api.testToken(tokenId);
    applySettings(result.settings);
    if (state.view === "settings") {
      renderView();
    }
    showToast(
      `令牌 ${token?.label || ""} 可用 · ${result.verification.latencyMs} ms`,
      "success",
    );
  } catch (error) {
    showToast(friendlyError(error), "error");
  }
}

async function importEnvToken() {
  try {
    const result = await api.importEnvToken();
    applySettings(result.settings);
    await refreshAfterSettingsChange();
    showToast("已从 .env 导入令牌，现在可在页面中管理", "success");
  } catch (error) {
    showToast(friendlyError(error), "error");
  }
}

function renderConnectionDiagnostic(result) {
  const box = document.querySelector("#connection-diagnostic");
  if (!box) {
    return;
  }
  const proxyOk = result.proxy?.ok;
  const tokenOk = result.token?.ok;
  const tokenChecks = Array.isArray(result.tokens) ? result.tokens : [];
  const item = (label, check, iconName) => `
    <div class="diagnostic-item ${check.ok ? "ok" : "fail"}">
      <span class="diagnostic-item-icon">${icon(check.ok ? "check" : "alert")}</span>
      <span class="diagnostic-item-copy">
        <strong>${escapeHtml(label)}</strong>
        <span>${escapeHtml(check.message || "")}${check.latencyMs !== undefined ? ` · ${check.latencyMs} ms` : ""}</span>
      </span>
    </div>
  `;
  box.classList.remove("is-hidden");
  box.innerHTML = `
    <div class="diagnostic-head">
      <strong>${result.ok ? "连接正常" : "连接存在问题"}</strong>
      <span>${escapeHtml(relativeTime(result.checkedAt))}</span>
    </div>
    <div class="diagnostic-grid">
      ${item("SOCKS 代理", result.proxy || { ok: true, message: "未启用" }, "network")}
      ${item("API 令牌", result.token || { ok: false, message: "未配置" }, "key")}
    </div>
    ${
      tokenChecks.length > 1
        ? `<div class="diagnostic-token-list">
            ${tokenChecks
              .map(
                (token) => `<span class="diagnostic-token${token.ok ? " is-ok" : " is-fail"}">
                  ${icon(token.ok ? "check" : "alert")}
                  <strong>${escapeHtml(token.accountLabel || token.label)}</strong>
                  <small>${escapeHtml(token.message)}${token.latencyMs !== undefined ? ` · ${token.latencyMs} ms` : ""}</small>
                </span>`,
              )
              .join("")}
          </div>`
        : ""
    }
  `;
  return { proxyOk, tokenOk };
}

async function runConnectionTest(target) {
  if (target) {
    target.disabled = true;
  }
  const box = document.querySelector("#connection-diagnostic");
  if (box) {
    box.classList.remove("is-hidden");
    box.innerHTML = `<div class="diagnostic-head"><strong>${spinner()} 正在检查代理与令牌…</strong></div>`;
  }

  try {
    const result = await api.testConnection();
    renderConnectionDiagnostic(result);
    showToast(
      result.ok ? "代理与 API 令牌连接正常" : "连接测试未通过，请查看诊断详情",
      result.ok ? "success" : "error",
    );
  } catch (error) {
    if (box) {
      box.classList.remove("is-hidden");
      box.innerHTML = `<div class="form-alert">${icon("alert")}<span>${escapeHtml(friendlyError(error))}</span></div>`;
    }
    showToast(friendlyError(error), "error");
  } finally {
    if (target?.isConnected) {
      target.disabled = false;
    }
  }
}

function showProxyResult(message, type = "ok") {
  const box = document.querySelector("#proxy-result");
  if (!box) {
    return;
  }
  box.classList.remove("is-hidden");
  box.classList.toggle("is-ok", type === "ok");
  box.classList.toggle("is-error", type === "error");
  box.innerHTML = `${icon(type === "ok" ? "check" : "alert")}<span>${escapeHtml(message)}</span>`;
}

async function testProxySettings(target) {
  const url = document.querySelector("#proxy-url")?.value.trim() || "";
  const username = document.querySelector("#proxy-username")?.value.trim() || "";
  const password = document.querySelector("#proxy-password")?.value || "";
  if (!url) {
    showProxyResult("请填写 SOCKS 代理地址。", "error");
    return;
  }

  if (target) {
    target.disabled = true;
  }
  showProxyResult("正在通过代理连接 Linode API…", "ok");
  try {
    const result = await api.testProxy({
      enabled: true,
      url,
      username,
      password,
    });
    showProxyResult(
      `${result.message}${result.latencyMs !== undefined ? ` · ${result.latencyMs} ms` : ""}`,
      result.ok ? "ok" : "error",
    );
  } catch (error) {
    showProxyResult(friendlyError(error), "error");
  } finally {
    if (target?.isConnected) {
      target.disabled = false;
    }
  }
}

function handleClick(event) {
  const copyTarget = event.target.closest("[data-copy]");
  if (copyTarget) {
    event.preventDefault();
    void copyToClipboard(copyTarget.dataset.copy).then((copied) => {
      showToast(copied ? "已复制到剪贴板" : "复制失败，请手动选择文本", copied ? "success" : "error");
    });
    return;
  }

  const target = event.target.closest("[data-action]");
  if (!target) {
    return;
  }
  const action = target.dataset.action;

  switch (action) {
    case "refresh-overview":
      void refreshAll({ includeCatalog: state.view === "create" });
      break;
    case "global-search":
      if (state.view !== "instances") {
        window.location.hash = "#instances";
        setTimeout(() => document.querySelector("#instance-search")?.focus(), 80);
      } else {
        document.querySelector("#instance-search")?.focus();
      }
      break;
    case "open-token":
      openTokenModal();
      break;
    case "activate-token":
      void activateSettingsToken(target.dataset.id);
      break;
    case "test-token":
      void testSettingsToken(target.dataset.id);
      break;
    case "delete-token": {
      const token = state.settings?.tokens?.find(
        (entry) => entry.id === target.dataset.id,
      );
      openDeleteTokenModal(token);
      break;
    }
    case "import-env-token":
      void importEnvToken();
      break;
    case "test-connection":
      void runConnectionTest(target);
      break;
    case "test-proxy":
      void testProxySettings(target);
      break;
    case "proxy-preset": {
      const input = document.querySelector("#proxy-url");
      if (input) {
        input.value = target.dataset.url || "";
        input.focus();
      }
      break;
    }
    case "close-modal":
      closeModal();
      break;
    case "toggle-token-visibility": {
      const input = document.querySelector("#token-input");
      if (!input) break;
      const visible = input.type === "text";
      input.type = visible ? "password" : "text";
      target.innerHTML = icon(visible ? "eye" : "eye-off");
      target.setAttribute("aria-label", visible ? "显示令牌" : "隐藏令牌");
      break;
    }
    case "toggle-password": {
      state.create.passwordVisible = !state.create.passwordVisible;
      const input = document.querySelector("#create-root-pass");
      if (input) {
        input.type = state.create.passwordVisible ? "text" : "password";
      }
      target.innerHTML = icon(state.create.passwordVisible ? "eye-off" : "eye");
      break;
    }
    case "generate-password": {
      const password = generatePassword(20);
      state.create.rootPass = password;
      state.create.passwordVisible = true;
      const input = document.querySelector("#create-root-pass");
      if (input) {
        input.value = password;
        input.type = "text";
      }
      updatePasswordMeter();
      updateCreateSummary();
      showToast("已生成 20 位随机密码", "success");
      break;
    }
    case "filter-status":
      state.filters.status = target.dataset.status || "all";
      renderView();
      break;
    case "clear-filters":
      state.filters = {
        query: "",
        status: "all",
        region: "all",
        account: "all",
      };
      renderView();
      break;
    case "open-detail":
      openDetail(target.dataset.id, target.dataset.tokenId);
      break;
    case "close-drawer":
      closeDrawer();
      break;
    case "retry-detail":
      void loadDetail(target.dataset.id, target.dataset.tokenId);
      break;
    case "instance-action":
      void runInstanceAction(
        target.dataset.id,
        target.dataset.operation,
        target.dataset.tokenId,
      );
      break;
    case "open-delete": {
      const instance =
        state.detail.data?.instance ||
        state.overview?.instances?.find(
          (entry) =>
            String(entry.id) === String(target.dataset.id) &&
            (!target.dataset.tokenId ||
              String(entry.tokenId) === String(target.dataset.tokenId)),
        );
      openDeleteModal(instance);
      break;
    }
    case "open-ip-swap": {
      const instance =
        state.detail.data?.instance ||
        state.overview?.instances?.find(
          (entry) =>
            String(entry.id) === String(target.dataset.id) &&
            (!target.dataset.tokenId ||
              String(entry.tokenId) === String(target.dataset.tokenId)),
        );
      void openIpSwapModal(instance);
      break;
    }
    case "ip-swap-kind":
      if (state.modal?.type === "ip-swap" && !state.modal.busy) {
        state.modal.kind =
          target.dataset.kind === "ipv6" ? "ipv6" : "ipv4";
        state.modal.error = "";
        renderModal();
      }
      break;
    case "open-ip-renew": {
      const instance =
        state.detail.data?.instance ||
        state.overview?.instances?.find(
          (entry) =>
            String(entry.id) === String(target.dataset.id) &&
            (!target.dataset.tokenId ||
              String(entry.tokenId) === String(target.dataset.tokenId)),
        );
      void openIpRenewModal(instance);
      break;
    }
    case "ip-renew-kind":
      if (state.modal?.type === "ip-renew" && !state.modal.busy) {
        state.modal.kind =
          target.dataset.kind === "ipv6" ? "ipv6" : "ipv4";
        state.modal.error = "";
        renderModal();
      }
      break;
    case "ip-renew-prefix":
      if (state.modal?.type === "ip-renew" && !state.modal.busy) {
        state.modal.ipv6Prefix =
          target.dataset.prefix === "56" ? 56 : 64;
        state.modal.error = "";
        renderModal();
      }
      break;
    case "retry-catalog":
      void loadCatalog();
      break;
    default:
      break;
  }
}

function handleInput(event) {
  const target = event.target;
  if (target.id === "instance-search") {
    state.filters.query = target.value;
    if (!isComposingSearch && !event.isComposing) {
      debouncedSearch();
    }
    return;
  }

  if (target.id === "create-label") {
    state.create.label = target.value;
    state.createError = "";
    debouncedSummary();
    return;
  }
  if (target.id === "create-root-pass") {
    state.create.rootPass = target.value;
    state.createError = "";
    updatePasswordMeter();
    debouncedSummary();
    return;
  }
  if (target.id === "create-tags") {
    state.create.tags = target.value;
    return;
  }
  if (target.id === "create-ssh-keys") {
    state.create.sshKeys = target.value;
    debouncedSummary();
    return;
  }
  if (target.id === "create-user-data") {
    state.create.userData = target.value;
  }
}

function handleChange(event) {
  const target = event.target;

  if (target.id === "ip-swap-target") {
    void loadIpSwapTarget(target.value);
    return;
  }
  if (target.id === "ip-renew-confirm") {
    if (state.modal?.type === "ip-renew") {
      state.modal.confirmed = target.checked;
      state.modal.error = "";
      document.querySelector("#ip-renew-error")?.classList.add("is-hidden");
      const submit = document.querySelector(
        '#ip-renew-form button[type="submit"]',
      );
      if (submit) {
        const info = state.modal.sourceInfo;
        submit.disabled =
          Boolean(state.modal.busy) ||
          Boolean(state.modal.sourceLoading) ||
          !info ||
          !target.checked ||
          (state.modal.kind === "ipv4" && !info.publicIpv4);
      }
    }
    return;
  }
  if (target.id === "account-filter") {
    state.filters.account = target.value;
    renderView();
    return;
  }
  if (target.id === "region-filter") {
    state.filters.region = target.value;
    renderView();
    return;
  }
  if (target.id === "create-token") {
    state.create.tokenId = target.value;
    state.createError = "";
    state.catalog = null;
    state.catalogTokenId = "";
    state.catalogError = "";
    state.availability = {
      loading: false,
      region: "",
      plans: null,
      error: "",
    };
    renderView();
    void loadCatalog({ tokenId: target.value }).then(() => {
      if (state.view === "create" && state.catalog) {
        void startAvailabilityCheck(state.create.region, target.value);
      }
    });
    return;
  }
  if (target.id === "create-region") {
    state.create.region = target.value;
    state.create.type = "";
    state.createError = "";
    state.availability = {
      loading: true,
      region: target.value,
      plans: null,
      error: "",
    };
    renderView();
    void startAvailabilityCheck(target.value);
    return;
  }
  if (target.id === "create-type") {
    state.create.type = target.value;
    state.createError = "";
    renderView();
    return;
  }
  if (target.id === "create-image") {
    state.create.image = target.value;
    state.createError = "";
    updateCreateSummary();
    return;
  }
  if (target.id === "create-backups") {
    state.create.backups = target.checked;
    updateCreateSummary();
    return;
  }
  if (target.id === "create-private-ip") {
    state.create.privateIp = target.checked;
    return;
  }
  if (target.id === "create-booted") {
    state.create.booted = target.checked;
    return;
  }
  if (target.id === "pref-auto-refresh") {
    state.prefs.autoRefresh = target.checked;
    savePreferences(state.prefs);
    showToast(
      target.checked ? "已开启自动刷新" : "已关闭自动刷新",
      "info",
    );
  }
}

function handleToggle(event) {
  if (event.target?.matches?.(".advanced-panel")) {
    state.create.advancedOpen = event.target.open;
  }
}

function handleSubmit(event) {
  if (event.target.id === "token-form") {
    void handleTokenSubmit(event);
  } else if (event.target.id === "delete-token-form") {
    void handleDeleteTokenSubmit(event);
  } else if (event.target.id === "proxy-form") {
    void handleProxySubmit(event);
  } else if (event.target.id === "delete-form") {
    void handleDeleteSubmit(event);
  } else if (event.target.id === "ip-swap-form") {
    void handleIpSwapSubmit(event);
  } else if (event.target.id === "ip-renew-form") {
    void handleIpRenewSubmit(event);
  } else if (event.target.id === "create-form") {
    void handleCreateSubmit(event);
  }
}

async function handleProxySubmit(event) {
  event.preventDefault();
  const enabled = document.querySelector("#proxy-enabled")?.checked === true;
  const url = document.querySelector("#proxy-url")?.value.trim() || "";
  const username = document.querySelector("#proxy-username")?.value.trim() || "";
  const password = document.querySelector("#proxy-password")?.value || "";
  const submit = event.target.querySelector('button[type="submit"]');

  if (enabled && !url) {
    showProxyResult("启用代理时必须填写 SOCKS 地址。", "error");
    return;
  }

  submit.disabled = true;
  const original = submit.innerHTML;
  submit.innerHTML = `${spinner()}<span>正在保存…</span>`;
  try {
    const result = await api.saveProxy({
      enabled,
      url,
      username,
      password,
    });
    applySettings(result.settings);
    showToast(
      enabled ? "SOCKS 代理设置已保存" : "已切换为直连",
      "success",
    );
    await refreshAfterSettingsChange();
  } catch (error) {
    showProxyResult(friendlyError(error), "error");
    showToast(friendlyError(error), "error");
  } finally {
    if (submit.isConnected) {
      submit.disabled = false;
      submit.innerHTML = original;
    }
  }
}

function handleKeydown(event) {
  const isTyping = isTypingElement();

  if (event.key === "Escape") {
    if (state.modal) {
      closeModal();
      return;
    }
    if (state.detail.open) {
      closeDrawer();
      return;
    }
    if (state.mobileNavOpen) {
      closeMobileNav();
    }
    return;
  }

  if (
    event.key === "/" &&
    !isTyping &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !state.modal
  ) {
    event.preventDefault();
    if (state.view !== "instances") {
      window.location.hash = "#instances";
      setTimeout(() => document.querySelector("#instance-search")?.focus(), 80);
    } else {
      document.querySelector("#instance-search")?.focus();
    }
  }
}

function isTypingElement() {
  const activeTag = document.activeElement?.tagName?.toLowerCase();
  return (
    ["input", "textarea", "select"].includes(activeTag) ||
    Boolean(document.activeElement?.isContentEditable)
  );
}

function handleHashChange() {
  const nextView = viewFromHash();
  const changed = nextView !== state.view;
  state.view = nextView;
  if (changed) {
    if (state.detail.open) {
      closeDrawer();
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  closeMobileNav();
  updateShell();

  if (!hasCredentials()) {
    renderView();
    return;
  }

  if (state.view === "create") {
    activateCreateView();
  } else {
    renderView();
  }
}

function openMobileNav() {
  state.mobileNavOpen = true;
  elements.sidebar.classList.add("is-open");
  elements.mobileScrim.hidden = false;
  elements.mobileMenuButton.setAttribute("aria-expanded", "true");
  document.body.classList.add("nav-open");
}

function closeMobileNav() {
  state.mobileNavOpen = false;
  elements.sidebar.classList.remove("is-open");
  elements.mobileScrim.hidden = true;
  elements.mobileMenuButton.setAttribute("aria-expanded", "false");
  document.body.classList.remove("nav-open");
}

function startAutoRefresh() {
  window.setInterval(() => {
    if (
      document.visibilityState === "visible" &&
      state.prefs.autoRefresh &&
      hasCredentials() &&
      !state.modal &&
      !state.creating &&
      !isTypingElement()
    ) {
      void refreshAll({ silent: true, includeCatalog: false });
    }
  }, AUTO_REFRESH_INTERVAL);
}

function bindEvents() {
  document.addEventListener("click", handleClick);
  document.addEventListener("input", handleInput);
  document.addEventListener("change", handleChange);
  document.addEventListener("submit", handleSubmit);
  document.addEventListener("keydown", handleKeydown);
  document.addEventListener("toggle", handleToggle, true);
  document.addEventListener("compositionstart", (event) => {
    if (event.target.id === "instance-search") {
      isComposingSearch = true;
    }
  });
  document.addEventListener("compositionend", (event) => {
    if (event.target.id === "instance-search") {
      isComposingSearch = false;
      debouncedSearch();
    }
  });

  elements.mobileMenuButton.addEventListener("click", () => {
    if (state.mobileNavOpen) {
      closeMobileNav();
    } else {
      openMobileNav();
    }
  });
  elements.mobileScrim.addEventListener("click", closeMobileNav);
  elements.refreshButton.addEventListener("click", () => {
    void refreshAll({ includeCatalog: state.view === "create" });
  });
  elements.tokenButton.addEventListener("click", () => {
    if (hasCredentials()) {
      window.location.hash = "#settings";
    } else {
      openTokenModal();
    }
  });
  window.addEventListener("hashchange", handleHashChange);
  document.addEventListener("visibilitychange", () => {
    if (
      document.visibilityState === "visible" &&
      state.prefs.autoRefresh &&
      hasCredentials() &&
      !state.modal &&
      !isTypingElement()
    ) {
      void refreshAll({ silent: true, includeCatalog: false });
    }
  });
}

async function init() {
  mountIcons();
  state.view = viewFromHash();
  bindEvents();
  updateShell();
  try {
    sessionStorage.removeItem("linode-pilot:token");
  } catch {
    // Remove the legacy browser-session token when storage is available.
  }

  const [sessionResult, settingsResult] = await Promise.allSettled([
    api.session(),
    api.settings(),
  ]);
  if (sessionResult.status === "fulfilled") {
    state.session = { ...state.session, ...sessionResult.value };
  } else {
    state.sessionError = friendlyError(sessionResult.reason);
  }
  if (settingsResult.status === "fulfilled") {
    applySettings(settingsResult.value);
  } else if (!state.sessionError) {
    if (sessionResult.status === "fulfilled") {
      applySettings(sessionResult.value);
    } else {
      state.sessionError = friendlyError(settingsResult.reason);
    }
  }

  state.initialised = true;

  if (!hasCredentials()) {
    state.loading = false;
    renderView();
    updateShell();
    openTokenModal();
    startAutoRefresh();
    return;
  }

  await loadInitialData();
  startAutoRefresh();
}

void init();
