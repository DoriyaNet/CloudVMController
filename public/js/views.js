import { extractPoints, latestValue, renderLineChart } from "./charts.js";
import { icon } from "./icons.js";
import { getOracleRegion } from "./oracle-regions.js";
import {
  clamp,
  countryFlag,
  emptyState,
  escapeHtml,
  eventActionLabel,
  formatBitrate,
  formatDate,
  formatDateTime,
  formatDisk,
  formatMemory,
  formatMoney,
  formatNumber,
  formatPercent,
  formatTransfer,
  getBackupPrice,
  getEventStatusMeta,
  getPlanPrice,
  getStatusMeta,
  imageDisplay,
  isTransitional,
  passwordStrength,
  planClassLabel,
  regionDisplay,
  relativeTime,
  spinner,
  typeDisplay,
} from "./utils.js";

function pageHeader({ eyebrow, title, description, actions = "" }) {
  return `
    <header class="page-header">
      <div>
        ${eyebrow ? `<span class="eyebrow">${escapeHtml(eyebrow)}</span>` : ""}
        <h1>${escapeHtml(title)}</h1>
        ${description ? `<p>${escapeHtml(description)}</p>` : ""}
      </div>
      ${actions ? `<div class="page-header-actions">${actions}</div>` : ""}
    </header>
  `;
}

export function statusBadge(status, { compact = false } = {}) {
  const meta = getStatusMeta(status);
  return `
    <span class="status-badge status-${meta.tone}${compact ? " is-compact" : ""}">
      <span class="status-indicator"></span>
      <span>${escapeHtml(meta.label)}</span>
    </span>
  `;
}

function accountName(account) {
  if (!account) {
    return "云账户";
  }
  const fullName = [account.first_name, account.last_name].filter(Boolean).join(" ");
  return fullName || account.company || account.email || "云账户";
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 6) return "夜深了";
  if (hour < 12) return "早上好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

function getRegion(state, regionId) {
  return (
    state.catalog?.regions?.find((region) => region.id === regionId) ||
    getOracleRegion(regionId)
  );
}

function getPlan(state, typeId) {
  return state.catalog?.types?.find((plan) => plan.id === typeId) || null;
}

function primaryIp(instance) {
  return instance?.ipv4?.[0] || "";
}

function accountNameForInstance(instance) {
  return instance?.accountLabel || instance?.tokenLabel || "";
}

function accountBadge(instance, { compact = false } = {}) {
  const label = accountNameForInstance(instance);
  if (!label) {
    return "";
  }
  return `<span class="account-chip${compact ? " is-compact" : ""}" title="所属账户">${icon("key")}<span>${escapeHtml(label)}</span></span>`;
}

function providerBadge(instance, { compact = false } = {}) {
  const provider = instance?.provider === "oracle" ? "oracle" : "linode";
  const label = provider === "oracle" ? "OCI" : "LINODE";
  return `<span class="provider-chip provider-${provider}${compact ? " is-compact" : ""}" title="${provider === "oracle" ? "Oracle Cloud Infrastructure" : "Akamai Cloud / Linode"}">${escapeHtml(label)}</span>`;
}

function compactInstanceRow(state, instance) {
  const region = getRegion(state, instance.region);
  const plan = getPlan(state, instance.type);
  const ip = primaryIp(instance);
  const isOracle = instance.provider === "oracle";

  return `
    <button
      type="button"
      class="compact-instance"
      data-action="open-detail"
      data-id="${escapeHtml(instance.id)}"
      data-token-id="${escapeHtml(instance.tokenId || "")}"
      data-provider="${escapeHtml(instance.provider || "linode")}"
      aria-label="查看 ${escapeHtml(instance.label || instance.id)} 详情"
    >
      <span class="compact-instance-primary">
        <span class="server-tile">${icon("server")}</span>
        <span class="compact-instance-copy">
          <strong>${escapeHtml(instance.label || `linode-${instance.id}`)}</strong>
          <small>${providerBadge(instance, { compact: true })} ${escapeHtml(region?.label || instance.region || "未知区域")} · ${escapeHtml(typeDisplay(instance.type, plan))}</small>
          <small class="compact-instance-account">${escapeHtml(accountNameForInstance(instance))}</small>
        </span>
      </span>
      <span class="compact-instance-status">${statusBadge(instance.status, { compact: true })}</span>
      <span class="compact-instance-ip mono">${escapeHtml(ip || (isOracle ? "详情查看 IP" : "无公网 IP"))}</span>
      <span class="compact-instance-chevron">${icon("chevron-right")}</span>
    </button>
  `;
}

function eventIcon(action) {
  const value = String(action || "");
  if (value.includes("boot") || value.includes("shutdown") || value.includes("reboot")) {
    return "power";
  }
  if (value.includes("create") || value.includes("clone")) return "plus";
  if (value.includes("delete")) return "trash";
  if (value.includes("backup") || value.includes("snapshot")) return "disk";
  if (value.includes("migrate") || value.includes("resize")) return "server";
  if (value.includes("update") || value.includes("config")) return "settings";
  return "activity";
}

function eventItem(event, { compact = false } = {}) {
  const statusMeta = getEventStatusMeta(event.status);
  const target = event.entity?.label || (event.entity?.id ? `#${event.entity.id}` : "Linode");

  return `
    <div class="event-item${compact ? " is-compact" : ""}">
      <span class="event-icon event-icon-${escapeHtml(statusMeta.tone)}">
        ${icon(eventIcon(event.action))}
      </span>
      <span class="event-copy">
        <span class="event-title-row">
          <strong>${escapeHtml(eventActionLabel(event.action))}</strong>
          <span class="event-state event-state-${escapeHtml(statusMeta.tone)}">${escapeHtml(statusMeta.label)}</span>
        </span>
        <span class="event-meta">
          ${escapeHtml(target)} · ${escapeHtml(relativeTime(event.created))}${event.accountLabel ? ` · ${escapeHtml(event.accountLabel)}` : ""}
        </span>
      </span>
    </div>
  `;
}

function accountPoolStrip(accounts) {
  return `
    <section class="account-pool panel">
      <div class="account-pool-heading">
        <div>
          <span class="panel-kicker">CONNECTED ACCOUNTS</span>
          <h2>${accounts.length} 个云账户同时工作</h2>
        </div>
        <span class="panel-note">并行聚合</span>
      </div>
      <div class="account-pool-list">
        ${accounts
          .map(
            (account) => `
              <span class="account-pool-item${account.ok ? "" : " is-error"}">
                <span class="account-pool-dot"></span>
                <span>
                  <strong>${escapeHtml(account.label || account.tokenLabel || "Linode 账户")}</strong>
                  <small>${escapeHtml(account.providerLabel || "Akamai Cloud")} · ${account.instanceCount} 个实例${account.balance !== null ? ` · ${formatMoney(account.balance)}` : ""}${account.error ? ` · ${escapeHtml(account.error)}` : ""}</small>
                </span>
              </span>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

export function renderOverview(state) {
  const overview = state.overview;
  const instances = overview?.instances || [];
  const account = overview?.account;
  const accounts = overview?.accounts || [];
  const multiAccount = accounts.length > 1;
  const hasLinodeAccount = accounts.some(
    (entry) => (entry.provider || "linode") !== "oracle",
  );
  const transfer = overview?.transfer;
  const events = overview?.events || [];
  const running = instances.filter((instance) => instance.status === "running").length;
  const offline = instances.filter((instance) => instance.status === "offline").length;
  const transitional = instances.filter((instance) => isTransitional(instance.status)).length;
  const regions = new Set(instances.map((instance) => instance.region).filter(Boolean));
  const usedTransfer = Number(transfer?.used);
  const transferQuota = Number(transfer?.quota);
  const transferPercent =
    Number.isFinite(usedTransfer) && Number.isFinite(transferQuota) && transferQuota > 0
      ? clamp((usedTransfer / transferQuota) * 100, 0, 100)
      : 0;

  const regionCounts = new Map();
  for (const instance of instances) {
    const key = instance.region || "unknown";
    regionCounts.set(key, (regionCounts.get(key) || 0) + 1);
  }
  const regionRows = [...regionCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5);
  const maxRegionCount = Math.max(...regionRows.map((entry) => entry[1]), 1);

  const currentDate = new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date());
  const healthCopy =
    offline === 0 && transitional === 0
      ? "所有实例运行正常，没有需要处理的事项。"
      : `${running} 个实例正在运行，${offline} 个已关机${transitional ? `，${transitional} 个正在变更` : ""}。`;
  const greetingName = multiAccount
    ? `${accounts.length} 个云账户`
    : accountName(account) !== "云账户"
      ? accountName(account)
      : accounts[0]?.label || "云账户";

  return `
    <section class="page page-overview">
      <header class="page-header console-header">
        <div class="page-heading">
          <span class="page-eyebrow"><span class="status-dot ${offline === 0 ? "is-ok" : "is-warn"}"></span> CLOUD INFRASTRUCTURE</span>
          <h1>基础设施概览</h1>
          <p>${escapeHtml(greeting())}，${escapeHtml(greetingName)}。${escapeHtml(healthCopy)}</p>
        </div>
        <div class="page-header-actions">
          <button type="button" class="button button-secondary" data-action="refresh-overview">
            ${state.refreshing ? spinner() : icon("refresh")}
            <span>同步状态</span>
          </button>
          ${
            state.settings?.tokenConfigured || state.settings?.oracleConfigured
              ? `<a class="button button-primary" href="#create">${icon("plus")}<span>部署实例</span></a>`
              : `<a class="button button-primary" href="#settings">${icon("plus")}<span>连接云账户</span></a>`
          }
        </div>
      </header>

      <div class="system-strip">
        <span class="system-health ${offline === 0 ? "is-ok" : "is-warn"}">
          <span class="status-dot"></span>
          ${offline === 0 ? "所有系统运行正常" : `${offline} 个实例已停止`}
        </span>
        <span class="system-strip-divider"></span>
        <span>${running} 运行中</span>
        <span>${transitional} 变更中</span>
        <span>${regions.size} 个区域</span>
        <span class="system-strip-spacer"></span>
        <span class="system-date mono">${escapeHtml(currentDate)}</span>
      </div>

      <div class="stat-grid">
        <article class="stat-card">
          <span class="stat-card-head">
            <span class="stat-label">计算实例</span>
            <span class="stat-icon tone-green">${icon("server")}</span>
          </span>
          <span class="stat-value">${formatNumber(instances.length)}</span>
          <span class="stat-foot">${formatNumber(regions.size)} 个区域 <span class="stat-divider"></span> ${running} 运行中</span>
        </article>
        <article class="stat-card">
          <span class="stat-card-head">
            <span class="stat-label">运行状态</span>
            <span class="stat-icon tone-blue">${icon("activity")}</span>
          </span>
          <span class="stat-value">${running}<small> / ${instances.length}</small></span>
          <span class="stat-foot">${offline} 已关机 <span class="stat-divider"></span> ${transitional} 过渡中</span>
        </article>
        <article class="stat-card stat-card-progress">
          <span class="stat-card-head">
            <span class="stat-label">本月出站流量</span>
            <span class="stat-icon tone-amber">${icon("network")}</span>
          </span>
          <span class="stat-value">${Number.isFinite(usedTransfer) ? formatNumber(usedTransfer) : "—"}<small> GB</small></span>
          <div class="mini-progress"><span style="width: ${transferPercent.toFixed(1)}%"></span></div>
          <span class="stat-foot">${Number.isFinite(transferQuota) ? `${formatNumber(transferQuota)} GB 配额 · ${formatPercent(transferPercent)}` : "流量数据不可用"}</span>
        </article>
        <article class="stat-card">
          <span class="stat-card-head">
            <span class="stat-label">账户余额</span>
            <span class="stat-icon tone-violet">${icon("wallet")}</span>
          </span>
          <span class="stat-value">${account ? formatMoney(account.balance) : "—"}</span>
          <span class="stat-foot">${
            multiAccount
              ? `${accounts.length} 个账户合并 · ${formatMoney(account?.balance_uninvoiced ?? 0)} 待出账`
              : account?.balance_uninvoiced !== undefined
                ? `${formatMoney(account.balance_uninvoiced)} 待出账`
                : hasLinodeAccount
                  ? "需要 Account 只读权限"
                  : "OCI 费用请在 Oracle 控制台查看"
          }</span>
        </article>
      </div>

      ${state.overviewError ? renderInlineError(state.overviewError) : ""}
      ${multiAccount ? accountPoolStrip(accounts) : ""}

      <div class="overview-grid">
        <div class="overview-column overview-column-main">
          <section class="panel instances-overview-panel">
            <div class="panel-heading">
              <div>
                <span class="panel-kicker">FLEET</span>
                <h2>实例</h2>
              </div>
              <a class="text-link" href="#instances">查看全部 ${icon("chevron-right")}</a>
            </div>
            <div class="compact-instance-list">
              ${
                instances.length > 0
                  ? instances
                      .slice()
                      .sort((left, right) => {
                        const order = { running: 0, transitional: 1, offline: 2 };
                        const leftOrder = isTransitional(left.status) ? 1 : order[left.status] ?? 2;
                        const rightOrder = isTransitional(right.status) ? 1 : order[right.status] ?? 2;
                        return leftOrder - rightOrder;
                      })
                      .slice(0, 6)
                      .map((instance) => compactInstanceRow(state, instance))
                      .join("")
                  : emptyState({
                      iconName: "server",
                      title: "还没有计算实例",
                      description: "选择一个区域和配置，几分钟内即可完成部署。",
                      action:
                        state.settings?.tokenConfigured ||
                        state.settings?.oracleConfigured
                        ? `<a class="button button-primary button-sm" href="#create">${icon("plus")}创建实例</a>`
                        : `<a class="button button-secondary button-sm" href="#settings">${icon("settings")}连接云账户</a>`,
                    })
              }
            </div>
          </section>

          <section class="panel activity-panel">
            <div class="panel-heading">
              <div>
                <span class="panel-kicker">ACTIVITY</span>
                <h2>最近活动</h2>
              </div>
              <span class="panel-note">${events.length} 条</span>
            </div>
            <div class="event-list">
              ${
                events.length > 0
                  ? events.slice(0, 6).map((event) => eventItem(event, { compact: true })).join("")
                  : emptyState({
                      iconName: "activity",
                      title: "暂无近期活动",
                      description: "对实例执行操作后，事件会显示在这里。",
                    })
              }
            </div>
          </section>
        </div>

        <div class="overview-column overview-column-side">
          <section class="panel traffic-panel">
            <div class="panel-heading">
              <div>
                <span class="panel-kicker">TRANSFER</span>
                <h2>流量用量</h2>
              </div>
              <span class="panel-note mono">${formatPercent(transferPercent)}</span>
            </div>
            <div class="traffic-visual traffic-visual-linear">
              <div class="traffic-summary">
                <span class="traffic-copy">
                  <span class="traffic-label">本月出站</span>
                  <strong>${Number.isFinite(usedTransfer) ? formatTransfer(usedTransfer) : "—"}</strong>
                  <span class="traffic-quota">${Number.isFinite(transferQuota) ? `共 ${formatTransfer(transferQuota)}` : "配额不可用"}</span>
                </span>
              </div>
              <div class="quota-bar" aria-hidden="true"><i style="width: ${transferPercent.toFixed(1)}%"></i></div>
              <div class="quota-scale"><span>0</span><span>${Number.isFinite(transferQuota) ? formatTransfer(transferQuota) : "—"}</span></div>
            </div>
            <div class="traffic-meta">
              <span><i class="legend-dot legend-green"></i> 免费配额内</span>
              <span>${transfer ? "当前计费周期" : "查看账户了解详情"}</span>
            </div>
          </section>

          <section class="panel region-panel">
            <div class="panel-heading">
              <div>
                <span class="panel-kicker">DISTRIBUTION</span>
                <h2>区域分布</h2>
              </div>
              <span class="panel-note">${regions.size} 个区域</span>
            </div>
            <div class="region-bars">
              ${
                regionRows.length > 0
                  ? regionRows
                      .map(([regionId, count]) => {
                        const region = getRegion(state, regionId);
                        const percent = (count / maxRegionCount) * 100;
                        return `
                          <div class="region-bar-row">
                            <span class="region-bar-label">
                              <span>${countryFlag(region?.country)} ${escapeHtml(region?.label || regionId)}</span>
                              <strong>${count}</strong>
                            </span>
                            <span class="region-bar-track"><i style="width: ${percent.toFixed(1)}%"></i></span>
                          </div>
                        `;
                      })
                      .join("")
                  : `<p class="muted-copy">创建实例后显示区域分布。</p>`
              }
            </div>
            <a class="region-cta" href="#create">
              <span class="region-cta-icon">${icon("globe")}</span>
              <span><strong>扩展基础设施</strong><small>在更多区域部署实例</small></span>
              ${icon("arrow-up-right")}
            </a>
          </section>
        </div>
      </div>
    </section>
  `;
}

function matchesFilters(state, instance) {
  const query = state.filters.query.trim().toLowerCase();
  const status = state.filters.status;
  const region = state.filters.region;
  const account = state.filters.account;

  if (status === "running" && instance.status !== "running") return false;
  if (status === "offline" && instance.status !== "offline") return false;
  if (status === "transitional" && !isTransitional(instance.status)) return false;
  if (region !== "all" && instance.region !== region) return false;
  if (account !== "all" && instance.tokenId !== account) return false;

  if (!query) {
    return true;
  }

  return [
    instance.label,
    instance.id,
    instance.region,
    instance.type,
    ...(instance.tags || []),
    ...(instance.ipv4 || []),
    instance.ipv6,
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(query));
}

function quickActionButton(state, instance, operation, label, iconName) {
  const busyKey = `${instance.id}:${operation}`;
  const busy = state.busyActions.has(busyKey);
  const transitional = isTransitional(instance.status);

  return `
    <button
      type="button"
      class="power-button${operation === "shutdown" ? " power-button-danger" : ""}"
      data-action="instance-action"
      data-id="${escapeHtml(instance.id)}"
      data-token-id="${escapeHtml(instance.tokenId || "")}"
      data-provider="${escapeHtml(instance.provider || "linode")}"
      data-operation="${operation}"
      title="${escapeHtml(label)}"
      aria-label="${escapeHtml(label)}"
      ${busy || transitional ? "disabled" : ""}
    >
      ${busy ? spinner("icon is-spinning") : icon(iconName)}
    </button>
  `;
}

function instanceCard(state, instance) {
  const region = getRegion(state, instance.region);
  const plan = getPlan(state, instance.type);
  const ip = primaryIp(instance);
  const price = getPlanPrice(plan, instance.region);
  const transitional = isTransitional(instance.status);
  const tags = Array.isArray(instance.tags) ? instance.tags : [];
  const accountLabel = accountNameForInstance(instance);
  const isOracle = instance.provider === "oracle";

  const actions =
    instance.status === "running"
      ? `${quickActionButton(state, instance, "reboot", "重启实例", "reboot")}
         ${quickActionButton(state, instance, "shutdown", "关闭实例", "power")}`
      : instance.status === "offline"
        ? quickActionButton(state, instance, "boot", "启动实例", "power")
        : "";

  return `
    <article class="instance-row">
      <div class="instance-cell instance-name-cell" data-label="实例">
        <span class="server-tile">${icon("server")}</span>
        <span class="instance-name-copy">
          <button type="button" class="instance-name" data-action="open-detail" data-id="${escapeHtml(instance.id)}" data-token-id="${escapeHtml(instance.tokenId || "")}" data-provider="${escapeHtml(instance.provider || "linode")}">
            ${escapeHtml(instance.label || `${isOracle ? "oci" : "linode"}-${instance.id}`)}
          </button>
          <span class="instance-row-meta">
            ${providerBadge(instance, { compact: true })}
            <span class="mono">#${escapeHtml(isOracle ? instance.id.slice(-12) : instance.id)}</span>
            ${accountLabel ? `<span>${escapeHtml(accountLabel)}</span>` : ""}
            ${tags.length > 0 ? `<span>${escapeHtml(tags.slice(0, 2).map((tag) => `#${tag}`).join(" "))}</span>` : ""}
          </span>
        </span>
      </div>
      <div class="instance-cell instance-status-cell" data-label="状态">
        ${statusBadge(instance.status)}
        ${transitional ? `<span class="transition-label">${spinner()} 处理中</span>` : ""}
      </div>
      <div class="instance-cell instance-ip-cell" data-label="公网 IPv4">
        <span class="ip-stack">
          <span class="mono">${escapeHtml(ip || (isOracle ? "详情查看" : "未分配"))}</span>
          ${
            ip
              ? `<button type="button" class="copy-button" data-copy="${escapeHtml(ip)}" aria-label="复制 IP" title="复制 IP">${icon("copy")}</button>`
              : ""
          }
        </span>
      </div>
      <div class="instance-cell instance-spec-cell" data-label="规格">
        <span class="spec-line">${escapeHtml(typeDisplay(instance.type, plan))}</span>
        <span class="instance-row-meta">
          ${formatNumber(instance.specs?.ocpus ?? instance.specs?.vcpus ?? plan?.vcpus)} ${isOracle ? "OCPU" : "vCPU"}
          <span class="meta-sep">·</span>
          ${formatMemory(instance.specs?.memory ?? plan?.memory)}
          ${isOracle ? "" : `<span class="meta-sep">·</span>${formatDisk(instance.specs?.disk ?? plan?.disk)}`}
        </span>
      </div>
      <div class="instance-cell instance-region-cell" data-label="区域">
        <span class="region-flag">${countryFlag(region?.country)}</span>
        <span class="region-copy">
          <strong>${escapeHtml(region?.label || instance.region || "未知区域")}</strong>
          <small class="mono">${escapeHtml(instance.region || "—")}</small>
        </span>
      </div>
      <div class="instance-cell instance-cost-cell" data-label="月费">
        <span class="instance-price">${price.monthly ? formatMoney(price.monthly) : isOracle ? "OCI" : "—"}</span>
        <small class="mono">${isOracle ? "计费" : "/mo"}</small>
      </div>
      <div class="instance-cell instance-row-actions">
        ${actions ? `<span class="quick-actions">${actions}</span>` : ""}
        <button
          type="button"
          class="row-open"
          data-action="open-detail"
          data-id="${escapeHtml(instance.id)}"
          data-token-id="${escapeHtml(instance.tokenId || "")}"
          data-provider="${escapeHtml(instance.provider || "linode")}"
          aria-label="管理 ${escapeHtml(instance.label || instance.id)}"
          title="管理实例"
        >
          ${icon("arrow-up-right")}
        </button>
      </div>
    </article>
  `;
}

export function renderInstances(state) {
  const instances = state.overview?.instances || [];
  const filtered = instances
    .filter((instance) => matchesFilters(state, instance))
    .sort((left, right) => {
      const statusOrder = { running: 0, offline: 2 };
      const leftOrder = isTransitional(left.status) ? 1 : statusOrder[left.status] ?? 3;
      const rightOrder = isTransitional(right.status) ? 1 : statusOrder[right.status] ?? 3;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return String(left.label || "").localeCompare(String(right.label || ""), "zh-CN");
    });

  const counts = {
    all: instances.length,
    running: instances.filter((instance) => instance.status === "running").length,
    offline: instances.filter((instance) => instance.status === "offline").length,
    transitional: instances.filter((instance) => isTransitional(instance.status)).length,
  };

  const regions = new Map();
  const accounts = new Map();
  for (const instance of instances) {
    if (instance.region) {
      const region = getRegion(state, instance.region);
      regions.set(instance.region, region?.label || instance.region);
    }
    if (instance.tokenId) {
      accounts.set(
        instance.tokenId,
        instance.accountLabel || instance.tokenLabel || instance.tokenId,
      );
    }
  }

  return `
    <section class="page page-instances">
      ${pageHeader({
        eyebrow: "COMPUTE",
        title: "计算实例",
        description: "统一管理 Linode 与 Oracle Cloud 实例，执行创建、开关机、监控和生命周期操作。",
        actions: `
          <button type="button" class="button button-secondary" data-action="refresh-overview">
            ${state.refreshing ? spinner() : icon("refresh")}
            <span>刷新</span>
          </button>
          ${
            state.settings?.tokenConfigured || state.settings?.oracleConfigured
              ? `<a class="button button-primary" href="#create">${icon("plus")}<span>部署实例</span></a>`
              : `<a class="button button-secondary" href="#settings">${icon("settings")}<span>连接云账户</span></a>`
          }
        `,
      })}

      <div class="instance-toolbar">
        <div class="segmented-filter" role="group" aria-label="按状态筛选">
          ${[
            ["all", "全部", counts.all],
            ["running", "运行中", counts.running],
            ["offline", "已关机", counts.offline],
            ["transitional", "过渡中", counts.transitional],
          ]
            .map(
              ([value, label, count]) => `
                <button
                  type="button"
                  class="segment${state.filters.status === value ? " is-active" : ""}"
                  data-action="filter-status"
                  data-status="${value}"
                >
                  ${label} <span>${count}</span>
                </button>
              `,
            )
            .join("")}
        </div>

        <div class="filter-controls">
          <label class="search-field">
            ${icon("search")}
            <input
              type="search"
              id="instance-search"
              placeholder="搜索名称、IP、标签…"
              value="${escapeHtml(state.filters.query)}"
              autocomplete="off"
              aria-label="搜索实例"
            />
            <kbd>/</kbd>
          </label>
          <label class="select-field select-field-compact">
            ${icon("key")}
            <select id="account-filter" aria-label="按账户筛选">
              <option value="all">全部账户</option>
              ${[...accounts.entries()]
                .sort((left, right) =>
                  String(left[1]).localeCompare(String(right[1]), "zh-CN"),
                )
                .map(
                  ([tokenId, label]) =>
                    `<option value="${escapeHtml(tokenId)}"${state.filters.account === tokenId ? " selected" : ""}>${escapeHtml(label)}</option>`,
                )
                .join("")}
            </select>
            ${icon("chevron-down")}
          </label>
          <label class="select-field select-field-compact">
            ${icon("globe")}
            <select id="region-filter" aria-label="按区域筛选">
              <option value="all">全部区域</option>
              ${[...regions.entries()]
                .sort((left, right) => left[1].localeCompare(right[1], "zh-CN"))
                .map(
                  ([regionId, label]) =>
                    `<option value="${escapeHtml(regionId)}"${state.filters.region === regionId ? " selected" : ""}>${escapeHtml(label)}</option>`,
                )
                .join("")}
            </select>
            ${icon("chevron-down")}
          </label>
        </div>
      </div>

      <div class="list-summary">
        <span>显示 <strong>${filtered.length}</strong> 个实例</span>
        ${
          state.filters.query ||
          state.filters.status !== "all" ||
          state.filters.region !== "all" ||
          state.filters.account !== "all"
            ? `<button type="button" class="text-button" data-action="clear-filters">清除筛选</button>`
            : `<span class="list-summary-hint">按 <kbd>/</kbd> 快速搜索</span>`
        }
      </div>

      ${
        state.overviewError ? renderInlineError(state.overviewError) : ""
      }

      ${
        filtered.length > 0
          ? `<div class="instances-table">
              <div class="instances-table-head" aria-hidden="true">
                <span>实例</span>
                <span>状态</span>
                <span>公网 IPv4</span>
                <span>规格</span>
                <span>区域</span>
                <span>月费</span>
                <span></span>
              </div>
              <div class="instances-table-body">${filtered.map((instance) => instanceCard(state, instance)).join("")}</div>
            </div>`
          : emptyState({
              iconName: instances.length === 0 ? "server" : "search",
              title: instances.length === 0 ? "还没有计算实例" : "没有匹配的实例",
              description:
                instances.length === 0
                  ? "部署第一个实例，开始构建你的云端基础设施。"
                  : "尝试更换关键词、状态或区域筛选条件。",
              action:
                instances.length === 0
                  ? state.settings?.tokenConfigured ||
                    state.settings?.oracleConfigured
                    ? `<a class="button button-primary button-sm" href="#create">${icon("plus")}创建实例</a>`
                    : `<a class="button button-secondary button-sm" href="#settings">${icon("settings")}连接云账户</a>`
                  : `<button type="button" class="button button-secondary button-sm" data-action="clear-filters">清除筛选</button>`,
            })
      }
    </section>
  `;
}

function availableRegions(state) {
  return (state.catalog?.regions || [])
    .filter((region) => !region.status || region.status === "ok")
    .slice()
    .sort((left, right) => {
      return String(left.label || left.id).localeCompare(String(right.label || right.id), "zh-CN");
    });
}

function imageGroups(state) {
  const images = (state.catalog?.images || []).filter((image) => {
    return image && image.status !== "disabled" && image.deprecated !== true;
  });
  const priority = [
    "linode/ubuntu24.04",
    "linode/ubuntu22.04",
    "linode/debian12",
    "linode/debian11",
    "linode/alpine3.20",
    "linode/rocky9",
    "linode/centos-stream9",
    "linode/fedora40",
  ];
  const groups = new Map();

  for (const image of images) {
    const vendor =
      image.vendor ||
      (image.is_public === false ? "私有镜像" : image.id?.split("/")[0] || "其他");
    if (!groups.has(vendor)) {
      groups.set(vendor, []);
    }
    groups.get(vendor).push(image);
  }

  for (const entries of groups.values()) {
    entries.sort((left, right) => {
      const leftPriority = priority.indexOf(left.id);
      const rightPriority = priority.indexOf(right.id);
      if (leftPriority !== -1 || rightPriority !== -1) {
        return (leftPriority === -1 ? 999 : leftPriority) - (rightPriority === -1 ? 999 : rightPriority);
      }
      return String(left.label || left.id).localeCompare(String(right.label || right.id));
    });
  }

  return [...groups.entries()].sort((left, right) => {
    if (left[0] === "私有镜像") return 1;
    if (right[0] === "私有镜像") return -1;
    return left[0].localeCompare(right[0]);
  });
}

function selectedCreatePlan(state) {
  return getPlan(state, state.create.type);
}

function createCredentials(state) {
  const credentials = state.settings?.credentials;
  if (Array.isArray(credentials) && credentials.length > 0) {
    return credentials;
  }
  return (state.settings?.tokens || []).map((token) => ({
    id: token.id,
    label: token.label,
    accountLabel: token.accountLabel || "",
    source: "web",
    active: token.active,
  }));
}

function selectedCreateCredential(state) {
  return createCredentials(state).find(
    (credential) => credential.id === state.create.tokenId,
  );
}

function selectedCreateRegion(state) {
  return getRegion(state, state.create.region);
}

function createCost(state) {
  const plan = selectedCreatePlan(state);
  const price = getPlanPrice(plan, state.create.region);
  const backupPrice = state.create.backups ? getBackupPrice(plan, state.create.region) : 0;
  return {
    hourly: price.hourly + (state.create.backups ? backupPrice / 730 : 0),
    monthly: price.monthly + backupPrice,
    backupPrice,
  };
}

export function renderCreateSummary(state) {
  const region = selectedCreateRegion(state);
  const plan = selectedCreatePlan(state);
  const credential = selectedCreateCredential(state);
  const price = createCost(state);
  const image = imageDisplay(state.create.image, state.catalog?.images || []);
  const passwordScore = passwordStrength(state.create.rootPass);

  return `
    <div class="summary-heading">
      <span>配置摘要</span>
      <span class="summary-live"><i></i> LIVE</span>
    </div>

    <div class="summary-region">
      <span class="summary-flag">${countryFlag(region?.country)}</span>
      <span>
        <strong>${escapeHtml(region?.label || "选择区域")}</strong>
        <small>${escapeHtml(region?.country || "尚未选择部署位置")}</small>
      </span>
    </div>

    <div class="summary-divider"></div>

    <dl class="summary-list">
      <div><dt>部署账户</dt><dd>${escapeHtml(credential?.accountLabel || credential?.label || "尚未选择")}</dd></div>
      <div><dt>实例名称</dt><dd>${escapeHtml(state.create.label || "自动生成")}</dd></div>
      <div><dt>实例规格</dt><dd>${escapeHtml(plan?.label || "尚未选择")}</dd></div>
      <div><dt>计算资源</dt><dd>${plan ? `${plan.vcpus} vCPU · ${formatMemory(plan.memory)}` : "—"}</dd></div>
      <div><dt>系统镜像</dt><dd>${escapeHtml(image)}</dd></div>
      <div><dt>自动备份</dt><dd>${state.create.backups ? `${formatMoney(price.backupPrice)} / 月` : "未启用"}</dd></div>
      <div><dt>登录方式</dt><dd>${state.create.rootPass ? "Root 密码" : state.create.sshKeys ? "SSH 公钥" : "待配置"}</dd></div>
    </dl>

    <div class="summary-divider"></div>

    <div class="cost-block">
      <span class="cost-label">预计费用</span>
      <span class="cost-value">${price.monthly ? formatMoney(price.monthly) : "—"}<small>/ 月</small></span>
      <span class="cost-hourly">${price.hourly ? `${formatMoney(price.hourly, { minimumFractionDigits: 4 })} / 小时` : "按实际用量计费"}</span>
    </div>

    ${
      state.availability.loading
        ? `<div class="summary-status">${spinner()} 正在检查区域库存…</div>`
        : state.availability.error
          ? `<div class="summary-status summary-status-warn">${icon("info")} 库存信息不可用，仍可尝试部署</div>`
          : ""
    }

    ${
      state.createError
        ? `<div class="form-alert" role="alert">${icon("alert")}<span>${escapeHtml(state.createError)}</span></div>`
        : ""
    }

    <button
      type="submit"
      form="create-form"
      class="button button-primary button-block create-submit"
      ${state.creating ? "disabled" : ""}
    >
      ${state.creating ? spinner() : icon("zap")}
      <span>${state.creating ? "正在部署…" : "部署实例"}</span>
    </button>
    <p class="summary-note">${icon("shield")} 创建后按 Linode 计费规则收费。密码不会写入日志或本地存储。</p>
    ${
      passwordScore > 0
        ? `<span class="sr-only">密码强度 ${passwordScore}/4</span>`
        : ""
    }
  `;
}

export function renderCreateProviderSwitch(state) {
  const linodeAvailable =
    Boolean(state.settings?.tokenConfigured) ||
    Boolean(state.session?.tokenConfigured);
  const oracleAvailable =
    Boolean(state.settings?.oracleConfigured) ||
    (Array.isArray(state.settings?.oracleAccounts) &&
      state.settings.oracleAccounts.length > 0);
  if (!linodeAvailable || !oracleAvailable) {
    return "";
  }
  const provider = state.create.provider === "oracle" ? "oracle" : "linode";
  return `
    <span class="create-provider-switch" role="group" aria-label="选择部署提供商">
      <button
        type="button"
        class="create-provider-option${provider === "linode" ? " is-active" : ""}"
        data-action="set-create-provider"
        data-provider="linode"
      >
        <span class="provider-chip provider-linode">LINODE</span>
        <span>Akamai</span>
      </button>
      <button
        type="button"
        class="create-provider-option${provider === "oracle" ? " is-active" : ""}"
        data-action="set-create-provider"
        data-provider="oracle"
      >
        <span class="provider-chip provider-oracle">OCI</span>
        <span>Oracle</span>
      </button>
    </span>
  `;
}

export function renderCreateUnavailable(state) {
  return `
    <section class="page page-create">
      ${pageHeader({
        eyebrow: "COMPUTE",
        title: "部署实例",
        description: "连接 Linode 或 Oracle Cloud 账户后，可在这里创建对应提供商的实例。",
      })}
      <div class="panel panel-empty-onboarding">
        <span class="connect-mark">${icon("cloud")}</span>
        <div>
          <span class="panel-kicker">COMPUTE PROVISIONING</span>
          <h2>还没有可部署的云账户</h2>
          <p>添加 Linode API 令牌或 OCI API 密钥后，即可在控制台创建实例。OCI 创建需要可访问的 Shape、镜像、VCN 与子网。</p>
          <div class="page-header-actions">
            <button type="button" class="button button-primary" data-action="open-token">${icon("key")}添加 Linode 令牌</button>
            <button type="button" class="button button-secondary" data-action="open-oracle">${icon("cloud")}添加 OCI 账户</button>
          </div>
        </div>
      </div>
    </section>
  `;
}

export function renderCreate(state) {
  if (!state.catalog) {
    return renderCreateSkeleton(state);
  }

  const regions = availableRegions(state);
  const plans = (state.catalog.types || [])
    .filter((plan) => !plan.deprecated)
    .slice()
    .sort((left, right) => {
      const leftPrice = getPlanPrice(left, state.create.region).monthly;
      const rightPrice = getPlanPrice(right, state.create.region).monthly;
      if (left.class !== right.class) {
        const order = ["standard", "dedicated", "highmem", "premium", "accelerated", "gpu"];
        return (order.indexOf(left.class) === -1 ? 99 : order.indexOf(left.class)) -
          (order.indexOf(right.class) === -1 ? 99 : order.indexOf(right.class));
      }
      return leftPrice - rightPrice;
    });

  const planGroups = new Map();
  for (const plan of plans) {
    const key = plan.class || "other";
    if (!planGroups.has(key)) planGroups.set(key, []);
    planGroups.get(key).push(plan);
  }

  const planUnavailable =
    state.availability.region === state.create.region && state.availability.plans
      ? state.availability.plans
      : null;
  const score = passwordStrength(state.create.rootPass);
  const strengthLabels = ["", "较弱", "一般", "良好", "很强"];
  const selectedPlan = selectedCreatePlan(state);
  const selectedPrice = getPlanPrice(selectedPlan, state.create.region);
  const imageChoices = imageGroups(state);
  const region = selectedCreateRegion(state);
  const credentials = createCredentials(state);

  const actions = `
    ${renderCreateProviderSwitch(state)}
    <a class="text-link" href="https://techdocs.akamai.com/linode-api/reference/post-linode-instance" target="_blank" rel="noreferrer">
      创建 API 文档 ${icon("external-link")}
    </a>
  `;

  return `
    <section class="page page-create">
      ${pageHeader({
        eyebrow: "DEPLOY",
        title: "部署新实例",
        description: "选择区域、计算规格和系统镜像，几分钟内获得一台新的 Linode。",
        actions,
      })}

      <div class="create-layout">
        <form id="create-form" class="create-form" novalidate>
          <section class="form-card">
            <div class="form-card-heading">
              <span class="form-step">01</span>
              <div><h2>位置与规格</h2><p>选择离用户更近的区域，以及适合工作负载的计算计划。</p></div>
            </div>

            <label class="form-field">
              <span class="field-label">部署账户</span>
              <span class="select-wrap">
                <span class="select-leading">${icon("key")}</span>
                <select id="create-token" name="tokenId" ${credentials.length <= 1 ? "disabled" : ""}>
                  ${credentials
                    .map(
                      (credential) => `
                        <option value="${escapeHtml(credential.id)}"${credential.id === state.create.tokenId ? " selected" : ""}>
                          ${escapeHtml(credential.label)}${credential.accountLabel ? ` · ${escapeHtml(credential.accountLabel)}` : ""}${credential.active ? "（默认）" : ""}
                        </option>
                      `,
                    )
                    .join("")}
                </select>
                ${icon("chevron-down")}
              </span>
              <span class="field-hint">所有令牌会同时读取实例；这里选择新实例创建到哪个账户。</span>
            </label>

            <label class="form-field">
              <span class="field-label">实例名称</span>
              <input
                type="text"
                id="create-label"
                name="label"
                maxlength="64"
                value="${escapeHtml(state.create.label)}"
                placeholder="例如 cloudvm-web-01"
                autocomplete="off"
              />
              <span class="field-hint">仅限字母、数字与连字符，最多 64 个字符。</span>
            </label>

            <div class="form-grid-two">
              <label class="form-field">
                <span class="field-label">部署区域</span>
                <span class="select-wrap">
                  <span class="select-leading">${countryFlag(region?.country)}</span>
                  <select id="create-region" name="region">
                    ${regions
                      .map(
                        (entry) => `
                          <option value="${escapeHtml(entry.id)}"${entry.id === state.create.region ? " selected" : ""}>
                            ${escapeHtml(entry.label || entry.id)} (${escapeHtml(entry.country || "—")})
                          </option>
                        `,
                      )
                      .join("")}
                  </select>
                  ${icon("chevron-down")}
                </span>
              </label>

              <label class="form-field">
                <span class="field-label">计算规格 ${state.availability.loading ? `<em>检查库存中…</em>` : ""}</span>
                <span class="select-wrap">
                  <span class="select-leading">${icon("cpu")}</span>
                  <select id="create-type" name="type" ${state.availability.loading ? "disabled" : ""}>
                    ${[...planGroups.entries()]
                      .map(
                        ([className, entries]) => `
                          <optgroup label="${escapeHtml(planClassLabel(className))}">
                            ${entries
                              .map((plan) => {
                                const price = getPlanPrice(plan, state.create.region);
                                const unavailable = planUnavailable?.[plan.id] === false;
                                return `
                                  <option
                                    value="${escapeHtml(plan.id)}"
                                    ${plan.id === state.create.type ? "selected" : ""}
                                    ${unavailable ? "disabled" : ""}
                                  >
                                    ${escapeHtml(plan.label)} — ${plan.vcpus} vCPU / ${formatMemory(plan.memory)} / ${formatTransfer(plan.transfer)} — ${formatMoney(price.monthly, { minimumFractionDigits: 0 })}/月${unavailable ? "（该区域不可用）" : ""}
                                  </option>
                                `;
                              })
                              .join("")}
                          </optgroup>
                        `,
                      )
                      .join("")}
                  </select>
                  ${icon("chevron-down")}
                </span>
              </label>
            </div>

            <div class="plan-inline-preview">
              <span class="plan-preview-icon">${icon("cpu")}</span>
              <span class="plan-preview-copy">
                <strong>${escapeHtml(selectedPlan?.label || "等待选择规格")}</strong>
                <small>
                  ${selectedPlan ? `${selectedPlan.vcpus} vCPU · ${formatMemory(selectedPlan.memory)} 内存 · ${formatDisk(selectedPlan.disk)} 存储 · ${formatTransfer(selectedPlan.transfer)} 流量` : "选择区域后可用的计算计划"}
                </small>
              </span>
              <span class="plan-preview-price">${selectedPrice.monthly ? `${formatMoney(selectedPrice.monthly)}<small>/月</small>` : ""}</span>
            </div>

            ${
              state.availability.error
                ? `<p class="inline-note">${icon("info")} 无法读取区域库存信息，创建时仍会由 Linode API 校验可用性。</p>`
                : ""
            }
          </section>

          <section class="form-card">
            <div class="form-card-heading">
              <span class="form-step">02</span>
              <div><h2>系统与访问</h2><p>选择操作系统，并设置安全的初始登录凭据。</p></div>
            </div>

            <label class="form-field">
              <span class="field-label">系统镜像</span>
              <span class="select-wrap">
                <span class="select-leading">${icon("terminal")}</span>
                <select id="create-image" name="image">
                  ${imageChoices
                    .map(
                      ([vendor, images]) => `
                        <optgroup label="${escapeHtml(vendor)}">
                          ${images
                            .map(
                              (image) => `
                                <option value="${escapeHtml(image.id)}"${image.id === state.create.image ? " selected" : ""}>
                                  ${escapeHtml(image.label || image.id)}${image.is_public === false ? "（私有）" : ""}
                                </option>
                              `,
                            )
                            .join("")}
                        </optgroup>
                      `,
                    )
                    .join("")}
                </select>
                ${icon("chevron-down")}
              </span>
            </label>

            <label class="form-field">
              <span class="field-label">Root 密码</span>
              <span class="input-action-wrap">
                <span class="input-leading">${icon("key")}</span>
                <input
                  type="${state.create.passwordVisible ? "text" : "password"}"
                  id="create-root-pass"
                  name="root_pass"
                  value="${escapeHtml(state.create.rootPass)}"
                  placeholder="至少 12 位，混合大小写、数字和符号"
                  autocomplete="new-password"
                  spellcheck="false"
                />
                <button
                  type="button"
                  class="input-action"
                  data-action="toggle-password"
                  aria-label="${state.create.passwordVisible ? "隐藏密码" : "显示密码"}"
                  title="${state.create.passwordVisible ? "隐藏密码" : "显示密码"}"
                >
                  ${icon(state.create.passwordVisible ? "eye-off" : "eye")}
                </button>
                <button type="button" class="input-action input-action-text" data-action="generate-password">
                  ${icon("sparkles")} 生成
                </button>
              </span>
              <span class="password-meter" data-score="${score}">
                <span><i></i><i></i><i></i><i></i></span>
                <small id="password-strength-label">${state.create.rootPass ? `密码强度：${strengthLabels[score]}` : "建议使用 16 位以上随机密码"}</small>
              </span>
            </label>

            <label class="form-field">
              <span class="field-label">标签 <em>可选</em></span>
              <input
                type="text"
                id="create-tags"
                name="tags"
                value="${escapeHtml(state.create.tags)}"
                placeholder="production, web, ap-south"
                autocomplete="off"
              />
              <span class="field-hint">用逗号分隔，最多 10 个标签。</span>
            </label>
          </section>

          <section class="form-card form-card-advanced">
            <details class="advanced-panel"${state.create.advancedOpen ? " open" : ""}>
              <summary>
                <span class="form-step">03</span>
                <span class="advanced-summary-copy">
                  <strong>网络与初始化</strong>
                  <small>备份、私有网络、SSH 公钥与 Cloud-init</small>
                </span>
                ${icon("chevron-down")}
              </summary>

              <div class="advanced-content">
                <label class="switch-row">
                  <span>
                    <strong>自动备份</strong>
                    <small>每天创建备份，保留最近的备份快照（额外收费）。</small>
                  </span>
                  <input type="checkbox" id="create-backups" name="backups" ${state.create.backups ? "checked" : ""} />
                  <span class="switch-control"></span>
                </label>

                <label class="switch-row">
                  <span>
                    <strong>私有 IPv4</strong>
                    <small>为实例分配一个仅限账户内访问的私有地址。</small>
                  </span>
                  <input type="checkbox" id="create-private-ip" name="private_ip" ${state.create.privateIp ? "checked" : ""} />
                  <span class="switch-control"></span>
                </label>

                <label class="switch-row">
                  <span>
                    <strong>创建后立即启动</strong>
                    <small>部署完成后自动开机。</small>
                  </span>
                  <input type="checkbox" id="create-booted" name="booted" ${state.create.booted ? "checked" : ""} />
                  <span class="switch-control"></span>
                </label>

                <label class="form-field">
                  <span class="field-label">SSH 公钥 <em>可选</em></span>
                  <textarea
                    id="create-ssh-keys"
                    name="ssh_keys"
                    rows="3"
                    placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA... user@example"
                    spellcheck="false"
                  >${escapeHtml(state.create.sshKeys)}</textarea>
                  <span class="field-hint">每行一个公钥。使用 SSH 登录时，Root 密码可以留空。</span>
                </label>

                <label class="form-field">
                  <span class="field-label">Cloud-init 脚本 <em>可选</em></span>
                  <textarea
                    id="create-user-data"
                    name="user_data"
                    rows="4"
                    placeholder="#cloud-config&#10;package_update: true&#10;packages:&#10;  - nginx"
                    spellcheck="false"
                  >${escapeHtml(state.create.userData)}</textarea>
                  <span class="field-hint">以 Base64 安全传输，最大 64 KB。</span>
                </label>
              </div>
            </details>
          </section>

          <button type="submit" class="button button-primary button-block create-mobile-submit" ${state.creating ? "disabled" : ""}>
            ${state.creating ? spinner() : icon("zap")}
            <span>${state.creating ? "正在部署…" : "部署实例"}</span>
          </button>
        </form>

        <aside class="create-summary" aria-label="配置摘要">
          <div id="create-summary-content">${renderCreateSummary(state)}</div>
        </aside>
      </div>
    </section>
  `;
}

function oracleCreateSelectEmpty(label) {
  return `<option value="">${escapeHtml(label)}</option>`;
}

function oracleImageOptionLabel(image) {
  const base = image?.displayName || image?.operatingSystem || image?.id || "";
  const version = String(image?.operatingSystemVersion || "").trim();
  return version && !String(base).includes(version)
    ? `${base} ${version}`
    : base;
}

export function renderOracleCreateSkeleton(state) {
  return `
    <section class="page page-create skeleton-page">
      ${pageHeader({
        eyebrow: "ORACLE CLOUD",
        title: "创建 OCI 实例",
        description: "正在读取可用域、计算 Shape 与网络资源。",
        actions: renderCreateProviderSwitch(state),
      })}
      <div class="create-layout">
        <div>
          <div class="skeleton skeleton-card skeleton-card-tall"></div>
          <div class="skeleton skeleton-card skeleton-card-tall"></div>
        </div>
        <div class="skeleton skeleton-summary"></div>
      </div>
    </section>
  `;
}

export function renderOracleCreate(state) {
  const options = state.oracleCreate.options || {};
  const account = options.account ||
    oracleCreateAccountsFromState(state).find(
      (entry) => entry.id === state.oracleCreate.accountId,
    ) ||
    null;
  const region = getRegion(state, account?.region || "");
  const compartments = Array.isArray(options.compartments)
    ? options.compartments
    : [];
  const domains = Array.isArray(options.availabilityDomains)
    ? options.availabilityDomains
    : [];
  const shapes = Array.isArray(options.shapes) ? options.shapes : [];
  const images = Array.isArray(options.images) ? options.images : [];
  const vcns = Array.isArray(options.vcns) ? options.vcns : [];
  const allSubnets = Array.isArray(options.subnets) ? options.subnets : [];
  const subnets = allSubnets.filter(
    (subnet) =>
      !state.oracleCreate.vcnId ||
      subnet.vcnId === state.oracleCreate.vcnId,
  );
  const selectedShape = shapes.find(
    (shape) => shape.name === state.oracleCreate.shape,
  );
  const selectedImage = images.find(
    (image) => image.id === state.oracleCreate.imageId,
  );
  const selectedVcn = vcns.find(
    (vcn) => vcn.id === state.oracleCreate.vcnId,
  );
  const selectedSubnet = subnets.find(
    (subnet) => subnet.id === state.oracleCreate.subnetId,
  );
  const selectedCompartment = compartments.find(
    (compartment) => compartment.id === state.oracleCreate.compartmentId,
  );
  const busy = Boolean(state.oracleCreating);
  const resourcesLoading = Boolean(options.loading);
  const disabled = busy || resourcesLoading;
  const errors = Array.isArray(options.errors) ? options.errors : [];
  const empty = Array.isArray(options.empty) ? options.empty : [];
  const accounts = oracleCreateAccountsFromState(state);
  const shapeDescription =
    selectedShape?.isFlexible
      ? `${state.oracleCreate.ocpus || selectedShape.ocpuMin} OCPU · ${state.oracleCreate.memoryInGBs || selectedShape.memoryMinInGBs} GB 内存（可调）`
      : selectedShape
        ? `${formatNumber(selectedShape.ocpus ?? selectedShape.ocpuMin)} OCPU · ${formatNumber(selectedShape.memoryInGBs ?? selectedShape.memoryMinInGBs)} GB 内存`
        : "等待选择";

  return `
    <section class="page page-create">
      ${pageHeader({
        eyebrow: "ORACLE CLOUD",
        title: "创建 OCI 实例",
        description: "从现有 OCI 账户、可用域和子网创建 Compute 实例。新实例按 OCI 实际用量计费。",
        actions: `
          ${renderCreateProviderSwitch(state)}
          <a class="text-link" href="https://docs.oracle.com/iaas/api/#/en/iaas/20160918/Instance/LaunchInstance" target="_blank" rel="noreferrer">
            创建 API 文档 ${icon("external-link")}
          </a>
        `,
      })}

      ${
        options.error
          ? `<div class="form-alert page-form-alert" role="alert">
              ${icon("alert")}
              <span>${escapeHtml(options.error)}</span>
              <button type="button" class="text-button" data-action="retry-oracle-create-options">重试</button>
            </div>`
          : ""
      }

      <div class="create-layout">
        <form id="oracle-create-form" class="create-form" novalidate>
          <section class="form-card">
            <div class="form-card-heading">
              <span class="form-step">01</span>
              <div><h2>账户、位置与规格</h2><p>OCI 资源按区域和 Compartment 隔离；Shape 与可用域会共同影响可创建规格。</p></div>
            </div>

            <div class="form-grid-two">
              <label class="form-field">
                <span class="field-label">OCI 账户</span>
                <span class="select-wrap">
                  <span class="select-leading">${icon("cloud")}</span>
                  <select id="oracle-create-account" ${disabled ? "disabled" : ""}>
                    ${
                      accounts.length > 0
                        ? accounts
                            .map(
                              (entry) => `<option value="${escapeHtml(entry.id)}"${entry.id === state.oracleCreate.accountId ? " selected" : ""}>${escapeHtml(entry.label)} · ${escapeHtml(getRegion(state, entry.region)?.label || entry.region)}</option>`,
                            )
                            .join("")
                        : oracleCreateSelectEmpty("没有 OCI 账户")
                    }
                  </select>
                  ${icon("chevron-down")}
                </span>
              </label>
              <label class="form-field">
                <span class="field-label">实例名称</span>
                <input
                  type="text"
                  id="oracle-create-label"
                  value="${escapeHtml(state.oracleCreate.label)}"
                  maxlength="255"
                  autocomplete="off"
                  ${disabled ? "disabled" : ""}
                />
                <span class="field-hint">最多 255 个字符，会作为 OCI Display Name。</span>
              </label>
            </div>

            <div class="form-grid-two">
              <label class="form-field">
                <span class="field-label">Compartment</span>
                <span class="select-wrap">
                  <span class="select-leading">${icon("grid")}</span>
                  <select id="oracle-create-compartment" ${disabled ? "disabled" : ""}>
                    ${
                      compartments.length > 0
                        ? compartments
                            .map(
                              (entry) => `<option value="${escapeHtml(entry.id)}"${entry.id === state.oracleCreate.compartmentId ? " selected" : ""}>${escapeHtml(entry.name)}</option>`,
                            )
                            .join("")
                        : oracleCreateSelectEmpty("没有可访问的 Compartment")
                    }
                  </select>
                  ${icon("chevron-down")}
                </span>
                <span class="field-hint">只列出当前 OCI 凭据可读取的 Compartment。</span>
              </label>
              <label class="form-field">
                <span class="field-label">可用域</span>
                <span class="select-wrap">
                  <span class="select-leading">${icon("globe")}</span>
                  <select id="oracle-create-ad" ${disabled ? "disabled" : ""}>
                    ${
                      domains.length > 0
                        ? domains
                            .map(
                              (entry) => `<option value="${escapeHtml(entry.name)}"${entry.name === state.oracleCreate.availabilityDomain ? " selected" : ""}>${escapeHtml(entry.name)}</option>`,
                            )
                            .join("")
                        : oracleCreateSelectEmpty("没有可用域")
                    }
                  </select>
                  ${icon("chevron-down")}
                </span>
              </label>
            </div>

            <label class="form-field">
              <span class="field-label">Shape</span>
              <span class="select-wrap">
                <span class="select-leading">${icon("cpu")}</span>
                <select id="oracle-create-shape" ${disabled ? "disabled" : ""}>
                  ${
                    shapes.length > 0
                      ? shapes
                          .map(
                            (shape) => `<option value="${escapeHtml(shape.name)}"${shape.name === state.oracleCreate.shape ? " selected" : ""}>${escapeHtml(shape.name)}${shape.isFlexible ? ` · ${formatNumber(shape.ocpuMin)}–${formatNumber(shape.ocpuMax)} OCPU · ${formatNumber(shape.memoryMinInGBs)}–${formatNumber(shape.memoryMaxInGBs)} GB` : " · 固定规格"}</option>`,
                          )
                          .join("")
                      : oracleCreateSelectEmpty("没有可用 Shape")
                  }
                </select>
                ${icon("chevron-down")}
              </span>
            </label>

            ${
              selectedShape?.isFlexible
                ? `<div class="form-grid-two oci-flex-fields">
                    <label class="form-field">
                      <span class="field-label">OCPU</span>
                      <input type="number" id="oracle-create-ocpus" min="${selectedShape.ocpuMin}" max="${selectedShape.ocpuMax}" step="0.1" value="${escapeHtml(state.oracleCreate.ocpus)}" ${disabled ? "disabled" : ""} />
                      <span class="field-hint">范围 ${formatNumber(selectedShape.ocpuMin)}–${formatNumber(selectedShape.ocpuMax)} OCPU。</span>
                    </label>
                    <label class="form-field">
                      <span class="field-label">内存（GB）</span>
                      <input type="number" id="oracle-create-memory" min="${selectedShape.memoryMinInGBs}" max="${selectedShape.memoryMaxInGBs}" step="1" value="${escapeHtml(state.oracleCreate.memoryInGBs)}" ${disabled ? "disabled" : ""} />
                      <span class="field-hint">范围 ${formatNumber(selectedShape.memoryMinInGBs)}–${formatNumber(selectedShape.memoryMaxInGBs)} GB。</span>
                    </label>
                  </div>`
                : ""
            }

            <label class="form-field">
              <span class="field-label">系统镜像</span>
              <span class="select-wrap">
                <span class="select-leading">${icon("terminal")}</span>
                <select id="oracle-create-image" ${disabled ? "disabled" : ""}>
                  ${
                    images.length > 0
                      ? images
                          .map(
                            (image) => `<option value="${escapeHtml(image.id)}"${image.id === state.oracleCreate.imageId ? " selected" : ""}>${escapeHtml(oracleImageOptionLabel(image))}</option>`,
                          )
                          .join("")
                      : oracleCreateSelectEmpty("没有可用镜像")
                  }
                </select>
                ${icon("chevron-down")}
              </span>
              <span class="field-hint">平台镜像与当前 Compartment 可访问的自定义镜像。</span>
            </label>
          </section>

          <section class="form-card">
            <div class="form-card-heading">
              <span class="form-step">02</span>
              <div><h2>网络与访问</h2><p>OCI 必须选择现有 VCN 与子网；本控制台不会自动创建网络。</p></div>
            </div>

            <div class="form-grid-two">
              <label class="form-field">
                <span class="field-label">VCN</span>
                <span class="select-wrap">
                  <span class="select-leading">${icon("network")}</span>
                  <select id="oracle-create-vcn" ${disabled ? "disabled" : ""}>
                    ${
                      vcns.length > 0
                        ? vcns
                            .map(
                              (vcn) => `<option value="${escapeHtml(vcn.id)}"${vcn.id === state.oracleCreate.vcnId ? " selected" : ""}>${escapeHtml(vcn.displayName || vcn.id)} · ${escapeHtml(vcn.cidrBlock || "")}</option>`,
                            )
                            .join("")
                        : oracleCreateSelectEmpty("当前 Compartment 没有 VCN")
                    }
                  </select>
                  ${icon("chevron-down")}
                </span>
              </label>
              <label class="form-field">
                <span class="field-label">子网</span>
                <span class="select-wrap">
                  <span class="select-leading">${icon("network")}</span>
                  <select id="oracle-create-subnet" ${disabled ? "disabled" : ""}>
                    ${
                      subnets.length > 0
                        ? subnets
                            .map(
                              (subnet) => `<option value="${escapeHtml(subnet.id)}"${subnet.id === state.oracleCreate.subnetId ? " selected" : ""}>${escapeHtml(subnet.displayName || subnet.id)} · ${escapeHtml(subnet.cidrBlock || "")}${subnet.prohibitPublicIpOnVnic ? " · 禁止公网 IP" : ""}</option>`,
                            )
                            .join("")
                        : oracleCreateSelectEmpty("所选 VCN 没有子网")
                    }
                  </select>
                  ${icon("chevron-down")}
                </span>
              </label>
            </div>

            <label class="switch-row">
              <span>
                <strong>分配公网 IPv4</strong>
                <small>需要子网允许公网 IP。OCI 仅分配一个公网 IPv4；私有地址由 VCN 自动提供。</small>
              </span>
              <input type="checkbox" id="oracle-create-public-ip" ${state.oracleCreate.assignPublicIp ? "checked" : ""} ${disabled ? "disabled" : ""} />
              <span class="switch-control"></span>
            </label>

            ${
              selectedSubnet?.prohibitPublicIpOnVnic
                ? `<div class="inline-note">${icon("alert")} 所选子网禁止公网 IP；实例仍可创建，但无法从公网直接访问。</div>`
                : ""
            }
          </section>

          <section class="form-card form-card-advanced">
            <details class="advanced-panel"${state.create.advancedOpen ? " open" : ""}>
              <summary>
                <span class="form-step">03</span>
                <span class="advanced-summary-copy">
                  <strong>SSH 与初始化</strong>
                  <small>至少一个公钥；可附加 Cloud-init 用户数据</small>
                </span>
                ${icon("chevron-down")}
              </summary>
              <div class="advanced-content">
                <label class="form-field">
                  <span class="field-label">SSH 公钥</span>
                  <textarea
                    id="oracle-create-ssh-keys"
                    rows="4"
                    placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA... user@example"
                    spellcheck="false"
                    ${disabled ? "disabled" : ""}
                  >${escapeHtml(state.oracleCreate.sshKeys)}</textarea>
                  <span class="field-hint">每行一个公钥，会写入 OCI 实例 metadata 的 <code>ssh_authorized_keys</code>。至少需要一个。</span>
                </label>
                <label class="form-field">
                  <span class="field-label">Cloud-init 用户数据 <em>可选</em></span>
                  <textarea
                    id="oracle-create-user-data"
                    rows="5"
                    placeholder="#cloud-config&#10;package_update: true"
                    spellcheck="false"
                    ${disabled ? "disabled" : ""}
                  >${escapeHtml(state.oracleCreate.userData)}</textarea>
                  <span class="field-hint">服务端会以 Base64 写入 <code>user_data</code>，最大 64 KB。</span>
                </label>
              </div>
            </details>
          </section>

          ${
            errors.length > 0 || empty.length > 0
              ? `<div class="summary-status summary-status-warn oci-create-warning">
                  ${icon("info")}
                  <span>
                    ${errors.length > 0 ? escapeHtml(errors.join("；")) : ""}
                    ${errors.length > 0 && empty.length > 0 ? "；" : ""}
                    ${empty.length > 0 ? `以下资源为空：${escapeHtml(empty.join("、"))}。请检查 IAM 权限，或到 OCI 控制台创建缺少的 VCN/子网。` : ""}
                  </span>
                </div>`
              : ""
          }

          ${
            state.oracleCreateError
              ? `<div class="form-alert" role="alert">${icon("alert")}<span>${escapeHtml(state.oracleCreateError)}</span></div>`
              : ""
          }

          <button type="submit" class="button button-primary button-block create-mobile-submit" ${disabled || !accounts.length ? "disabled" : ""}>
            ${busy ? spinner() : icon("zap")}
            <span>${busy ? "正在提交创建…" : "创建 OCI 实例"}</span>
          </button>
        </form>

        <aside class="create-summary" aria-label="OCI 配置摘要">
          <div class="summary-heading">
            <span>OCI 配置摘要</span>
            <span class="summary-live"><i></i> OCI API</span>
          </div>
          <div class="summary-region">
            <span class="summary-flag">${countryFlag(region?.country)}</span>
            <span>
              <strong>${escapeHtml(region?.label || account?.region || "未选择区域")}</strong>
              <small>${escapeHtml(account?.label || "未选择 OCI 账户")}</small>
            </span>
          </div>
          <div class="summary-divider"></div>
          <dl class="summary-list">
            <div><dt>实例名称</dt><dd>${escapeHtml(state.oracleCreate.label || "自动生成")}</dd></div>
            <div><dt>Compartment</dt><dd title="${escapeHtml(state.oracleCreate.compartmentId)}">${escapeHtml(selectedCompartment?.name || state.oracleCreate.compartmentId || "—")}</dd></div>
            <div><dt>可用域</dt><dd>${escapeHtml(state.oracleCreate.availabilityDomain || "—")}</dd></div>
            <div><dt>Shape</dt><dd>${escapeHtml(selectedShape?.name || "未选择")}</dd></div>
            <div><dt>计算资源</dt><dd>${escapeHtml(shapeDescription)}</dd></div>
            <div><dt>系统镜像</dt><dd>${escapeHtml(selectedImage ? oracleImageOptionLabel(selectedImage) : "未选择")}</dd></div>
            <div><dt>VCN / 子网</dt><dd>${escapeHtml(selectedVcn?.displayName || "未选择")} / ${escapeHtml(selectedSubnet?.displayName || "未选择")}</dd></div>
            <div><dt>公网 IPv4</dt><dd>${state.oracleCreate.assignPublicIp ? "分配（若子网允许）" : "不分配"}</dd></div>
            <div><dt>登录方式</dt><dd>SSH 公钥</dd></div>
          </dl>
          <div class="summary-divider"></div>
          <div class="cost-block">
            <span class="cost-label">预计费用</span>
            <span class="cost-value">OCI<small>按实际用量</small></span>
            <span class="cost-hourly">具体费用由 OCI 计费与免费额度决定。</span>
          </div>
          ${
            resourcesLoading
              ? `<div class="summary-status">${spinner()} 正在读取 OCI 资源…</div>`
              : ""
          }
          <button
            type="submit"
            form="oracle-create-form"
            class="button button-primary button-block create-submit"
            ${disabled || !accounts.length ? "disabled" : ""}
          >
            ${busy ? spinner() : icon("zap")}
            <span>${busy ? "正在提交创建…" : "创建 OCI 实例"}</span>
          </button>
          <p class="summary-note">${icon("shield")} 创建是异步操作；实例会先进入 PROVISIONING。OCI 私钥只在本地服务端使用。</p>
        </aside>
      </div>
    </section>
  `;
}

function oracleCreateAccountsFromState(state) {
  const accounts = Array.isArray(state.settings?.oracleAccounts)
    ? state.settings.oracleAccounts
    : [];
  return accounts;
}


export function renderSettings(state) {
  if (!state.settings) {
    return `
      <section class="page page-settings skeleton-page">
        <div class="skeleton skeleton-title"></div>
        <div class="skeleton skeleton-card skeleton-card-tall"></div>
        <div class="skeleton skeleton-card skeleton-card-tall"></div>
      </section>
    `;
  }

  const settings = state.settings;
  const proxy = settings.proxy || {};
  const tokens = Array.isArray(settings.tokens) ? settings.tokens : [];
  const oracleAccounts = Array.isArray(settings.oracleAccounts)
    ? settings.oracleAccounts
    : [];
  const connected = Boolean(settings.tokenConfigured && !state.authInvalid);
  const poolSize =
    Number(settings.poolSize) ||
    tokens.length ||
    (settings.tokenConfigured ? 1 : 0);
  const credentialLabel =
    poolSize > 1
      ? `${poolSize} 个令牌同时工作`
      : settings.credentialSource === "web"
        ? settings.credentialLabel || "Web 令牌"
        : settings.credentialSource === "env"
          ? "服务端 .env 回退令牌"
          : "未配置";

  return `
    <section class="page page-settings">
      ${pageHeader({
        eyebrow: "SYSTEM",
        title: "连接与设置",
        description: "管理 Linode API 令牌、Oracle Cloud OCI 密钥、本地 SOCKS 代理和刷新偏好。",
      })}

      <div class="settings-grid">
        <section class="panel settings-panel settings-token-panel">
          <div class="settings-panel-heading">
            <span class="settings-icon ${connected ? "is-connected" : ""}">${icon("shield")}</span>
            <div>
              <span class="panel-kicker">AUTHENTICATION</span>
              <h2>API 令牌管理</h2>
            </div>
            ${
              connected
                ? `<span class="status-badge status-running"><span class="status-indicator"></span>已连接</span>`
                : `<span class="status-badge status-offline"><span class="status-indicator"></span>未连接</span>`
            }
          </div>

          <div class="token-manager-toolbar">
            <span class="token-manager-current">
              <small>${poolSize > 1 ? "多账户模式" : "当前凭据"}</small>
              <strong>${escapeHtml(credentialLabel)}</strong>
            </span>
            <span class="token-manager-actions">
              <button type="button" class="button button-primary button-sm" data-action="open-token">
                ${icon("plus")} 添加令牌
              </button>
              ${
                settings.envTokenConfigured
                  ? `<button type="button" class="button button-secondary button-sm" data-action="import-env-token">${icon("download")} 从 .env 导入</button>`
                  : ""
              }
              <button type="button" class="button button-secondary button-sm" data-action="test-connection">
                ${icon("activity")} 测试连接
              </button>
            </span>
          </div>

          ${poolSize > 1 ? `<div class="token-pool-note">${icon("network")}<span>所有令牌会并行读取实例、账户余额、流量和活动；实例操作会自动路由到所属账户。标记为默认的令牌用于新建实例时的初始选择。</span></div>` : ""}

          <div class="token-list">
            ${
              tokens.length > 0
                ? tokens
                    .map(
                      (token) => `
                        <article class="token-row${token.active ? " is-active" : ""}">
                          <span class="token-row-icon">${icon("key")}</span>
                          <span class="token-row-main">
                            <span class="token-row-title">
                              <strong>${escapeHtml(token.label)}</strong>
                              ${token.active ? `<span class="token-active-badge">默认</span>` : ""}
                            </span>
                            <span class="token-row-meta">
                              <span class="mono">${escapeHtml(token.masked)}</span>
                              ${token.accountLabel ? `<span>${escapeHtml(token.accountLabel)}</span>` : ""}
                              <span>验证于 ${escapeHtml(relativeTime(token.lastVerifiedAt))}</span>
                            </span>
                          </span>
                          <span class="token-row-actions">
                            ${
                              token.active
                                ? ""
                                : `<button type="button" class="text-button" data-action="activate-token" data-id="${escapeHtml(token.id)}">设为默认</button>`
                            }
                            <button type="button" class="text-button" data-action="test-token" data-id="${escapeHtml(token.id)}">测试</button>
                            <button type="button" class="text-button text-button-danger" data-action="delete-token" data-id="${escapeHtml(token.id)}">删除</button>
                          </span>
                        </article>
                      `,
                    )
                    .join("")
                : `<div class="token-empty">
                    <span>${icon("key")}</span>
                    <div><strong>还没有 Web 管理的令牌</strong><small>添加至少一个 API 令牌即可从页面直接连接 Linode。</small></div>
                    <button type="button" class="button button-secondary button-sm" data-action="open-token">${icon("plus")}添加令牌</button>
                  </div>`
            }
          </div>

          ${
            settings.envTokenConfigured
              ? `<div class="env-token-note">
                  ${icon("info")}
                  <span>检测到服务端 <code>.env</code> 令牌，当前作为回退凭据。导入后可删除 <code>LINODE_API_TOKEN</code>，以后完全通过页面管理。</span>
                </div>`
              : ""
          }

          <div class="diagnostic-box is-hidden" id="connection-diagnostic"></div>

          <p class="settings-note">
            ${icon("shield")}
            <span>令牌不会返回给浏览器。服务端使用 AES-256-GCM 加密后保存到 <code>data/settings.json</code>，密钥单独存放在 <code>data/.key</code>。</span>
          </p>
        </section>

        <section class="panel settings-panel settings-oracle-panel">
          <div class="settings-panel-heading">
            <span class="settings-icon ${oracleAccounts.length > 0 ? "is-connected" : ""}">${icon("cloud")}</span>
            <div>
              <span class="panel-kicker">MULTI-CLOUD</span>
              <h2>Oracle Cloud 账户</h2>
            </div>
            ${
              oracleAccounts.length > 0
                ? `<span class="status-badge status-running"><span class="status-indicator"></span>${oracleAccounts.length} 个账户</span>`
                : `<span class="status-badge status-offline"><span class="status-indicator"></span>未连接</span>`
            }
          </div>

          <div class="token-manager-toolbar">
            <span class="token-manager-current">
              <small>OCI API KEY</small>
              <strong>${oracleAccounts.length > 0 ? `${oracleAccounts.length} 个 OCI 配置并行读取` : "使用 API 签名连接"}</strong>
            </span>
            <span class="token-manager-actions">
              <button type="button" class="button button-primary button-sm" data-action="open-oracle">
                ${icon("plus")} 添加 OCI 账户
              </button>
            </span>
          </div>

          <div class="token-pool-note">${icon("shield")}<span>使用租户 OCID、用户 OCID、API 密钥指纹和 RSA 私钥进行请求签名。私钥只会加密保存在本地 Node 服务中，不会返回浏览器。</span></div>

          <div class="token-list">
            ${
              oracleAccounts.length > 0
                ? oracleAccounts
                    .map(
                      (account) => `
                        <article class="token-row oracle-account-row">
                          <span class="token-row-icon">${icon("cloud")}</span>
                          <span class="token-row-main">
                            <span class="token-row-title">
                              <strong>${escapeHtml(account.label)}</strong>
                              <span class="provider-chip provider-oracle">OCI</span>
                            </span>
                            <span class="token-row-meta">
                              <span title="${escapeHtml(account.region)}">${escapeHtml(getRegion(state, account.region)?.label || account.region)}</span>
                              <span>租户 …${escapeHtml(String(account.tenancyId || "").slice(-10))}</span>
                              <span>指纹 …${escapeHtml(String(account.fingerprint || "").slice(-8))}</span>
                              <span>验证于 ${escapeHtml(relativeTime(account.lastVerifiedAt))}</span>
                            </span>
                          </span>
                          <span class="token-row-actions">
                            <button type="button" class="text-button" data-action="test-oracle" data-id="${escapeHtml(account.id)}">测试</button>
                            <button type="button" class="text-button text-button-danger" data-action="delete-oracle" data-id="${escapeHtml(account.id)}">删除</button>
                          </span>
                        </article>
                      `,
                    )
                    .join("")
                : `<div class="token-empty">
                    <span>${icon("cloud")}</span>
                    <div><strong>还没有 Oracle Cloud 账户</strong><small>添加 OCI API 密钥后，即可在实例列表中管理 OCI 计算实例。</small></div>
                    <button type="button" class="button button-secondary button-sm" data-action="open-oracle">${icon("plus")}添加 OCI 账户</button>
                  </div>`
            }
          </div>

          <p class="settings-note">
            ${icon("info")}
            <span>建议使用专用 IAM 用户。实例管理至少需要 <code>manage instances</code>；创建、监控、启动卷备份、串口和终止还需要网络、镜像、metrics、volume 与 console 权限，完整策略见 README。</span>
          </p>
          <div class="settings-actions">
            <a class="resource-link resource-link-inline" href="https://docs.oracle.com/en-us/iaas/Content/API/Concepts/apisigningkey.htm" target="_blank" rel="noreferrer">
              <span><strong>如何创建 OCI API 密钥</strong><small>Oracle Cloud 文档</small></span>
              ${icon("external-link")}
            </a>
          </div>
        </section>

        <section class="panel settings-panel settings-proxy-panel">
          <div class="settings-panel-heading">
            <span class="settings-icon ${proxy.enabled ? "is-connected" : ""}">${icon("network")}</span>
            <div>
              <span class="panel-kicker">NETWORK ROUTE</span>
              <h2>本地 SOCKS 代理</h2>
            </div>
            ${
              proxy.enabled
                ? `<span class="status-badge status-running"><span class="status-indicator"></span>已启用</span>`
                : `<span class="status-badge status-offline"><span class="status-indicator"></span>直连</span>`
            }
          </div>

          <form id="proxy-form" novalidate>
            <label class="switch-row settings-switch">
              <span>
                <strong>通过 SOCKS 代理访问云 API</strong>
                <small>适合 Clash、v2ray、sing-box 等本地代理。</small>
              </span>
              <input type="checkbox" id="proxy-enabled" ${proxy.enabled ? "checked" : ""} />
              <span class="switch-control"></span>
            </label>

            <label class="form-field">
              <span class="field-label">代理地址</span>
              <input type="text" id="proxy-url" value="${escapeHtml(proxy.url || "socks5h://127.0.0.1:7890")}" placeholder="socks5h://127.0.0.1:7890" autocomplete="off" spellcheck="false" />
              <span class="field-hint">推荐 <code>socks5h://</code>，由代理端完成 DNS 解析。支持 SOCKS4 / 4A / 5 / 5H。</span>
            </label>

            <div class="proxy-presets">
              <span>常用端口</span>
              <button type="button" class="preset-button" data-action="proxy-preset" data-url="socks5h://127.0.0.1:7890">Clash 7890</button>
              <button type="button" class="preset-button" data-action="proxy-preset" data-url="socks5h://127.0.0.1:1080">SOCKS 1080</button>
              <button type="button" class="preset-button" data-action="proxy-preset" data-url="socks5h://127.0.0.1:10808">v2ray 10808</button>
            </div>

            <div class="form-grid-two">
              <label class="form-field">
                <span class="field-label">用户名 <em>可选</em></span>
                <input type="text" id="proxy-username" value="${escapeHtml(proxy.username || "")}" autocomplete="off" />
              </label>
              <label class="form-field">
                <span class="field-label">密码 <em>可选</em></span>
                <input type="password" id="proxy-password" value="" placeholder="${proxy.hasPassword ? "已保存，留空保持不变" : "代理密码"}" autocomplete="new-password" />
              </label>
            </div>

            <div class="settings-actions">
              <button type="submit" class="button button-primary button-sm">${icon("check")} 保存代理设置</button>
              <button type="button" class="button button-secondary button-sm" data-action="test-proxy">${icon("activity")} 测试代理</button>
            </div>
            <div class="proxy-result is-hidden" id="proxy-result"></div>
          </form>

          <p class="settings-note">
            ${icon("info")}
            <span>代理只影响 Node 服务访问 Linode 与 Oracle API 的请求。修改后点击“测试代理”确认能否连通，再保存。</span>
          </p>
        </section>

        <section class="panel settings-panel">
          <div class="settings-panel-heading">
            <span class="settings-icon">${icon("refresh")}</span>
            <div>
              <span class="panel-kicker">BEHAVIOR</span>
              <h2>刷新与偏好</h2>
            </div>
          </div>

          <label class="switch-row settings-switch">
            <span>
              <strong>自动刷新实例状态</strong>
              <small>页面可见时每 30 秒更新一次状态和活动。</small>
            </span>
            <input type="checkbox" id="pref-auto-refresh" ${state.prefs.autoRefresh ? "checked" : ""} />
            <span class="switch-control"></span>
          </label>

          <div class="settings-list settings-list-compact">
            <div><dt>API 地址</dt><dd class="mono">${escapeHtml(state.session?.apiBase || "https://api.linode.com/v4")}</dd></div>
            <div><dt>界面语言</dt><dd>简体中文</dd></div>
            <div><dt>计费单位</dt><dd>USD</dd></div>
            <div><dt>控制台版本</dt><dd>v${escapeHtml(state.session?.version || "1.1.0")}</dd></div>
          </div>
        </section>

        <section class="panel settings-panel settings-security">
          <div class="settings-panel-heading">
            <span class="settings-icon">${icon("shield")}</span>
            <div>
              <span class="panel-kicker">SECURITY</span>
              <h2>安全建议</h2>
            </div>
          </div>
          <ul class="security-list">
            <li><span>${icon("check")}</span>Linode 使用最小权限令牌；Oracle 使用专用 IAM 用户和独立 API 密钥。</li>
            <li><span>${icon("check")}</span>令牌、OCI 私钥和代理密码加密保存在本机，不写入浏览器 localStorage。</li>
            <li><span>${icon("check")}</span>若需通过公网访问，请在前面加 HTTPS 反向代理，并限制来源 IP。</li>
            <li><span>${icon("check")}</span>删除或终止实例不可恢复；控制台会要求输入实例名称二次确认。</li>
          </ul>
        </section>

        <section class="panel settings-panel settings-links">
          <div class="settings-panel-heading">
            <span class="settings-icon">${icon("code")}</span>
            <div>
              <span class="panel-kicker">RESOURCES</span>
              <h2>相关链接</h2>
            </div>
          </div>
          <a class="resource-link" href="https://cloud.linode.com/profile/tokens" target="_blank" rel="noreferrer">
            <span><strong>创建 Personal Access Token</strong><small>Linode Cloud Manager</small></span>
            ${icon("external-link")}
          </a>
          <a class="resource-link" href="https://techdocs.akamai.com/linode-api/reference/api" target="_blank" rel="noreferrer">
            <span><strong>Linode API v4 文档</strong><small>Akamai TechDocs</small></span>
            ${icon("external-link")}
          </a>
          <a class="resource-link" href="https://www.linode.com/docs/" target="_blank" rel="noreferrer">
            <span><strong>Linode 使用指南</strong><small>部署、网络与安全文档</small></span>
            ${icon("external-link")}
          </a>
        </section>
      </div>
    </section>
  `;
}

export function renderDisconnected(state) {
  return `
    <section class="page page-disconnected">
      <div class="connect-card">
        <span class="connect-mark">${icon("cloud")}</span>
        <span class="eyebrow">CLOUDVMCONTROLLER / LOCAL</span>
        <h1>连接你的云账户</h1>
        <p>连接 Linode 或 Oracle Cloud，在一个本地控制面中查看实例、执行开关机与重启。Linode 支持部署、监控和 IP 管理；OCI 支持创建、监控、启动卷备份和串口控制台。</p>
        <div class="connect-actions">
          <button type="button" class="button button-primary" data-action="open-token">
            ${icon("key")} 连接 Linode
          </button>
          <button type="button" class="button button-secondary" data-action="open-oracle">
            ${icon("cloud")} 连接 Oracle Cloud
          </button>
        </div>
        ${state.sessionError ? `<div class="form-alert">${icon("alert")}<span>${escapeHtml(state.sessionError)}</span></div>` : ""}
        <div class="connect-features">
          <span><strong>01</strong> 实例开关机</span>
          <span><strong>02</strong> 实时监控</span>
          <span><strong>03</strong> 多云账户</span>
          <span><strong>04</strong> 加密凭据</span>
        </div>
        <p class="connect-foot">${icon("shield")} 浏览器不会接触或持久化令牌与私钥；所有凭据由本地 Node 服务加密管理。</p>
      </div>
    </section>
  `;
}

function metricCard(label, value, iconName, detail = "") {
  return `
    <div class="metric-card">
      <span class="metric-icon">${icon(iconName)}</span>
      <span class="metric-copy"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong>${detail ? `<span>${escapeHtml(detail)}</span>` : ""}</span>
    </div>
  `;
}

function detailActionButton(state, instance, operation, label, iconName, style = "") {
  const busy = state.busyActions.has(`${instance.id}:${operation}`);
  const disabled = busy || isTransitional(instance.status);
  return `
    <button
      type="button"
      class="button ${style || "button-secondary"} button-sm"
      data-action="instance-action"
      data-id="${escapeHtml(instance.id)}"
      data-token-id="${escapeHtml(instance.tokenId || "")}"
      data-provider="${escapeHtml(instance.provider || "linode")}"
      data-operation="${operation}"
      ${disabled ? "disabled" : ""}
    >
      ${busy ? spinner() : icon(iconName)}
      <span>${escapeHtml(label)}</span>
    </button>
  `;
}

function renderDetailCharts(stats) {
  if (!stats) {
    return emptyState({
      iconName: "activity",
      title: "监控数据暂不可用",
      description: "需要 Linodes 只读权限，或实例刚创建尚无统计数据。",
    });
  }

  const cpuPoints = extractPoints(stats.cpu);
  const netInPoints = extractPoints(stats.netv4?.in ?? stats.netin);
  const netOutPoints = extractPoints(stats.netv4?.out ?? stats.netout);
  const latestCpu = latestValue(cpuPoints);
  const latestIn = latestValue(netInPoints);
  const latestOut = latestValue(netOutPoints);
  const cpuMax = Math.max(100, Math.ceil(Math.max(...cpuPoints.map((point) => point[1]), 0) / 10) * 10);

  return `
    <div class="metric-grid">
      ${metricCard("CPU", latestCpu === null ? "—" : formatPercent(latestCpu, 1), "cpu", "24 小时最新值")}
      ${metricCard("入站", latestIn === null ? "—" : formatBitrate(latestIn), "network", "bits / 秒")}
      ${metricCard("出站", latestOut === null ? "—" : formatBitrate(latestOut), "network", "bits / 秒")}
    </div>

    <div class="chart-card">
      <div class="chart-heading">
        <div><span class="panel-kicker">CPU</span><h3>处理器使用率</h3></div>
        <span class="chart-legend"><i class="legend-dot legend-green"></i>24 小时</span>
      </div>
      ${renderLineChart([{ points: cpuPoints }], {
        height: 210,
        colors: ["#4ade80"],
        maxValueOverride: cpuMax,
      })}
      <div class="chart-axis"><span>24 小时前</span><span>现在</span></div>
    </div>

    <div class="chart-card">
      <div class="chart-heading">
        <div><span class="panel-kicker">NETWORK</span><h3>网络吞吐</h3></div>
        <span class="chart-legend">
          <span><i class="legend-dot legend-green"></i>入站</span>
          <span><i class="legend-dot legend-blue"></i>出站</span>
        </span>
      </div>
      ${renderLineChart(
        [
          { points: netInPoints },
          { points: netOutPoints },
        ],
        {
          height: 210,
          colors: ["#4ade80", "#60a5fa"],
        },
      )}
      <div class="chart-axis"><span>24 小时前</span><span>现在</span></div>
    </div>
  `;
}

function renderDetailEvents(events) {
  if (!events?.length) {
    return `<p class="muted-copy">最近没有与该实例相关的账户事件。</p>`;
  }

  return `
    <div class="detail-event-list">
      ${events
        .slice(0, 8)
        .map((event) => eventItem(event, { compact: true }))
        .join("")}
    </div>
  `;
}

function renderBackups(backups) {
  if (!backups) {
    return `<p class="muted-copy">备份信息不可用。</p>`;
  }

  return `
    <div class="backup-status">
      <span class="backup-icon ${backups.enabled ? "is-enabled" : ""}">${icon("disk")}</span>
      <span class="backup-copy">
        <strong>${backups.enabled ? "自动备份已启用" : "自动备份未启用"}</strong>
        <small>
          ${
            backups.enabled
              ? `${backups.available ? "有可用快照" : "等待首个快照"}${backups.last_successful ? ` · 最近成功 ${formatDateTime(backups.last_successful)}` : ""}`
              : "可在 Linode Cloud Manager 中启用备份计划。"
          }
        </small>
      </span>
    </div>
    ${
      backups.enabled && backups.schedule
        ? `<div class="backup-schedule"><span>计划：${escapeHtml(backups.schedule.day || "每日")}</span><span>窗口：${escapeHtml(backups.schedule.window || "—")}</span></div>`
        : ""
    }
  `;
}

function ipSwapAddress(info, kind) {
  if (!info) {
    return "";
  }
  if (kind === "ipv6") {
    return info.ipv6Ranges?.[0]?.range || "";
  }
  return info.publicIpv4 || "";
}

export function renderIpSwapModal(state) {
  const modal = state.modal;
  if (!modal || modal.type !== "ip-swap") {
    return "";
  }

  const source = modal.instance || {};
  const candidates = Array.isArray(modal.candidates) ? modal.candidates : [];
  const kind = modal.kind === "ipv6" ? "ipv6" : "ipv4";
  const sourceInfo = modal.sourceInfo;
  const targetInfo = modal.targetInfo;
  const sourceAddress = ipSwapAddress(sourceInfo, kind);
  const targetAddress = ipSwapAddress(targetInfo, kind);
  const selectedCandidate = candidates.find(
    (candidate) => String(candidate.id) === String(modal.targetId),
  );
  const sourceAvailable =
    kind === "ipv4" ? sourceInfo?.ipv4Swappable : sourceInfo?.ipv6Swappable;
  const targetAvailable =
    kind === "ipv4" ? targetInfo?.ipv4Swappable : targetInfo?.ipv6Swappable;
  const targetLabel =
    selectedCandidate?.label ||
    (selectedCandidate ? `linode-${selectedCandidate.id}` : "选择目标实例");
  const targetRegion = selectedCandidate?.region || source.region || "";
  const missingKindMessage =
    kind === "ipv6"
      ? "至少有一方没有 /56 或 /64 IPv6 路由段。默认 IPv6 SLAAC 地址不可转移。"
      : "至少有一方没有可交换的公网 IPv4 地址。";
  const submitDisabled =
    Boolean(modal.busy) ||
    Boolean(modal.sourceLoading) ||
    Boolean(modal.targetLoading) ||
    !modal.targetId ||
    !targetInfo ||
    !sourceAddress ||
    !targetAddress ||
    sourceAvailable === false ||
    targetAvailable === false;

  return `
    <div class="modal-layer">
      <div class="modal-backdrop" data-action="close-modal"></div>
      <section class="modal-card modal-ip-swap" role="dialog" aria-modal="true" aria-labelledby="ip-swap-title">
        <button type="button" class="icon-button modal-close" data-action="close-modal" aria-label="关闭" ${modal.busy ? "disabled" : ""}>${icon("x")}</button>
        <span class="modal-mark">${icon("refresh")}</span>
        <span class="eyebrow">NETWORK ADDRESS SWAP</span>
        <h2 id="ip-swap-title">交换公网 IP</h2>
        <p>在同一账户和区域的两台实例之间交换地址。交换完成后需要重启两台实例，新地址才会在系统内生效。</p>

        <div class="form-alert${modal.error ? "" : " is-hidden"}" id="ip-swap-error" role="alert">
          ${icon("alert")}
          <span>${escapeHtml(modal.error || "")}</span>
        </div>

        <form id="ip-swap-form" novalidate>
          <div class="ip-swap-kind" role="group" aria-label="选择要交换的地址类型">
            <button
              type="button"
              class="ip-swap-kind-option${kind === "ipv4" ? " is-active" : ""}"
              data-action="ip-swap-kind"
              data-kind="ipv4"
              ${modal.busy ? "disabled" : ""}
            >
              <span class="ip-swap-kind-copy">
                <strong>IPv4</strong>
                <small>公网地址</small>
              </span>
              <span class="ip-swap-kind-state ${sourceInfo?.ipv4Swappable ? "is-ready" : sourceInfo ? "is-missing" : ""}">
                ${sourceInfo ? (sourceInfo.ipv4Swappable ? "可交换" : "不可用") : modal.error ? "未知" : "检查中"}
              </span>
            </button>
            <button
              type="button"
              class="ip-swap-kind-option${kind === "ipv6" ? " is-active" : ""}"
              data-action="ip-swap-kind"
              data-kind="ipv6"
              ${modal.busy ? "disabled" : ""}
            >
              <span class="ip-swap-kind-copy">
                <strong>IPv6</strong>
                <small>路由段 /56 · /64</small>
              </span>
              <span class="ip-swap-kind-state ${sourceInfo?.ipv6Swappable ? "is-ready" : sourceInfo ? "is-missing" : ""}">
                ${sourceInfo ? (sourceInfo.ipv6Swappable ? "可交换" : "不可用") : modal.error ? "未知" : "检查中"}
              </span>
            </button>
          </div>

          <label class="form-field">
            <span class="field-label">目标实例</span>
            ${
              candidates.length > 0
                ? `<span class="select-wrap">
                    <span class="select-leading">${icon("network")}</span>
                    <select id="ip-swap-target" ${modal.busy ? "disabled" : ""}>
                      <option value="">选择同区域的另一台实例…</option>
                      ${candidates
                        .map(
                          (candidate) => `
                            <option value="${escapeHtml(candidate.id)}"${String(candidate.id) === String(modal.targetId) ? " selected" : ""}>
                              ${escapeHtml(candidate.label || `linode-${candidate.id}`)} · #${escapeHtml(candidate.id)}
                            </option>
                          `,
                        )
                        .join("")}
                    </select>
                    ${icon("chevron-down")}
                  </span>
                  <span class="field-hint">只显示同一 API 令牌、同一区域内的实例。</span>`
                : `<span class="ip-swap-empty">${icon("info")} 当前区域没有可用于交换的其他实例。</span>`
            }
          </label>

          <div class="ip-swap-compare">
            <div class="ip-swap-endpoint">
              <span class="ip-swap-endpoint-label">当前实例</span>
              <strong>${escapeHtml(source.label || `linode-${source.id}`)}</strong>
              <small>#${escapeHtml(source.id || "—")} · ${escapeHtml(source.region || "—")}</small>
              <span class="ip-swap-address mono">${
                modal.sourceLoading
                  ? `${spinner()} 读取地址…`
                  : escapeHtml(sourceAddress || "无可用地址")
              }</span>
            </div>
            <span class="ip-swap-arrow">${icon("refresh")}</span>
            <div class="ip-swap-endpoint ip-swap-endpoint-target">
              <span class="ip-swap-endpoint-label">目标实例</span>
              <strong>${escapeHtml(targetLabel)}</strong>
              <small>${selectedCandidate ? `#${escapeHtml(selectedCandidate.id)} · ${escapeHtml(targetRegion)}` : "尚未选择"}</small>
              <span class="ip-swap-address mono">${
                modal.targetLoading
                  ? `${spinner()} 读取地址…`
                  : escapeHtml(targetAddress || (selectedCandidate ? "无可用地址" : "—"))
              }</span>
            </div>
          </div>

          ${
            kind === "ipv6"
              ? `<div class="ip-swap-note">${icon("info")}<span>IPv6 仅支持 /56 或 /64 路由段互换。实例默认的 SLAAC 地址由平台绑定，无法转移。</span></div>`
              : ""
          }
          ${
            sourceInfo &&
            !modal.targetLoading &&
            (sourceAvailable === false || (targetInfo && targetAvailable === false))
              ? `<div class="ip-swap-note is-warning">${icon("alert")}<span>${escapeHtml(missingKindMessage)}</span></div>`
              : ""
          }
          ${
            sourceInfo?.ipv6Slaac && kind === "ipv6"
              ? `<div class="ip-swap-slaac"><span>默认 SLAAC</span><code class="mono">${escapeHtml(sourceInfo.ipv6Slaac)}</code><small>不可转移</small></div>`
              : ""
          }

          <div class="ip-swap-warning">
            ${icon("alert")}
            <span>交换会中断 SSH、网站和其他依赖当前地址的连接。请在操作后分别重启两台实例，并确认系统使用 Network Helper 或手动更新静态网络配置。API 令牌需要 IPs 与 Linodes 的读写权限。</span>
          </div>

          <div class="modal-actions">
            <button type="button" class="button button-secondary" data-action="close-modal" ${modal.busy ? "disabled" : ""}>取消</button>
            <button type="submit" class="button button-primary" ${submitDisabled ? "disabled" : ""}>
              ${modal.busy ? spinner() : icon("refresh")}
              <span>${modal.busy ? "正在交换…" : "确认交换"}</span>
            </button>
          </div>
        </form>
      </section>
    </div>
  `;
}

export function renderIpRenewModal(state) {
  const modal = state.modal;
  if (!modal || modal.type !== "ip-renew") {
    return "";
  }

  const source = modal.instance || {};
  const info = modal.sourceInfo;
  const kind = modal.kind === "ipv6" ? "ipv6" : "ipv4";
  const prefix = Number(modal.ipv6Prefix) === 56 ? 56 : 64;
  const currentAddress =
    kind === "ipv6"
      ? info?.ipv6Ranges?.[0]?.range || ""
      : info?.publicIpv4 || "";
  const hasIpv4 = Boolean(info?.publicIpv4);
  const hasIpv6 = Boolean(info?.ipv6Ranges?.length);
  const submitDisabled =
    Boolean(modal.busy) ||
    Boolean(modal.sourceLoading) ||
    !info ||
    !modal.confirmed ||
    (kind === "ipv4" && !hasIpv4);

  return `
    <div class="modal-layer">
      <div class="modal-backdrop" data-action="close-modal"></div>
      <section class="modal-card modal-ip-renew" role="dialog" aria-modal="true" aria-labelledby="ip-renew-title">
        <button type="button" class="icon-button modal-close" data-action="close-modal" aria-label="关闭" ${modal.busy ? "disabled" : ""}>${icon("x")}</button>
        <span class="modal-mark">${icon("zap")}</span>
        <span class="eyebrow">NETWORK ADDRESS RENEWAL</span>
        <h2 id="ip-renew-title">换新 IP</h2>
        <p>为当前实例申请新的公网地址。旧地址会被释放，操作完成后需要重启实例才能让新地址生效。</p>

        <div class="form-alert${modal.error ? "" : " is-hidden"}" id="ip-renew-error" role="alert">
          ${icon("alert")}
          <span>${escapeHtml(modal.error || "")}</span>
        </div>

        <form id="ip-renew-form" novalidate>
          <div class="ip-swap-kind" role="group" aria-label="选择要更换的地址类型">
            <button
              type="button"
              class="ip-swap-kind-option${kind === "ipv4" ? " is-active" : ""}"
              data-action="ip-renew-kind"
              data-kind="ipv4"
              ${modal.busy ? "disabled" : ""}
            >
              <span class="ip-swap-kind-copy">
                <strong>IPv4</strong>
                <small>公网地址</small>
              </span>
              <span class="ip-swap-kind-state ${hasIpv4 ? "is-ready" : info ? "is-missing" : ""}">
                ${info ? (hasIpv4 ? "有旧地址" : "不可更换") : modal.error ? "未知" : "检查中"}
              </span>
            </button>
            <button
              type="button"
              class="ip-swap-kind-option${kind === "ipv6" ? " is-active" : ""}"
              data-action="ip-renew-kind"
              data-kind="ipv6"
              ${modal.busy ? "disabled" : ""}
            >
              <span class="ip-swap-kind-copy">
                <strong>IPv6</strong>
                <small>路由段 /64 · /56</small>
              </span>
              <span class="ip-swap-kind-state ${info ? "is-ready" : ""}">
                ${info ? (hasIpv6 ? "替换旧段" : "将新建") : modal.error ? "未知" : "检查中"}
              </span>
            </button>
          </div>

          <div class="ip-swap-endpoint ip-renew-current">
            <span class="ip-swap-endpoint-label">当前实例</span>
            <strong>${escapeHtml(source.label || `linode-${source.id}`)}</strong>
            <small>#${escapeHtml(source.id || "—")} · ${escapeHtml(source.region || "—")}</small>
            <span class="ip-renew-current-label">
              ${kind === "ipv4" ? "当前公网 IPv4" : "当前 IPv6 路由段"}
            </span>
            <span class="ip-swap-address ip-renew-address mono">${
              modal.sourceLoading
                ? `${spinner()} 读取地址…`
                : escapeHtml(
                    currentAddress ||
                      (kind === "ipv4"
                        ? "无公网 IPv4"
                        : "无路由段（将新建）"),
                  )
            }</span>
          </div>

          ${
            kind === "ipv6"
              ? `<div class="form-field">
                  <span class="field-label">新 IPv6 段大小</span>
                  <div class="ip-swap-kind ip-renew-prefix">
                    <button
                      type="button"
                      class="ip-swap-kind-option${prefix === 64 ? " is-active" : ""}"
                      data-action="ip-renew-prefix"
                      data-prefix="64"
                      ${modal.busy ? "disabled" : ""}
                    >
                      <span class="ip-swap-kind-copy"><strong>/64</strong><small>默认</small></span>
                      <span class="ip-swap-kind-state is-ready">推荐</span>
                    </button>
                    <button
                      type="button"
                      class="ip-swap-kind-option${prefix === 56 ? " is-active" : ""}"
                      data-action="ip-renew-prefix"
                      data-prefix="56"
                      ${modal.busy ? "disabled" : ""}
                    >
                      <span class="ip-swap-kind-copy"><strong>/56</strong><small>更大地址空间</small></span>
                      <span class="ip-swap-kind-state">高级</span>
                    </button>
                  </div>
                </div>
                <div class="ip-swap-slaac ip-renew-slaac">
                  <span>默认 SLAAC</span>
                  <code class="mono">${escapeHtml(info?.ipv6Slaac || "未分配")}</code>
                  <small>不可变</small>
                </div>
                <div class="ip-swap-warning">
                  ${icon("alert")}
                  <span>会先释放当前路由段，再申请全新的 /${prefix} 段。每个账户在每个区域默认只有一个 IPv6 路由段；如果新段申请失败，旧段可能已经释放。默认 SLAAC 地址不会改变。</span>
                </div>
                <div class="ip-swap-note">
                  ${icon("info")}
                  <span>新段会路由到实例的 SLAAC 地址，但不会自动把段内地址配置进系统。请在实例内从新段添加一个地址（/64 段使用 /64，/56 段使用 /56），并放行 ICMPv6 后再测试；前缀本身不能直接 ping。</span>
                </div>
                <div class="ip-swap-warning">
                  ${icon("alert")}
                  <span>如果实例开启了 Network Helper，重启时会重写网卡配置，手工添加的段内地址可能消失。长期使用前请先准备静态网络配置，再按 Linode 官方建议关闭 Network Helper；不要只关闭 Helper 就直接重启。</span>
                </div>
                <div class="ip-swap-note">
                  ${icon("info")}
                  <span>IPv6 路由段不单独计费；实际费用以 Akamai 账单为准。</span>
                </div>`
              : `<div class="ip-swap-warning">
                  ${icon("alert")}
                  <span>会先为实例申请一个额外公网 IPv4，成功后再删除旧地址。账户必须具备额外 IPv4 配额（通常需提交工单）；额外 IPv4 会单独计费，新旧地址短暂并存期间也可能产生按小时计费。分配失败时不会删除旧地址。</span>
                </div>`
          }

          ${
            kind === "ipv4" && info && !hasIpv4
              ? `<div class="ip-swap-note is-warning">${icon("alert")}<span>当前实例没有公网 IPv4，无法执行 IPv4 换新。请切换到 IPv6 或先分配 IPv4。</span></div>`
              : ""
          }

          <label class="simple-checkbox ip-renew-confirm">
            <input type="checkbox" id="ip-renew-confirm" ${modal.confirmed ? "checked" : ""} ${modal.busy ? "disabled" : ""} />
            <span>${icon("check")}</span>
            <span>我了解旧 IP 会释放、且需要重启实例</span>
          </label>

          <div class="modal-actions">
            <button type="button" class="button button-secondary" data-action="close-modal" ${modal.busy ? "disabled" : ""}>取消</button>
            <button type="submit" class="button button-primary" ${submitDisabled ? "disabled" : ""}>
              ${modal.busy ? spinner() : icon("zap")}
              <span>${modal.busy ? "正在换新…" : kind === "ipv6" ? "申请新 IPv6 段" : "申请新 IPv4"}</span>
            </button>
          </div>
        </form>
      </section>
    </div>
  `;
}

export function renderOracleBackupModal(state) {
  const modal = state.modal;
  if (!modal || modal.type !== "oracle-backup") {
    return "";
  }
  const instance = modal.instance || {};
  return `
    <div class="modal-layer">
      <div class="modal-backdrop" data-action="close-modal"></div>
      <section class="modal-card modal-oci-backup" role="dialog" aria-modal="true" aria-labelledby="oracle-backup-title">
        <button type="button" class="icon-button modal-close" data-action="close-modal" aria-label="关闭" ${modal.busy ? "disabled" : ""}>${icon("x")}</button>
        <span class="modal-mark">${icon("disk")}</span>
        <span class="eyebrow">BOOT VOLUME BACKUP</span>
        <h2 id="oracle-backup-title">创建启动卷备份</h2>
        <p>为 <strong>${escapeHtml(instance.label || "OCI 实例")}</strong> 的启动卷创建备份。OCI 备份是启动卷快照，不是完整实例快照，也不会自动恢复整台实例。</p>

        <div class="form-alert${modal.error ? "" : " is-hidden"}" id="oracle-backup-error" role="alert">
          ${icon("alert")}<span>${escapeHtml(modal.error || "")}</span>
        </div>

        <form id="oracle-backup-form" novalidate>
          <label class="form-field">
            <span class="field-label">备份名称</span>
            <input type="text" id="oracle-backup-name" maxlength="255" value="${escapeHtml(modal.displayName || "")}" ${modal.busy ? "disabled" : ""} />
            <span class="field-hint">最多 255 个字符。创建后在 OCI 控制台可看到同一名称。</span>
          </label>
          <label class="form-field">
            <span class="field-label">备份类型</span>
            <span class="select-wrap">
              <span class="select-leading">${icon("disk")}</span>
              <select id="oracle-backup-type" ${modal.busy ? "disabled" : ""}>
                <option value="INCREMENTAL"${modal.backupType !== "FULL" ? " selected" : ""}>增量备份（推荐，体积更小）</option>
                <option value="FULL"${modal.backupType === "FULL" ? " selected" : ""}>完整备份</option>
              </select>
              ${icon("chevron-down")}
            </span>
          </label>
          <div class="ip-swap-note">
            ${icon("info")}
            <span>备份创建是异步操作，可能需要数分钟到数小时才变为 AVAILABLE。备份会占用 OCI 存储并产生费用；恢复时通常需要基于该备份创建新的启动卷。</span>
          </div>
          <div class="modal-actions">
            <button type="button" class="button button-secondary" data-action="close-modal" ${modal.busy ? "disabled" : ""}>取消</button>
            <button type="submit" class="button button-primary" ${modal.busy ? "disabled" : ""}>
              ${modal.busy ? spinner() : icon("disk")}
              <span>${modal.busy ? "正在提交…" : "创建备份"}</span>
            </button>
          </div>
        </form>
      </section>
    </div>
  `;
}

export function renderOracleBackupDeleteModal(state) {
  const modal = state.modal;
  if (!modal || modal.type !== "oracle-backup-delete") {
    return "";
  }
  const backup = modal.backup || {};
  return `
    <div class="modal-layer">
      <div class="modal-backdrop" data-action="close-modal"></div>
      <section class="modal-card modal-delete modal-oci-backup" role="dialog" aria-modal="true" aria-labelledby="oracle-backup-delete-title">
        <button type="button" class="icon-button modal-close" data-action="close-modal" aria-label="关闭" ${modal.busy ? "disabled" : ""}>${icon("x")}</button>
        <span class="modal-mark modal-mark-danger">${icon("trash")}</span>
        <span class="eyebrow eyebrow-danger">DELETE BOOT VOLUME BACKUP</span>
        <h2 id="oracle-backup-delete-title">删除启动卷备份</h2>
        <p>将永久删除 <strong>${escapeHtml(backup.displayName || backup.id || "该备份")}</strong>。这会删除该时间点的启动卷恢复点，无法撤销。</p>
        <div class="form-alert${modal.error ? "" : " is-hidden"}" id="oracle-backup-delete-error" role="alert">
          ${icon("alert")}<span>${escapeHtml(modal.error || "")}</span>
        </div>
        <form id="oracle-backup-delete-form">
          <label class="simple-checkbox ip-renew-confirm">
            <input type="checkbox" id="oracle-backup-delete-confirm" ${modal.confirmed ? "checked" : ""} ${modal.busy ? "disabled" : ""} />
            <span>${icon("check")}</span>
            <span>我确认删除这个 OCI 启动卷备份</span>
          </label>
          <div class="modal-actions">
            <button type="button" class="button button-secondary" data-action="close-modal" ${modal.busy ? "disabled" : ""}>取消</button>
            <button type="submit" class="button button-danger" ${modal.busy || !modal.confirmed ? "disabled" : ""}>
              ${modal.busy ? spinner() : icon("trash")}
              <span>${modal.busy ? "正在删除…" : "删除备份"}</span>
            </button>
          </div>
        </form>
      </section>
    </div>
  `;
}

export function renderOracleConsoleModal(state) {
  const modal = state.modal;
  if (!modal || modal.type !== "oracle-console") {
    return "";
  }
  const instance = modal.instance || {};
  return `
    <div class="modal-layer">
      <div class="modal-backdrop" data-action="close-modal"></div>
      <section class="modal-card modal-oci-console" role="dialog" aria-modal="true" aria-labelledby="oracle-console-title">
        <button type="button" class="icon-button modal-close" data-action="close-modal" aria-label="关闭" ${modal.busy ? "disabled" : ""}>${icon("x")}</button>
        <span class="modal-mark">${icon("terminal")}</span>
        <span class="eyebrow">SERIAL CONSOLE CONNECTION</span>
        <h2 id="oracle-console-title">创建 OCI 串口连接</h2>
        <p>为 <strong>${escapeHtml(instance.label || "OCI 实例")}</strong> 创建 SSH 串口连接。浏览器只显示 OCI 返回的 SSH 命令，不会在浏览器内建立交互终端，也不会保存你的私钥。</p>

        <div class="form-alert${modal.error ? "" : " is-hidden"}" id="oracle-console-error" role="alert">
          ${icon("alert")}<span>${escapeHtml(modal.error || "")}</span>
        </div>

        <form id="oracle-console-form" novalidate>
          <label class="form-field">
            <span class="field-label">RSA 公钥</span>
            <textarea id="oracle-console-public-key" rows="5" placeholder="ssh-rsa AAAAB3NzaC1yc2E... user@example" spellcheck="false" ${modal.busy ? "disabled" : ""}>${escapeHtml(modal.publicKey || "")}</textarea>
            <span class="field-hint">OCI 串口控制台要求 RSA 公钥。请把对应私钥保存在本机；连接串会出现在实例详情里。</span>
          </label>
          <div class="ip-swap-note">
            ${icon("info")}
            <span>创建后可复制 OCI 提供的 SSH 命令，并用本机私钥连接。主机指纹会显示在详情中；连接前请核对 <code>serviceHostKeyFingerprint</code>。</span>
          </div>
          <div class="modal-actions">
            <button type="button" class="button button-secondary" data-action="close-modal" ${modal.busy ? "disabled" : ""}>取消</button>
            <button type="submit" class="button button-primary" ${modal.busy ? "disabled" : ""}>
              ${modal.busy ? spinner() : icon("terminal")}
              <span>${modal.busy ? "正在创建…" : "创建串口连接"}</span>
            </button>
          </div>
        </form>
      </section>
    </div>
  `;
}

export function renderOracleTerminateModal(state) {
  const modal = state.modal;
  if (!modal || modal.type !== "oracle-terminate") {
    return "";
  }
  const instance = modal.instance || {};
  const expected = instance.label || "";
  const confirmationMatches =
    String(modal.confirmation || "").trim() === expected;
  return `
    <div class="modal-layer">
      <div class="modal-backdrop" data-action="close-modal"></div>
      <section class="modal-card modal-delete modal-oci-terminate" role="dialog" aria-modal="true" aria-labelledby="oracle-terminate-title">
        <button type="button" class="icon-button modal-close" data-action="close-modal" aria-label="关闭" ${modal.busy ? "disabled" : ""}>${icon("x")}</button>
        <span class="modal-mark modal-mark-danger">${icon("trash")}</span>
        <span class="eyebrow eyebrow-danger">TERMINATE OCI INSTANCE</span>
        <h2 id="oracle-terminate-title">终止 OCI 实例</h2>
        <p>这是不可逆的异步操作。OCI 会终止 <strong>${escapeHtml(expected || "该实例")}</strong>，实例状态会先变为 TERMINATING，随后从活动实例列表消失。</p>

        <div class="form-alert${modal.error ? "" : " is-hidden"}" id="oracle-terminate-error" role="alert">
          ${icon("alert")}<span>${escapeHtml(modal.error || "")}</span>
        </div>

        <form id="oracle-terminate-form" novalidate>
          <label class="form-field">
            <span class="field-label">输入实例名以确认</span>
            <input type="text" id="oracle-terminate-confirmation" autocomplete="off" placeholder="${escapeHtml(expected)}" value="${escapeHtml(modal.confirmation || "")}" ${modal.busy ? "disabled" : ""} />
            <span class="field-hint">必须与实例显示名称完全一致：<code>${escapeHtml(expected)}</code></span>
          </label>
          <label class="switch-row">
            <span>
              <strong>保留启动卷</strong>
              <small>保留启动卷可避免数据立即删除，但仍会继续占用 OCI 存储和产生费用。它不等于保留整台实例。</small>
            </span>
            <input type="checkbox" id="oracle-terminate-preserve-boot" ${modal.preserveBootVolume ? "checked" : ""} ${modal.busy ? "disabled" : ""} />
            <span class="switch-control"></span>
          </label>
          <label class="switch-row">
            <span>
              <strong>保留随实例创建的数据卷</strong>
              <small>OCI 默认保留随实例创建的数据卷。取消勾选会同时删除这些数据卷。</small>
            </span>
            <input type="checkbox" id="oracle-terminate-preserve-data" ${modal.preserveDataVolumes !== false ? "checked" : ""} ${modal.busy ? "disabled" : ""} />
            <span class="switch-control"></span>
          </label>
          <div class="modal-actions">
            <button type="button" class="button button-secondary" data-action="close-modal" ${modal.busy ? "disabled" : ""}>取消</button>
            <button type="submit" class="button button-danger" ${modal.busy || !confirmationMatches ? "disabled" : ""}>
              ${modal.busy ? spinner() : icon("trash")}
              <span>${modal.busy ? "正在提交…" : "终止实例"}</span>
            </button>
          </div>
        </form>
      </section>
    </div>
  `;
}

function formatByteRate(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "—";
  }
  if (numericValue >= 1_000_000_000) {
    return `${(numericValue / 1_000_000_000).toFixed(2)} GB/s`;
  }
  if (numericValue >= 1_000_000) {
    return `${(numericValue / 1_000_000).toFixed(2)} MB/s`;
  }
  if (numericValue >= 1000) {
    return `${(numericValue / 1000).toFixed(1)} KB/s`;
  }
  return `${Math.round(numericValue)} B/s`;
}

function oracleMetricByKey(metrics = [], key) {
  return (Array.isArray(metrics) ? metrics : []).find(
    (metric) => metric?.key === key,
  ) || null;
}

function formatChartAxisTime(value, window) {
  const date =
    typeof value === "number" || /^\d+$/.test(String(value || ""))
      ? new Date(Number(value))
      : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: window === "7d" ? "2-digit" : undefined,
    day: window === "7d" ? "2-digit" : undefined,
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function oracleStatePill(value) {
  const state = String(value || "").toUpperCase();
  const map = {
    AVAILABLE: ["可用", "ok"],
    ACTIVE: ["已连接", "ok"],
    SUCCEEDED: ["已就绪", "ok"],
    REQUESTED: ["已请求", "pending"],
    "GETTING-HISTORY": ["采集中", "pending"],
    CREATING: ["创建中", "pending"],
    ATTACHING: ["挂载中", "pending"],
    TERMINATING: ["删除中", "danger"],
    TERMINATED: ["已删除", "danger"],
    FAILED: ["失败", "danger"],
    FAULTY: ["异常", "danger"],
  };
  const [label, tone] = map[state] || [state || "未知", "pending"];
  return `<span class="oci-state oci-state-${tone}">${escapeHtml(label)}</span>`;
}

function renderOracleMonitoring(state, detail, instance) {
  const bundle = detail.data?.oracleMetrics;
  const loading = Boolean(state.detail?.oracleMetricsLoading);
  const window =
    state.detail?.oracleMetricsWindow || bundle?.window || "24h";
  const metrics = Array.isArray(bundle?.metrics) ? bundle.metrics : [];
  const cpu = oracleMetricByKey(metrics, "cpu");
  const memory = oracleMetricByKey(metrics, "memory");
  const load = oracleMetricByKey(metrics, "load");
  const networkIn = oracleMetricByKey(metrics, "networkIn");
  const networkOut = oracleMetricByKey(metrics, "networkOut");
  const diskRead = oracleMetricByKey(metrics, "diskRead");
  const diskWrite = oracleMetricByKey(metrics, "diskWrite");
  const cpuPoints = extractPoints(cpu?.points);
  const memoryPoints = extractPoints(memory?.points);
  const networkInPoints = extractPoints(networkIn?.points);
  const networkOutPoints = extractPoints(networkOut?.points);
  const diskReadPoints = extractPoints(diskRead?.points);
  const diskWritePoints = extractPoints(diskWrite?.points);
  const latestCpu = latestValue(cpuPoints);
  const latestMemory = latestValue(memoryPoints);
  const latestLoad = latestValue(load?.points);
  const latestNetworkIn = latestValue(networkInPoints);
  const errors = Array.isArray(bundle?.errors) ? bundle.errors : [];
  const emptyReason =
    bundle?.emptyReason ||
    "OCI 未返回监控数据。请确认实例已启用 Compute Instance Monitoring 插件并且 Oracle Cloud Agent 正常运行。";
  const rangeLabels = {
    "1h": "1 小时",
    "6h": "6 小时",
    "24h": "24 小时",
    "7d": "7 天",
  };

  return `
    <div class="oci-metric-toolbar">
      <span class="chart-legend">${icon("activity")} 数据源：oci_computeagent · ${escapeHtml(bundle?.resolution || "5m")} 粒度</span>
      <span class="oci-range-switch" role="group" aria-label="监控时间范围">
        ${Object.entries(rangeLabels)
          .map(
            ([value, label]) => `<button type="button" class="oci-range-option${window === value ? " is-active" : ""}" data-action="oci-metric-window" data-window="${value}" ${loading ? "disabled" : ""}>${escapeHtml(label)}</button>`,
          )
          .join("")}
      </span>
    </div>
    ${
      loading
        ? `<div class="drawer-transition">${spinner()} 正在刷新 OCI 监控指标…</div>`
        : ""
    }
    ${
      errors.length > 0
        ? `<div class="inline-error"><span class="inline-error-icon">${icon("alert")}</span><span><strong>部分监控指标不可用</strong><small>${escapeHtml(errors.map((entry) => entry.message).join("；"))}</small></span></div>`
        : ""
    }
    ${
      !bundle || (metrics.every((metric) => !extractPoints(metric.points).length) && !loading)
        ? `<div class="chart-empty oci-chart-empty">${escapeHtml(emptyReason)}</div>`
        : `
          <div class="metric-grid oci-metric-grid">
            ${metricCard("CPU", latestCpu === null ? "—" : formatPercent(latestCpu, 1), "cpu", `${rangeLabels[window]}最新值`)}
            ${metricCard("内存", latestMemory === null ? "—" : formatPercent(latestMemory, 1), "memory", "Compute Agent")}
            ${metricCard("负载", latestLoad === null ? "—" : formatNumber(Number(latestLoad).toFixed(2)), "activity", "1 分钟平均")}
            ${metricCard("入站", latestNetworkIn === null ? "—" : formatByteRate(latestNetworkIn), "network", "网络接收")}
          </div>
          <div class="oci-monitor-charts">
            <div class="chart-card">
              <div class="chart-heading">
                <div><span class="panel-kicker">CPU + MEMORY</span><h3>处理器与内存</h3></div>
                <span class="chart-legend">
                  <span><i class="legend-dot legend-green"></i>CPU</span>
                  <span><i class="legend-dot legend-blue"></i>内存</span>
                </span>
              </div>
              ${renderLineChart(
                [
                  { points: cpuPoints },
                  { points: memoryPoints },
                ],
                {
                  height: 210,
                  colors: ["#4ade80", "#60a5fa"],
                  maxValueOverride: 100,
                },
              )}
              <div class="chart-axis"><span>${escapeHtml(formatChartAxisTime(bundle?.startTime, window))}</span><span>现在</span></div>
            </div>
            <div class="chart-card">
              <div class="chart-heading">
                <div><span class="panel-kicker">NETWORK</span><h3>网络吞吐</h3></div>
                <span class="chart-legend">
                  <span><i class="legend-dot legend-green"></i>入站</span>
                  <span><i class="legend-dot legend-blue"></i>出站</span>
                </span>
              </div>
              ${renderLineChart(
                [
                  { points: networkInPoints },
                  { points: networkOutPoints },
                ],
                { height: 210, colors: ["#4ade80", "#60a5fa"] },
              )}
              <div class="chart-axis"><span>${escapeHtml(formatChartAxisTime(bundle?.startTime, window))}</span><span>现在</span></div>
            </div>
            <div class="chart-card">
              <div class="chart-heading">
                <div><span class="panel-kicker">DISK I/O</span><h3>磁盘吞吐</h3></div>
                <span class="chart-legend">
                  <span><i class="legend-dot legend-green"></i>读取</span>
                  <span><i class="legend-dot legend-blue"></i>写入</span>
                </span>
              </div>
              ${renderLineChart(
                [
                  { points: diskReadPoints },
                  { points: diskWritePoints },
                ],
                { height: 210, colors: ["#4ade80", "#60a5fa"] },
              )}
              <div class="chart-axis"><span>${escapeHtml(formatChartAxisTime(bundle?.startTime, window))}</span><span>现在</span></div>
            </div>
          </div>
        `
    }
    <div class="network-swap-row">
      <span>${icon("info")} 监控依赖 Compute Instance Monitoring 插件。插件未启用、Agent 未运行或实例无监控服务出口时，OCI 不会返回数据；本控制台不会伪造指标。</span>
    </div>
  `;
}

function renderOracleBackups(state, detail, instance) {
  const bundle = detail.data?.oracleBackups;
  const bootVolume = bundle?.bootVolume || null;
  const backups = Array.isArray(bundle?.backups) ? bundle.backups : [];
  const busy = Boolean(state.detail?.oracleOpsBusy);
  return `
    <div class="oci-resource-toolbar">
      <span>${bootVolume ? `启动卷 ${escapeHtml(bootVolume.displayName || bootVolume.id)}${Number.isFinite(Number(bootVolume.sizeInGBs)) ? ` · ${formatNumber(bootVolume.sizeInGBs)} GB` : ""}` : "启动卷信息不可用"}</span>
      <button type="button" class="button button-secondary button-sm" data-action="oci-backup-create" data-id="${escapeHtml(instance.id)}" data-token-id="${escapeHtml(instance.accountId || instance.tokenId || "")}" ${busy || !bootVolume ? "disabled" : ""}>
        ${icon("plus")} 创建启动卷备份
      </button>
    </div>
    ${
      bundle?.error
        ? `<div class="inline-error"><span class="inline-error-icon">${icon("alert")}</span><span><strong>备份信息不可用</strong><small>${escapeHtml(bundle.error)}</small></span></div>`
        : !bootVolume
          ? `<p class="muted-copy">${escapeHtml(bundle?.emptyReason || "没有找到该实例的启动卷附件，或当前凭据无权读取 Block Storage。")}</p>`
          : backups.length === 0
            ? `<p class="muted-copy">${escapeHtml(bundle?.emptyReason || "该启动卷还没有备份。创建备份后会保留该时间点的启动卷快照。")}</p>`
            : `<div class="oci-resource-list">
                ${backups
                  .map(
                    (backup) => `
                      <article class="oci-resource-row">
                        <span class="oci-resource-icon">${icon("disk")}</span>
                        <span class="oci-resource-copy">
                          <strong>${escapeHtml(backup.displayName || backup.id)}</strong>
                          <small class="mono">${escapeHtml(backup.type || "BACKUP")} · ${Number.isFinite(Number(backup.sizeInGBs)) ? `${formatNumber(backup.sizeInGBs)} GB` : "—"} · ${escapeHtml(formatDateTime(backup.timeCreated))}</small>
                        </span>
                        ${oracleStatePill(backup.lifecycleState)}
                        <button type="button" class="text-button text-button-danger" data-action="oci-backup-delete" data-id="${escapeHtml(instance.id)}" data-token-id="${escapeHtml(instance.accountId || instance.tokenId || "")}" data-backup-id="${escapeHtml(backup.id)}" ${busy ? "disabled" : ""}>删除</button>
                      </article>
                    `,
                  )
                  .join("")}
              </div>`
    }
    <div class="network-swap-row">
      <span>${icon("info")} 这里管理的是 OCI <strong>启动卷备份</strong>，不是整机快照。恢复时通常需要从备份创建新启动卷；备份、恢复和存储都会产生 OCI 费用。</span>
    </div>
  `;
}

function renderOracleConsole(state, detail, instance) {
  const bundle = detail.data?.oracleConsole;
  const connections = Array.isArray(bundle?.connections)
    ? bundle.connections
    : [];
  const histories = Array.isArray(bundle?.histories) ? bundle.histories : [];
  const busy = state.detail?.oracleOpsBusy || "";
  const historyData = detail.data?.oracleConsoleHistory;
  return `
    <div class="oci-resource-toolbar">
      <span>SSH 串口连接 · ${connections.length} 个连接 · ${histories.length} 条历史</span>
      <span class="oci-toolbar-actions">
        <button type="button" class="button button-secondary button-sm" data-action="oci-console-connect" data-id="${escapeHtml(instance.id)}" data-token-id="${escapeHtml(instance.accountId || instance.tokenId || "")}" ${busy ? "disabled" : ""}>
          ${icon("plus")} 创建串口连接
        </button>
        <button type="button" class="button button-secondary button-sm" data-action="oci-console-capture" data-id="${escapeHtml(instance.id)}" data-token-id="${escapeHtml(instance.accountId || instance.tokenId || "")}" ${busy ? "disabled" : ""}>
          ${busy === "history:create" ? spinner() : icon("terminal")} 采集控制台日志
        </button>
      </span>
    </div>
    ${
      bundle?.error
        ? `<div class="inline-error"><span class="inline-error-icon">${icon("alert")}</span><span><strong>串口控制台信息不可用</strong><small>${escapeHtml(bundle.error)}</small></span></div>`
        : ""
    }
    ${
      connections.length === 0
        ? `<p class="muted-copy">还没有 OCI 串口连接。创建时需要一个 RSA 公钥；浏览器不会保存对应私钥。</p>`
        : `<div class="oci-resource-list">
            ${connections
              .map(
                (connection) => `
                  <article class="oci-resource-row oci-console-row">
                    <span class="oci-resource-icon">${icon("terminal")}</span>
                    <span class="oci-resource-copy">
                      <strong>串口连接 ${escapeHtml(String(connection.id || "").slice(-12))}</strong>
                      <small class="mono">主机指纹 ${escapeHtml(connection.serviceHostKeyFingerprint || "—")}</small>
                      <small class="mono">用户密钥指纹 ${escapeHtml(connection.fingerprint || "—")}</small>
                      ${
                        connection.connectionString
                          ? `<details class="oci-command">
                              <summary>查看 SSH 连接串</summary>
                              <pre class="mono">${escapeHtml(connection.connectionString)}</pre>
                            </details>`
                          : ""
                      }
                    </span>
                    ${oracleStatePill(connection.lifecycleState)}
                    <span class="oci-row-actions">
                      ${
                        connection.connectionString
                          ? `<button type="button" class="text-button" data-copy="${escapeHtml(connection.connectionString)}">复制命令</button>`
                          : ""
                      }
                      <button type="button" class="text-button text-button-danger" data-action="oci-console-disconnect" data-id="${escapeHtml(instance.id)}" data-token-id="${escapeHtml(instance.accountId || instance.tokenId || "")}" data-connection-id="${escapeHtml(connection.id)}" ${busy ? "disabled" : ""}>删除</button>
                    </span>
                  </article>
                `,
              )
              .join("")}
          </div>`
    }
    ${
      histories.length > 0
        ? `<div class="oci-history-heading">
            <span class="panel-kicker">CONSOLE HISTORY</span>
            <h4>控制台启动日志</h4>
          </div>
          <div class="oci-resource-list">
            ${histories
              .map(
                (history) => `
                  <article class="oci-resource-row">
                    <span class="oci-resource-icon">${icon("terminal")}</span>
                    <span class="oci-resource-copy">
                      <strong>${escapeHtml(history.displayName || "控制台历史")}</strong>
                      <small class="mono">${escapeHtml(formatDateTime(history.timeCreated))}</small>
                    </span>
                    ${oracleStatePill(history.lifecycleState)}
                    <span class="oci-row-actions">
                      <button type="button" class="text-button" data-action="oci-console-history" data-id="${escapeHtml(instance.id)}" data-token-id="${escapeHtml(instance.accountId || instance.tokenId || "")}" data-history-id="${escapeHtml(history.id)}" ${busy ? "disabled" : ""} ${["SUCCEEDED", "AVAILABLE"].includes(String(history.lifecycleState || "").toUpperCase()) ? "" : "disabled"}>查看</button>
                      <button type="button" class="text-button text-button-danger" data-action="oci-console-history-delete" data-id="${escapeHtml(instance.id)}" data-token-id="${escapeHtml(instance.accountId || instance.tokenId || "")}" data-history-id="${escapeHtml(history.id)}" ${busy ? "disabled" : ""}>删除</button>
                    </span>
                  </article>
                `,
              )
              .join("")}
          </div>`
        : ""
    }
    ${
      historyData
        ? `<div class="oci-console-output">
            <div class="oci-console-output-heading">
              <span>${icon("terminal")} 最近采集的控制台文本${historyData.length ? ` · ${formatNumber(historyData.length)} 字符` : ""}</span>
              <button type="button" class="text-button" data-action="oci-console-history-close">关闭</button>
            </div>
            <pre class="mono">${escapeHtml(historyData.text || "未读取到控制台文本。")}</pre>
          </div>`
        : ""
    }
    <div class="network-swap-row">
      <span>${icon("shield")} ${escapeHtml(bundle?.publicKeyHint || "浏览器内不建立交互式串口终端。请复制 OCI 返回的 SSH 命令，在本机使用私钥连接，并核对服务主机指纹。")}</span>
    </div>
  `;
}

function renderOracleDrawerBody(state, detail, instance) {
  const ips = detail.data?.ips || {};
  const publicIps = Array.isArray(ips.publicIpv4s)
    ? ips.publicIpv4s
    : [ips.publicIpv4].filter(Boolean);
  const privateIps = Array.isArray(ips.privateIpv4s)
    ? ips.privateIpv4s
    : [ips.privateIpv4].filter(Boolean);
  const ipv6Addresses = Array.isArray(ips.ipv6s)
    ? ips.ipv6s
    : [ips.ipv6].filter(Boolean);
  const primaryAddress = publicIps[0] || privateIps[0] || "";
  const isRunning = instance.status === "running";
  const isOffline = instance.status === "offline";
  const meta = getStatusMeta(instance.status);
  const tags = Array.isArray(instance.tags) ? instance.tags : [];
  const region = getRegion(state, instance.region);
  const consoleUrl = `https://cloud.oracle.com/compute/instances/${encodeURIComponent(instance.id)}?region=${encodeURIComponent(instance.region)}`;

  return `
    <div class="drawer-status-row">
      ${statusBadge(instance.status)}
      ${providerBadge(instance)}
      <span class="drawer-instance-id mono" title="${escapeHtml(instance.id)}">OCI …${escapeHtml(instance.id.slice(-12))}</span>
    </div>

    <div class="drawer-actions">
      ${isOffline ? detailActionButton(state, instance, "boot", "启动", "power", "button-primary") : ""}
      ${isRunning ? detailActionButton(state, instance, "reboot", "重启", "reboot") : ""}
      ${isRunning ? detailActionButton(state, instance, "shutdown", "关闭", "power", "button-danger-ghost") : ""}
      <a class="button button-secondary button-sm" href="${consoleUrl}" target="_blank" rel="noreferrer">
        ${icon("external-link")} <span>OCI 控制台</span>
      </a>
    </div>

    ${meta.transitional ? `<div class="drawer-transition">${spinner()} 实例状态为 ${escapeHtml(instance.providerStatus || meta.label)}，部分操作暂时禁用。</div>` : ""}
    ${instance.status === "failed" ? `<div class="form-alert">${icon("alert")}<span>OCI 报告实例处于 FAILED 状态，请前往 OCI 控制台检查维护事件或实例日志。</span></div>` : ""}

    <section class="drawer-section">
      <div class="drawer-section-heading">
        <span class="panel-kicker">NETWORK</span>
        <h3>网络地址</h3>
      </div>
      ${detail.data?.ipsError ? `<div class="inline-error"><span class="inline-error-icon">${icon("alert")}</span><span><strong>网络信息不可用</strong><small>${escapeHtml(detail.data.ipsError)}</small></span></div>` : ""}
      <div class="address-list">
        ${
          publicIps.length > 0
            ? publicIps
                .map(
                  (address, index) => `
                    <div class="address-row">
                      <span class="address-type">公网 IPv4${index > 0 ? ` ${index + 1}` : ""}</span>
                      <span class="mono">${escapeHtml(address)}</span>
                      <button type="button" class="copy-button" data-copy="${escapeHtml(address)}" aria-label="复制公网 IPv4">${icon("copy")}</button>
                    </div>
                  `,
                )
                .join("")
            : `<div class="address-row"><span class="address-type">公网 IPv4</span><span class="text-muted">未分配</span></div>`
        }
        ${privateIps
          .map(
            (address, index) => `
              <div class="address-row">
                <span class="address-type">私网 IPv4${index > 0 ? ` ${index + 1}` : ""}</span>
                <span class="mono">${escapeHtml(address)}</span>
                <button type="button" class="copy-button" data-copy="${escapeHtml(address)}" aria-label="复制私网 IPv4">${icon("copy")}</button>
              </div>
            `,
          )
          .join("")}
        ${ipv6Addresses
          .map(
            (address, index) => `
              <div class="address-row">
                <span class="address-type">IPv6${index > 0 ? ` ${index + 1}` : ""}</span>
                <span class="mono address-wrap">${escapeHtml(address)}</span>
                <button type="button" class="copy-button" data-copy="${escapeHtml(address)}" aria-label="复制 IPv6">${icon("copy")}</button>
              </div>
            `,
          )
          .join("")}
        ${
          primaryAddress
            ? `<div class="address-row">
                <span class="address-type">SSH</span>
                <span class="mono">ssh opc@${escapeHtml(primaryAddress)}</span>
                <button type="button" class="copy-button" data-copy="ssh opc@${escapeHtml(primaryAddress)}" aria-label="复制 SSH 命令">${icon("copy")}</button>
              </div>`
            : ""
        }
      </div>
      <div class="network-swap-row">
        <span>${icon("info")} Oracle 的公网 IPv4 与 VNIC 绑定；当前控制台只读网络信息，不执行 IP 交换、换新或安全列表修改。</span>
      </div>
    </section>

    <section class="drawer-section">
      <div class="drawer-section-heading">
        <span class="panel-kicker">CONFIGURATION</span>
        <h3>实例配置</h3>
      </div>
      <dl class="detail-meta-grid">
        <div><dt>所属账户</dt><dd>${escapeHtml(instance.accountLabel || "Oracle Cloud")}</dd></div>
        <div><dt>区域</dt><dd>${countryFlag(region?.country)} ${escapeHtml(region?.label || instance.region)} <span class="mono">${escapeHtml(instance.region)}</span></dd></div>
        <div><dt>可用域</dt><dd>${escapeHtml(instance.availabilityDomain || "—")}</dd></div>
        <div><dt>Shape</dt><dd>${escapeHtml(instance.type || "—")}</dd></div>
        <div><dt>计算规格</dt><dd>${formatNumber(instance.specs?.ocpus)} OCPU · ${formatMemory(instance.specs?.memory)}</dd></div>
        <div><dt>创建时间</dt><dd>${formatDate(instance.created)}</dd></div>
        <div class="detail-span-two"><dt>Compartment</dt><dd class="mono address-wrap" title="${escapeHtml(instance.compartmentId)}">${escapeHtml(instance.compartmentId)}</dd></div>
        <div class="detail-span-two"><dt>实例 OCID</dt><dd class="mono address-wrap" title="${escapeHtml(instance.id)}">${escapeHtml(instance.id)}</dd></div>
      </dl>
      <div class="detail-spec-row">
        <span>${icon("cpu")}<strong>${formatNumber(instance.specs?.ocpus)}</strong><small>OCPU</small></span>
        <span>${icon("memory")}<strong>${formatMemory(instance.specs?.memory)}</strong><small>内存</small></span>
        <span>${icon("server")}<strong>${escapeHtml(instance.type || "—")}</strong><small>Shape</small></span>
      </div>
      ${tags.length > 0 ? `<div class="detail-tags">${tags.map((tag) => `<span class="tag">#${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
    </section>

    <section class="drawer-section">
      <div class="drawer-section-heading">
        <span class="panel-kicker">OBSERVABILITY</span>
        <h3>OCI 监控</h3>
      </div>
      ${renderOracleMonitoring(state, detail, instance)}
    </section>

    <section class="drawer-section">
      <div class="drawer-section-heading">
        <span class="panel-kicker">BOOT VOLUME BACKUPS</span>
        <h3>启动卷备份</h3>
      </div>
      ${renderOracleBackups(state, detail, instance)}
    </section>

    <section class="drawer-section">
      <div class="drawer-section-heading">
        <span class="panel-kicker">SERIAL CONSOLE</span>
        <h3>串口控制台</h3>
      </div>
      ${renderOracleConsole(state, detail, instance)}
    </section>

    <section class="drawer-section danger-zone oci-danger-zone">
      <div>
        <strong>终止此 OCI 实例</strong>
        <p>OCI 将异步终止实例。默认删除启动卷；可选择保留启动卷与随实例创建的数据卷，但保留的卷仍会产生存储费用。</p>
      </div>
      <button
        type="button"
        class="button button-danger-ghost button-sm"
        data-action="oci-terminate"
        data-id="${escapeHtml(instance.id)}"
        data-token-id="${escapeHtml(instance.accountId || instance.tokenId || "")}"
        ${isTransitional(instance.status) || instance.status === "deleting" ? "disabled" : ""}
      >
        ${icon("trash")} 终止实例
      </button>
    </section>
  `;
}

export function renderDrawer(state) {
  const detail = state.detail;
  if (!detail.open) {
    return "";
  }

  const instance = detail.data?.instance;
  const isOracle = detail.provider === "oracle" || instance?.provider === "oracle";
  const title = instance?.label || `${isOracle ? "OCI 实例" : "实例"} ${String(detail.id).slice(-12)}`;
  const status = instance?.status;
  const meta = getStatusMeta(status);

  let body;
  if (detail.loading) {
    body = `
      <div class="drawer-skeleton">
        <div class="skeleton skeleton-line skeleton-line-wide"></div>
        <div class="skeleton skeleton-card"></div>
        <div class="skeleton skeleton-card"></div>
        <div class="skeleton skeleton-card"></div>
      </div>
    `;
  } else if (detail.error) {
    body = `
      ${renderInlineError(detail.error)}
      <button type="button" class="button button-secondary button-block" data-action="retry-detail" data-id="${escapeHtml(detail.id)}" data-token-id="${escapeHtml(detail.tokenId || "")}" data-provider="${escapeHtml(detail.provider || "linode")}">
        ${icon("refresh")} 重新加载
      </button>
    `;
  } else if (instance?.provider === "oracle") {
    body = renderOracleDrawerBody(state, detail, instance);
  } else if (instance) {
    const region = getRegion(state, instance.region);
    const plan = getPlan(state, instance.type);
    const price = getPlanPrice(plan, instance.region);
    const isRunning = instance.status === "running";
    const isOffline = instance.status === "offline";
    const tags = Array.isArray(instance.tags) ? instance.tags : [];
    const ipv4 = instance.ipv4 || [];
    const primaryAddress = detail.data?.ips?.publicIpv4 || ipv4[0];
    const slaacAddress = detail.data?.ips?.ipv6Slaac || instance.ipv6 || "";
    const routedIpv6Ranges = Array.isArray(detail.data?.ips?.ipv6Ranges)
      ? detail.data.ips.ipv6Ranges
      : [];

    body = `
      <div class="drawer-status-row">
        ${statusBadge(instance.status)}
        <span class="drawer-instance-id mono">LINODE ${escapeHtml(instance.id)}</span>
      </div>

      <div class="drawer-actions">
        ${
          isOffline
            ? detailActionButton(state, instance, "boot", "启动", "power", "button-primary")
            : ""
        }
        ${
          isRunning
            ? detailActionButton(state, instance, "reboot", "重启", "reboot")
            : ""
        }
        ${
          isRunning
            ? detailActionButton(state, instance, "shutdown", "关闭", "power", "button-danger-ghost")
            : ""
        }
        <a class="button button-secondary button-sm" href="https://cloud.linode.com/linodes/${encodeURIComponent(instance.id)}" target="_blank" rel="noreferrer">
          ${icon("external-link")} <span>Cloud Manager</span>
        </a>
      </div>

      ${meta.transitional ? `<div class="drawer-transition">${spinner()} 实例正在${escapeHtml(meta.label.replace("中", ""))}，部分操作已暂时禁用。</div>` : ""}

      <section class="drawer-section">
        <div class="drawer-section-heading">
          <span class="panel-kicker">NETWORK</span>
          <h3>网络地址</h3>
        </div>
        <div class="address-list">
          <div class="address-row">
            <span class="address-type">IPv4</span>
            <span class="mono">${escapeHtml(primaryAddress || "未分配")}</span>
            ${primaryAddress ? `<button type="button" class="copy-button" data-copy="${escapeHtml(primaryAddress)}" aria-label="复制 IPv4">${icon("copy")}</button>` : ""}
          </div>
          <div class="address-row">
            <span class="address-type">IPv6</span>
            <span class="mono address-wrap">${escapeHtml(slaacAddress || "未分配")}</span>
            ${slaacAddress ? `<button type="button" class="copy-button" data-copy="${escapeHtml(slaacAddress)}" aria-label="复制 IPv6">${icon("copy")}</button>` : ""}
          </div>
          ${routedIpv6Ranges
            .map(
              (entry) => `
                <div class="address-row">
                  <span class="address-type">IPv6 段</span>
                  <span class="mono address-wrap">${escapeHtml(entry.range)}</span>
                  <button type="button" class="copy-button" data-copy="${escapeHtml(entry.range)}" aria-label="复制 IPv6 路由段">${icon("copy")}</button>
                </div>
              `,
            )
            .join("")}
          ${
            primaryAddress
              ? `<div class="address-row">
                  <span class="address-type">SSH</span>
                  <span class="mono">ssh root@${escapeHtml(primaryAddress)}</span>
                  <button type="button" class="copy-button" data-copy="ssh root@${escapeHtml(primaryAddress)}" aria-label="复制 SSH 命令">${icon("copy")}</button>
                </div>`
              : ""
          }
        </div>
        <div class="network-swap-row">
          <span>${icon("info")} 默认 IPv6 为 SLAAC 地址，不可变；交换/换新的是 /56 或 /64 路由段。路由段前缀不能直接 ping，需在实例内配置段内地址；Network Helper 开启时重启可能覆盖手工配置。</span>
          <div class="network-swap-actions">
            <button
              type="button"
              class="button button-secondary button-sm"
              data-action="open-ip-swap"
              data-id="${escapeHtml(instance.id)}"
              data-token-id="${escapeHtml(instance.tokenId || "")}"
              ${isTransitional(instance.status) ? "disabled" : ""}
            >
              ${icon("refresh")} <span>交换 IP</span>
            </button>
            <button
              type="button"
              class="button button-danger-ghost button-sm"
              data-action="open-ip-renew"
              data-id="${escapeHtml(instance.id)}"
              data-token-id="${escapeHtml(instance.tokenId || "")}"
              ${isTransitional(instance.status) ? "disabled" : ""}
            >
              ${icon("zap")} <span>换新 IP</span>
            </button>
          </div>
        </div>
      </section>

      <section class="drawer-section">
        <div class="drawer-section-heading">
          <span class="panel-kicker">CONFIGURATION</span>
          <h3>实例配置</h3>
        </div>
        <dl class="detail-meta-grid">
          <div><dt>所属账户</dt><dd>${escapeHtml(instance.accountLabel || instance.tokenLabel || "—")}</dd></div>
          <div><dt>区域</dt><dd>${countryFlag(region?.country)} ${escapeHtml(region?.label || instance.region)}</dd></div>
          <div><dt>计算计划</dt><dd>${escapeHtml(typeDisplay(instance.type, plan))}</dd></div>
          <div><dt>系统镜像</dt><dd>${escapeHtml(imageDisplay(instance.image, state.catalog?.images || []))}</dd></div>
          <div><dt>月费</dt><dd>${price.monthly ? formatMoney(price.monthly) : "—"}</dd></div>
          <div><dt>创建时间</dt><dd>${formatDate(instance.created)}</dd></div>
          <div><dt>最后更新</dt><dd>${relativeTime(instance.updated)}</dd></div>
        </dl>
        <div class="detail-spec-row">
          <span>${icon("cpu")}<strong>${formatNumber(instance.specs?.vcpus ?? plan?.vcpus)}</strong><small>vCPU</small></span>
          <span>${icon("memory")}<strong>${formatMemory(instance.specs?.memory ?? plan?.memory)}</strong><small>内存</small></span>
          <span>${icon("disk")}<strong>${formatDisk(instance.specs?.disk ?? plan?.disk)}</strong><small>存储</small></span>
          <span>${icon("network")}<strong>${formatTransfer(instance.specs?.transfer ?? plan?.transfer)}</strong><small>流量</small></span>
        </div>
        ${
          tags.length > 0
            ? `<div class="detail-tags">${tags.map((tag) => `<span class="tag">#${escapeHtml(tag)}</span>`).join("")}</div>`
            : ""
        }
      </section>

      <section class="drawer-section">
        <div class="drawer-section-heading">
          <span class="panel-kicker">OBSERVABILITY</span>
          <h3>监控</h3>
        </div>
        ${renderDetailCharts(detail.data.stats)}
      </section>

      <section class="drawer-section">
        <div class="drawer-section-heading">
          <span class="panel-kicker">BACKUPS</span>
          <h3>备份</h3>
        </div>
        ${renderBackups(detail.data.backups)}
      </section>

      <section class="drawer-section">
        <div class="drawer-section-heading">
          <span class="panel-kicker">ACTIVITY</span>
          <h3>近期事件</h3>
        </div>
        ${renderDetailEvents(detail.data.events)}
      </section>

      <section class="drawer-section danger-zone">
        <div>
          <strong>删除此实例</strong>
          <p>磁盘、配置和公网地址将永久删除。此操作无法撤销。</p>
        </div>
        <button type="button" class="button button-danger-ghost button-sm" data-action="open-delete" data-id="${escapeHtml(instance.id)}" data-token-id="${escapeHtml(instance.tokenId || "")}">
          ${icon("trash")} 删除实例
        </button>
      </section>
    `;
  }

  return `
    <div class="drawer-layer">
      <div class="drawer-backdrop" data-action="close-drawer"></div>
      <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
        <header class="drawer-header">
          <div class="drawer-title-wrap">
            <span class="drawer-title-icon">${icon(isOracle ? "cloud" : "server")}</span>
            <div>
              <span class="panel-kicker">${isOracle ? "ORACLE CLOUD INSTANCE" : "INSTANCE DETAIL"}</span>
              <h2 id="drawer-title">${escapeHtml(title)}</h2>
            </div>
          </div>
          <button type="button" class="icon-button drawer-close" data-action="close-drawer" aria-label="关闭详情">
            ${icon("x")}
          </button>
        </header>
        <div class="drawer-body">${body}</div>
      </aside>
    </div>
  `;
}

export function renderInlineError(error) {
  const message =
    typeof error === "string"
      ? error
      : error?.message || "请求失败，请稍后重试。";
  return `
    <div class="inline-error" role="alert">
      <span class="inline-error-icon">${icon("alert")}</span>
      <span><strong>连接出现问题</strong><small>${escapeHtml(message)}</small></span>
      <button type="button" class="text-button" data-action="refresh-overview">重试</button>
    </div>
  `;
}

export function renderOverviewSkeleton() {
  return `
    <section class="page page-overview skeleton-page">
      <div class="skeleton skeleton-hero"></div>
      <div class="stat-grid">
        ${Array.from({ length: 4 }, () => `<div class="skeleton skeleton-stat"></div>`).join("")}
      </div>
      <div class="overview-grid">
        <div class="skeleton skeleton-panel skeleton-panel-tall"></div>
        <div class="skeleton skeleton-panel"></div>
        <div class="skeleton skeleton-panel"></div>
        <div class="skeleton skeleton-panel"></div>
      </div>
    </section>
  `;
}

export function renderInstancesSkeleton() {
  return `
    <section class="page skeleton-page">
      <div class="skeleton skeleton-title"></div>
      <div class="skeleton skeleton-toolbar"></div>
      <div class="instance-grid">
        ${Array.from({ length: 6 }, () => `<div class="skeleton skeleton-instance"></div>`).join("")}
      </div>
    </section>
  `;
}

export function renderCreateSkeleton(state) {
  if (state.catalogError) {
    return `
      <section class="page page-create">
        ${pageHeader({
          eyebrow: "DEPLOY",
          title: "部署新实例",
          description: "选择区域、计算规格和系统镜像，几分钟内获得一台新的 Linode。",
        })}
        <div class="empty-state">
          <span class="empty-state-icon">${icon("alert")}</span>
          <h3>无法加载部署目录</h3>
          <p>${escapeHtml(state.catalogError)}</p>
          <button type="button" class="button button-secondary button-sm" data-action="retry-catalog">${icon("refresh")}重新加载</button>
        </div>
      </section>
    `;
  }

  return `
    <section class="page page-create skeleton-page">
      <div class="skeleton skeleton-title"></div>
      <div class="create-layout">
        <div>
          <div class="skeleton skeleton-card skeleton-card-tall"></div>
          <div class="skeleton skeleton-card skeleton-card-tall"></div>
        </div>
        <div class="skeleton skeleton-summary"></div>
      </div>
    </section>
  `;
}

