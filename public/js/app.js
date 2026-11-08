import { ApiError, createApi } from "./api.js";
import { icon, mountIcons } from "./icons.js";
import {
  oracleRegionGroups,
  oracleRegionLabel,
  oracleRegionOptionText,
} from "./oracle-regions.js";
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
  renderCreateUnavailable,
  renderCreateSkeleton,
  renderCreateSummary,
  renderDisconnected,
  renderDrawer as renderDrawerView,
  renderIpRenewModal,
  renderIpSwapModal,
  renderInstances,
  renderInstancesSkeleton,
  renderOracleBackupDeleteModal,
  renderOracleBackupModal,
  renderOracleConsoleModal,
  renderOracleCreate,
  renderOracleCreateSkeleton,
  renderOracleTerminateModal,
  renderOverview,
  renderOverviewSkeleton,
  renderSettings,
  renderCreateProviderSwitch,
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
const CUSTOM_ORACLE_REGION = "__custom__";

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
    provider: "linode",
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

function newOracleCreateState() {
  return {
    accountId: "",
    label: randomInstanceLabel(),
    compartmentId: "",
    availabilityDomain: "",
    shape: "",
    ocpus: "1",
    memoryInGBs: "6",
    imageId: "",
    vcnId: "",
    subnetId: "",
    assignPublicIp: true,
    sshKeys: "",
    userData: "",
    options: {
      loading: false,
      error: "",
      account: null,
      compartments: [],
      availabilityDomains: [],
      shapes: [],
      images: [],
      vcns: [],
      subnets: [],
      resourcesKey: "",
      empty: [],
      warnings: [],
    },
  };
}

const state = {
  session: { tokenConfigured: false, apiBase: "", version: "1.1.0" },
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
    provider: "linode",
    loading: false,
    error: null,
    data: null,
    returnFocus: null,
    oracleMetricsWindow: "24h",
    oracleMetricsLoading: false,
    oracleOpsBusy: "",
  },
  modal: null,
  create: newCreateState(),
  oracleCreate: newOracleCreateState(),
  oracleCreating: false,
  oracleCreateError: "",
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

function hasLinodeCredentials() {
  const configured =
    state.settings?.tokenConfigured ?? state.session.tokenConfigured;
  return Boolean(configured && !state.authInvalid);
}

function hasOracleCredentials() {
  const accounts = state.settings?.oracleAccounts;
  if (Array.isArray(accounts) && accounts.length > 0) {
    return true;
  }
  return Boolean(state.settings?.oracleConfigured);
}

function hasCredentials() {
  return hasLinodeCredentials() || hasOracleCredentials();
}

function oracleCreateAccounts() {
  return Array.isArray(state.settings?.oracleAccounts)
    ? state.settings.oracleAccounts
    : [];
}

function ensureCreateProvider() {
  const linodeAvailable = hasLinodeCredentials();
  const oracleAvailable = oracleCreateAccounts().length > 0;
  if (
    state.create.provider === "oracle" &&
    !oracleAvailable
  ) {
    state.create.provider = "linode";
  } else if (
    state.create.provider !== "oracle" &&
    !linodeAvailable &&
    oracleAvailable
  ) {
    state.create.provider = "oracle";
  }
  if (!["linode", "oracle"].includes(state.create.provider)) {
    state.create.provider = oracleAvailable ? "oracle" : "linode";
  }
}

function ensureOracleCreateAccount() {
  const accounts = oracleCreateAccounts();
  if (
    !accounts.some((account) => account.id === state.oracleCreate.accountId)
  ) {
    state.oracleCreate.accountId = accounts[0]?.id || "";
  }
  return accounts.find(
    (account) => account.id === state.oracleCreate.accountId,
  ) || null;
}

function accountName(account) {
  if (!account) {
    return "云账户";
  }
  return (
    [account.first_name, account.last_name].filter(Boolean).join(" ") ||
    account.company ||
    account.email ||
    "云账户"
  );
}

function initials(value) {
  const parts = String(value || "Cloud")
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
  const oracleCount = Array.isArray(state.settings?.oracleAccounts)
    ? state.settings.oracleAccounts.length
    : 0;
  const parts = [];
  if (poolSize > 0) {
    parts.push(poolSize > 1 ? `${poolSize} 个 Linode 令牌` : "Linode 令牌");
  }
  if (oracleCount > 0) {
    parts.push(
      oracleCount > 1 ? `${oracleCount} 个 Oracle 账户` : "Oracle Cloud",
    );
  }
  if (parts.length > 1) {
    return `${parts.join(" + ")} · 多云模式`;
  }
  if (parts.length === 1) {
    return parts[0];
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
  return "未配置凭据";
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
    return error.message || "API 凭据无效或已过期，请重新连接。";
  }
  if (error.status === 403) {
    const reason = error.details?.[0]?.reason;
    return reason
      ? `凭据权限不足：${reason}`
      : "API 凭据权限不足，请检查账户授权。";
  }
  if (error.status === 429) {
    return "云 API 请求频率超限，请稍后再试。";
  }
  if (error.status === 504) {
    return "云 API 响应超时，请稍后重试。";
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
  const accountSlices = state.overview?.accounts || [];
  const accountCount = accountSlices.length || (account ? 1 : 0);
  const multiAccount = accountCount > 1;
  const oraclePrimary = accountSlices.find(
    (entry) => entry.provider === "oracle",
  );
  const linodeCount = accountSlices.filter(
    (entry) => entry.provider !== "oracle",
  ).length;
  const oracleCount = accountSlices.filter(
    (entry) => entry.provider === "oracle",
  ).length;
  const name = multiAccount
    ? `${accountCount} 个云账户`
    : account
      ? accountName(account)
      : oraclePrimary?.label || "云账户";
  const email = multiAccount
    ? [
        linodeCount ? `${linodeCount} Linode` : "",
        oracleCount ? `${oracleCount} Oracle` : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : account?.email || oraclePrimary?.providerLabel || tokenSourceLabel();
  const avatar = multiAccount ? "MA" : account ? initials(name) : "CV";
  elements.sidebarAvatar.textContent = avatar;
  elements.topbarAvatarText.textContent = avatar;
  elements.sidebarAccountName.textContent =
    accountSlices.length > 0 ? name : state.overview ? "云账户" : "未连接";
  elements.sidebarAccountEmail.textContent =
    accountSlices.length > 0 ? email : tokenSourceLabel();
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
    ensureCreateProvider();
    if (
      state.create.provider === "linode" &&
      !hasLinodeCredentials() &&
      oracleCreateAccounts().length > 0
    ) {
      state.create.provider = "oracle";
    }
    if (state.create.provider === "oracle") {
      if (!hasOracleCredentials()) {
        paintView(renderCreateUnavailable(state));
        return;
      }
      ensureOracleCreateSelections();
      paintView(
        state.oracleCreate.options.resourcesKey ||
          state.oracleCreate.options.loading ||
          state.oracleCreate.options.error
          ? renderOracleCreate(state)
          : renderOracleCreateSkeleton(state),
      );
      return;
    }
    if (!hasLinodeCredentials()) {
      paintView(renderCreateUnavailable(state));
      return;
    }
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

function oracleCreateResourcesKey() {
  return [
    state.oracleCreate.accountId,
    state.oracleCreate.compartmentId,
    state.oracleCreate.availabilityDomain,
  ].join("|");
}

function ensureOracleCreateSelections() {
  const account = ensureOracleCreateAccount();
  const options = state.oracleCreate.options;
  if (!account) {
    return;
  }
  if (!state.oracleCreate.compartmentId) {
    state.oracleCreate.compartmentId =
      options.selectedCompartmentId ||
      account.compartmentId ||
      account.tenancyId ||
      "";
  }
  if (!state.oracleCreate.availabilityDomain) {
    state.oracleCreate.availabilityDomain =
      options.selectedAvailabilityDomain ||
      options.availabilityDomains?.[0]?.name ||
      "";
  }

  const shapes = Array.isArray(options.shapes) ? options.shapes : [];
  if (!shapes.some((shape) => shape.name === state.oracleCreate.shape)) {
    const preferred = [
      "VM.Standard.A1.Flex",
      "VM.Standard.E4.Flex",
      "VM.Standard.E2.1.Micro",
    ];
    state.oracleCreate.shape =
      preferred
        .map((name) => shapes.find((shape) => shape.name === name))
        .find(Boolean)?.name ||
      shapes[0]?.name ||
      "";
  }
  const selectedShape = shapes.find(
    (shape) => shape.name === state.oracleCreate.shape,
  );
  if (selectedShape?.isFlexible) {
    const ocpus = Number(state.oracleCreate.ocpus);
    const memory = Number(state.oracleCreate.memoryInGBs);
    if (
      !Number.isFinite(ocpus) ||
      ocpus < selectedShape.ocpuMin ||
      ocpus > selectedShape.ocpuMax
    ) {
      state.oracleCreate.ocpus = String(selectedShape.ocpuMin);
    }
    if (
      !Number.isFinite(memory) ||
      memory < selectedShape.memoryMinInGBs ||
      memory > selectedShape.memoryMaxInGBs
    ) {
      state.oracleCreate.memoryInGBs = String(
        selectedShape.memoryMinInGBs,
      );
    }
  }

  const images = Array.isArray(options.images) ? options.images : [];
  if (!images.some((image) => image.id === state.oracleCreate.imageId)) {
    state.oracleCreate.imageId =
      images.find(
        (image) =>
          /ubuntu/i.test(image.operatingSystem || image.displayName || ""),
      )?.id ||
      images[0]?.id ||
      "";
  }
  const vcns = Array.isArray(options.vcns) ? options.vcns : [];
  if (!vcns.some((vcn) => vcn.id === state.oracleCreate.vcnId)) {
    state.oracleCreate.vcnId = vcns[0]?.id || "";
  }
  const subnets = (Array.isArray(options.subnets) ? options.subnets : [])
    .filter(
      (subnet) =>
        !state.oracleCreate.vcnId ||
        subnet.vcnId === state.oracleCreate.vcnId,
    );
  if (!subnets.some((subnet) => subnet.id === state.oracleCreate.subnetId)) {
    state.oracleCreate.subnetId =
      subnets.find((subnet) => subnet.prohibitPublicIpOnVnic !== true)
        ?.id ||
      subnets[0]?.id ||
      "";
  }
}

async function loadOracleCreateOptions({ suppressRender = false } = {}) {
  const account = ensureOracleCreateAccount();
  if (!account) {
    state.oracleCreate.options.error = "请先在连接与设置中添加 OCI 账户。";
    if (!suppressRender && state.view === "create") {
      renderView();
    }
    return;
  }
  const requestKey = oracleCreateResourcesKey();
  if (
    state.oracleCreate.options.loading &&
    state.oracleCreate.options.requestKey === requestKey
  ) {
    return;
  }
  state.oracleCreate.options.loading = true;
  state.oracleCreate.options.requestKey = requestKey;
  state.oracleCreate.options.error = "";
  if (!suppressRender && state.view === "create") {
    renderView();
  }

  try {
    const options = await api.oracleCreateOptions(account.id, {
      compartmentId: state.oracleCreate.compartmentId,
      availabilityDomain: state.oracleCreate.availabilityDomain,
    });
    if (
      state.oracleCreate.options.requestKey !== requestKey ||
      state.oracleCreate.accountId !== account.id
    ) {
      return;
    }
    state.oracleCreate.options = {
      ...state.oracleCreate.options,
      ...options,
      loading: false,
      error: "",
      warnings: options.errors || [],
    };
    state.oracleCreate.compartmentId =
      options.selectedCompartmentId || state.oracleCreate.compartmentId;
    state.oracleCreate.availabilityDomain =
      options.selectedAvailabilityDomain ||
      state.oracleCreate.availabilityDomain;
    state.oracleCreate.options.resourcesKey = oracleCreateResourcesKey();
    ensureOracleCreateSelections();
  } catch (error) {
    if (state.oracleCreate.options.requestKey !== requestKey) {
      return;
    }
    state.oracleCreate.options.loading = false;
    state.oracleCreate.options.error = friendlyError(error);
    state.oracleCreate.options.resourcesKey = "";
  } finally {
    if (!suppressRender && state.view === "create") {
      renderView();
    }
  }
}

function activateOracleCreateView() {
  ensureCreateProvider();
  if (!hasOracleCredentials()) {
    renderView();
    return;
  }
  ensureOracleCreateAccount();
  ensureOracleCreateSelections();
  if (
    state.oracleCreate.options.resourcesKey !== oracleCreateResourcesKey() &&
    !state.oracleCreate.options.loading
  ) {
    void loadOracleCreateOptions();
    return;
  }
  renderView();
}

function activateCreateView() {
  ensureCreateProvider();
  if (state.create.provider === "oracle") {
    activateOracleCreateView();
    return;
  }
  if (!hasLinodeCredentials()) {
    if (oracleCreateAccounts().length > 0) {
      state.create.provider = "oracle";
      activateOracleCreateView();
      return;
    }
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
  ensureCreateProvider();
  ensureOracleCreateAccount();
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
  const tasks = [loadOverview({ suppressRender: true })];
  if (hasLinodeCredentials()) {
    tasks.push(loadCatalog({ suppressRender: true }));
  }
  await Promise.all(tasks);
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
    window.location.hash = "#settings";
    return;
  }
  if (state.refreshing) {
    return;
  }

  state.refreshing = true;
  updateShell();

  const tasks = [loadOverview({ silent: true, suppressRender: true })];
  if (includeCatalog && hasLinodeCredentials()) {
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

function openOracleModal({ error = "" } = {}) {
  if (state.modal && state.modal.type !== "oracle") {
    return;
  }
  state.modal = {
    type: "oracle",
    error,
    busy: false,
  };
  renderModal();
  requestAnimationFrame(() => {
    document.querySelector("#oracle-tenancy")?.focus();
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
  } else if (state.modal.type === "oracle") {
    elements.modalRoot.innerHTML = `
      <div class="modal-layer">
        <div class="modal-backdrop" data-action="close-modal"></div>
        <section class="modal-card modal-token modal-oracle" role="dialog" aria-modal="true" aria-labelledby="oracle-modal-title">
          <button type="button" class="icon-button modal-close" data-action="close-modal" aria-label="关闭">${icon("x")}</button>
          <span class="modal-mark">${icon("cloud")}</span>
          <span class="eyebrow">ORACLE CLOUD INFRASTRUCTURE</span>
          <h2 id="oracle-modal-title">连接 OCI 账户</h2>
          <p>使用 OCI API 签名密钥访问 Compute API。私钥会加密保存在本地 Node 服务中，不会返回浏览器。</p>

          <div class="form-alert${state.modal.error ? "" : " is-hidden"}" id="oracle-error" role="alert">
            ${icon("alert")}
            <span>${escapeHtml(state.modal.error)}</span>
          </div>

          <form id="oracle-account-form" novalidate>
            <label class="form-field">
              <span class="field-label">账户名称 <em>可选</em></span>
              <input type="text" id="oracle-label" name="label" placeholder="例如 生产租户、Oracle 东京" maxlength="64" autocomplete="off" />
            </label>
            <label class="form-field">
              <span class="field-label">Tenancy OCID</span>
              <input type="text" id="oracle-tenancy" name="tenancyId" placeholder="ocid1.tenancy.oc1..…" autocomplete="off" spellcheck="false" />
            </label>
            <label class="form-field">
              <span class="field-label">User OCID</span>
              <input type="text" id="oracle-user" name="userId" placeholder="ocid1.user.oc1..…" autocomplete="off" spellcheck="false" />
            </label>
            <div class="form-grid-two">
              <div class="form-field">
                <span class="field-label">区域</span>
                <span class="select-wrap">
                  <span class="select-leading">${icon("globe")}</span>
                  <select id="oracle-region" name="region" aria-label="选择 OCI 区域" data-custom-menu-min-width="420">
                    <option value="">选择 OCI 区域…</option>
                    ${oracleRegionGroups()
                      .map(
                        (group) => `
                          <optgroup label="${escapeHtml(group.label)}">
                            ${group.regions
                              .map(
                                (region) => `
                                  <option value="${escapeHtml(region.id)}">
                                    ${escapeHtml(oracleRegionOptionText(region))}
                                  </option>
                                `,
                              )
                              .join("")}
                          </optgroup>
                        `,
                      )
                      .join("")}
                    <optgroup label="其他">
                      <option value="${CUSTOM_ORACLE_REGION}">其他区域（手动输入代码） — 政府云或未列出的区域</option>
                    </optgroup>
                  </select>
                  ${icon("chevron-down")}
                </span>
                <span class="field-hint">一个 OCI 账户只读取一个区域；多区域请分别添加账户。</span>
                <div class="oracle-region-custom is-hidden" id="oracle-region-custom-field">
                  <input type="text" id="oracle-region-custom" name="customRegion" placeholder="例如 us-gov-west-1 或 eu-frankfurt-1" autocomplete="off" spellcheck="false" />
                  <span class="field-hint">请输入 OCI 区域标识符；保存前会由服务端校验格式。</span>
                </div>
              </div>
              <label class="form-field">
                <span class="field-label">密钥指纹</span>
                <input type="text" id="oracle-fingerprint" name="fingerprint" placeholder="aa:bb:cc:…" autocomplete="off" spellcheck="false" />
              </label>
            </div>
            <label class="form-field">
              <span class="field-label">Compartment OCID <em>可选</em></span>
              <input type="text" id="oracle-compartment" name="compartmentId" placeholder="留空时扫描租户与可访问的子 Compartment" autocomplete="off" spellcheck="false" />
              <span class="field-hint">限定到单一 Compartment 可减少 API 请求；留空需要 <code>inspect compartments</code> 权限。</span>
            </label>
            <label class="form-field">
              <span class="field-label">API 私钥（PEM）</span>
              <textarea id="oracle-private-key" name="privateKey" rows="8" autocomplete="off" spellcheck="false"></textarea>
              <span class="field-hint">在 OCI「我的概要信息 → API 密钥」中创建。请使用专用 IAM 用户；创建、监控、备份和串口还需要网络、镜像、metrics、volume 与 console 相关权限，完整策略见 README。</span>
            </label>

            <button type="submit" class="button button-primary button-block token-submit oracle-submit">
              ${icon("zap")} <span>验证并保存</span>
            </button>
          </form>

          <div class="modal-foot">
            <span>${icon("shield")} RSA 私钥使用 AES-256-GCM 加密落盘</span>
            <a href="https://docs.oracle.com/en-us/iaas/Content/API/Concepts/apisigningkey.htm" target="_blank" rel="noreferrer">
              创建 API 密钥 ${icon("external-link")}
            </a>
          </div>
        </section>
      </div>
    `;
  } else if (state.modal.type === "delete-oracle") {
    const account = state.modal.account;
    elements.modalRoot.innerHTML = `
      <div class="modal-layer">
        <div class="modal-backdrop" data-action="close-modal"></div>
        <section class="modal-card modal-delete" role="dialog" aria-modal="true" aria-labelledby="delete-oracle-title">
          <button type="button" class="icon-button modal-close" data-action="close-modal" aria-label="关闭">${icon("x")}</button>
          <span class="modal-mark modal-mark-danger">${icon("cloud")}</span>
          <span class="eyebrow eyebrow-danger">REMOVE OCI ACCOUNT</span>
          <h2 id="delete-oracle-title">删除本地 OCI 账户</h2>
          <p>将从本机加密存储中删除 <strong>${escapeHtml(account.label)}</strong>（${escapeHtml(oracleRegionLabel(account.region))}）。这不会删除 OCI 上的用户或 API 密钥。</p>
          <form id="delete-oracle-form">
            <div class="form-alert is-hidden" id="delete-oracle-error" role="alert">${icon("alert")}<span></span></div>
            <div class="modal-actions">
              <button type="button" class="button button-secondary" data-action="close-modal">取消</button>
              <button type="submit" class="button button-danger delete-oracle-submit">${icon("trash")} 删除 OCI 账户</button>
            </div>
          </form>
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
  } else if (state.modal.type === "oracle-backup") {
    elements.modalRoot.innerHTML = renderOracleBackupModal(state);
  } else if (state.modal.type === "oracle-backup-delete") {
    elements.modalRoot.innerHTML = renderOracleBackupDeleteModal(state);
  } else if (state.modal.type === "oracle-console") {
    elements.modalRoot.innerHTML = renderOracleConsoleModal(state);
  } else if (state.modal.type === "oracle-terminate") {
    elements.modalRoot.innerHTML = renderOracleTerminateModal(state);
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

async function connectOracleAccount(payload) {
  const result = await api.addOracleAccount(payload);
  applySettings(result.settings);
  state.modal = null;
  renderModal();
  updateShell();
  await refreshAfterSettingsChange();
  showToast("Oracle Cloud 账户已验证并加密保存", "success");
}

async function handleOracleSubmit(event) {
  event.preventDefault();
  if (state.modal?.type !== "oracle" || state.modal.busy) {
    return;
  }

  const form = event.currentTarget;
  const field = (id) => form.querySelector(`#${id}`)?.value.trim() || "";
  const regionChoice = field("oracle-region");
  const region =
    regionChoice === CUSTOM_ORACLE_REGION
      ? field("oracle-region-custom")
      : regionChoice;
  const payload = {
    label: field("oracle-label"),
    tenancyId: field("oracle-tenancy"),
    userId: field("oracle-user"),
    region,
    fingerprint: field("oracle-fingerprint"),
    compartmentId: field("oracle-compartment"),
    privateKey: form.querySelector("#oracle-private-key")?.value || "",
  };
  const errorElement = document.querySelector("#oracle-error");
  const submit = form.querySelector(".oracle-submit");

  const missing = [
    ["oracle-tenancy", "Tenancy OCID"],
    ["oracle-user", "User OCID"],
    [
      regionChoice === CUSTOM_ORACLE_REGION ? "oracle-region-custom" : "oracle-region",
      "区域",
    ],
    ["oracle-fingerprint", "密钥指纹"],
    ["oracle-private-key", "API 私钥"],
  ].find(([id]) => !field(id));
  if (missing) {
    errorElement.classList.remove("is-hidden");
    errorElement.querySelector("span").textContent =
      `请填写 ${missing[1]}。`;
    const missingField = document.querySelector(`#${missing[0]}`);
    const focusTarget =
      missingField?.tagName === "SELECT"
        ? missingField
            .closest(".select-wrap")
            ?.querySelector(".custom-select-trigger")
        : missingField;
    focusTarget?.focus();
    return;
  }

  state.modal.busy = true;
  errorElement.classList.add("is-hidden");
  form.querySelectorAll("input, select, textarea, button").forEach((element) => {
    element.disabled = true;
  });
  submit.innerHTML = `${spinner()}<span>正在验证 OCI 签名…</span>`;

  try {
    await connectOracleAccount(payload);
  } catch (error) {
    if (state.modal?.type === "oracle") {
      errorElement.classList.remove("is-hidden");
      errorElement.querySelector("span").textContent = friendlyError(error);
      state.modal.busy = false;
      form.querySelectorAll("input, select, textarea, button").forEach((element) => {
        element.disabled = false;
      });
      submit.innerHTML = `${icon("zap")}<span>验证并保存</span>`;
    }
  }
}

function openDeleteOracleModal(account) {
  if (!account) {
    return;
  }
  state.modal = { type: "delete-oracle", account, busy: false };
  renderModal();
}

async function handleDeleteOracleSubmit(event) {
  event.preventDefault();
  if (state.modal?.type !== "delete-oracle" || state.modal.busy) {
    return;
  }
  const account = state.modal.account;
  const errorElement = document.querySelector("#delete-oracle-error");
  const submit = document.querySelector(".delete-oracle-submit");
  state.modal.busy = true;
  errorElement.classList.add("is-hidden");
  submit.disabled = true;
  submit.innerHTML = `${spinner()}<span>正在删除…</span>`;

  try {
    const result = await api.deleteOracleAccount(account.id);
    applySettings(result.settings);
    state.modal = null;
    renderModal();
    await refreshAfterSettingsChange();
    showToast(`OCI 账户 ${account.label} 已从本机删除`, "success");
  } catch (error) {
    if (state.modal?.type === "delete-oracle") {
      errorElement.classList.remove("is-hidden");
      errorElement.querySelector("span").textContent = friendlyError(error);
      state.modal.busy = false;
      submit.disabled = false;
      submit.innerHTML = `${icon("trash")} 删除 OCI 账户`;
    }
  }
}

async function testOracleAccount(accountId) {
  const account = state.settings?.oracleAccounts?.find(
    (entry) => entry.id === accountId,
  );
  try {
    const result = await api.testOracleAccount(accountId);
    applySettings(result.settings);
    if (state.view === "settings") {
      renderView();
    }
    showToast(
      `OCI 账户 ${account?.label || ""} 验证通过 · ${result.verification.latencyMs} ms`,
      "success",
    );
  } catch (error) {
    showToast(friendlyError(error), "error");
  }
}

function openOracleBackupModal(instance) {
  if (!instance) {
    return;
  }
  const stamp = new Date()
    .toISOString()
    .slice(0, 19)
    .replace(/[-:T]/g, "");
  state.modal = {
    type: "oracle-backup",
    instance,
    accountId: instance.accountId || instance.tokenId || "",
    displayName: `${instance.label || "oci-instance"}-backup-${stamp}`,
    backupType: "INCREMENTAL",
    busy: false,
    error: "",
  };
  renderModal();
  requestAnimationFrame(() => {
    document.querySelector("#oracle-backup-name")?.focus();
  });
}

async function handleOracleBackupSubmit(event) {
  event.preventDefault();
  if (state.modal?.type !== "oracle-backup" || state.modal.busy) {
    return;
  }
  const form = event.currentTarget;
  const displayName = form.querySelector("#oracle-backup-name")?.value.trim() || "";
  const type =
    form.querySelector("#oracle-backup-type")?.value === "FULL"
      ? "FULL"
      : "INCREMENTAL";
  const errorElement = document.querySelector("#oracle-backup-error");
  const submit = form.querySelector('button[type="submit"]');
  if (!displayName) {
    errorElement.classList.remove("is-hidden");
    errorElement.querySelector("span").textContent = "请填写备份名称。";
    return;
  }

  const instance = state.modal.instance;
  state.modal.busy = true;
  state.modal.error = "";
  errorElement.classList.add("is-hidden");
  submit.disabled = true;
  submit.innerHTML = `${spinner()}<span>正在提交…</span>`;
  try {
    const result = await api.createOracleBackup(
      instance.id,
      instance.accountId || instance.tokenId,
      { displayName, type },
    );
    let refreshError = "";
    try {
      await refreshOracleBackups();
    } catch (error) {
      refreshError = friendlyError(error);
    }
    state.modal = null;
    renderModal();
    renderDrawer();
    showToast(
      `${result.warning || "已提交 OCI 启动卷备份创建"}${refreshError ? `；刷新失败：${refreshError}` : ""}`,
      refreshError ? "info" : "success",
    );
  } catch (error) {
    if (state.modal?.type === "oracle-backup") {
      state.modal.busy = false;
      state.modal.error = friendlyError(error);
      renderModal();
    }
  }
}

function openOracleBackupDeleteModal(backup) {
  if (!backup) {
    return;
  }
  const instance = currentOracleDetail();
  if (!instance) {
    return;
  }
  state.modal = {
    type: "oracle-backup-delete",
    instance,
    backup,
    accountId: instance.accountId || instance.tokenId || "",
    confirmed: false,
    busy: false,
    error: "",
  };
  renderModal();
}

async function handleOracleBackupDeleteSubmit(event) {
  event.preventDefault();
  if (
    state.modal?.type !== "oracle-backup-delete" ||
    state.modal.busy
  ) {
    return;
  }
  if (!state.modal.confirmed) {
    state.modal.error = "请先勾选删除确认。";
    renderModal();
    return;
  }
  const modal = state.modal;
  modal.busy = true;
  modal.error = "";
  renderModal();
  try {
    await api.deleteOracleBackup(
      modal.instance.id,
      modal.backup.id,
      modal.accountId,
    );
    let refreshError = "";
    try {
      await refreshOracleBackups();
    } catch (error) {
      refreshError = friendlyError(error);
    }
    state.modal = null;
    renderModal();
    renderDrawer();
    showToast(
      refreshError
        ? `备份已删除，但列表刷新失败：${refreshError}`
        : "OCI 启动卷备份已删除",
      refreshError ? "info" : "success",
    );
  } catch (error) {
    if (state.modal?.type === "oracle-backup-delete") {
      state.modal.busy = false;
      state.modal.error = friendlyError(error);
      renderModal();
    }
  }
}

function openOracleConsoleModal(instance) {
  if (!instance) {
    return;
  }
  state.modal = {
    type: "oracle-console",
    instance,
    accountId: instance.accountId || instance.tokenId || "",
    publicKey: "",
    busy: false,
    error: "",
  };
  renderModal();
  requestAnimationFrame(() => {
    document.querySelector("#oracle-console-public-key")?.focus();
  });
}

async function handleOracleConsoleSubmit(event) {
  event.preventDefault();
  if (state.modal?.type !== "oracle-console" || state.modal.busy) {
    return;
  }
  const form = event.currentTarget;
  const publicKey =
    form.querySelector("#oracle-console-public-key")?.value.trim() || "";
  const errorElement = document.querySelector("#oracle-console-error");
  const submit = form.querySelector('button[type="submit"]');
  if (!/^ssh-rsa\s+\S+(?:\s+.*)?$/i.test(publicKey)) {
    errorElement.classList.remove("is-hidden");
    errorElement.querySelector("span").textContent =
      "OCI 串口连接需要 OpenSSH RSA 公钥（ssh-rsa ...）。";
    document.querySelector("#oracle-console-public-key")?.focus();
    return;
  }

  const instance = state.modal.instance;
  state.modal.busy = true;
  state.modal.error = "";
  errorElement.classList.add("is-hidden");
  submit.disabled = true;
  submit.innerHTML = `${spinner()}<span>正在创建…</span>`;
  try {
    const result = await api.createOracleConsoleConnection(
      instance.id,
      instance.accountId || instance.tokenId,
      { publicKey },
    );
    let refreshError = "";
    try {
      await refreshOracleConsole({ clearHistory: false });
    } catch (error) {
      refreshError = friendlyError(error);
    }
    state.modal = null;
    renderModal();
    renderDrawer();
    showToast(
      `${result.note || "OCI 串口连接已创建，可复制详情中的 SSH 命令"}${refreshError ? `；列表刷新失败：${refreshError}` : ""}`,
      refreshError ? "info" : "success",
    );
  } catch (error) {
    if (state.modal?.type === "oracle-console") {
      state.modal.busy = false;
      state.modal.error = friendlyError(error);
      renderModal();
    }
  }
}

function openOracleTerminateModal(instance) {
  if (!instance) {
    return;
  }
  state.modal = {
    type: "oracle-terminate",
    instance,
    accountId: instance.accountId || instance.tokenId || "",
    confirmation: "",
    preserveBootVolume: false,
    preserveDataVolumes: true,
    busy: false,
    error: "",
  };
  renderModal();
  requestAnimationFrame(() => {
    document.querySelector("#oracle-terminate-confirmation")?.focus();
  });
}

async function handleOracleTerminateSubmit(event) {
  event.preventDefault();
  if (state.modal?.type !== "oracle-terminate" || state.modal.busy) {
    return;
  }
  const modal = state.modal;
  const instanceName = modal.instance.label || "";
  const confirmation = String(modal.confirmation || "").trim();
  if (confirmation !== instanceName) {
    modal.error = "输入的名称必须与实例显示名称完全一致。";
    renderModal();
    return;
  }
  modal.busy = true;
  modal.error = "";
  renderModal();
  try {
    await api.terminateOracleInstance(
      modal.instance.id,
      modal.accountId,
      {
        confirmation,
        preserveBootVolume: modal.preserveBootVolume,
        preserveDataVolumes: modal.preserveDataVolumes,
      },
    );
    state.modal = null;
    renderModal();
    closeDrawer();
    await loadOverview({ silent: true, suppressRender: true });
    if (window.location.hash === "#instances") {
      renderView();
    } else {
      window.location.hash = "#instances";
    }
    showToast("已向 OCI 提交终止实例请求", "success");
  } catch (error) {
    if (state.modal?.type === "oracle-terminate") {
      state.modal.busy = false;
      state.modal.error = friendlyError(error);
      renderModal();
    }
  }
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
    const followUp =
      kind === "ipv4"
        ? "请重启两台实例后生效"
        : "请重启两台实例，并在系统内确认新路由段的地址和 ICMPv6 防火墙配置";
    showToast(
      `已交换${kind === "ipv4" ? " IPv4 公网地址" : " IPv6 路由段"}，${followUp}`,
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
      kind === "ipv4"
        ? newValue
          ? `已获取新 IPv4 地址 ${newValue}，请重启实例后生效`
          : "IPv4 已换新，请重启实例后生效"
        : newValue
          ? `已获取新 IPv6 路由段 ${newValue}；请重启后从新段配置地址（/64 或 /56），并注意 Network Helper 可能覆盖手工配置`
          : "IPv6 路由段已换新；请重启后从新段配置地址（/64 或 /56），并注意 Network Helper 可能覆盖手工配置",
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

async function loadDetail(
  instanceId,
  tokenId,
  { silent = false, provider = "linode" } = {},
) {
  const requestedTokenId = tokenId || null;
  const requestedProvider = provider === "oracle" ? "oracle" : "linode";
  if (!silent) {
    state.detail.loading = true;
    state.detail.error = null;
    renderDrawer();
  }

  try {
    let detailResult;
    let ipsResult;
    if (requestedProvider === "oracle") {
      const data = await api.oracleDetail(instanceId, requestedTokenId);
      detailResult = { status: "fulfilled", value: data };
      ipsResult = { status: "fulfilled", value: null };
    } else {
      [detailResult, ipsResult] = await Promise.allSettled([
        api.detail(instanceId, requestedTokenId),
        api.instanceIps(instanceId, requestedTokenId),
      ]);
    }
    if (detailResult.status !== "fulfilled") {
      throw detailResult.reason;
    }
    const data = detailResult.value;
    if (requestedProvider !== "oracle" && ipsResult.status === "fulfilled") {
      data.ips = ipsResult.value;
    }
    if (
      !state.detail.open ||
      String(state.detail.id) !== String(instanceId) ||
      state.detail.tokenId !== requestedTokenId ||
      state.detail.provider !== requestedProvider
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
      state.detail.tokenId !== requestedTokenId ||
      state.detail.provider !== requestedProvider
    ) {
      return;
    }
    state.detail.loading = false;
    state.detail.error = friendlyError(error);
  }

  renderDrawer();
  updateShell();
}

function currentOracleDetail() {
  const instance = state.detail.data?.instance;
  return instance?.provider === "oracle" ? instance : null;
}

async function loadOracleMetrics(window = "24h") {
  const instance = currentOracleDetail();
  if (!instance || state.detail.oracleMetricsLoading) {
    return;
  }
  state.detail.oracleMetricsWindow =
    ["1h", "6h", "24h", "7d"].includes(window) ? window : "24h";
  state.detail.oracleMetricsLoading = true;
  renderDrawer();
  try {
    state.detail.data.oracleMetrics = await api.oracleMetrics(
      instance.id,
      instance.accountId || instance.tokenId,
      state.detail.oracleMetricsWindow,
    );
  } catch (error) {
    state.detail.data.oracleMetrics = {
      available: false,
      window: state.detail.oracleMetricsWindow,
      resolution: "5m",
      metrics: [],
      errors: [],
      emptyReason: friendlyError(error),
    };
    showToast(friendlyError(error), "error");
  } finally {
    state.detail.oracleMetricsLoading = false;
    renderDrawer();
  }
}

async function refreshOracleBackups() {
  const instance = currentOracleDetail();
  if (!instance) {
    return;
  }
  state.detail.data.oracleBackups = await api.oracleBackups(
    instance.id,
    instance.accountId || instance.tokenId,
  );
}

async function refreshOracleConsole({ clearHistory = false } = {}) {
  const instance = currentOracleDetail();
  if (!instance) {
    return;
  }
  state.detail.data.oracleConsole = await api.oracleConsole(
    instance.id,
    instance.accountId || instance.tokenId,
  );
  if (clearHistory) {
    state.detail.data.oracleConsoleHistory = null;
  }
}

async function loadOracleConsoleHistory(historyId) {
  const instance = currentOracleDetail();
  if (!instance || !historyId) {
    return;
  }
  state.detail.oracleOpsBusy = `history:${historyId}`;
  renderDrawer();
  try {
    state.detail.data.oracleConsoleHistory =
      await api.oracleConsoleHistoryData(
        instance.id,
        historyId,
        instance.accountId || instance.tokenId,
      );
  } catch (error) {
    showToast(friendlyError(error), "error");
  } finally {
    state.detail.oracleOpsBusy = "";
    renderDrawer();
  }
}

async function createOracleConsoleHistory() {
  const instance = currentOracleDetail();
  if (!instance) {
    return;
  }
  state.detail.oracleOpsBusy = "history:create";
  renderDrawer();
  try {
    const result = await api.createOracleConsoleHistory(
      instance.id,
      instance.accountId || instance.tokenId,
      {
        displayName: `console-${instance.label || "instance"} ${new Date()
          .toISOString()
          .slice(0, 19)}`,
      },
    );
    let refreshError = "";
    try {
      await refreshOracleConsole({ clearHistory: false });
    } catch (error) {
      refreshError = friendlyError(error);
    }
    showToast(
      `${result.note || "已提交控制台历史采集，稍后即可读取启动日志"}${refreshError ? `；列表刷新失败：${refreshError}` : ""}`,
      refreshError ? "info" : "success",
    );
  } catch (error) {
    showToast(friendlyError(error), "error");
  } finally {
    state.detail.oracleOpsBusy = "";
    renderDrawer();
  }
}

async function deleteOracleConsoleHistory(historyId) {
  const instance = currentOracleDetail();
  if (!instance || !historyId) {
    return;
  }
  state.detail.oracleOpsBusy = `history:${historyId}`;
  renderDrawer();
  try {
    await api.deleteOracleConsoleHistory(
      instance.id,
      historyId,
      instance.accountId || instance.tokenId,
    );
    if (
      state.detail.data.oracleConsoleHistory?.historyId === historyId
    ) {
      state.detail.data.oracleConsoleHistory = null;
    }
    let refreshError = "";
    try {
      await refreshOracleConsole();
    } catch (error) {
      refreshError = friendlyError(error);
    }
    showToast(
      refreshError
        ? `已删除 OCI 控制台历史记录，但列表刷新失败：${refreshError}`
        : "已删除 OCI 控制台历史记录",
      refreshError ? "info" : "success",
    );
  } catch (error) {
    showToast(friendlyError(error), "error");
  } finally {
    state.detail.oracleOpsBusy = "";
    renderDrawer();
  }
}

async function deleteOracleConsoleConnection(connectionId) {
  const instance = currentOracleDetail();
  if (!instance || !connectionId) {
    return;
  }
  state.detail.oracleOpsBusy = `connection:${connectionId}`;
  renderDrawer();
  try {
    await api.deleteOracleConsoleConnection(
      instance.id,
      connectionId,
      instance.accountId || instance.tokenId,
    );
    let refreshError = "";
    try {
      await refreshOracleConsole();
    } catch (error) {
      refreshError = friendlyError(error);
    }
    showToast(
      refreshError
        ? `已删除 OCI 串口连接，但列表刷新失败：${refreshError}`
        : "已删除 OCI 串口连接",
      refreshError ? "info" : "success",
    );
  } catch (error) {
    showToast(friendlyError(error), "error");
  } finally {
    state.detail.oracleOpsBusy = "";
    renderDrawer();
  }
}

function mergeInstance(instance) {
  if (!instance || !state.overview?.instances) {
    return;
  }
  const index = state.overview.instances.findIndex(
    (entry) =>
      String(entry.id) === String(instance.id) &&
      (entry.provider || "linode") === (instance.provider || "linode") &&
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

function openDetail(instanceId, tokenId, provider = "linode") {
  state.detail = {
    open: true,
    id: String(instanceId),
    tokenId: tokenId || null,
    provider: provider === "oracle" ? "oracle" : "linode",
    loading: true,
    error: null,
    data: null,
    returnFocus: document.activeElement,
    oracleMetricsWindow: "24h",
    oracleMetricsLoading: false,
    oracleOpsBusy: "",
  };
  renderDrawer();
  syncBodyLock();
  void loadDetail(instanceId, tokenId, { provider });
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
    provider: "linode",
    loading: false,
    error: null,
    data: null,
    returnFocus: null,
    oracleMetricsWindow: "24h",
    oracleMetricsLoading: false,
    oracleOpsBusy: "",
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
      (entry) =>
        String(entry.id) === String(instanceId) &&
        (!tokenId || String(entry.tokenId) === String(tokenId)),
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
    if (instance.provider === "oracle") {
      await api.oracleAction(instanceId, operation, instance.accountId || tokenId);
    } else {
      await api.action(instanceId, operation, tokenId);
    }
    showToast(`已向 ${instance.label || instanceId} 发送${operationLabel}请求`, "success");
    await loadOverview({ silent: true, suppressRender: true });
    if (state.detail.open && String(state.detail.id) === String(instanceId)) {
      await loadDetail(instanceId, tokenId, {
        silent: true,
        provider: instance.provider,
      });
    } else if (state.view !== "create") {
      renderView();
    }
    setTimeout(() => {
      void refreshAfterAction(instanceId, tokenId, instance.provider);
    }, 4_000);
  } catch (error) {
    showToast(friendlyError(error), "error");
  } finally {
    state.busyActions.delete(busyKey);
    refreshCurrentSurface();
    updateShell();
  }
}

async function refreshAfterAction(instanceId, tokenId, provider = "linode") {
  if (!hasCredentials()) {
    return;
  }
  await loadOverview({ silent: true, suppressRender: true });
  if (state.detail.open && String(state.detail.id) === String(instanceId)) {
    await loadDetail(instanceId, tokenId, { silent: true, provider });
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

function validateOracleCreateForm() {
  const form = state.oracleCreate;
  const options = form.options;
  if (!form.accountId) {
    return "请选择用于创建实例的 OCI 账户。";
  }
  if (!form.label.trim()) {
    return "请填写 OCI 实例名称。";
  }
  if (!form.compartmentId) {
    return "请选择 Compartment。";
  }
  if (!form.availabilityDomain) {
    return "请选择可用域。";
  }
  if (!form.shape) {
    return "请选择 Shape。";
  }
  if (!form.imageId) {
    return "请选择系统镜像。";
  }
  if (!form.vcnId) {
    return "请选择 VCN。";
  }
  if (!form.subnetId) {
    return "请选择子网。";
  }
  const sshKeys = parseSshKeys(form.sshKeys);
  if (sshKeys.length === 0) {
    return "至少填写一个 SSH 公钥，否则新实例将无法登录。";
  }
  const selectedShape = (options.shapes || []).find(
    (shape) => shape.name === form.shape,
  );
  if (selectedShape?.isFlexible) {
    const ocpus = Number(form.ocpus);
    const memory = Number(form.memoryInGBs);
    if (
      !Number.isFinite(ocpus) ||
      ocpus < selectedShape.ocpuMin ||
      ocpus > selectedShape.ocpuMax
    ) {
      return `OCPU 必须在 ${selectedShape.ocpuMin}–${selectedShape.ocpuMax} 之间。`;
    }
    if (
      !Number.isFinite(memory) ||
      memory < selectedShape.memoryMinInGBs ||
      memory > selectedShape.memoryMaxInGBs
    ) {
      return `内存必须在 ${selectedShape.memoryMinInGBs}–${selectedShape.memoryMaxInGBs} GB 之间。`;
    }
  }
  return "";
}

function setOracleCreateBusy(busy) {
  state.oracleCreating = busy;
  const form = document.querySelector("#oracle-create-form");
  form
    ?.querySelectorAll("input, select, textarea, button")
    .forEach((element) => {
      element.disabled = busy;
    });
  document
    .querySelectorAll(".create-summary .create-submit")
    .forEach((button) => {
      button.disabled = busy;
    });
}

async function handleOracleCreateSubmit(event) {
  event.preventDefault();
  if (state.oracleCreating) {
    return;
  }
  const validationError = validateOracleCreateForm();
  if (validationError) {
    state.oracleCreateError = validationError;
    renderView();
    document
      .querySelector(".create-summary")
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  const form = state.oracleCreate;
  const selectedShape = (form.options.shapes || []).find(
    (shape) => shape.name === form.shape,
  );
  const payload = {
    accountId: form.accountId,
    compartmentId: form.compartmentId,
    availabilityDomain: form.availabilityDomain,
    displayName: form.label.trim(),
    shape: form.shape,
    imageId: form.imageId,
    subnetId: form.subnetId,
    assignPublicIp: form.assignPublicIp,
    sshAuthorizedKeys: parseSshKeys(form.sshKeys),
  };
  if (selectedShape?.isFlexible) {
    payload.ocpus = Number(form.ocpus);
    payload.memoryInGBs = Number(form.memoryInGBs);
  }
  if (form.userData.trim()) {
    payload.userData = form.userData;
  }

  state.oracleCreateError = "";
  setOracleCreateBusy(true);
  renderView();
  try {
    const result = await api.createOracleInstance(payload);
    const created = result.instance;
    const keptAccountId = form.accountId;
    state.oracleCreating = false;
    state.oracleCreate = newOracleCreateState();
    state.oracleCreate.accountId = keptAccountId;
    state.oracleCreateError = "";
    showToast(
      `OCI 实例 ${created?.label || payload.displayName} 已提交创建`,
      "success",
    );
    await loadOverview({ silent: true, suppressRender: true });
    if (window.location.hash === "#instances") {
      renderView();
    } else {
      window.location.hash = "#instances";
    }
  } catch (error) {
    state.oracleCreating = false;
    state.oracleCreateError = friendlyError(error);
    setOracleCreateBusy(false);
    renderView();
  }
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
  const oracleChecks = Array.isArray(result.oracles) ? result.oracles : [];
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
      ${
        tokenChecks.length > 0 || !result.oracle?.configured
          ? item("Linode 令牌", result.token || { ok: false, message: "未配置" }, "key")
          : ""
      }
      ${result.oracle?.configured ? item("Oracle Cloud", result.oracle, "cloud") : ""}
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
    ${
      oracleChecks.length > 0
        ? `<div class="diagnostic-token-list">
            ${oracleChecks
              .map(
                (account) => `<span class="diagnostic-token${account.ok ? " is-ok" : " is-fail"}">
                  ${icon(account.ok ? "check" : "alert")}
                  <strong>${escapeHtml(account.label)}</strong>
                  <small>${escapeHtml(account.region || "")} · ${escapeHtml(account.message)}${account.latencyMs !== undefined ? ` · ${account.latencyMs} ms` : ""}</small>
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
    box.innerHTML = `<div class="diagnostic-head"><strong>${spinner()} 正在检查代理与云账户…</strong></div>`;
  }

  try {
    const result = await api.testConnection();
    renderConnectionDiagnostic(result);
    showToast(
      result.ok ? "代理与云账户连接正常" : "连接测试未通过，请查看诊断详情",
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
  showProxyResult("正在通过代理连接云 API…", "ok");
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
    case "open-oracle":
      openOracleModal();
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
    case "test-oracle":
      void testOracleAccount(target.dataset.id);
      break;
    case "delete-oracle": {
      const account = state.settings?.oracleAccounts?.find(
        (entry) => entry.id === target.dataset.id,
      );
      openDeleteOracleModal(account);
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
      openDetail(
        target.dataset.id,
        target.dataset.tokenId,
        target.dataset.provider,
      );
      break;
    case "close-drawer":
      closeDrawer();
      break;
    case "retry-detail":
      void loadDetail(target.dataset.id, target.dataset.tokenId, {
        provider: target.dataset.provider,
      });
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
            (entry.provider || "linode") ===
              (target.dataset.provider || "linode") &&
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
            (entry.provider || "linode") === "linode" &&
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
            (entry.provider || "linode") === "linode" &&
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
    case "set-create-provider":
      state.create.provider =
        target.dataset.provider === "oracle" ? "oracle" : "linode";
      state.createError = "";
      state.oracleCreateError = "";
      activateCreateView();
      break;
    case "retry-oracle-create-options":
      void loadOracleCreateOptions();
      break;
    case "oci-metric-window":
      void loadOracleMetrics(target.dataset.window || "24h");
      break;
    case "oci-backup-create":
      openOracleBackupModal(currentOracleDetail());
      break;
    case "oci-backup-delete": {
      const backup = state.detail.data?.oracleBackups?.backups?.find(
        (entry) => entry.id === target.dataset.backupId,
      );
      openOracleBackupDeleteModal(backup);
      break;
    }
    case "oci-console-connect":
      openOracleConsoleModal(currentOracleDetail());
      break;
    case "oci-console-capture":
      void createOracleConsoleHistory();
      break;
    case "oci-console-history":
      void loadOracleConsoleHistory(target.dataset.historyId);
      break;
    case "oci-console-history-delete":
      void deleteOracleConsoleHistory(target.dataset.historyId);
      break;
    case "oci-console-disconnect":
      void deleteOracleConsoleConnection(target.dataset.connectionId);
      break;
    case "oci-console-history-close":
      if (state.detail.data) {
        state.detail.data.oracleConsoleHistory = null;
      }
      renderDrawer();
      break;
    case "oci-terminate":
      openOracleTerminateModal(currentOracleDetail());
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
    return;
  }
  if (target.id === "oracle-create-label") {
    state.oracleCreate.label = target.value;
    state.oracleCreateError = "";
    return;
  }
  if (target.id === "oracle-create-ocpus") {
    state.oracleCreate.ocpus = target.value;
    state.oracleCreateError = "";
    return;
  }
  if (target.id === "oracle-create-memory") {
    state.oracleCreate.memoryInGBs = target.value;
    state.oracleCreateError = "";
    return;
  }
  if (target.id === "oracle-create-ssh-keys") {
    state.oracleCreate.sshKeys = target.value;
    state.oracleCreateError = "";
    return;
  }
  if (target.id === "oracle-create-user-data") {
    state.oracleCreate.userData = target.value;
    return;
  }
  if (
    target.id === "oracle-terminate-confirmation" &&
    state.modal?.type === "oracle-terminate"
  ) {
    state.modal.confirmation = target.value;
    state.modal.error = "";
    const expected = state.modal.instance?.label || "";
    const submit = document.querySelector(
      '#oracle-terminate-form button[type="submit"]',
    );
    if (submit) {
      submit.disabled =
        Boolean(state.modal.busy) ||
        String(target.value || "").trim() !== expected;
    }
  }
}

function handleChange(event) {
  const target = event.target;

  if (target.id === "oracle-region") {
    const customField = document.querySelector("#oracle-region-custom-field");
    const useCustom = target.value === CUSTOM_ORACLE_REGION;
    customField?.classList.toggle("is-hidden", !useCustom);
    if (useCustom) {
      requestAnimationFrame(() => {
        document.querySelector("#oracle-region-custom")?.focus();
      });
    }
    return;
  }
  if (target.id === "oracle-create-account") {
    state.oracleCreate.accountId = target.value;
    state.oracleCreate.compartmentId = "";
    state.oracleCreate.availabilityDomain = "";
    state.oracleCreate.shape = "";
    state.oracleCreate.imageId = "";
    state.oracleCreate.vcnId = "";
    state.oracleCreate.subnetId = "";
    state.oracleCreateError = "";
    state.oracleCreate.options = {
      ...state.oracleCreate.options,
      loading: false,
      error: "",
      resourcesKey: "",
      compartments: [],
      availabilityDomains: [],
      shapes: [],
      images: [],
      vcns: [],
      subnets: [],
      empty: [],
      warnings: [],
    };
    renderView();
    void loadOracleCreateOptions();
    return;
  }
  if (target.id === "oracle-create-compartment") {
    state.oracleCreate.compartmentId = target.value;
    state.oracleCreate.shape = "";
    state.oracleCreate.imageId = "";
    state.oracleCreate.vcnId = "";
    state.oracleCreate.subnetId = "";
    state.oracleCreateError = "";
    state.oracleCreate.options.resourcesKey = "";
    renderView();
    void loadOracleCreateOptions();
    return;
  }
  if (target.id === "oracle-create-ad") {
    state.oracleCreate.availabilityDomain = target.value;
    state.oracleCreate.shape = "";
    state.oracleCreateError = "";
    state.oracleCreate.options.resourcesKey = "";
    renderView();
    void loadOracleCreateOptions();
    return;
  }
  if (target.id === "oracle-create-shape") {
    state.oracleCreate.shape = target.value;
    state.oracleCreateError = "";
    ensureOracleCreateSelections();
    renderView();
    return;
  }
  if (target.id === "oracle-create-image") {
    state.oracleCreate.imageId = target.value;
    state.oracleCreateError = "";
    renderView();
    return;
  }
  if (target.id === "oracle-create-vcn") {
    state.oracleCreate.vcnId = target.value;
    state.oracleCreate.subnetId = "";
    ensureOracleCreateSelections();
    renderView();
    return;
  }
  if (target.id === "oracle-create-subnet") {
    state.oracleCreate.subnetId = target.value;
    state.oracleCreateError = "";
    renderView();
    return;
  }
  if (target.id === "oracle-create-public-ip") {
    state.oracleCreate.assignPublicIp = target.checked;
    return;
  }
  if (target.id === "oracle-backup-delete-confirm") {
    if (state.modal?.type === "oracle-backup-delete") {
      state.modal.confirmed = target.checked;
      state.modal.error = "";
      renderModal();
    }
    return;
  }
  if (target.id === "oracle-terminate-preserve-boot") {
    if (state.modal?.type === "oracle-terminate") {
      state.modal.preserveBootVolume = target.checked;
      state.modal.error = "";
    }
    return;
  }
  if (target.id === "oracle-terminate-preserve-data") {
    if (state.modal?.type === "oracle-terminate") {
      state.modal.preserveDataVolumes = target.checked;
      state.modal.error = "";
    }
    return;
  }
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
  } else if (event.target.id === "oracle-account-form") {
    void handleOracleSubmit(event);
  } else if (event.target.id === "delete-oracle-form") {
    void handleDeleteOracleSubmit(event);
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
  } else if (event.target.id === "oracle-create-form") {
    void handleOracleCreateSubmit(event);
  } else if (event.target.id === "oracle-backup-form") {
    void handleOracleBackupSubmit(event);
  } else if (event.target.id === "oracle-backup-delete-form") {
    void handleOracleBackupDeleteSubmit(event);
  } else if (event.target.id === "oracle-console-form") {
    void handleOracleConsoleSubmit(event);
  } else if (event.target.id === "oracle-terminate-form") {
    void handleOracleTerminateSubmit(event);
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
      window.location.hash = "#settings";
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
    startAutoRefresh();
    return;
  }

  await loadInitialData();
  startAutoRefresh();
}

void init();
