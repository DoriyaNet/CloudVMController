# CloudVMController

一个本地运行的多云实例控制面板。通过 Akamai / Linode API v4 和 Oracle Cloud Infrastructure（OCI）API 管理虚拟机，界面专注于日常高频操作：查看状态、开关机、重启、部署 Linode 实例、监控和删除实例。Linode 与 Oracle 实例可以在同一概览和实例列表中聚合展示。界面采用锐利的 Vercel / Cloudflare 控制台风格，强调信息密度、清晰层级和高频操作效率。

需要 Node.js 20+。运行时只使用一个依赖 `socks-proxy-agent`，用于连接 SOCKS 代理。

## 功能

- 账户总览：实例数量、运行状态、月度流量、账户余额和最近活动
- 实例列表：按名称、IP、标签、状态和区域筛选
- 快捷运维：启动、关闭、重启和删除实例
- 公网 IP 管理：同区域实例之间互换公网 IPv4 或 `/56`、`/64` IPv6 路由段
- 单机换新 IP：为实例申请新的公网 IPv4，或替换为新的 `/56`、`/64` IPv6 路由段
- 创建实例：区域、规格、镜像、标签、备份、私有 IPv4、SSH 公钥和 Cloud-init
- 区域库存检查：选择区域后标记不可用规格
- 实例详情：IP、SSH 命令、配置、24 小时 CPU / 网络监控、备份状态和近期事件
- 多账户聚合：Linode 令牌与 Oracle 账户同时读取，实例合并展示，余额、流量和活动按提供商呈现
- 多令牌管理：在 Web 页面添加、测试、设置默认和删除多个 Linode API Token
- Oracle Cloud：使用 OCI API Key 签名连接一个或多个租户，聚合展示 Compute 实例
- OCI 运维：查看实例 Shape、OCPU、可用域、Compartment、VNIC 地址，并执行启动、关闭、重启
- 多云凭据：Linode Token 与 OCI RSA 私钥通常并存，写操作自动路由到实例所属账户
- 本地 SOCKS 代理：支持 SOCKS4 / 4A / 5 / 5H，可直接填写 Clash、v2ray 等本地代理
- 凭据加密：Linode 令牌、OCI 私钥与代理密码使用 AES-256-GCM 加密保存在本机 `data/`
- 自动刷新：页面可见时每 30 秒同步一次状态
- 响应式界面：桌面端三列实例卡片，移动端单列布局

## 快速开始

需要 Node.js 20 或更高版本。

```powershell
node --version
npm install
npm start
```

默认打开地址：<http://127.0.0.1:4173>

### 首次连接

1. 打开 <http://127.0.0.1:4173>。
2. 进入「连接与设置」。
3. Linode：点击「添加令牌」，粘贴 Personal Access Token 并保存。
4. Oracle：点击「添加 OCI 账户」，填写 Tenancy OCID、User OCID、区域、密钥指纹和 API 私钥。
5. 需要时在同一个页面填写本地 SOCKS 代理并「测试代理」。

令牌、OCI 密钥、默认令牌和代理设置都在 Web 页面管理，不需要手动编辑 `.env`。所有已添加的账户会同时工作，实例数据会合并展示；设置会立即生效，写入本机 `data/settings.json`，敏感字段加密保存，密钥在 `data/.key`。

如果你之前把令牌放在 `.env` 的 `LINODE_API_TOKEN` 中，页面会把它作为回退凭据，并显示「从 .env 导入」按钮。导入后即可删除该环境变量，以后完全通过页面管理。

## 创建 API 令牌

打开 <https://cloud.linode.com/profile/tokens>，创建 Personal Access Token。建议采用最小权限：

| 权限 | 级别 | 用途 |
| --- | --- | --- |
| Linodes | Read / Write | 查看、创建、开关机、删除实例 |
| IPs | Read / Write | 交换或换新公网 IPv4 和 IPv6 路由段 |
| Account | Read Only | 余额、流量和使用概览 |
| Events | Read Only | 最近活动和实例事件 |
| Images | Read Only | 加载系统镜像列表 |

如果令牌没有 Account 或 Events 权限，实例管理仍可使用，但部分概览信息会显示为不可用。

## 连接 Oracle Cloud

OCI 不使用普通 Bearer Token，而是对每个请求做 RSA-SHA256 签名。控制台会在本地服务端完成签名，私钥不会发送到浏览器。

### 1. 创建 API 密钥

1. 打开 OCI 控制台右上角的「我的概要信息」。
2. 在左侧选择「API 密钥」，点击「添加 API 密钥」。
3. 选择「生成 API 密钥对」，下载私钥并立即妥善保存；OCI 只允许下载一次。
4. 记录弹窗中的 **Fingerprint**、当前 **User OCID** 和 **Tenancy OCID**。
5. 确认控制台所在系统时钟准确；OCI 会拒绝时间偏差过大的签名请求。

### 2. 配置 IAM 权限

建议为控制台创建专用 IAM 用户组，至少授予目标 Compartment 的实例管理权限：

```text
Allow group CloudVMOperators to manage instances in compartment <compartment_name>
Allow group CloudVMOperators to inspect compartments in tenancy
Allow group CloudVMOperators to inspect virtual-network-family in compartment <compartment_name>
```

- `manage instances` 用于实例发现、启动、关闭和重启。
- `inspect compartments in tenancy` 用于自动发现可访问的子 Compartment。如果不希望扫描全租户，可在界面填写固定 Compartment OCID，并省略此权限。
- `inspect virtual-network-family` 用于详情页读取 VNIC 私网/公网 IP。没有该权限时实例控制仍可用，只是网络信息显示为不可用。
- OCI 根 Compartment 的 OCID 就是 Tenancy OCID；填写 Tenancy OCID 作为 Compartment 也是有效的。

生产环境请按实际 Compartment 缩小授权范围，不要直接复用管理员账户。

### 3. 在控制台添加账户

1. 打开「连接与设置」→「Oracle Cloud 账户」→「添加 OCI 账户」。
2. 填写名称、Tenancy OCID、User OCID、区域、API 密钥指纹和 PEM 私钥。
3. Compartment OCID 可留空。留空时控制台会扫描租户与所有可访问子 Compartment；填写后只读取指定范围。
4. 点击「验证并保存」。验证会实际调用 OCI Compute API 检查签名和读取权限。

目前一个配置对应一个 OCI 区域。如果同一租户在多个区域有实例，请按区域分别添加账户配置。控制台会按实例的 OCID 与账户 ID 分离路由，不会把不同租户的同名实例合并。

### 4. OCI 支持范围

当前支持：

- 列出同一区域内的 OCI Compute 实例，包括根 Compartment 和可访问子 Compartment。
- 展示生命周期状态、Shape、OCPU、内存、可用域、Compartment、创建时间和标签。
- 读取 VNIC 私网 IPv4、公网 IPv4 和 IPv6 地址。
- 启动（`START`）、关闭（`STOP`）和重启（`RESET`）实例。

暂不支持：创建 OCI 实例、监控图表、备份、串口控制台、终止实例、修改安全列表或 IP 地址。这些操作仍请在 OCI 控制台完成。关闭与重启会使用 OCI 的强制电源操作 `STOP` / `RESET`，不会先等待操作系统优雅关机。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LINODE_API_TOKEN` | 空 | 可选的回退令牌；Web 中启用的令牌优先 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `PORT` | `4173` | 本地端口 |
| `CLOUDVM_DATA_DIR` | `./data` | 加密设置与密钥的保存目录 |
| `LINODE_API_BASE` | `https://api.linode.com/v4` | API 地址，仅用于兼容代理或测试 |

旧版本的 `LINODE_PILOT_DATA_DIR` 仍可作为 `CLOUDVM_DATA_DIR` 的兼容回退。

示例：

```dotenv
HOST=127.0.0.1
PORT=4173
LINODE_API_TOKEN=
```

`.env` 只用于可选的回退令牌和服务启动参数。Linode API 令牌、OCI API 密钥、默认令牌和 SOCKS 代理都在「连接与设置」页面管理，保存后立即生效。修改 `.env` 后需要重启 Node 服务。

## 安全说明

这个项目是本地控制台，本身没有用户登录系统，**不要直接把 `HOST=0.0.0.0` 的服务暴露到公网**。

- 默认只监听 `127.0.0.1`，仅本机可访问。
- Linode 令牌和 OCI 私钥只保存在本地 Node 服务中，不会返回前端 JavaScript。
- Linode 令牌、OCI RSA 私钥和代理密码使用 AES-256-GCM 加密后保存在 `data/settings.json`，密钥独立存放在 `data/.key`。
- 浏览器不会保存令牌或 OCI 私钥；前端只能看到掩码信息。
- OCI 私钥仅用于本地生成 `Authorization: Signature ...` 请求头，不会写入日志。
- 服务端不记录 Authorization 头、令牌或私钥内容。
- 页面使用 CSP、`X-Frame-Options: DENY`、`nosniff` 等响应头。
- `.env` 和 `data/` 已加入 `.gitignore`，不要把这两个路径提交到仓库。
- 删除实例需要输入完整实例名称二次确认。
- 如需远程访问，请在前面部署带 HTTPS 和身份认证的反向代理，并限制来源 IP。

如果 `data/.key` 丢失，已保存的令牌、OCI 私钥和代理密码将无法解密。此时删除 `data/` 后重新在页面添加凭据即可；这不会影响 Linode Personal Access Token 或 OCI API 密钥本身。

## 常用操作

### 管理多个 API 令牌

打开「连接与设置」：

- 「添加令牌」会先验证令牌，再加密保存到本机。填写名称便于区分生产、测试或不同账户。
- 所有添加的令牌都会加入并发池，读取实例、账户余额、流量和活动；同一个实例不会重复显示。
- 「设为默认」只决定新建实例时默认选中的账户，不会停用其他令牌。
- 实例的开关机、重启、详情和删除会自动按所属账户路由，不需要手动切换令牌。
- 「部署实例」页面可以选择本次创建使用哪个账户。
- 「测试」重新验证某个令牌，不会改变默认令牌，也不会影响其他令牌。
- 「删除」只移除本机保存的令牌，不会撤销 Linode 上的 Personal Access Token。
- 如果存在 `LINODE_API_TOKEN`，可使用「从 .env 导入」把它迁移到 Web 管理，然后从 `.env` 中删除。

### 管理 Oracle Cloud 账户

- 每个 OCI 配置保存 Tenancy OCID、User OCID、密钥指纹、区域、可选 Compartment 和加密私钥。
- 所有 OCI 账户会与 Linode 账户一起并行读取，实例进入同一个控制台；账户筛选器按 OCI 账户 ID 区分。
- 「测试」会重新生成签名并读取 Compute API，不会改变其他账户。
- 「删除」只移除本机加密配置，不会删除 OCI 用户或 API 密钥。
- 实例详情中的启动、关闭和重启会自动使用实例所属 OCI 账户，无需手动切换。
- 操作完成后自动刷新状态；OCI 状态变更可能需要几十秒才会反映到列表。
- 当前 OCI 账户按区域读取。多区域实例请添加多个配置。

### 使用本地 SOCKS 代理

在「连接与设置」的「本地 SOCKS 代理」中启用代理，填写地址后先点「测试代理」，确认能连通 Linode API 再保存。

```text
socks5h://127.0.0.1:7890     Clash 默认端口，DNS 也由代理解析
socks5h://127.0.0.1:1080     常见 SOCKS 端口
socks5h://127.0.0.1:10808    v2ray / sing-box 常见端口
```

也支持 `socks4://`、`socks4a://`、`socks5://`。代理只影响 Node 服务访问 Linode API 的流量，不会修改系统代理或浏览器设置。需要认证时填写用户名和密码；密码留空表示保留已保存的密码。

### 部署实例

1. 打开「部署实例」。
2. 选择区域和规格，等待区域库存检查完成。
3. 选择系统镜像。
4. 设置至少 12 位 Root 密码，或展开「网络与初始化」填写 SSH 公钥。
5. 可选：启用备份、私有 IPv4、Cloud-init。
6. 检查右侧费用摘要，点击「部署实例」。

Root 密码只随创建请求发送到本地后端，再由后端转发给 Linode API；不会写入日志、`localStorage` 或 `.env`。

### 开关机与重启

- 「运行中」实例可执行重启或关闭。
- 「已关机」实例可启动。
- 过渡状态（部署中、重启中、关闭中等）会暂时禁用操作。
- 指令发出后，控制台会自动刷新状态，并在几秒后再检查一次。
- Linode 使用 Linode API 的 boot / shutdown / reboot，OCI 使用 START / STOP / RESET 电源操作。
- OCI 的 STOP / RESET 属于强制电源操作，不会先等待操作系统优雅关机；请确保应用能承受直接断电式操作。
- Oracle 实例详情当前不提供监控、备份、串口控制台或终止实例操作。

### 交换公网 IP

1. 打开实例详情，在「网络地址」区域点击「交换 IP」。
2. 选择同一账户、同一区域的另一台实例。
3. 选择交换「IPv4 公网地址」或「IPv6 路由段」。
4. 确认双方的当前地址后执行交换。
5. 等待约 1–2 分钟，再重启两台实例，让系统网卡使用新地址。

注意事项：

- IPv4 交换的是两台实例的首个公网 IPv4；共享 IP 不参与交换。
- IPv6 只支持 `/56` 或 `/64` 的路由段，Linode 默认的 SLAAC `/128` 地址无法转移。
- 交换会中断 SSH 和对外服务；如果实例使用静态网络配置，可能还需要在系统内手动更新地址。
- 跨区域实例不能交换，不同 Linode 账户之间也不能交换。

### 单机换新 IP

1. 打开实例详情，在「网络地址」区域点击「换新 IP」。
2. 选择更换「IPv4 公网地址」或「IPv6 路由段」。
3. 勾选风险确认后执行；IPv4 成功后重启实例，IPv6 成功后重启实例并在系统内配置新段地址。

IPv4 换新会先调用官方接口为实例分配一个额外的公网 IPv4，确认新地址可用后再释放旧 IPv4。账户必须具备额外 IPv4 配额，通常需要先提交 Akamai 支持工单；额外公网 IPv4 会单独按月计费，新旧地址短暂并存期间可能产生少量按小时费用。分配失败时旧地址不会被删除。如果旧地址未能自动释放，接口会返回 `warnings`，并标记 `requiresManualCleanup`；请到 Akamai 控制台手动释放旧地址，避免继续占用配额或计费。

IPv6 换新支持 `/64` 和 `/56`，会先删除当前路由段，再申请指定前缀的新路由段。默认 SLAAC `/128` 地址保持不变。由于 Linode 默认每个账户在每个区域只有一个 IPv6 路由段，新旧段不能并存；如果旧段已删除但新段申请失败，需要手动重试申请。该操作不可撤销，执行前请确认业务可以短暂中断。

换新 IP 不会自动重启实例。IPv4 换新后，使用 Network Helper 的实例通常会在重启时应用新的主 IPv4；静态配置仍需手动更新。IPv6 路由段内的地址通常不由 Network Helper 自动添加，需要按下面的方式在系统内配置。

IPv6 路由段和主机地址是两个概念：控制台显示的是整段路由（例如 `2400:8907:cc03::/64`），这个前缀本身不能直接 ping，也不会自动变成实例网卡上的可用地址。新段会路由到实例的 SLAAC 地址，但还需要在系统内从新段配置地址，并允许 ICMPv6。临时测试可以执行：

```bash
# 从新 /64 中挑一个地址；如果是 /56 段，把地址前缀和掩码替换成 /56
sudo ip -6 addr add 2400:8907:cc03::10/64 dev eth0
sudo ip6tables -I INPUT -p icmpv6 -j ACCEPT
ip -6 addr show dev eth0
ip -6 route show default
```

然后从支持 IPv6 的外部网络 `ping -6 2400:8907:cc03::10`，不要去 ping `2400:8907:cc03::/64` 或只 ping 段前缀。也可以用 `curl -6 https://ipv6.icanhazip.com` 检查实例的出站 IPv6，用 `sudo tcpdump -ni eth0 icmp6` 检查入站 ICMPv6 是否到达。生产环境请用 Netplan、systemd-networkd 或 NetworkManager 持久化地址，并同时检查 Akamai Cloud Firewall、UFW/firewalld 和系统策略是否允许 ICMPv6。实例默认的 SLAAC 地址不会因换新而改变。

如果实例开启了 Network Helper（Linode 配置中的 `helpers.network`），它会在每次启动时重写网卡配置，手工添加的路由段地址可能因此在重启后消失。官方建议使用 `/64` 或 `/56` 路由段时关闭 Network Helper，但关闭前必须先准备好 IPv4、SLAAC 和路由段地址的静态网络配置，否则重启后可能失联。只想临时验证时，可以在当前系统启动后添加地址并立刻从外部测试，不需要先重启。

费用方面，Akamai/Linode 的 `/64`、`/56` IPv6 路由段不单独收费，主要受账户和区域的配额限制；真正可能产生费用的是 IPv4 换新时为完成切换而申请、以及清理失败后遗留的额外公网 IPv4。最终金额以 Akamai 账单为准。

### 删除实例

打开实例详情，滚动到底部点击「删除实例」，输入实例名称后确认。删除会永久移除磁盘、配置和公网地址，无法恢复。

## 本地 API 路由

后端只代理明确列出的操作，不提供任意 URL 转发：

| 方法 | 路由 | 说明 |
| --- | --- | --- |
| `GET` | `/api/session` | 连接配置状态 |
| `GET` | `/api/settings` | 令牌与代理的公开设置（不含明文凭据） |
| `POST` | `/api/settings/tokens` | 验证并添加令牌 |
| `POST` | `/api/settings/tokens/import-env` | 从 `.env` 导入回退令牌 |
| `POST` | `/api/settings/tokens/:id/activate` | 验证并设为默认令牌 |
| `POST` | `/api/settings/tokens/:id/test` | 测试指定令牌 |
| `DELETE` | `/api/settings/tokens/:id` | 删除本地保存的令牌 |
| `POST` | `/api/settings/oracle-accounts` | 验证并添加 OCI 账户 |
| `POST` | `/api/settings/oracle-accounts/:id/test` | 测试指定 OCI 账户 |
| `DELETE` | `/api/settings/oracle-accounts/:id` | 删除本地 OCI 账户 |
| `PUT` | `/api/settings/proxy` | 保存 SOCKS 代理设置 |
| `POST` | `/api/settings/proxy/test` | 测试代理连通性 |
| `POST` | `/api/settings/test-connection` | 同时诊断代理、Linode 令牌和 OCI 账户 |
| `GET` | `/api/overview` | 多云账户、实例、Linode 流量与活动 |
| `GET` | `/api/catalog` | 区域、规格和镜像 |
| `GET` | `/api/availability/:region` | 区域规格可用性 |
| `GET` / `POST` | `/api/instances` | 实例列表 / 创建实例 |
| `GET` | `/api/instances/:id/detail` | 实例详情、监控、备份和事件 |
| `GET` | `/api/instances/:id/ips` | 实例可交换的 IPv4 与 IPv6 地址 |
| `POST` | `/api/instances/:id/ip-swap` | 交换同区域实例的公网 IPv4 或 IPv6 路由段 |
| `POST` | `/api/instances/:id/ip-renew` | 为单个实例换新公网 IPv4 或 IPv6 路由段 |
| `POST` | `/api/instances/:id/actions/:action` | `boot`、`shutdown`、`reboot` |
| `DELETE` | `/api/instances/:id` | 删除实例 |
| `GET` | `/api/oracle/instances` | 列出 OCI 实例，可选 `accountId` |
| `GET` | `/api/oracle/instances/:ocid` | 读取单个 OCI 实例 |
| `GET` | `/api/oracle/instances/:ocid/detail` | OCI 实例详情与 VNIC 地址 |
| `POST` | `/api/oracle/instances/:ocid/actions/:action` | `boot`、`shutdown`、`reboot` |

读取时，所有 Linode Web 令牌和 OCI 账户并行工作；只有在没有任何 Web 令牌时才使用服务端 `LINODE_API_TOKEN` 回退。Linode 写操作按实例所属的 `tokenId` 路由，OCI 写操作按 `accountId` 路由；创建 Linode 实例时由请求体中的 `tokenId` 指定目标账户。浏览器不发送或保存 API 令牌或 OCI 私钥。

所有写操作还需要携带 `X-CloudVMController: 1` 请求头。前端会自动添加；这个自定义头用于阻止跨站表单伪造请求（CSRF）。旧版 `X-Linode-Pilot` 请求头仍兼容。

## 开发与测试

```powershell
# 自动重启开发服务
npm run dev

# 运行后端集成测试（使用内置模拟 Linode API 和会校验收签名的 OCI API）
npm test
```

测试覆盖：

- 静态页面与安全响应头
- 多令牌加密存储、切换和删除，公开接口不泄露凭据
- 多账户实例聚合、账户筛选和操作路由
- 本地 SOCKS5 代理转发
- 账户概览代理
- Linode 分页参数校验（`page_size` 必须为 25–500）
- 实例开关机参数校验
- 实例间 IPv4 / IPv6 路由段交换、区域校验和权限错误
- 单机 IPv4 / IPv6 换新、前缀校验、过渡状态和旧地址清理警告
- 换新 IP 弹窗的 IPv4、IPv6、`/56`、SLAAC 和确认状态
- 创建实例字段白名单和 Cloud-init Base64 编码
- Root 认证校验
- 实例详情和事件过滤
- OCI RSA-SHA256 请求签名校验、加密私钥存储和公开接口脱敏
- OCI 根/子 Compartment 实例发现、VNIC 地址读取和启动/关闭操作
- Linode 与 Oracle 实例聚合、账户筛选及 UI 渲染

## 项目结构

```text
.
├── public/
│   ├── index.html          # 应用外壳、图标和静态结构
│   ├── styles.css          # 深色主题与响应式布局
│   └── js/
│       ├── app.js          # 状态、路由、交互和数据加载
│       ├── api.js          # 本地 API 客户端
│       ├── views.js        # 页面和详情渲染
│       ├── charts.js       # 24 小时监控 SVG 图表
│       ├── utils.js        # 格式化、密码和状态工具
│       └── icons.js        # 内联 SVG 图标
├── server/
│   ├── index.js            # 启动、.env 加载和优雅关闭
│   ├── app.js              # 路由、校验、静态服务和安全头
│   ├── linode.js           # Linode API 客户端、分页与 SOCKS 代理
│   ├── oracle.js           # OCI 请求签名、分页、实例和 VNIC 客户端
│   └── settings-store.js   # 多令牌、OCI 账户、代理和本地加密存储
├── tests/
│   ├── app.test.js         # Node 内置测试
│   └── helpers/            # 模拟 Linode API、OCI API 与 SOCKS5 服务
├── data/                   # 运行时生成，已忽略：settings.json 与 .key
├── .env.example
├── package-lock.json
└── package.json
```

## 常见问题

**页面提示「令牌权限不足」**

检查令牌是否拥有 Linodes Read/Write 权限。删除、创建和开关机都需要写权限。

**余额或流量显示不可用**

令牌缺少 Account Read Only 权限。实例管理不受影响。

**端口被占用**

在 `.env` 中修改 `PORT`，或关闭占用 `4173` 的程序。

**SOCKS 代理测试失败**

确认代理进程正在运行、地址和端口正确。Clash 的混合端口通常是 `7890`，v2ray 常见 `10808`，独立 SOCKS 服务常见 `1080`。优先使用 `socks5h://`，让代理端解析 DNS；如果代理只监听 IPv4，避免使用 `localhost`，改为 `127.0.0.1`。

**修改 `.env` 后没有生效**

环境变量在服务启动时读取，需要停止并重新运行 `npm start`。

**401 / Token invalid**

令牌可能已过期、被撤销，或粘贴时包含了多余字符。在「连接与设置」中逐个测试令牌；如仍失败，重新生成令牌后添加并设为默认。若走代理，先用「测试代理」排除网络问题。

**OCI 签名失败 / NotAuthenticated**

依次检查 Tenancy OCID、User OCID、Fingerprint 和私钥是否来自同一组 API Key；确认私钥完整包含 `BEGIN PRIVATE KEY` 和 `END PRIVATE KEY`；确认本机与 OCI 的时间偏差不超过几分钟。若刚生成密钥，OCI 控制台可能需要短暂时间同步。

**OCI 实例列表为空或缺少子 Compartment**

确认 IAM 策略允许 `inspect instances` / `manage instances`，并允许 `inspect compartments in tenancy`。也可以直接填写目标 Compartment OCID，绕过自动发现。一个 OCI 配置只读取一个区域，多区域实例需要添加多个配置。

**OCI 详情没有公网 IP**

读取 VNIC 需要额外的虚拟网络只读权限；没有时不影响启动、关闭和重启。也可能是实例确实没有分配公网 IP。请到 OCI 控制台确认 VNIC 与 Public IP 绑定。

**页面显示已连接，但概览加载失败**

打开「连接与设置」点击「测试连接」，它会分别检查代理、Linode 令牌和 OCI 账户。若 Linode 令牌正常但概览失败，检查是否缺少 Account / Events 只读权限。

## 说明

CloudVMController 是第三方本地工具，与 Akamai / Linode、Oracle 均无官方关联。使用前请确认账户余额、计费方式和 API 权限；创建、删除、开关机和重启实例产生的费用与后果由账户持有人承担。
