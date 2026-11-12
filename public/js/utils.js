import { icon } from "./icons.js";

const HTML_ESCAPE_MAP = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    return HTML_ESCAPE_MAP[character];
  });
}

function parseIpv6Address(value) {
  const address = String(value || "")
    .trim()
    .toLowerCase();
  if (!address || address.includes(".")) {
    return null;
  }

  const halves = address.split("::");
  if (halves.length > 2) {
    return null;
  }
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groupCount = left.length + right.length;
  if (
    (halves.length === 1 && groupCount !== 8) ||
    (halves.length === 2 && groupCount > 7)
  ) {
    return null;
  }

  const groups = [
    ...left,
    ...Array(halves.length === 2 ? 8 - groupCount : 0).fill("0"),
    ...right,
  ];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))
  ) {
    return null;
  }
  return groups.map((group) => Number.parseInt(group, 16));
}

function formatIpv6Address(groups) {
  const values = groups.map((group) => group.toString(16));
  let bestStart = -1;
  let bestLength = 1;

  for (let index = 0; index < values.length; ) {
    if (values[index] !== "0") {
      index += 1;
      continue;
    }
    let end = index;
    while (end < values.length && values[end] === "0") {
      end += 1;
    }
    const length = end - index;
    if (length > bestLength) {
      bestStart = index;
      bestLength = length;
    }
    index = end;
  }

  if (bestStart < 0) {
    return values.join(":");
  }
  const left = values.slice(0, bestStart).join(":");
  const right = values.slice(bestStart + bestLength).join(":");
  return `${left}::${right}`;
}

export function ipv6RangeHost(range, hostHextet = "10") {
  const raw = String(range || "").trim();
  const [addressPart, prefixPart] = raw.split("/");
  const prefix = Number(prefixPart ?? 64);
  const groups = parseIpv6Address(addressPart);
  const host = Number.parseInt(String(hostHextet || "10"), 16);

  if (
    !groups ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > 128 ||
    !Number.isInteger(host) ||
    host < 0 ||
    host > 0xffff
  ) {
    return null;
  }

  groups[7] = host;
  const hostAddress = formatIpv6Address(groups);
  return {
    range: raw,
    prefix,
    hostAddress,
    cidr: `${hostAddress}/${prefix}`,
  };
}

export function buildIpv6BindScripts({
  range,
  instanceId = "",
  allowIcmp = true,
} = {}) {
  const details = ipv6RangeHost(range);
  if (!details) {
    return null;
  }

  const safeId =
    String(instanceId || "instance")
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, "-") || "instance";
  const unitName = `cloudvm-ipv6-${safeId}`;
  const detectInterface = `IFACE="$(ip -4 route show default 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="dev") {print $(i+1); exit}}')"
if [ -z "$IFACE" ]; then
  IFACE="$(ip -6 route show default 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="dev") {print $(i+1); exit}}')"
fi
if [ -z "$IFACE" ]; then
  IFACE="eth0"
fi`;
  const sudoSetup = `SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
fi`;
  const firewall = allowIcmp
    ? `if command -v ip6tables >/dev/null 2>&1; then
  $SUDO ip6tables -C INPUT -p ipv6-icmp -j ACCEPT 2>/dev/null || $SUDO ip6tables -I INPUT -p ipv6-icmp -j ACCEPT
fi`
    : "";
  const systemdFirewall = allowIcmp
    ? `ExecStart=/bin/sh -c 'if command -v ip6tables >/dev/null 2>&1; then ip6tables -C INPUT -p ipv6-icmp -j ACCEPT 2>/dev/null || ip6tables -I INPUT -p ipv6-icmp -j ACCEPT || true; fi'\n`
    : "";

  const temporary = `#!/usr/bin/env bash
set -euo pipefail

CIDR="${details.cidr}"

${detectInterface}
${sudoSetup}

$SUDO ip -6 addr replace "$CIDR" dev "$IFACE"
${firewall ? `${firewall}\n` : ""}echo "已临时绑定 $CIDR 到 $IFACE；重启后失效。"
ip -6 addr show dev "$IFACE" | grep -F "$CIDR" || true
`;

  const permanent = `#!/usr/bin/env bash
set -euo pipefail

CIDR="${details.cidr}"
UNIT_NAME="${unitName}"
UNIT_PATH="/etc/systemd/system/$UNIT_NAME.service"

${detectInterface}
${sudoSetup}
IP_BIN="$(command -v ip || true)"
if [ -z "$IP_BIN" ]; then
  IP_BIN="/sbin/ip"
fi

$SUDO tee "$UNIT_PATH" >/dev/null <<EOF
[Unit]
Description=Bind routed IPv6 $CIDR to $IFACE
After=network-online.target cloud-init.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$IP_BIN -6 addr replace $CIDR dev $IFACE
${systemdFirewall}RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

$SUDO systemctl daemon-reload
$SUDO systemctl enable --now "$UNIT_NAME.service"
echo "已永久绑定 $CIDR 到 $IFACE。"
echo "开机服务：$UNIT_NAME.service"
`;

  const remove = `#!/usr/bin/env bash
set -euo pipefail

CIDR="${details.cidr}"
UNIT_NAME="${unitName}"

${detectInterface}
${sudoSetup}

$SUDO systemctl disable --now "$UNIT_NAME.service" 2>/dev/null || true
$SUDO rm -f "/etc/systemd/system/$UNIT_NAME.service"
$SUDO systemctl daemon-reload
$SUDO ip -6 addr del "$CIDR" dev "$IFACE" 2>/dev/null || true
echo "已撤销 $CIDR 的永久绑定。"
`;

  return {
    ...details,
    unitName,
    temporary,
    permanent,
    remove,
  };
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function formatMoney(value, { currency = "USD", minimumFractionDigits = 2 } = {}) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "—";
  }
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    minimumFractionDigits,
    maximumFractionDigits: minimumFractionDigits,
  }).format(numericValue);
}

export function formatDate(value, options = {}) {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...options,
  }).format(date);
}

export function formatDateTime(value) {
  return formatDate(value, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function relativeTime(value) {
  if (!value) {
    return "刚刚";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });

  if (Math.abs(seconds) < 45) {
    return "刚刚";
  }
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) {
    return formatter.format(minutes, "minute");
  }
  const hours = Math.round(seconds / 3600);
  if (Math.abs(hours) < 24) {
    return formatter.format(hours, "hour");
  }
  const days = Math.round(seconds / 86400);
  if (Math.abs(days) < 30) {
    return formatter.format(days, "day");
  }
  return formatDate(value);
}

export function formatMemory(megabytes) {
  const value = Number(megabytes);
  if (!Number.isFinite(value)) {
    return "—";
  }
  if (value >= 1024) {
    const gigabytes = value / 1024;
    return `${Number.isInteger(gigabytes) ? gigabytes : gigabytes.toFixed(1)} GB`;
  }
  return `${Math.round(value)} MB`;
}

export function formatDisk(megabytes) {
  const value = Number(megabytes);
  if (!Number.isFinite(value)) {
    return "—";
  }
  if (value >= 1_048_576) {
    return `${(value / 1_048_576).toFixed(1)} TB`;
  }
  if (value >= 1024) {
    const gigabytes = value / 1024;
    return `${Number.isInteger(gigabytes) ? gigabytes : gigabytes.toFixed(1)} GB`;
  }
  return `${Math.round(value)} MB`;
}

export function formatTransfer(gigabytes) {
  const value = Number(gigabytes);
  if (!Number.isFinite(value)) {
    return "—";
  }
  if (value >= 1000) {
    const terabytes = value / 1000;
    return `${Number.isInteger(terabytes) ? terabytes : terabytes.toFixed(1)} TB`;
  }
  return `${Math.round(value)} GB`;
}

export function formatNumber(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "—";
  }
  return new Intl.NumberFormat("zh-CN").format(numericValue);
}

export function formatBitrate(bitsPerSecond) {
  const value = Number(bitsPerSecond);
  if (!Number.isFinite(value)) {
    return "—";
  }
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(2)} Gbps`;
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)} Mbps`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)} Kbps`;
  }
  return `${Math.round(value)} bps`;
}

export function formatPercent(value, digits = 0) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "—";
  }
  return `${numericValue.toFixed(digits)}%`;
}

export const STATUS_META = {
  running: { label: "运行中", tone: "running", transitional: false },
  offline: { label: "已关机", tone: "offline", transitional: false },
  booting: { label: "启动中", tone: "transitional", transitional: true },
  shutting_down: { label: "关闭中", tone: "transitional", transitional: true },
  rebooting: { label: "重启中", tone: "transitional", transitional: true },
  provisioning: { label: "部署中", tone: "transitional", transitional: true },
  deleting: { label: "删除中", tone: "danger", transitional: true },
  migrating: { label: "迁移中", tone: "transitional", transitional: true },
  rebuilding: { label: "重建中", tone: "transitional", transitional: true },
  cloning: { label: "克隆中", tone: "transitional", transitional: true },
  restoring: { label: "恢复中", tone: "transitional", transitional: true },
  transitional: { label: "变更中", tone: "transitional", transitional: true },
  failed: { label: "异常", tone: "danger", transitional: false },
};

export function getStatusMeta(status) {
  return (
    STATUS_META[status] || {
      label: status ? String(status).replaceAll("_", " ") : "未知",
      tone: "neutral",
      transitional: false,
    }
  );
}

export function isTransitional(status) {
  return Boolean(getStatusMeta(status).transitional);
}

export function countryFlag(countryCode) {
  const code = String(countryCode || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  if (code.length !== 2) {
    return "🌐";
  }
  return String.fromCodePoint(
    ...[...code].map((character) => 0x1f1e6 + character.charCodeAt(0) - 65),
  );
}

export function regionDisplay(region) {
  if (!region) {
    return "未知区域";
  }
  return `${countryFlag(region.country)} ${region.label || region.id}`;
}

export function planClassLabel(planClass) {
  const labels = {
    standard: "通用",
    dedicated: "独享 CPU",
    highmem: "高内存",
    gpu: "GPU",
    premium: "高性能",
    accelerated: "加速计算",
  };
  return labels[planClass] || planClass || "其他";
}

export function getPlanPrice(plan, regionId) {
  const override = plan?.region_prices?.find(
    (entry) => entry.id === regionId || entry.region === regionId,
  );
  return {
    hourly: Number(override?.hourly ?? plan?.price?.hourly ?? 0),
    monthly: Number(override?.monthly ?? plan?.price?.monthly ?? 0),
  };
}

export function getBackupPrice(plan, regionId) {
  const backups = plan?.addons?.backups;
  if (!backups) {
    return 0;
  }
  const override = backups.region_prices?.find(
    (entry) => entry.id === regionId || entry.region === regionId,
  );
  return Number(override?.monthly ?? backups.price?.monthly ?? 0);
}

const EVENT_ACTION_LABELS = {
  linode_boot: "启动实例",
  linode_shutdown: "关闭实例",
  linode_reboot: "重启实例",
  linode_create: "创建实例",
  linode_delete: "删除实例",
  linode_clone: "克隆实例",
  linode_migrate: "迁移实例",
  linode_resize: "调整实例",
  linode_update: "更新实例",
  linode_config_update: "更新配置",
  disk_create: "创建磁盘",
  disk_delete: "删除磁盘",
  disk_resize: "调整磁盘",
  backup_restore: "恢复备份",
  backups_enable: "启用备份",
  backups_disable: "停用备份",
  linode_rebuild: "重建实例",
  linode_add_ip: "添加 IP",
  linode_remove_ip: "移除 IP",
  linode_snapshot: "创建快照",
};

export function eventActionLabel(action) {
  return (
    EVENT_ACTION_LABELS[action] ||
    String(action || "未知操作").replaceAll("_", " ")
  );
}

export const EVENT_STATUS_META = {
  finished: { label: "已完成", tone: "success" },
  started: { label: "进行中", tone: "active" },
  failed: { label: "失败", tone: "danger" },
  notification: { label: "通知", tone: "neutral" },
  scheduled: { label: "已计划", tone: "neutral" },
};

export function getEventStatusMeta(status) {
  return EVENT_STATUS_META[status] || { label: status || "未知", tone: "neutral" };
}

export function typeDisplay(type, plan) {
  if (plan?.label) {
    return plan.label;
  }
  if (type) {
    return String(type).replaceAll("-", " ");
  }
  return "未知规格";
}

export function imageDisplay(imageId, images = []) {
  const image = images.find((entry) => entry.id === imageId);
  if (image?.label) {
    return image.label;
  }
  if (!imageId) {
    return "—";
  }
  return String(imageId).replace(/^linode\//, "").replaceAll("-", " ");
}

export async function copyToClipboard(text) {
  const value = String(text ?? "");
  if (!value) {
    return false;
  }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fall through to the textarea fallback.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const succeeded = document.execCommand("copy");
  textarea.remove();
  return succeeded;
}

export function generatePassword(length = 20) {
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";
  const required = [
    "ABCDEFGHJKLMNPQRSTUVWXYZ",
    "abcdefghijkmnopqrstuvwxyz",
    "23456789",
    "!@#$%^&*",
  ];
  const randomIndex = (max) => {
    const limit = Math.floor(65_536 / max) * max;
    const buffer = new Uint32Array(1);
    do {
      crypto.getRandomValues(buffer);
    } while (buffer[0] >= limit);
    return buffer[0] % max;
  };

  const characters = required.map(
    (group) => group[randomIndex(group.length)],
  );

  while (characters.length < length) {
    characters.push(alphabet[randomIndex(alphabet.length)]);
  }

  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1);
    [characters[index], characters[swapIndex]] = [
      characters[swapIndex],
      characters[index],
    ];
  }

  return characters.join("");
}

export function passwordStrength(password) {
  const value = String(password || "");
  let score = 0;
  if (value.length >= 8) score += 1;
  if (value.length >= 14) score += 1;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1;
  if (/\d/.test(value)) score += 1;
  if (/[^A-Za-z0-9]/.test(value)) score += 1;
  return Math.min(score, 4);
}

export function randomInstanceLabel() {
  const words = ["nova", "atlas", "orbit", "ember", "north", "pixel", "sable", "drift"];
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  const suffix = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `vm-${words[bytes[0] % words.length]}-${suffix.slice(0, 4)}`;
}

export function debounce(callback, delay = 120) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => callback(...args), delay);
  };
}

export function spinner(className = "icon is-spinning") {
  return icon("loader", className);
}

export function emptyState({
  iconName = "cloud",
  title = "暂无数据",
  description = "",
  action = "",
} = {}) {
  return `
    <div class="empty-state">
      <span class="empty-state-icon">${icon(iconName)}</span>
      <h3>${escapeHtml(title)}</h3>
      ${description ? `<p>${escapeHtml(description)}</p>` : ""}
      ${action}
    </div>
  `;
}
