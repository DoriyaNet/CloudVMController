#!/usr/bin/env bash
set -euo pipefail

SCRIPT_VERSION="1.3.0"

CLOUDVM_HOME="${CLOUDVM_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/cloudvmcontroller}"
CONFIG_FILE="${CLOUDVM_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/cloudvmcontroller/config.env}"
RUN_DIR="$CLOUDVM_HOME/run"
LOG_DIR="$CLOUDVM_HOME/logs"
PID_FILE="$RUN_DIR/cloudvm.pid"
OUT_LOG="$LOG_DIR/cloudvm.out.log"
ERR_LOG="$LOG_DIR/cloudvm.err.log"

COMMAND=""
COMMAND_SET=0
FORCE=0
NO_RESTART=0
FOLLOW=0
TAIL=40
PROXY="${CLOUDVM_PROXY:-}"
ENV_ARGS=()
TUI_INDEX=0
TUI_CANCELLED=0

CLOUDVM_APP_DIR=""
CLOUDVM_LAUNCHER_DIR="$CLOUDVM_HOME/bin"
CLOUDVM_NODE_PATH=""
CLOUDVM_NPM_PATH=""
CLOUDVM_REPOSITORY="DoriyaNet/CloudVMController"
CLOUDVM_BRANCH="main"
CLOUDVM_INSTALL_MODE=""
CLOUDVM_INSTALLED="false"

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
CloudVMController 命令行

用法：
  cloudvm [命令] [选项]
  cloudvm                 在终端中打开交互菜单
                          非交互环境等价于 cloudvm start

命令：
  menu             打开交互菜单（tui 同义）
  start            启动服务（不打开浏览器）
  stop             停止由 cloudvm 启动的服务
  restart          重启服务
  status           查看运行状态
  open             在桌面环境中打开 Web 界面
  logs             查看日志
  update           更新软件并重新安装依赖
  update-script    从 GitHub 更新 cloudvm 脚本
  env              查看或修改 .env 配置
  version          查看版本
  help             显示帮助

选项：
      --no-restart   更新后不自动重启
      --force        更新时强制覆盖本地修改
      --tail <n>     日志行数，默认 40
      --follow       持续输出日志
      --proxy <url>  GitHub 下载代理，例如 http://127.0.0.1:7890

环境变量：
  cloudvm env list
  cloudvm env get PORT
  cloudvm env set HOST=0.0.0.0 PORT=8080
  cloudvm env set GITHUB_APP_PRIVATE_KEY=@/path/to/key.pem
  cloudvm env unset PORT
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --force)
            FORCE=1
            shift
            ;;
        --no-restart)
            NO_RESTART=1
            shift
            ;;
        --no-open)
            shift
            ;;
        --follow)
            FOLLOW=1
            shift
            ;;
        --tail)
            [[ $# -ge 2 ]] || die "缺少日志行数"
            TAIL="$2"
            [[ "$TAIL" =~ ^[0-9]+$ ]] || die "日志行数必须是数字"
            shift 2
            ;;
        --proxy)
            [[ $# -ge 2 ]] || die "缺少代理地址"
            PROXY="$2"
            shift 2
            ;;
        -h|--help)
            COMMAND="help"
            COMMAND_SET=1
            shift
            ;;
        env)
            if [[ "$COMMAND_SET" -eq 1 && "$COMMAND" != "env" ]]; then
                die "只能指定一个命令"
            fi
            COMMAND="env"
            COMMAND_SET=1
            shift
            ENV_ARGS=("$@")
            break
            ;;
        start|stop|restart|status|open|logs|update|update-script|menu|tui|version|help)
            if [[ "$COMMAND_SET" -eq 1 && "$COMMAND" != "$1" ]]; then
                die "只能指定一个命令"
            fi
            COMMAND="$1"
            COMMAND_SET=1
            shift
            ;;
        *)
            die "未知参数：$1"
            ;;
    esac
done

if [[ -f "$CONFIG_FILE" ]]; then
    source "$CONFIG_FILE"
else
    if [[ -f "$PWD/package.json" ]] && grep -q '"name"[[:space:]]*:[[:space:]]*"cloudvmcontroller"' "$PWD/package.json"; then
        CLOUDVM_APP_DIR="$PWD"
        CLOUDVM_LAUNCHER_DIR="$(cd "$(dirname "$0")" && pwd -P)"
        CLOUDVM_NODE_PATH="$(command -v node 2>/dev/null || true)"
        CLOUDVM_NPM_PATH="$(command -v npm 2>/dev/null || true)"
        CLOUDVM_INSTALLED="false"
        if [[ -d "$PWD/.git" ]]; then
            CLOUDVM_INSTALL_MODE="git"
        else
            CLOUDVM_INSTALL_MODE="archive"
        fi
    else
        die "未找到 CloudVMController 安装配置。请先运行 install.sh。"
    fi
fi

[[ -n "$CLOUDVM_APP_DIR" ]] || die "配置缺少 CLOUDVM_APP_DIR"
[[ -f "$CLOUDVM_APP_DIR/package.json" ]] || die "安装目录无效：$CLOUDVM_APP_DIR"
APP_ENV_FILE="$CLOUDVM_APP_DIR/.env"

if [[ -z "$CLOUDVM_INSTALL_MODE" ]]; then
    if [[ -d "$CLOUDVM_APP_DIR/.git" ]]; then
        CLOUDVM_INSTALL_MODE="git"
    else
        CLOUDVM_INSTALL_MODE="archive"
    fi
fi

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/cloudvm-cli.XXXXXX")"
cleanup() {
    if [[ -t 1 ]]; then
        printf '\033[?25h' 2>/dev/null || true
    fi
    if [[ -n "${TEMP_ROOT:-}" && -d "$TEMP_ROOT" ]]; then
        rm -rf "$TEMP_ROOT"
    fi
}
trap cleanup EXIT

new_temp() {
    mktemp -d "$TEMP_ROOT/work.XXXXXX"
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

app_version() {
    sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$CLOUDVM_APP_DIR/package.json" | head -n 1
}

env_value() {
    local key="$1"
    local file="$2"
    [[ -f "$file" ]] || return 0
    ENV_KEY="$key" awk '
        BEGIN {
            key = ENVIRON["ENV_KEY"]
            found = 0
            collecting = 0
            quote = ""
            value = ""
        }
        !collecting {
            if ($0 ~ "^[[:space:]]*" key "[[:space:]]*=") {
                found = 1
                line = $0
                sub(/\r$/, "", line)
                sub(/^[^=]*=[[:space:]]*/, "", line)
                sub(/[[:space:]]+$/, "", line)
                q = substr(line, 1, 1)
                if ((q == "\"" || q == sprintf("%c", 39)) && !(length(line) > 1 && substr(line, length(line), 1) == q)) {
                    collecting = 1
                    quote = q
                    value = substr(line, 2)
                } else {
                    value = line
                    exit
                }
            }
            next
        }
        collecting {
            line = $0
            sub(/\r$/, "", line)
            if (substr(line, length(line), 1) == quote) {
                value = value "\n" substr(line, 1, length(line) - 1)
                collecting = 0
                exit
            }
            value = value "\n" line
        }
        END {
            if (!found) {
                exit 0
            }
            if (length(value) >= 2) {
                q = substr(value, 1, 1)
                if ((q == "\"" || q == sprintf("%c", 39)) && substr(value, length(value), 1) == q) {
                    value = substr(value, 2, length(value) - 2)
                }
            }
            printf "%s", value
        }
    ' "$file"
}

validate_env_key() {
    local key="$1"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "无效的环境变量名：$key"
}

resolve_env_input() {
    local value="$1"
    if [[ "$value" == @* ]]; then
        local path="${value#@}"
        if [[ -f "$path" ]]; then
            local content
            content="$(cat "$path")"
            content="${content//$'\r'/}"
            content="${content//$'\n'/\\n}"
            printf '%s' "$content"
            return 0
        fi
    fi
    printf '%s' "$value"
}

ensure_app_env_file() {
    [[ -s "$APP_ENV_FILE" ]] && return 0
    mkdir -p "$CLOUDVM_APP_DIR"
    if [[ -f "$CLOUDVM_APP_DIR/.env.example" ]]; then
        cp -f "$CLOUDVM_APP_DIR/.env.example" "$APP_ENV_FILE"
    else
        printf 'HOST=127.0.0.1\nPORT=4173\n' > "$APP_ENV_FILE"
    fi
    chmod 0600 "$APP_ENV_FILE" 2>/dev/null || true
    info "已创建环境文件：$APP_ENV_FILE"
}

set_env_value() {
    local key="$1"
    local value="$2"
    local temporary
    touch "$APP_ENV_FILE"
    temporary="$(mktemp "$APP_ENV_FILE.tmp.XXXXXX")"
    if ! ENV_KEY="$key" ENV_LINE="$key=$value" awk '
        BEGIN {
            key = ENVIRON["ENV_KEY"]
            line = ENVIRON["ENV_LINE"]
            written = 0
            skipping = 0
            quote = ""
        }
        skipping {
            end = $0
            sub(/\r$/, "", end)
            if (substr(end, length(end), 1) == quote) {
                skipping = 0
            }
            next
        }
        $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
            if (!written) {
                print line
                written = 1
            }
            value = $0
            sub(/\r$/, "", value)
            sub(/^[^=]*=[[:space:]]*/, "", value)
            sub(/[[:space:]]+$/, "", value)
            q = substr(value, 1, 1)
            if ((q == "\"" || q == sprintf("%c", 39)) && !(length(value) > 1 && substr(value, length(value), 1) == q)) {
                skipping = 1
                quote = q
            }
            next
        }
        { print }
        END {
            if (!written) {
                print line
            }
        }
    ' "$APP_ENV_FILE" > "$temporary"; then
        rm -f "$temporary"
        die "写入 .env 失败：$APP_ENV_FILE"
    fi
    mv -f "$temporary" "$APP_ENV_FILE"
    chmod 0600 "$APP_ENV_FILE" 2>/dev/null || true
}

unset_env_value() {
    local key="$1"
    local count
    local temporary
    if [[ ! -f "$APP_ENV_FILE" ]]; then
        info "$key 未设置。"
        return 0
    fi
    count="$(grep -cE "^[[:space:]]*$key[[:space:]]*=" "$APP_ENV_FILE" || true)"
    if [[ "$count" -eq 0 ]]; then
        info "$key 未设置。"
        return 0
    fi
    temporary="$(mktemp "$APP_ENV_FILE.tmp.XXXXXX")"
    if ! ENV_KEY="$key" awk '
        BEGIN {
            key = ENVIRON["ENV_KEY"]
            skipping = 0
            quote = ""
        }
        skipping {
            end = $0
            sub(/\r$/, "", end)
            if (substr(end, length(end), 1) == quote) {
                skipping = 0
            }
            next
        }
        $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
            value = $0
            sub(/\r$/, "", value)
            sub(/^[^=]*=[[:space:]]*/, "", value)
            sub(/[[:space:]]+$/, "", value)
            q = substr(value, 1, 1)
            if ((q == "\"" || q == sprintf("%c", 39)) && !(length(value) > 1 && substr(value, length(value), 1) == q)) {
                skipping = 1
                quote = q
            }
            next
        }
        { print }
    ' "$APP_ENV_FILE" > "$temporary"; then
        rm -f "$temporary"
        die "写入 .env 失败：$APP_ENV_FILE"
    fi
    mv -f "$temporary" "$APP_ENV_FILE"
    chmod 0600 "$APP_ENV_FILE" 2>/dev/null || true
    success "$key 已删除。"
}

list_env() {
    [[ -f "$APP_ENV_FILE" ]] || die "未找到 .env：$APP_ENV_FILE"
    awk '
        BEGIN {
            skipping = 0
            quote = ""
        }
        skipping {
            end = $0
            sub(/\r$/, "", end)
            if (substr(end, length(end), 1) == quote) {
                skipping = 0
            }
            next
        }
        /^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/ {
            line = $0
            key = line
            sub(/[[:space:]]*=.*/, "", key)
            sub(/^[[:space:]]+/, "", key)
            upper = toupper(key)
            if (upper ~ /(SECRET|TOKEN|PASSWORD|PRIVATE_KEY|PROXY)/) {
                printf "%s=***\n", key
            } else {
                print line
            }
            value = $0
            sub(/\r$/, "", value)
            sub(/^[^=]*=[[:space:]]*/, "", value)
            sub(/[[:space:]]+$/, "", value)
            q = substr(value, 1, 1)
            if ((q == "\"" || q == sprintf("%c", 39)) && !(length(value) > 1 && substr(value, length(value), 1) == q)) {
                skipping = 1
                quote = q
            }
        }
    ' "$APP_ENV_FILE"
}

get_env() {
    local key="$1"
    validate_env_key "$key"
    if [[ ! -f "$APP_ENV_FILE" ]] || ! grep -qE "^[[:space:]]*$key[[:space:]]*=" "$APP_ENV_FILE"; then
        die "$key 未设置。"
    fi
    printf '%s\n' "$(env_value "$key" "$APP_ENV_FILE")"
}

set_env() {
    local assignments=()
    local entry
    local key
    local value
    while [[ $# -gt 0 ]]; do
        case "$1" in
            *=*)
                assignments+=("$1")
                shift
                ;;
            -*)
                die "未知 env 选项：$1"
                ;;
            *)
                [[ $# -ge 2 ]] || die "用法：cloudvm env set KEY=VALUE ..."
                assignments+=("$1=$2")
                shift 2
                ;;
        esac
    done
    [[ ${#assignments[@]} -gt 0 ]] || die "用法：cloudvm env set KEY=VALUE ..."
    for entry in "${assignments[@]}"; do
        key="${entry%%=*}"
        value="${entry#*=}"
        validate_env_key "$key"
        value="$(resolve_env_input "$value")"
        if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
            die "$key 的值包含换行。可先将内容保存到文件，再使用 $key=@/path/to/file。"
        fi
        set_env_value "$key" "$value"
        success "$key 已更新。"
    done
    printf '配置文件：%s\n' "$APP_ENV_FILE"
    if running_pid >/dev/null 2>&1; then
        info "服务正在运行，重启后生效：cloudvm restart"
    fi
}

show_env_help() {
    cat <<'EOF'
管理 .env 配置

用法：
  cloudvm env list
  cloudvm env get <KEY>
  cloudvm env set <KEY=VALUE> [KEY=VALUE ...]
  cloudvm env set <KEY> <VALUE>
  cloudvm env set <KEY>=@<FILE>
  cloudvm env unset <KEY> [KEY ...]

说明：
  - 修改后需要执行 cloudvm restart 才会生效。
  - list 会隐藏 SECRET、TOKEN、PASSWORD、PRIVATE_KEY、PROXY 的值。
  - 多行内容（例如 PEM）可保存为文件后用 KEY=@/path/to/file 写入。
EOF
}

env_command() {
    local action="${1:-list}"
    local key
    [[ $# -gt 0 ]] && shift
    ensure_app_env_file
    case "$action" in
        list|ls)
            list_env
            ;;
        get)
            [[ $# -eq 1 ]] || die "用法：cloudvm env get <KEY>"
            get_env "$1"
            ;;
        set)
            set_env "$@"
            ;;
        unset|remove|rm)
            [[ $# -ge 1 ]] || die "用法：cloudvm env unset <KEY> [KEY ...]"
            for key in "$@"; do
                validate_env_key "$key"
                unset_env_value "$key"
            done
            if running_pid >/dev/null 2>&1; then
                info "服务正在运行，重启后生效：cloudvm restart"
            fi
            ;;
        help|-h|--help)
            show_env_help
            ;;
        *)
            die "未知 env 命令：$action"
            ;;
    esac
}

app_port() {
    if [[ -n "${PORT:-}" ]]; then
        printf '%s' "$PORT"
        return 0
    fi
    local value
    value="$(env_value PORT "$CLOUDVM_APP_DIR/.env")"
    if [[ -n "$value" ]]; then
        printf '%s' "$value"
    else
        printf '4173'
    fi
}

app_host() {
    if [[ -n "${HOST:-}" ]]; then
        printf '%s' "$HOST"
        return 0
    fi
    local value
    value="$(env_value HOST "$CLOUDVM_APP_DIR/.env")"
    if [[ -n "$value" ]]; then
        printf '%s' "$value"
    else
        printf '127.0.0.1'
    fi
}

app_url() {
    local host
    host="$(app_host)"
    if [[ "$host" = "0.0.0.0" ]]; then
        host="127.0.0.1"
    fi
    printf 'http://%s:%s' "$host" "$(app_port)"
}

health_check() {
    local url
    url="$(app_url)/api/health"
    if command -v curl >/dev/null 2>&1; then
        curl -fsS --max-time 2 "$url" >/dev/null 2>&1
        return $?
    fi
    if command -v wget >/dev/null 2>&1; then
        wget -q -O /dev/null --timeout=2 "$url" >/dev/null 2>&1
        return $?
    fi
    return 1
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
    local runtime_dir="$CLOUDVM_HOME/runtime"
    if [[ ! -d "$runtime_dir" ]]; then
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
    done < <(find "$runtime_dir" -type f -path '*/bin/node' 2>/dev/null)
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

NODE_BIN=""
NPM_BIN=""

resolve_node() {
    if [[ -n "$CLOUDVM_NODE_PATH" && -x "$CLOUDVM_NODE_PATH" ]]; then
        NODE_BIN="$CLOUDVM_NODE_PATH"
    else
        NODE_BIN="$(find_local_node || find_system_node || true)"
    fi
    [[ -n "$NODE_BIN" ]] || die "未找到 Node.js 20+。请重新运行 install.sh。"
    local value
    value="$(node_version "$NODE_BIN")"
    [[ -n "$value" ]] && version_ge "$value" "20.0.0" || die "Node.js 版本低于 20：$NODE_BIN"
    if [[ -n "$CLOUDVM_NPM_PATH" && -x "$CLOUDVM_NPM_PATH" ]]; then
        NPM_BIN="$CLOUDVM_NPM_PATH"
    else
        NPM_BIN="$(find_npm_for_node "$NODE_BIN" || true)"
    fi
    [[ -n "$NPM_BIN" ]] || die "找不到 npm。请重新运行 install.sh。"
}

run_npm() {
    if [[ "$NPM_BIN" = *.js && -f "$NPM_BIN" ]]; then
        "$NODE_BIN" "$NPM_BIN" "$@"
        return $?
    fi
    PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" "$@"
}

install_dependencies() {
    resolve_node
    info "安装项目依赖..."
    if ! (cd "$CLOUDVM_APP_DIR" && run_npm ci --no-audit --no-fund); then
        (cd "$CLOUDVM_APP_DIR" && run_npm install --no-audit --no-fund)
    fi
}

read_pid() {
    if [[ -f "$PID_FILE" ]]; then
        cat "$PID_FILE"
    fi
}

pid_is_app() {
    local pid="$1"
    if [[ ! -r "/proc/$pid/cmdline" ]]; then
        return 1
    fi
    if ! tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q 'server/index.js'; then
        return 1
    fi
    local cwd
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    [[ "$cwd" = "$(readlink -f "$CLOUDVM_APP_DIR")" ]]
}

running_pid() {
    local pid
    pid="$(read_pid || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && pid_is_app "$pid"; then
        printf '%s' "$pid"
        return 0
    fi
    rm -f "$PID_FILE"
    return 1
}

open_app() {
    local url
    url="$(app_url)"
    if [[ -n "${WSL_INTEROP:-}" || -n "${WSL_DISTRO_NAME:-}" ]] && command -v wslview >/dev/null 2>&1; then
        wslview "$url" >/dev/null 2>&1 &
        return 0
    fi
    if [[ -n "${DISPLAY:-}" || -n "${WAYLAND_DISPLAY:-}" ]]; then
        if command -v xdg-open >/dev/null 2>&1; then
            xdg-open "$url" >/dev/null 2>&1 &
            return 0
        fi
        if command -v gio >/dev/null 2>&1; then
            gio open "$url" >/dev/null 2>&1 &
            return 0
        fi
        if command -v sensible-browser >/dev/null 2>&1; then
            sensible-browser "$url" >/dev/null 2>&1 &
            return 0
        fi
    fi
    printf '请在浏览器打开：%s\n' "$url"
}

start_app() {
    local url
    ensure_app_env_file
    url="$(app_url)"
    if health_check; then
        success "CloudVMController 已在运行：$url"
        return 0
    fi

    if [[ ! -d "$CLOUDVM_APP_DIR/node_modules" ]]; then
        install_dependencies
    fi

    resolve_node
    mkdir -p "$RUN_DIR" "$LOG_DIR"
    info "启动 CloudVMController..."
    (
        cd "$CLOUDVM_APP_DIR"
        if command -v setsid >/dev/null 2>&1; then
            setsid "$NODE_BIN" server/index.js >>"$OUT_LOG" 2>>"$ERR_LOG" &
        else
            nohup "$NODE_BIN" server/index.js >>"$OUT_LOG" 2>>"$ERR_LOG" &
        fi
        printf '%s' "$!" > "$PID_FILE"
    )

    local deadline=$((SECONDS + 30))
    local pid
    while [[ "$SECONDS" -lt "$deadline" ]]; do
        sleep 0.5
        pid="$(read_pid || true)"
        if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
            break
        fi
        if health_check; then
            success "CloudVMController 已启动：$url"
            printf '日志：%s\n' "$LOG_DIR"
            return 0
        fi
    done

    pid="$(read_pid || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        kill -TERM "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
    if [[ -f "$ERR_LOG" ]]; then
        warn "启动失败，错误日志："
        tail -n 30 "$ERR_LOG" || true
    fi
    die "CloudVMController 启动失败或超时"
}

stop_app() {
    local pid
    pid="$(running_pid || true)"
    if [[ -n "$pid" ]]; then
        info "停止 CloudVMController（PID $pid）..."
        kill -TERM "$pid" 2>/dev/null || true
        local deadline=$((SECONDS + 8))
        while [[ "$SECONDS" -lt "$deadline" ]]; do
            if ! kill -0 "$pid" 2>/dev/null; then
                break
            fi
            sleep 0.3
        done
        if kill -0 "$pid" 2>/dev/null; then
            kill -KILL "$pid" 2>/dev/null || true
        fi
        rm -f "$PID_FILE"
        success "服务已停止。"
        return 0
    fi
    rm -f "$PID_FILE"
    if health_check; then
        warn "检测到服务仍在运行，但它不是由 cloudvm 启动的，请手动停止。"
    else
        info "服务当前未运行。"
    fi
}

show_status() {
    local pid
    pid="$(running_pid || true)"
    printf 'CloudVMController %s\n' "$(app_version)"
    printf 'CLI              %s\n' "$SCRIPT_VERSION"
    printf '安装目录         %s\n' "$CLOUDVM_APP_DIR"
    printf '日志目录         %s\n' "$LOG_DIR"
    printf '地址             %s\n' "$(app_url)"
    if health_check; then
        if [[ -n "$pid" ]]; then
            success "状态             运行中（PID $pid）"
        else
            success "状态             运行中（非 cloudvm 启动）"
        fi
    else
        warn "状态             已停止"
    fi
}

show_logs() {
    local files=()
    if [[ -f "$OUT_LOG" ]]; then
        files+=("$OUT_LOG")
    fi
    if [[ -f "$ERR_LOG" ]]; then
        files+=("$ERR_LOG")
    fi
    if [[ ${#files[@]} -eq 0 ]]; then
        die "暂无日志。先运行 cloudvm start。"
    fi
    if [[ "$FOLLOW" -eq 1 ]]; then
        tail -n "$TAIL" -F "${files[@]}"
    else
        tail -n "$TAIL" "${files[@]}"
    fi
}

copy_app_files() {
    local source="$1"
    local target="$2"
    local directory
    local file
    mkdir -p "$target"
    for directory in public server tests scripts docs; do
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

update_from_archive() {
    local temp_root
    local archive
    local extract_dir
    local source_root
    local url
    temp_root="$(new_temp)"
    archive="$temp_root/source.tar.gz"
    extract_dir="$temp_root/extract"
    url="https://github.com/$CLOUDVM_REPOSITORY/archive/refs/heads/$CLOUDVM_BRANCH.tar.gz"
    info "下载最新版本：$url"
    download_file "$url" "$archive"
    mkdir -p "$extract_dir"
    tar -xzf "$archive" -C "$extract_dir"
    source_root="$(find "$extract_dir" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
    [[ -n "$source_root" ]] || die "无法识别下载的压缩包结构"
    copy_app_files "$source_root" "$CLOUDVM_APP_DIR"
}

update_from_git() {
    local git_bin
    local git_config=()
    local status
    git_bin="$(command -v git 2>/dev/null || true)"
    [[ -n "$git_bin" ]] || die "未找到 git，无法从 Git 仓库更新"
    if [[ -n "$PROXY" ]]; then
        git_config=(-c "http.proxy=$PROXY" -c "https.proxy=$PROXY")
    fi
    status="$("$git_bin" -C "$CLOUDVM_APP_DIR" status --porcelain)"
    if [[ -n "$status" && "$FORCE" -eq 0 ]]; then
        die "安装目录存在未提交的修改。请先提交、暂存或使用 cloudvm update --force。"
    fi
    info "从 Git 更新 $CLOUDVM_BRANCH..."
    "$git_bin" "${git_config[@]}" -C "$CLOUDVM_APP_DIR" fetch origin "$CLOUDVM_BRANCH"
    if [[ "$FORCE" -eq 1 ]]; then
        "$git_bin" "${git_config[@]}" -C "$CLOUDVM_APP_DIR" reset --hard "origin/$CLOUDVM_BRANCH"
    else
        "$git_bin" "${git_config[@]}" -C "$CLOUDVM_APP_DIR" pull --ff-only origin "$CLOUDVM_BRANCH"
    fi
}

sync_launcher_script() {
    local source
    local target
    local temporary
    if [[ "$CLOUDVM_INSTALLED" != "true" ]]; then
        return 0
    fi
    source="$CLOUDVM_APP_DIR/scripts/cloudvm.sh"
    target="$CLOUDVM_LAUNCHER_DIR/cloudvm.sh"
    if [[ -f "$source" && -d "$CLOUDVM_LAUNCHER_DIR" ]]; then
        temporary="$target.new.$$"
        cp -f "$source" "$temporary"
        chmod 0755 "$temporary"
        mv -f "$temporary" "$target"
    fi
}

update_app() {
    local old_version
    local new_version
    local was_running=0
    if [[ "$CLOUDVM_INSTALLED" != "true" ]]; then
        die "当前脚本不是通过 install.sh 安装的，update 不可用。请先运行 install.sh。"
    fi
    old_version="$(app_version)"
    if health_check; then
        was_running=1
        if [[ -z "$(running_pid || true)" ]]; then
            die "服务正在运行，但不是由 cloudvm 启动。请先停止该进程，再执行 cloudvm update。"
        fi
        stop_app
    fi

    if [[ "$CLOUDVM_INSTALL_MODE" = "git" ]] && command -v git >/dev/null 2>&1; then
        update_from_git
    else
        if [[ "$CLOUDVM_INSTALL_MODE" = "git" ]]; then
            warn "未找到 git，改用 GitHub 压缩包更新。"
        fi
        update_from_archive
    fi

    install_dependencies
    sync_launcher_script
    new_version="$(app_version)"
    success "软件已更新：$old_version -> $new_version"
    if [[ "$was_running" -eq 1 && "$NO_RESTART" -eq 0 ]]; then
        start_app
    elif [[ "$was_running" -eq 1 ]]; then
        info "更新前服务正在运行，已停止；可执行 cloudvm start 重新启动。"
    fi
}

update_script() {
    if [[ "$CLOUDVM_INSTALLED" != "true" ]]; then
        die "当前脚本不是通过 install.sh 安装的，update-script 不可用。请先运行 install.sh。"
    fi
    local temp_root
    local new_cli
    local new_installer
    local new_version
    temp_root="$(new_temp)"
    new_cli="$temp_root/cloudvm.sh"
    new_installer="$temp_root/install.sh"
    info "更新 cloudvm 脚本..."
    download_file "https://raw.githubusercontent.com/$CLOUDVM_REPOSITORY/$CLOUDVM_BRANCH/scripts/cloudvm.sh" "$new_cli"
    download_file "https://raw.githubusercontent.com/$CLOUDVM_REPOSITORY/$CLOUDVM_BRANCH/install.sh" "$new_installer"
    grep -q 'SCRIPT_VERSION="' "$new_cli" || die "下载的 cloudvm 脚本格式不正确"
    grep -q 'INSTALLER_VERSION="' "$new_installer" || die "下载的安装脚本格式不正确"
    chmod 0755 "$new_cli" "$new_installer"
    mv -f "$new_cli" "$CLOUDVM_LAUNCHER_DIR/cloudvm.sh"
    mv -f "$new_installer" "$CLOUDVM_HOME/install.sh"
    new_version="$(sed -n 's/^SCRIPT_VERSION="\([^"]*\)".*/\1/p' "$CLOUDVM_LAUNCHER_DIR/cloudvm.sh" | head -n 1)"
    success "脚本已更新：$new_version"
    printf '重新打开终端或再次运行 cloudvm 即可使用新版本。\n'
}

show_version() {
    printf 'CloudVMController %s\n' "$(app_version)"
    printf 'cloudvm CLI %s\n' "$SCRIPT_VERSION"
    printf '安装目录：%s\n' "$CLOUDVM_APP_DIR"
}

menu_clear() {
    if [[ -t 1 ]]; then
        printf '\033[H\033[2J'
    fi
}

is_sensitive_env_key() {
    case "$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')" in
        *SECRET*|*TOKEN*|*PASSWORD*|*PRIVATE_KEY*|*PROXY*)
            return 0
            ;;
    esac
    return 1
}

menu_header() {
    local pid
    local state
    local state_color
    pid="$(running_pid || true)"
    if [[ -n "$pid" ]]; then
        state="运行中（PID $pid）"
        state_color="32"
    elif health_check; then
        state="运行中（非 cloudvm 启动）"
        state_color="32"
    else
        state="已停止"
        state_color="31"
    fi
    printf '\033[1;36m CloudVMController 控制台 \033[0m\n'
    printf ' 版本    %s\n' "$(app_version)"
    printf ' CLI     %s\n' "$SCRIPT_VERSION"
    printf ' 地址    %s\n' "$(app_url)"
    printf ' 状态    \033[%sm%s\033[0m\n' "$state_color" "$state"
    printf ' 安装    %s\n' "$CLOUDVM_APP_DIR"
    printf ' 配置    %s\n' "$APP_ENV_FILE"
}

menu_pause() {
    local message="${1:-按回车返回主菜单...}"
    printf '\n'
    read -rp "$message" _ || true
}

tui_show_cursor() {
    if [[ -t 1 ]]; then
        printf '\033[?25h'
    fi
}

tui_hide_cursor() {
    if [[ -t 1 ]]; then
        printf '\033[?25l'
    fi
}

tui_menu() {
    local header="$1"
    local footer="$2"
    shift 2
    local -a items=("$@")
    local selected=0
    local key
    local rest
    local index
    TUI_INDEX=0
    TUI_CANCELLED=0
    if [[ ${#items[@]} -eq 0 ]]; then
        return 1
    fi
    tui_hide_cursor
    while true; do
        menu_clear
        printf '%s\n\n' "$header"
        for index in "${!items[@]}"; do
            if [[ "$index" -eq "$selected" ]]; then
                printf '\033[7m > %d) %s \033[0m\n' "$((index + 1))" "${items[$index]}"
            else
                printf '   %d) %s\n' "$((index + 1))" "${items[$index]}"
            fi
        done
        printf '\n\033[90m%s\033[0m\n' "$footer"
        if ! IFS= read -rsn1 key; then
            TUI_CANCELLED=1
            tui_show_cursor
            return 1
        fi
        case "$key" in
            $'\x1b')
                if IFS= read -rsn2 -t 0.1 rest; then
                    case "$rest" in
                        '[A'|'OA')
                            if (( selected > 0 )); then
                                selected=$((selected - 1))
                            fi
                            ;;
                        '[B'|'OB')
                            if (( selected + 1 < ${#items[@]} )); then
                                selected=$((selected + 1))
                            fi
                            ;;
                    esac
                else
                    TUI_CANCELLED=1
                    tui_show_cursor
                    return 1
                fi
                ;;
            k|K)
                if (( selected > 0 )); then
                    selected=$((selected - 1))
                fi
                ;;
            j|J)
                if (( selected + 1 < ${#items[@]} )); then
                    selected=$((selected + 1))
                fi
                ;;
            ''|$'\n'|$'\r')
                TUI_INDEX=$selected
                tui_show_cursor
                return 0
                ;;
            q|Q)
                TUI_CANCELLED=1
                tui_show_cursor
                return 1
                ;;
            [1-9])
                index=$((key - 1))
                if (( index >= 0 && index < ${#items[@]} )); then
                    TUI_INDEX=$index
                    tui_show_cursor
                    return 0
                fi
                ;;
        esac
    done
}

run_menu_action() {
    menu_clear
    ( "$@" ) || true
    menu_pause
}

menu_restart_app() {
    stop_app
    start_app
}

menu_show_logs() {
    FOLLOW=0
    show_logs
}

menu_open_app() {
    health_check || die "服务未运行。先执行 cloudvm start。"
    open_app
}

run_env_action() {
    menu_clear
    ( "$@" ) || true
    printf '\n'
    read -rp "按回车返回环境变量菜单..." _ || true
}

format_menu_value() {
    local value="$1"
    local max="${2:-40}"
    value="${value//$'\n'/ }"
    if (( ${#value} > max )); then
        printf '%s...' "${value:0:max-3}"
    else
        printf '%s' "$value"
    fi
}

env_label() {
    case "$1" in
        HOST) printf '监听地址 HOST' ;;
        PORT) printf '端口 PORT' ;;
        CLOUDVM_AUTH_MODE) printf '认证模式' ;;
        GITHUB_APP_ID) printf 'GitHub App ID' ;;
        GITHUB_APP_CLIENT_ID) printf 'GitHub Client ID' ;;
        GITHUB_APP_CLIENT_SECRET) printf 'GitHub Client Secret' ;;
        GITHUB_APP_PRIVATE_KEY) printf 'GitHub App 私钥' ;;
        GITHUB_APP_SLUG) printf 'GitHub App Slug' ;;
        SESSION_SECRET) printf '会话密钥 SESSION_SECRET' ;;
        APP_ORIGIN) printf '外部访问地址 APP_ORIGIN' ;;
        CLOUDVM_ALLOWED_GITHUB_USERS) printf 'GitHub 用户白名单' ;;
        CLOUDVM_ALLOWED_GITHUB_IDS) printf 'GitHub 用户 ID 白名单' ;;
        CLOUDVM_ALLOW_ANY_GITHUB_USER) printf '允许任意 GitHub 用户（谨慎）' ;;
        CLOUDVM_TRUST_PROXY) printf '信任反向代理' ;;
        CLOUDVM_SECURE_COOKIES) printf '强制 Secure Cookie' ;;
        CLOUDVM_ALLOW_INSECURE_REMOTE) printf '允许本地模式远程监听（谨慎）' ;;
        LINODE_API_TOKEN) printf 'Linode API Token' ;;
        CLOUDVM_DATA_DIR) printf '数据目录 CLOUDVM_DATA_DIR' ;;
        LINODE_API_BASE) printf 'Linode API 地址' ;;
        *) printf '%s' "$1" ;;
    esac
}

env_display_value() {
    local key="$1"
    local value
    value="$(env_value "$key" "$APP_ENV_FILE")"
    if is_sensitive_env_key "$key"; then
        if [[ -n "$value" ]]; then
            printf '(已设置)'
        else
            printf '(未设置)'
        fi
        return 0
    fi
    case "$key" in
        CLOUDVM_AUTH_MODE)
            if [[ -z "$value" ]]; then printf '自动'; else printf '%s' "$value"; fi
            ;;
        CLOUDVM_ALLOW_ANY_GITHUB_USER|CLOUDVM_TRUST_PROXY|CLOUDVM_SECURE_COOKIES|CLOUDVM_ALLOW_INSECURE_REMOTE)
            if [[ "$value" = "1" ]]; then printf '启用'; else printf '禁用'; fi
            ;;
        *)
            if [[ -n "$value" ]]; then
                format_menu_value "$value" 40
            else
                printf '(未设置)'
            fi
            ;;
    esac
}

generate_session_secret() {
    local value=""
    if command -v openssl >/dev/null 2>&1; then
        value="$(openssl rand -base64 48 2>/dev/null | tr -d '\r\n' || true)"
        if [[ -n "$value" ]]; then
            printf '%s' "$value"
            return 0
        fi
    fi
    if command -v base64 >/dev/null 2>&1; then
        value="$(head -c 48 /dev/urandom 2>/dev/null | base64 | tr -d '\r\n' || true)"
        if [[ -n "$value" ]]; then
            printf '%s' "$value"
            return 0
        fi
    fi
    return 1
}

apply_env_edit_value() {
    local key="$1"
    local value="$2"
    printf '\n'
    if [[ -z "$value" ]]; then
        ( unset_env_value "$key" ) || true
    else
        ( set_env "$key=$value" ) || true
    fi
    menu_pause "按回车返回环境变量列表..."
}

env_edit_text() {
    local key="$1"
    local value
    printf '\n%s\n当前值：%s\n' "$(env_label "$key")" "$(env_display_value "$key")"
    if is_sensitive_env_key "$key"; then
        if ! IFS= read -rsp "新值（留空清除，@文件读取内容）: " value; then
            printf '\n'
            return 0
        fi
    else
        if ! IFS= read -rp "新值（留空清除，@文件读取内容）: " value; then
            return 0
        fi
    fi
    printf '\n'
    apply_env_edit_value "$key" "$value"
}

env_edit_boolean() {
    local key="$1"
    local header
    header="$(printf '%s\n\n当前值：%s' "$(env_label "$key")" "$(env_display_value "$key")")"
    case "$key" in
        CLOUDVM_ALLOW_ANY_GITHUB_USER)
            header+=$'\n\n警告：启用后任何 GitHub 用户都可访问，请确保已配置 HTTPS 和反向代理。'
            ;;
        CLOUDVM_ALLOW_INSECURE_REMOTE)
            header+=$'\n\n警告：仅应在反向代理已强制 HTTPS 和身份认证时启用。'
            ;;
    esac
    if ! tui_menu "$header" "↑/↓ 选择  Enter 确认  q 取消" "启用 (1)" "禁用 / 清除" "取消"; then
        return 0
    fi
    case "$TUI_INDEX" in
        0) apply_env_edit_value "$key" "1" ;;
        1) apply_env_edit_value "$key" "" ;;
    esac
}

env_edit_host() {
    local header
    local value
    header="$(printf '监听地址 HOST\n\n当前值：%s\n\n0.0.0.0 会监听所有网卡；本地模式还需要鉴权或显式允许不安全远程访问。' "$(env_display_value HOST)")"
    if ! tui_menu "$header" "↑/↓ 选择  Enter 确认  q 取消" \
        "127.0.0.1（仅本机，推荐）" \
        "0.0.0.0（监听所有网卡）" \
        "自定义..." \
        "清除（默认 127.0.0.1）" \
        "取消"; then
        return 0
    fi
    case "$TUI_INDEX" in
        0) apply_env_edit_value HOST "127.0.0.1" ;;
        1) apply_env_edit_value HOST "0.0.0.0" ;;
        2)
            if ! IFS= read -rp "监听地址: " value; then
                return 0
            fi
            if [[ -n "$value" ]]; then
                apply_env_edit_value HOST "$value"
            fi
            ;;
        3) apply_env_edit_value HOST "" ;;
    esac
}

env_edit_port() {
    local value
    printf '\n端口 PORT\n当前值：%s\n' "$(env_display_value PORT)"
    if ! IFS= read -rp "新端口（1-65535，留空清除）: " value; then
        return 0
    fi
    if [[ -n "$value" ]]; then
        if ! [[ "$value" =~ ^[0-9]{1,5}$ ]] || (( 10#$value < 1 || 10#$value > 65535 )); then
            warn "端口必须是 1-65535 之间的数字。"
            menu_pause "按回车返回环境变量列表..."
            return 0
        fi
    fi
    apply_env_edit_value PORT "$value"
}

env_edit_auth_mode() {
    local header
    header="$(printf '认证模式\n\n当前值：%s\n\n自动：填写完整 GitHub App 配置时使用 github，否则使用 local。' "$(env_display_value CLOUDVM_AUTH_MODE)")"
    if ! tui_menu "$header" "↑/↓ 选择  Enter 确认  q 取消" \
        "自动（留空）" \
        "github（GitHub App + 私有仓库保险库）" \
        "local（本机加密设置）" \
        "取消"; then
        return 0
    fi
    case "$TUI_INDEX" in
        0) apply_env_edit_value CLOUDVM_AUTH_MODE "" ;;
        1) apply_env_edit_value CLOUDVM_AUTH_MODE "github" ;;
        2) apply_env_edit_value CLOUDVM_AUTH_MODE "local" ;;
    esac
}

env_edit_session_secret() {
    local header
    local value
    header="$(printf '会话密钥 SESSION_SECRET\n\n当前值：%s\n\n至少 32 字节，用于加密 OAuth / 会话 Cookie。' "$(env_display_value SESSION_SECRET)")"
    if ! tui_menu "$header" "↑/↓ 选择  Enter 确认  q 取消" \
        "自动生成（推荐）" \
        "手动输入" \
        "清除" \
        "取消"; then
        return 0
    fi
    case "$TUI_INDEX" in
        0)
            if ! value="$(generate_session_secret)"; then
                warn "无法生成随机密钥，请安装 openssl 或 base64。"
                menu_pause "按回车返回环境变量列表..."
                return 0
            fi
            apply_env_edit_value SESSION_SECRET "$value"
            ;;
        1) env_edit_text SESSION_SECRET ;;
        2) apply_env_edit_value SESSION_SECRET "" ;;
    esac
}

env_edit_private_key() {
    local header
    local path
    local value
    header="$(printf 'GitHub App 私钥\n\n当前值：%s\n\n推荐从 PEM 文件读取，脚本会保存为单行 \\n 转义格式。' "$(env_display_value GITHUB_APP_PRIVATE_KEY)")"
    if ! tui_menu "$header" "↑/↓ 选择  Enter 确认  q 取消" \
        "从文件读取" \
        "手动输入单行内容" \
        "清除" \
        "取消"; then
        return 0
    fi
    case "$TUI_INDEX" in
        0)
            if ! IFS= read -rp "私钥文件路径: " path; then
                return 0
            fi
            if [[ -z "$path" || ! -f "$path" ]]; then
                warn "文件不存在：$path"
                menu_pause "按回车返回环境变量列表..."
                return 0
            fi
            if [[ "$path" != @* ]]; then
                path="@$path"
            fi
            apply_env_edit_value GITHUB_APP_PRIVATE_KEY "$path"
            ;;
        1) env_edit_text GITHUB_APP_PRIVATE_KEY ;;
        2) apply_env_edit_value GITHUB_APP_PRIVATE_KEY "" ;;
    esac
}

edit_env_key() {
    local key="$1"
    case "$key" in
        HOST) env_edit_host ;;
        PORT) env_edit_port ;;
        CLOUDVM_AUTH_MODE) env_edit_auth_mode ;;
        SESSION_SECRET) env_edit_session_secret ;;
        GITHUB_APP_PRIVATE_KEY) env_edit_private_key ;;
        CLOUDVM_ALLOW_ANY_GITHUB_USER|CLOUDVM_TRUST_PROXY|CLOUDVM_SECURE_COOKIES|CLOUDVM_ALLOW_INSECURE_REMOTE)
            env_edit_boolean "$key"
            ;;
        *) env_edit_text "$key" ;;
    esac
}

env_group_menu() {
    local title="$1"
    shift
    local -a keys=("$@")
    local -a items
    local key
    local header
    local index
    while true; do
        items=()
        for key in "${keys[@]}"; do
            items+=("$(env_label "$key") = $(env_display_value "$key")")
        done
        items+=("返回")
        header="$(printf '环境变量管理 / %s\n\n配置文件：%s' "$title" "$APP_ENV_FILE")"
        if ! tui_menu "$header" "↑/↓ 选择  Enter 确认  q 返回" "${items[@]}"; then
            return 0
        fi
        index=$TUI_INDEX
        if (( index == ${#keys[@]} )); then
            return 0
        fi
        key="${keys[$index]}"
        edit_env_key "$key"
    done
}

env_menu() {
    local header
    local -a items
    ensure_app_env_file
    while true; do
        items=(
            "基础连接（HOST / PORT）"
            "GitHub 鉴权与保险库"
            "访问控制与反向代理"
            "数据与 API"
            "查看全部（密钥隐藏）"
            "返回主菜单"
        )
        header="$(printf '环境变量管理\n\n配置文件：%s' "$APP_ENV_FILE")"
        if ! tui_menu "$header" "↑/↓ 选择  Enter 确认  q 返回" "${items[@]}"; then
            return 0
        fi
        case "$TUI_INDEX" in
            0)
                env_group_menu "基础连接" HOST PORT
                ;;
            1)
                env_group_menu "GitHub 鉴权与保险库" \
                    CLOUDVM_AUTH_MODE \
                    GITHUB_APP_ID \
                    GITHUB_APP_CLIENT_ID \
                    GITHUB_APP_CLIENT_SECRET \
                    GITHUB_APP_PRIVATE_KEY \
                    GITHUB_APP_SLUG \
                    SESSION_SECRET \
                    APP_ORIGIN
                ;;
            2)
                env_group_menu "访问控制与反向代理" \
                    CLOUDVM_ALLOWED_GITHUB_USERS \
                    CLOUDVM_ALLOWED_GITHUB_IDS \
                    CLOUDVM_ALLOW_ANY_GITHUB_USER \
                    CLOUDVM_TRUST_PROXY \
                    CLOUDVM_SECURE_COOKIES \
                    CLOUDVM_ALLOW_INSECURE_REMOTE
                ;;
            3)
                env_group_menu "数据与 API" \
                    LINODE_API_TOKEN \
                    CLOUDVM_DATA_DIR \
                    LINODE_API_BASE
                ;;
            4)
                run_env_action list_env
                ;;
            5)
                return 0
                ;;
        esac
    done
}

interactive_menu() {
    local header
    local -a items=(
        "启动服务"
        "停止服务"
        "重启服务"
        "查看状态"
        "查看日志"
        "环境变量管理"
        "更新软件（含脚本）"
        "打开 Web 界面（桌面环境）"
        "退出"
    )
    if [[ ! -t 0 || ! -t 1 ]]; then
        die "交互菜单需要终端。可执行 cloudvm help 查看命令。"
    fi
    ensure_app_env_file
    while true; do
        header="$(menu_header)"
        if ! tui_menu "$header" "↑/↓ 选择  Enter 确认  q 退出" "${items[@]}"; then
            menu_clear
            return 0
        fi
        case "$TUI_INDEX" in
            0)
                run_menu_action start_app
                ;;
            1)
                run_menu_action stop_app
                ;;
            2)
                run_menu_action menu_restart_app
                ;;
            3)
                run_menu_action show_status
                ;;
            4)
                run_menu_action menu_show_logs
                ;;
            5)
                env_menu
                ;;
            6)
                run_menu_action update_app
                ;;
            7)
                run_menu_action menu_open_app
                ;;
            8)
                menu_clear
                return 0
                ;;
        esac
    done
}

if [[ -z "$COMMAND" ]]; then
    if [[ -t 0 && -t 1 ]]; then
        COMMAND="menu"
    else
        COMMAND="start"
    fi
fi

case "$COMMAND" in
    start)
        start_app
        ;;
    stop)
        stop_app
        ;;
    restart)
        stop_app
        start_app
        ;;
    open)
        health_check || die "服务未运行。先执行 cloudvm start。"
        open_app
        ;;
    status)
        show_status
        ;;
    logs)
        show_logs
        ;;
    update)
        update_app
        ;;
    update-script)
        update_script
        ;;
    menu|tui)
        interactive_menu
        ;;
    env)
        if [[ ${#ENV_ARGS[@]} -eq 0 ]]; then
            env_command
        else
            env_command "${ENV_ARGS[@]}"
        fi
        ;;
    version)
        show_version
        ;;
    help)
        usage
        ;;
    *)
        usage
        die "未知命令：$COMMAND"
        ;;
esac
