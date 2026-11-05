import { extractPoints, latestValue, renderLineChart } from "./charts.js";
import { icon } from "./icons.js";
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
    return "Linode 账户";
  }
  const fullName = [account.first_name, account.last_name].filter(Boolean).join(" ");
  return fullName || account.company || account.email || "Linode 账户";
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 6) return "夜深了";
  if (hour < 12) return "早上好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

function getRegion(state, regionId) {
  return state.catalog?.regions?.find((region) => region.id === regionId) || null;
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

function compactInstanceRow(state, instance) {
  const region = getRegion(state, instance.region);
  const plan = getPlan(state, instance.type);
  const ip = primaryIp(instance);

  return `
    <button
      type="button"
      class="compact-instance"
      data-action="open-detail"
      data-id="${escapeHtml(instance.id)}"
      data-token-id="${escapeHtml(instance.tokenId || "")}"
      aria-label="查看 ${escapeHtml(instance.label || instance.id)} 详情"
    >
      <span class="compact-instance-primary">
        <span class="server-tile">${icon("server")}</span>
        <span class="compact-instance-copy">
          <strong>${escapeHtml(instance.label || `linode-${instance.id}`)}</strong>
          <small>${escapeHtml(region?.label || instance.region || "未知区域")} · ${escapeHtml(typeDisplay(instance.type, plan))}</small>
          <small class="compact-instance-account">${escapeHtml(accountNameForInstance(instance))}</small>
        </span>
      </span>
      <span class="compact-instance-status">${statusBadge(instance.status, { compact: true })}</span>
      <span class="compact-instance-ip mono">${escapeHtml(ip || "无公网 IP")}</span>
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
          <h2>${accounts.length} 个账户同时工作</h2>
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
                  <small>${account.instanceCount} 个实例${account.balance !== null ? ` · ${formatMoney(account.balance)}` : ""}${account.error ? ` · ${escapeHtml(account.error)}` : ""}</small>
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
    ? `${accounts.length} 个 Linode 账户`
    : accountName(account);

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
          <a class="button button-primary" href="#create">${icon("plus")}<span>新建实例</span></a>
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
                : "需要 Account 只读权限"
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
                      action: `<a class="button button-primary button-sm" href="#create">${icon("plus")}创建实例</a>`,
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
          <button type="button" class="instance-name" data-action="open-detail" data-id="${escapeHtml(instance.id)}" data-token-id="${escapeHtml(instance.tokenId || "")}">
            ${escapeHtml(instance.label || `linode-${instance.id}`)}
          </button>
          <span class="instance-row-meta">
            <span class="mono">#${escapeHtml(instance.id)}</span>
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
          <span class="mono">${escapeHtml(ip || "未分配")}</span>
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
          ${formatNumber(instance.specs?.vcpus ?? plan?.vcpus)} vCPU
          <span class="meta-sep">·</span>
          ${formatMemory(instance.specs?.memory ?? plan?.memory)}
          <span class="meta-sep">·</span>
          ${formatDisk(instance.specs?.disk ?? plan?.disk)}
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
        <span class="instance-price">${price.monthly ? formatMoney(price.monthly) : "—"}</span>
        <small class="mono">/mo</small>
      </div>
      <div class="instance-cell instance-row-actions">
        ${actions ? `<span class="quick-actions">${actions}</span>` : ""}
        <button
          type="button"
          class="row-open"
          data-action="open-detail"
          data-id="${escapeHtml(instance.id)}"
          data-token-id="${escapeHtml(instance.tokenId || "")}"
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
        description: "启动、关闭、重启或检查分布在不同区域的 Linode 实例。",
        actions: `
          <button type="button" class="button button-secondary" data-action="refresh-overview">
            ${state.refreshing ? spinner() : icon("refresh")}
            <span>刷新</span>
          </button>
          <a class="button button-primary" href="#create">${icon("plus")}<span>新建实例</span></a>
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
                  ? `<a class="button button-primary button-sm" href="#create">${icon("plus")}创建实例</a>`
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
        description: "在浏览器中管理多个 Linode API 令牌、本地 SOCKS 代理和刷新偏好。",
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
                <strong>通过 SOCKS 代理访问 Linode API</strong>
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
            <span>代理只影响 Node 服务访问 Linode API 的请求。修改后点击“测试代理”确认能否连通，再保存。</span>
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
            <div><dt>控制台版本</dt><dd>v${escapeHtml(state.session?.version || "1.0.0")}</dd></div>
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
            <li><span>${icon("check")}</span>使用最小权限令牌；仅授予 Linodes 读写和 Account 只读。</li>
            <li><span>${icon("check")}</span>令牌和代理密码加密保存在本机，不写入浏览器 localStorage。</li>
            <li><span>${icon("check")}</span>若需通过公网访问，请在前面加 HTTPS 反向代理，并限制来源 IP。</li>
            <li><span>${icon("check")}</span>删除实例不可恢复；控制台会要求输入实例名称二次确认。</li>
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
        <h1>连接你的 Linode 账户</h1>
        <p>添加个人 API 令牌，在一个控制面中查看实例、部署新机器、掌握流量并执行日常运维。令牌加密保存在本机服务端。</p>
        <div class="connect-actions">
          <button type="button" class="button button-primary" data-action="open-token">
            ${icon("key")} 连接 Linode 账户
          </button>
          <a class="button button-secondary" href="https://cloud.linode.com/profile/tokens" target="_blank" rel="noreferrer">
            创建 API 令牌 ${icon("external-link")}
          </a>
        </div>
        ${state.sessionError ? `<div class="form-alert">${icon("alert")}<span>${escapeHtml(state.sessionError)}</span></div>` : ""}
        <div class="connect-features">
          <span><strong>01</strong> 实例开关机</span>
          <span><strong>02</strong> 实时监控</span>
          <span><strong>03</strong> 快速部署</span>
          <span><strong>04</strong> 本地凭据</span>
        </div>
        <p class="connect-foot">${icon("shield")} 浏览器不会接触或持久化令牌；所有凭据由本地 Node 服务管理。</p>
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
        height: 140,
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
          height: 140,
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

export function renderDrawer(state) {
  const detail = state.detail;
  if (!detail.open) {
    return "";
  }

  const instance = detail.data?.instance;
  const title = instance?.label || `实例 #${detail.id}`;
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
      <button type="button" class="button button-secondary button-block" data-action="retry-detail" data-id="${escapeHtml(detail.id)}" data-token-id="${escapeHtml(detail.tokenId || "")}">
        ${icon("refresh")} 重新加载
      </button>
    `;
  } else if (instance) {
    const region = getRegion(state, instance.region);
    const plan = getPlan(state, instance.type);
    const price = getPlanPrice(plan, instance.region);
    const isRunning = instance.status === "running";
    const isOffline = instance.status === "offline";
    const tags = Array.isArray(instance.tags) ? instance.tags : [];
    const ipv4 = instance.ipv4 || [];
    const primaryAddress = ipv4[0];

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
            <span class="mono address-wrap">${escapeHtml(instance.ipv6 || "未分配")}</span>
            ${instance.ipv6 ? `<button type="button" class="copy-button" data-copy="${escapeHtml(instance.ipv6)}" aria-label="复制 IPv6">${icon("copy")}</button>` : ""}
          </div>
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
            <span class="drawer-title-icon">${icon("server")}</span>
            <div>
              <span class="panel-kicker">INSTANCE DETAIL</span>
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

