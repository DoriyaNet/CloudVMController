#!/usr/bin/env bash
set -euo pipefail

SCRIPT_VERSION="1.1.0"

CLOUDVM_HOME="${CLOUDVM_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/cloudvmcontroller}"
CONFIG_FILE="${CLOUDVM_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/cloudvmcontroller/config.env}"
RUN_DIR="$CLOUDVM_HOME/run"
LOG_DIR="$CLOUDVM_HOME/logs"
PID_FILE="$RUN_DIR/cloudvm.pid"
OUT_LOG="$LOG_DIR/cloudvm.out.log"
ERR_LOG="$LOG_DIR/cloudvm.err.log"

COMMAND="start"
COMMAND_SET=0
FORCE=0
NO_RESTART=0
FOLLOW=0
TAIL=40
PROXY="${CLOUDVM_PROXY:-}"
ENV_ARGS=()

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

命令：
  start            启动服务（默认，不打开浏览器）
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
        start|stop|restart|status|open|logs|update|update-script|version|help)
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
