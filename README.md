# CloudVMController

CloudVMController 是一个在本地运行的多云实例控制面板，通过 Akamai / Linode API v4 与 Oracle Cloud Infrastructure（OCI）API 管理虚拟机。Linode 和 OCI 实例会聚合到同一个概览与实例列表中，适合日常运维：查看状态、开关机、重启、创建实例、监控、备份、串口控制台和终止实例。

界面采用锐利的 Vercel / Cloudflare 控制台风格，强调信息密度、清晰层级和高频操作效率。GitHub 模式下凭据加密保存在你的 GitHub 私有仓库；本地模式继续保存在本机。Node 服务默认只监听 `127.0.0.1`。

> 这是第三方本地工具，与 Akamai / Linode、Oracle 均无官方关联。

## 一键安装

### Windows

在仓库目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

也可以直接双击 `install.cmd`。脚本会检查 Node.js 20+、安装依赖，并注册 `cloudvm` 快捷指令：

```powershell
cloudvm              # 进入交互菜单
cloudvm start        # 启动服务（不打开浏览器）
cloudvm open         # 在桌面环境下手动打开 Web 界面
cloudvm update       # 更新软件
```

安装时可以直接写入环境变量：

```powershell
.\install.ps1 -SetEnv "HOST=127.0.0.1","PORT=4173"
```

安装位置、远程一键安装和更多命令见 [Windows 一键安装](https://github.com/DoriyaNet/CloudVMController/wiki/Windows-Install)。

### Linux

在仓库目录运行：

```bash
bash install.sh
```

也可以直接运行远程脚本：

```bash
curl -fsSL https://raw.githubusercontent.com/DoriyaNet/CloudVMController/main/install.sh | bash
```

脚本会检查 Node.js 20+、安装依赖，并把 `cloudvm` 安装到 `~/.local/bin`。常用命令与 Windows 相同：

```bash
cloudvm
cloudvm update
```

安装时可以直接写入环境变量，适合非交互式服务器部署：

```bash
bash install.sh --env HOST=127.0.0.1 --env PORT=4173
curl -fsSL https://raw.githubusercontent.com/DoriyaNet/CloudVMController/main/install.sh \
  | bash -s -- --env HOST=127.0.0.1 --env PORT=4173
```

安装位置、代理和更多命令见 [Linux 一键安装](https://github.com/DoriyaNet/CloudVMController/wiki/Linux-Install)。

`cloudvm start`、`restart` 和安装完成后的自动启动都不会打开浏览器，适用于无桌面环境的服务器。只有显式执行 `cloudvm open` 才会尝试打开本地浏览器。

如果希望由 systemd、supervisor 等进程管理器启动服务，安装时加 `--no-start`（Windows 使用 `-NoStart`），安装完成后配置进程管理器调用 `node server/index.js` 即可。

## 交互菜单

在终端直接运行 `cloudvm`，或执行 `cloudvm menu` / `cloudvm tui`，会进入类似 x-ui 的全屏 TUI 菜单。使用 ↑/↓ 选择、Enter 确认、Q 返回或退出，也可以直接按数字：

```text
  1) 启动服务
  2) 停止服务
  3) 重启服务
  4) 查看状态
  5) 查看日志
  6) 环境变量管理
  7) 更新软件（含脚本）
  8) 打开 Web 界面（桌面环境）
  9) 退出
```

菜单顶部会显示版本、监听地址、运行状态、安装目录和 `.env` 路径。环境变量子菜单按「基础连接 / GitHub 鉴权与保险库 / 访问控制与反向代理 / 数据与 API」分组，直接选择要修改的变量，不再需要手输变量名；布尔项和认证模式使用选择器，敏感值输入时会隐藏内容。非交互环境（例如脚本、定时任务）中直接无参数运行 `cloudvm` 仍按 `cloudvm start` 处理；建议显式写 `cloudvm start`。

## 环境变量管理

安装后可直接通过 `cloudvm` 菜单的「环境变量管理」或 `cloudvm env` 修改 `.env`，不需要手工查找文件：

```bash
cloudvm env list
cloudvm env get HOST
cloudvm env set HOST=127.0.0.1 PORT=4173
cloudvm env unset PORT
cloudvm restart
```

修改会写入安装目录的 `.env`，重启服务后生效。`cloudvm env list` 会隐藏 `SECRET`、`TOKEN`、`PASSWORD`、`PRIVATE_KEY` 和 `PROXY` 的值；需要查看单个值时使用 `cloudvm env get KEY`。

安装脚本会在安装目录提前创建 `.env`；如果文件缺失或为空，`cloudvm` 菜单、启动服务和 `cloudvm env` 命令也会尝试从 `.env.example` 重新创建。

多行内容（例如 GitHub App 私钥）可以先保存为文件，再写入：

```bash
cloudvm env set GITHUB_APP_PRIVATE_KEY=@/path/to/private-key.pem
```

Windows 下同样支持：

```powershell
cloudvm env set HOST=127.0.0.1 PORT=4173
cloudvm env set GITHUB_APP_PRIVATE_KEY=@C:\path\to\private-key.pem
cloudvm restart
```

## GitHub 私有仓库保险库（推荐）

远程服务器部署建议启用 GitHub App 鉴权，并让控制台把设置保存到自己的私有仓库：

- 使用 GitHub App 登录，只有白名单中的 GitHub 账户可以进入。
- Linode Token、OCI 私钥、代理密码整体使用 PBKDF2-SHA256 + AES-256-GCM 加密。
- 密文固定写入私有仓库的 `.cloudvm/vault.json`，服务器不把明文凭据写到磁盘。
- 保险库密码只在解锁时通过 HTTPS 提交给自托管服务，并仅保留在 Node 进程内存中；重启、锁定或退出后需要重新解锁。

### 创建 GitHub App

1. 打开 GitHub **Settings → Developer settings → GitHub Apps → New GitHub App**。
2. **Callback URL** 填写 `https://YOUR_DOMAIN/api/auth/callback`。
3. **Setup URL** 填写 `https://YOUR_DOMAIN/api/github/setup`，并启用 Redirect on update。
4. **Repository permissions** 只授予 Contents: Read and write、Metadata: Read-only。
5. 创建后记录 App ID、Client ID，生成 Client secret，并下载 Private key。

### 配置 `.env`

在安装目录创建或编辑 `.env`：

```bash
cp .env.example .env
chmod 600 .env
# 然后编辑 .env
```

Windows 下可使用 `Copy-Item .env.example .env`，并通过文件属性限制访问权限。

填入 GitHub App 配置：

```bash
CLOUDVM_AUTH_MODE=github
GITHUB_APP_ID=123456
GITHUB_APP_CLIENT_ID=Iv1.xxxxxxxx
GITHUB_APP_CLIENT_SECRET=xxxxxxxx
# 可直接把 PEM 用双引号包起来跨多行，或把换行替换成字面量 \n
GITHUB_APP_PRIVATE_KEY=
GITHUB_APP_SLUG=your-app-slug
# 填入 openssl rand -base64 48 的输出
SESSION_SECRET=
APP_ORIGIN=https://cloudvm.example.com
CLOUDVM_ALLOWED_GITHUB_USERS=your-github-login
```

然后重启：

```bash
cloudvm restart
```

首次打开页面时使用 GitHub 登录，安装 GitHub App，选择一个**已有初始提交的私有仓库**并设置保险库密码。已有本地 `data/` 设置会在创建新保险库时自动导入。

> GitHub 模式默认要求配置 `CLOUDVM_ALLOWED_GITHUB_USERS` 或 `CLOUDVM_ALLOWED_GITHUB_IDS`；否则服务会拒绝启动。只有明确设置 `CLOUDVM_ALLOW_ANY_GITHUB_USER=1` 才允许多用户使用。

确认保险库创建成功并能在另一台设备解锁后，可以删除安装目录下的 `data/settings.json` 与 `data/.key`，避免旧凭据继续留在服务器磁盘上。

## 功能概览

- **多云聚合**：Linode 与 OCI 实例统一展示，支持账户筛选、名称 / IP / 标签 / 状态 / 区域筛选。
- **快捷运维**：启动、关闭、重启、终止实例，写操作自动路由到实例所属账户。
- **IP 管理**：同区域实例间交换公网 IPv4 或 IPv6 路由段；为单机换新 IPv4 或 `/56`、`/64` IPv6 段。
- **IPv6 绑定助手**：IPv6 换新或交换成功后自动弹出脚本，可复制临时绑定命令或 systemd 永久绑定脚本，直接粘贴到实例终端执行。
- **创建实例**：Linode 支持区域库存检查、镜像、备份、私有 IPv4、SSH 公钥与 Cloud-init；OCI 支持 Compartment、可用域、Shape、VCN、子网与 Cloud-init。
- **监控与备份**：Linode 24 小时 CPU / 网络图表；OCI CPU、内存、负载、网络、磁盘指标与启动卷备份。
- **串口控制台**：管理 OCI Instance Console Connection 与控制台历史。
- **多账户与代理**：多个 Linode Token、多个 OCI 配置并行工作；支持本地 SOCKS4 / 4A / 5 / 5H 代理。
- **GitHub 保险库安全**：Linode 令牌、OCI 私钥与代理密码使用 PBKDF2-SHA256 + AES-256-GCM 加密保存在私有仓库 `.cloudvm/vault.json`。
- **本地模式安全**：不使用 GitHub 登录时，凭据继续加密保存在 `data/settings.json`，密钥存放在 `data/.key`。

IPv6 绑定助手只生成并复制脚本，不会从浏览器或 Node 服务远程执行命令。临时脚本在当前实例内立即绑定地址，重启后失效；永久脚本会安装一个 systemd oneshot 服务，在每次开机后重新添加地址，不要求关闭 Network Helper，适用于使用 systemd 的 Linux。脚本默认自动识别默认路由网卡，并尝试在 `ip6tables` 中放行 ICMPv6，可在弹窗中取消。关闭弹窗后，仍可从实例详情的「网络地址 → 绑定 IPv6」重新打开。多网卡、nftables、firewalld 或自定义 UFW 规则仍应在执行前人工确认。

## 快速开始

需要 Node.js 20+。运行时仅使用一个依赖 `socks-proxy-agent`。

```powershell
npm install
npm start
```

打开 <http://127.0.0.1:4173>。如果启用了 GitHub 模式，先登录并解锁保险库；本地模式直接进入「连接与设置」：

1. **Linode**：添加 Personal Access Token。
2. **Oracle Cloud**：填写 Tenancy OCID、User OCID、区域、密钥指纹和 API 私钥。
3. 如需代理，填写本地 SOCKS 地址并测试连接。

设置保存后立即生效。GitHub 模式下每次修改都会重新加密并提交到私有仓库，其他设备解锁同一保险库即可同步。

详细架构、接口和安全边界见 [`docs/github-vault.md`](docs/github-vault.md)。

## 文档

更详细的说明放在 GitHub Wiki：

| 文档 | 内容 |
| --- | --- |
| [快速开始](https://github.com/DoriyaNet/CloudVMController/wiki/Quick-Start) | 安装、首次连接与基础配置 |
| [Windows 一键安装](https://github.com/DoriyaNet/CloudVMController/wiki/Windows-Install) | 安装脚本、cloudvm 命令与更新 |
| [Linux 一键安装](https://github.com/DoriyaNet/CloudVMController/wiki/Linux-Install) | 安装脚本、cloudvm 命令与更新 |
| [Linode](https://github.com/DoriyaNet/CloudVMController/wiki/Linode) | 令牌权限、多令牌管理、实例创建、IP 交换与换新 |
| [Oracle Cloud](https://github.com/DoriyaNet/CloudVMController/wiki/Oracle-Cloud) | API 密钥、IAM 策略、实例创建、监控、备份、串口与终止 |
| [使用指南](https://github.com/DoriyaNet/CloudVMController/wiki/Usage) | 开关机、SOCKS 代理与多账户路由 |
| [配置](https://github.com/DoriyaNet/CloudVMController/wiki/Configuration) | 环境变量与数据目录 |
| [安全说明](https://github.com/DoriyaNet/CloudVMController/wiki/Security) | 凭据加密、本地暴露风险与操作确认 |
| [GitHub 保险库](docs/github-vault.md) | GitHub App 登录、私有仓库存储与保险库接口 |
| [本地 API](https://github.com/DoriyaNet/CloudVMController/wiki/Local-API) | 后端路由与 CSRF 请求头 |
| [开发与测试](https://github.com/DoriyaNet/CloudVMController/wiki/Development) | 测试覆盖与项目结构 |
| [常见问题](https://github.com/DoriyaNet/CloudVMController/wiki/FAQ) | 令牌、OCI、代理与监控问题排查 |

## 安全提示

**GitHub 模式**：服务端仍需要 HTTPS 反向代理；保险库密码会提交给自托管 Node 服务并保存在内存中，不是零知识证明。请限制 GitHub 白名单，并使用最小权限的 Linode Token 与 OCI IAM 用户。

GitHub 的提交历史会保留旧版本密文。删除 Token 或 OCI 密钥后，历史密文仍可能被保险库密码解密；需要彻底清除时请重写仓库历史或轮换对应凭据。

**本地模式**：本项目没有内建用户登录系统。监听非回环地址时，服务默认拒绝启动；只有显式设置 `CLOUDVM_ALLOW_INSECURE_REMOTE=1`，并且已经在反向代理层完成 HTTPS 和身份认证时才可绕过。更安全的远程方式是保持 `HOST=127.0.0.1` 并使用 SSH 隧道，或启用 GitHub 保险库模式。

无论使用哪种模式，都不要把控制台直接暴露到公网。详见 [安全说明](https://github.com/DoriyaNet/CloudVMController/wiki/Security)。

## 说明

使用前请确认账户余额、计费方式和 API 权限。创建、删除、终止、开关机、重启、备份、保留卷和串口操作产生的费用与后果由账户持有人承担。
