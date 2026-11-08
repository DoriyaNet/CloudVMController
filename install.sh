#!/usr/bin/env bash
set -euo pipefail

INSTALLER_VERSION="1.0.0"
REPOSITORY="DoriyaNet/CloudVMController"
BRANCH="main"
INSTALL_DIR=""
NO_LAUNCH=0
NO_PATH=0
SKIP_DEPS=0
FORCE=0
PROXY="${CLOUDVM_PROXY:-}"

info() {
    printf '\033[36m%s\033[0m\n' "$*"
}

success() {
    printf '\033[32m%s\033[0m\n' "$*"
}

warn() {
    printf '\033[33m%s\033[0m\n' "$*" >&2
}

die() {
    printf '错误：%s\n' "$*" >&2
    exit 1
}

usage() {
    cat <<'EOF'
CloudVMController Linux 安装脚本

用法：
  bash install.sh [选项]

选项：
  -d, --install-dir <path>   自定义安装目录
      --branch <name>        Git 分支，默认 main
      --repo <owner/repo>    GitHub 仓库，默认 DoriyaNet/CloudVMController
      --no-launch            安装完成后不启动服务
      --no-path              不修改 shell 启动文件
      --skip-deps            跳过 npm 依赖安装
      --force                下载失败时不回退到已有安装
      --proxy <url>          GitHub / Node.js 下载代理
  -h, --help                 显示帮助
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -d|--install-dir)
            [[ $# -ge 2 ]] || die "缺少安装目录参数"
            INSTALL_DIR="$2"
            shift 2
            ;;
        --branch)
            [[ $# -ge 2 ]] || die "缺少分支参数"
            BRANCH="$2"
            shift 2
            ;;
        --repo)
            [[ $# -ge 2 ]] || die "缺少仓库参数"
            REPOSITORY="$2"
            shift 2
            ;;
        --no-launch)
            NO_LAUNCH=1
            shift
            ;;
        --no-path)
            NO_PATH=1
            shift
            ;;
        --skip-deps)
            SKIP_DEPS=1
            shift
            ;;
        --force)
            FORCE=1
            shift
            ;;
        --proxy)
            [[ $# -ge 2 ]] || die "缺少代理地址"
            PROXY="$2"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            die "未知参数：$1"
            ;;
    esac
done

[[ -n "${HOME:-}" ]] || die "HOME 未设置"

SOURCE="${BASH_SOURCE[0]:-}"
PIPED_INSTALL=0
if [[ -n "$SOURCE" && "$SOURCE" != "/dev/stdin" && "$SOURCE" != /dev/fd/* && -f "$SOURCE" ]]; then
    SCRIPT_DIR="$(cd "$(dirname "$SOURCE")" && pwd -P)"
else
    PIPED_INSTALL=1
    SCRIPT_DIR="$(pwd -P)"
fi

CLOUDVM_HOME="${CLOUDVM_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/cloudvmcontroller}"
BIN_DIR="${CLOUDVM_BIN_DIR:-$HOME/.local/bin}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/cloudvmcontroller"
CONFIG_FILE="${CLOUDVM_CONFIG:-$CONFIG_DIR/config.env}"
RUNTIME_DIR="$CLOUDVM_HOME/runtime"
LAUNCHER_DIR="$CLOUDVM_HOME/bin"

TMP_DIRS=()
cleanup() {
    local dir
    if [[ ${#TMP_DIRS[@]} -gt 0 ]]; then
        for dir in "${TMP_DIRS[@]}"; do
            if [[ -n "$dir" ]]; then
                rm -rf "$dir"
            fi
        done
    fi
}
trap cleanup EXIT

new_temp() {
    local dir
    dir="$(mktemp -d)"
    TMP_DIRS+=("$dir")
    printf '%s' "$dir"
}

download_file() {
    local url="$1"
    local output="$2"
    if command -v curl >/dev/null 2>&1; then
        local args=(-fsSL --retry 3 --connect-timeout 15)
        if [[ -n "$PROXY" ]]; then
            args+=(-x "$PROXY")
        fi
        curl "${args[@]}" -o "$output" "$url"
        return 0
    fi
    if command -v wget >/dev/null 2>&1; then
        if [[ -n "$PROXY" ]]; then
            https_proxy="$PROXY" http_proxy="$PROXY" wget -q -O "$output" "$url"
        else
            wget -q -O "$output" "$url"
        fi
        return 0
    fi
    die "需要 curl 或 wget 才能下载文件"
}

is_local_repo() {
    local dir="$1"
    if [[ -f "$dir/package.json" ]] && grep -q '"name"[[:space:]]*:[[:space:]]*"cloudvmcontroller"' "$dir/package.json"; then
        return 0
    fi
    return 1
}

resolve_target() {
    local dir="$1"
    mkdir -p "$dir"
    (cd "$dir" && pwd -P)
}

copy_app_files() {
    local source="$1"
    local target="$2"
    local directory
    local file
    mkdir -p "$target"
    for directory in public server tests scripts; do
        if [[ -d "$source/$directory" ]]; then
            rm -rf "$target/$directory"
            cp -a "$source/$directory" "$target/$directory"
        fi
    done
    for file in install.sh install.ps1 install.cmd README.md package.json package-lock.json .env.example .gitignore .gitattributes; do
        if [[ -f "$source/$file" ]]; then
            cp -f "$source/$file" "$target/$file"
        fi
    done
}

install_app_archive() {
    local target="$1"
    local temp_root
    local archive
    local extract_dir
    local source_root
    local url
    temp_root="$(new_temp)"
    archive="$temp_root/source.tar.gz"
    extract_dir="$temp_root/extract"
    url="https://github.com/$REPOSITORY/archive/refs/heads/$BRANCH.tar.gz"
    info "下载 CloudVMController：$url"
    download_file "$url" "$archive" || return 1
    mkdir -p "$extract_dir"
    tar -xzf "$archive" -C "$extract_dir" || return 1
    source_root="$(find "$extract_dir" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
    if [[ -z "$source_root" ]]; then
        warn "无法识别下载的压缩包结构"
        return 1
    fi
    copy_app_files "$source_root" "$target" || return 1
}

version_ge() {
    local first="$1"
    local second="$2"
    local smallest
    smallest="$(printf '%s\n%s\n' "$first" "$second" | sort -V | head -n 1)"
    [[ "$smallest" = "$second" ]]
}

node_version() {
    local node="$1"
    local value
    value="$("$node" --version 2>/dev/null || true)"
    value="${value#v}"
    printf '%s' "$value"
}

find_local_node() {
    if [[ ! -d "$RUNTIME_DIR" ]]; then
        return 1
    fi
    local node
    local value
    while IFS= read -r node; do
        if [[ -x "$node" ]]; then
            value="$(node_version "$node")"
            if [[ -n "$value" ]] && version_ge "$value" "20.0.0"; then
                printf '%s' "$node"
                return 0
            fi
        fi
    done < <(find "$RUNTIME_DIR" -type f -path '*/bin/node' 2>/dev/null)
    return 1
}

find_system_node() {
    local node
    local value
    node="$(command -v node 2>/dev/null || true)"
    [[ -n "$node" ]] || return 1
    value="$(node_version "$node")"
    if [[ -n "$value" ]] && version_ge "$value" "20.0.0"; then
        printf '%s' "$node"
        return 0
    fi
    return 1
}

find_npm_for_node() {
    local node="$1"
    local node_dir
    local npm_cli
    local npm
    node_dir="$(dirname "$node")"
    npm_cli="$node_dir/../lib/node_modules/npm/bin/npm-cli.js"
    if [[ -f "$npm_cli" ]]; then
        printf '%s' "$npm_cli"
        return 0
    fi
    npm="$node_dir/npm"
    if [[ -x "$npm" ]]; then
        printf '%s' "$npm"
        return 0
    fi
    npm="$(command -v npm 2>/dev/null || true)"
    if [[ -n "$npm" && -x "$npm" ]]; then
        printf '%s' "$npm"
        return 0
    fi
    return 1
}

sha256_file() {
    local file="$1"
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$file" | awk '{print tolower($1)}'
        return 0
    fi
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$file" | awk '{print tolower($1)}'
        return 0
    fi
    if command -v openssl >/dev/null 2>&1; then
        openssl dgst -sha256 "$file" | awk '{print tolower($NF)}'
        return 0
    fi
    die "找不到 SHA256 校验工具"
}

install_portable_node() {
    local architecture
    local node_arch
    local temp_root
    local sums
    local line
    local expected
    local filename
    local archive
    local actual
    local node
    architecture="$(uname -m)"
    case "$architecture" in
        x86_64|amd64)
            node_arch="x64"
            ;;
        aarch64|arm64)
            node_arch="arm64"
            ;;
        *)
            die "不支持的 CPU 架构：$architecture"
            ;;
    esac
    temp_root="$(new_temp)"
    sums="$temp_root/SHASUMS256.txt"
    info "未找到 Node.js 20+，准备下载便携版 Node.js..."
    download_file "https://nodejs.org/dist/latest/SHASUMS256.txt" "$sums"
    line="$(grep "linux-$node_arch.tar.gz" "$sums" | head -n 1)"
    [[ -n "$line" ]] || die "无法在 Node.js 校验文件中找到 linux-$node_arch 安装包"
    read -r expected filename <<< "$line"
    expected="$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')"
    archive="$temp_root/$filename"
    info "下载 $filename..."
    download_file "https://nodejs.org/dist/latest/$filename" "$archive"
    actual="$(sha256_file "$archive")"
    [[ "$actual" = "$expected" ]] || die "Node.js 安装包 SHA256 校验失败"
    mkdir -p "$RUNTIME_DIR"
    tar -xzf "$archive" -C "$RUNTIME_DIR"
    node="$(find_local_node || true)"
    [[ -n "$node" ]] || die "Node.js 便携版解压失败"
    printf '%s' "$node"
}

NODE_BIN=""
NPM_BIN=""

resolve_node_runtime() {
    NODE_BIN="$(find_local_node || find_system_node || true)"
    if [[ -z "$NODE_BIN" ]]; then
        NODE_BIN="$(install_portable_node)"
    fi
    NPM_BIN="$(find_npm_for_node "$NODE_BIN" || true)"
    [[ -n "$NPM_BIN" ]] || die "找不到 npm，请安装完整版 Node.js 20+ 后重试"
}

run_npm() {
    if [[ "$NPM_BIN" = *.js && -f "$NPM_BIN" ]]; then
        "$NODE_BIN" "$NPM_BIN" "$@"
        return $?
    fi
    PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" "$@"
}

install_dependencies() {
    if [[ "$SKIP_DEPS" -eq 1 ]]; then
        return 0
    fi
    info "安装项目依赖..."
    if ! (cd "$TARGET_DIR" && run_npm ci --no-audit --no-fund); then
        (cd "$TARGET_DIR" && run_npm install --no-audit --no-fund)
    fi
}

install_launcher() {
    local source_cli="$TARGET_DIR/scripts/cloudvm.sh"
    local target_cli="$LAUNCHER_DIR/cloudvm.sh"
    mkdir -p "$LAUNCHER_DIR" "$BIN_DIR"
    if [[ -f "$source_cli" ]]; then
        cp -f "$source_cli" "$target_cli"
    else
        download_file "https://raw.githubusercontent.com/$REPOSITORY/$BRANCH/scripts/cloudvm.sh" "$target_cli"
    fi
    chmod 0755 "$target_cli"
    cat > "$BIN_DIR/cloudvm" <<EOF
#!/usr/bin/env bash
exec bash $(printf '%q' "$target_cli") "\$@"
EOF
    chmod 0755 "$BIN_DIR/cloudvm"
}

install_installer_copy() {
    local target_installer="$CLOUDVM_HOME/install.sh"
    mkdir -p "$CLOUDVM_HOME"
    if [[ -n "$SOURCE" && "$SOURCE" != "/dev/stdin" && "$SOURCE" != /dev/fd/* && -f "$SOURCE" ]]; then
        cp -f "$SOURCE" "$target_installer"
    else
        download_file "https://raw.githubusercontent.com/$REPOSITORY/$BRANCH/install.sh" "$target_installer"
    fi
    grep -q 'INSTALLER_VERSION="' "$target_installer" || die "安装脚本格式不正确"
    chmod 0755 "$target_installer"
}

add_path_block() {
    local file="$1"
    mkdir -p "$(dirname "$file")"
    if grep -q '# >>> cloudvm >>>' "$file" 2>/dev/null; then
        return 0
    fi
    {
        printf '\n# >>> cloudvm >>>\n'
        printf 'case ":$PATH:" in\n'
        printf '  *":%s:"*) ;;\n' "$BIN_DIR"
        printf '  *) PATH=%q:"$PATH" ;;\n' "$BIN_DIR"
        printf 'esac\n'
        printf 'export PATH\n'
        printf '# <<< cloudvm <<<\n'
    } >> "$file"
}

configure_path() {
    add_path_block "$HOME/.profile"
    if [[ -f "$HOME/.bashrc" || "${SHELL:-}" = *bash* ]]; then
        add_path_block "$HOME/.bashrc"
    fi
    if [[ -f "$HOME/.zshrc" || "${SHELL:-}" = *zsh* ]]; then
        add_path_block "$HOME/.zshrc"
    fi
}

write_config() {
    local install_mode="archive"
    local script_version=""
    local config_dir
    if [[ -d "$TARGET_DIR/.git" ]]; then
        install_mode="git"
    fi
    if [[ -f "$LAUNCHER_DIR/cloudvm.sh" ]]; then
        script_version="$(sed -n 's/^SCRIPT_VERSION="\([^"]*\)".*/\1/p' "$LAUNCHER_DIR/cloudvm.sh" | head -n 1)"
    fi
    config_dir="$(dirname "$CONFIG_FILE")"
    mkdir -p "$config_dir"
    {
        printf 'CLOUDVM_APP_DIR=%q\n' "$TARGET_DIR"
        printf 'CLOUDVM_LAUNCHER_DIR=%q\n' "$LAUNCHER_DIR"
        printf 'CLOUDVM_NODE_PATH=%q\n' "$NODE_BIN"
        printf 'CLOUDVM_NPM_PATH=%q\n' "$NPM_BIN"
        printf 'CLOUDVM_REPOSITORY=%q\n' "$REPOSITORY"
        printf 'CLOUDVM_BRANCH=%q\n' "$BRANCH"
        printf 'CLOUDVM_INSTALL_MODE=%q\n' "$install_mode"
        printf 'CLOUDVM_INSTALLED=%q\n' "true"
        printf 'CLOUDVM_INSTALLER_VERSION=%q\n' "$INSTALLER_VERSION"
        printf 'CLOUDVM_SCRIPT_VERSION=%q\n' "$script_version"
    } > "$CONFIG_FILE"
}

if [[ -n "$INSTALL_DIR" ]]; then
    TARGET_DIR="$(resolve_target "$INSTALL_DIR")"
elif [[ "$PIPED_INSTALL" -eq 0 ]] && is_local_repo "$SCRIPT_DIR"; then
    TARGET_DIR="$(cd "$SCRIPT_DIR" && pwd -P)"
else
    TARGET_DIR="$(resolve_target "$CLOUDVM_HOME/app")"
fi

info "CloudVMController 安装程序 $INSTALLER_VERSION"
printf '安装目录：%s\n' "$TARGET_DIR"

if [[ "$PIPED_INSTALL" -eq 0 ]] && is_local_repo "$SCRIPT_DIR"; then
    if [[ "$SCRIPT_DIR" != "$TARGET_DIR" ]]; then
        info "复制本地项目文件..."
        copy_app_files "$SCRIPT_DIR" "$TARGET_DIR"
    fi
else
    if ! install_app_archive "$TARGET_DIR"; then
        if [[ -f "$TARGET_DIR/package.json" && "$FORCE" -eq 0 ]]; then
            warn "下载最新版本失败，继续使用现有安装"
        else
            die "下载 CloudVMController 失败"
        fi
    fi
fi

[[ -f "$TARGET_DIR/package.json" ]] || die "安装目录缺少 package.json：$TARGET_DIR"

resolve_node_runtime
printf 'Node.js：%s\n' "$NODE_BIN"
printf 'npm：%s\n' "$NPM_BIN"
install_dependencies
install_launcher
install_installer_copy
write_config

if [[ "$NO_PATH" -eq 0 ]]; then
    configure_path
fi

printf '\n'
success "安装完成。"
printf '安装目录：%s\n' "$TARGET_DIR"
printf '配置目录：%s\n' "$(dirname "$CONFIG_FILE")"
printf '快捷指令：%s\n' "$BIN_DIR/cloudvm"
printf '日志目录：%s\n' "$CLOUDVM_HOME/logs"
printf '\n可用命令：\n'
printf '  cloudvm                启动并打开浏览器\n'
printf '  cloudvm status         查看状态\n'
printf '  cloudvm stop           停止服务\n'
printf '  cloudvm logs           查看日志\n'
printf '  cloudvm update         更新软件\n'
printf '  cloudvm update-script  更新 cloudvm 脚本\n'

if [[ "$NO_PATH" -eq 1 ]]; then
    warn "已跳过 PATH 修改。可直接运行：$BIN_DIR/cloudvm"
else
    printf '请重新打开终端，或执行 source ~/.bashrc / source ~/.zshrc 后使用 cloudvm。\n'
fi

if [[ "$NO_LAUNCH" -eq 0 ]]; then
    printf '\n'
    CLOUDVM_CONFIG="$CONFIG_FILE" bash "$LAUNCHER_DIR/cloudvm.sh" start
fi
