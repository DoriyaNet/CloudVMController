# CloudVMController

CloudVMController 是一个在本地运行的多云实例控制面板，通过 Akamai / Linode API v4 与 Oracle Cloud Infrastructure（OCI）API 管理虚拟机。Linode 和 OCI 实例会聚合到同一个概览与实例列表中，适合日常运维：查看状态、开关机、重启、创建实例、监控、备份、串口控制台和终止实例。

界面采用锐利的 Vercel / Cloudflare 控制台风格，强调信息密度、清晰层级和高频操作效率。所有凭据与设置都保存在本机，Node 服务默认只监听 `127.0.0.1`。

> 这是第三方本地工具，与 Akamai / Linode、Oracle 均无官方关联。

## 一键安装

### Windows

在仓库目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

也可以直接双击 `install.cmd`。脚本会检查 Node.js 20+、安装依赖，并注册 `cloudvm` 快捷指令：

```powershell
cloudvm              # 启动并打开浏览器
cloudvm update       # 更新软件
cloudvm update-script # 更新 cloudvm 脚本
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

脚本会检查 Node.js 20+、安装依赖，并把 `cloudvm` 安装到 `~/.local/bin`。更新命令与 Windows 相同：

```bash
cloudvm update
cloudvm update-script
```

安装位置、代理和更多命令见 [Linux 一键安装](https://github.com/DoriyaNet/CloudVMController/wiki/Linux-Install)。

## 功能概览

- **多云聚合**：Linode 与 OCI 实例统一展示，支持账户筛选、名称 / IP / 标签 / 状态 / 区域筛选。
- **快捷运维**：启动、关闭、重启、终止实例，写操作自动路由到实例所属账户。
- **IP 管理**：同区域实例间交换公网 IPv4 或 IPv6 路由段；为单机换新 IPv4 或 `/56`、`/64` IPv6 段。
- **创建实例**：Linode 支持区域库存检查、镜像、备份、私有 IPv4、SSH 公钥与 Cloud-init；OCI 支持 Compartment、可用域、Shape、VCN、子网与 Cloud-init。
- **监控与备份**：Linode 24 小时 CPU / 网络图表；OCI CPU、内存、负载、网络、磁盘指标与启动卷备份。
- **串口控制台**：管理 OCI Instance Console Connection 与控制台历史。
- **多账户与代理**：多个 Linode Token、多个 OCI 配置并行工作；支持本地 SOCKS4 / 4A / 5 / 5H 代理。
- **本地安全**：Linode 令牌、OCI 私钥与代理密码使用 AES-256-GCM 加密保存在 `data/`。

## 快速开始

需要 Node.js 20+。运行时仅使用一个依赖 `socks-proxy-agent`。

```powershell
npm install
npm start
```

打开 <http://127.0.0.1:4173>，进入「连接与设置」：

1. **Linode**：添加 Personal Access Token。
2. **Oracle Cloud**：填写 Tenancy OCID、User OCID、区域、密钥指纹和 API 私钥。
3. 如需代理，填写本地 SOCKS 地址并测试连接。

设置保存后立即生效，不需要手动编辑 `.env`。

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
| [本地 API](https://github.com/DoriyaNet/CloudVMController/wiki/Local-API) | 后端路由与 CSRF 请求头 |
| [开发与测试](https://github.com/DoriyaNet/CloudVMController/wiki/Development) | 测试覆盖与项目结构 |
| [常见问题](https://github.com/DoriyaNet/CloudVMController/wiki/FAQ) | 令牌、OCI、代理与监控问题排查 |

## 安全提示

本项目没有用户登录系统，**不要直接把 `HOST=0.0.0.0` 的服务暴露到公网**。如需远程访问，请在前面部署带 HTTPS 和身份认证的反向代理，并限制来源 IP。详见 [安全说明](https://github.com/DoriyaNet/CloudVMController/wiki/Security)。

## 说明

使用前请确认账户余额、计费方式和 API 权限。创建、删除、终止、开关机、重启、备份、保留卷和串口操作产生的费用与后果由账户持有人承担。
