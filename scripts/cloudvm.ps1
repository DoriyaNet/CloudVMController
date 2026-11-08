#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Command = "start",
    [switch]$Force,
    [switch]$NoRestart,
    [switch]$NoOpen,
    [switch]$Follow,
    [int]$Tail = 40,
    [string]$Proxy = ""
)

$ErrorActionPreference = "Stop"
$ScriptVersion = "1.0.0"

function Write-Info {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Cyan
}

function Write-Success {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Yellow
}

function Get-CloudVmHome {
    if ($env:CLOUDVM_HOME) {
        return [System.IO.Path]::GetFullPath($env:CLOUDVM_HOME)
    }
    return Join-Path $env:LOCALAPPDATA "CloudVMController"
}

function Get-ConfigPath {
    if ($env:CLOUDVM_CONFIG) {
        return [System.IO.Path]::GetFullPath($env:CLOUDVM_CONFIG)
    }
    return Join-Path (Get-CloudVmHome) "config.json"
}

function Read-CloudVmConfig {
    $configPath = Get-ConfigPath
    if (Test-Path -LiteralPath $configPath) {
        $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        if (-not $config.appDir) {
            throw "配置文件缺少 appDir：$configPath"
        }
        $config.appDir = [System.IO.Path]::GetFullPath([string]$config.appDir)
        if ($config.launcherDir) {
            $config.launcherDir = [System.IO.Path]::GetFullPath([string]$config.launcherDir)
        }
        if (-not $config.installMode) {
            if (Test-Path -LiteralPath (Join-Path $config.appDir ".git")) {
                $config | Add-Member -NotePropertyName installMode -NotePropertyValue "git" -Force
            } else {
                $config | Add-Member -NotePropertyName installMode -NotePropertyValue "zip" -Force
            }
        }
        if (-not $config.repository) {
            $config | Add-Member -NotePropertyName repository -NotePropertyValue "DoriyaNet/CloudVMController" -Force
        }
        if (-not $config.branch) {
            $config | Add-Member -NotePropertyName branch -NotePropertyValue "main" -Force
        }
        $config | Add-Member -NotePropertyName installed -NotePropertyValue $true -Force
    } else {
        $current = (Get-Location).Path
        $packagePath = Join-Path $current "package.json"
        if (-not (Test-Path -LiteralPath $packagePath)) {
            throw "未找到 CloudVMController 安装配置。请先运行 install.ps1。"
        }
        $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
        if ($package.name -ne "cloudvmcontroller") {
            throw "未找到 CloudVMController 安装配置。请先运行 install.ps1。"
        }
        $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
        $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
        $nodePath = ""
        $npmPath = ""
        if ($nodeCommand) {
            $nodePath = $nodeCommand.Source
        }
        if ($npmCommand) {
            $npmPath = $npmCommand.Source
        }
        $config = [pscustomobject]@{
            appDir = $current
            launcherDir = Split-Path -Parent $PSCommandPath
            nodePath = $nodePath
            npmPath = $npmPath
            repository = "DoriyaNet/CloudVMController"
            branch = "main"
            installMode = "git"
            installed = $false
        }
    }

    if (-not (Test-Path -LiteralPath (Join-Path $config.appDir "package.json"))) {
        throw "安装目录无效：$($config.appDir)"
    }
    return $config
}

function Get-AppVersion {
    param([pscustomobject]$Config)
    $packagePath = Join-Path $Config.appDir "package.json"
    try {
        $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
        if ($package.version) {
            return [string]$package.version
        }
    } catch {
    }
    return "unknown"
}

function Get-EnvFileValue {
    param(
        [string]$Path,
        [string]$Name
    )
    if (-not (Test-Path -LiteralPath $Path)) {
        return ""
    }
    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()
        if ($trimmed.StartsWith("#")) {
            continue
        }
        if ($trimmed -match "^$([regex]::Escape($Name))\s*=\s*(.*)$") {
            $value = $matches[1].Trim()
            if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            return $value
        }
    }
    return ""
}

function Get-AppPort {
    param([pscustomobject]$Config)
    if ($env:PORT) {
        $parsed = 0
        if ([int]::TryParse([string]$env:PORT, [ref]$parsed)) {
            return $parsed
        }
    }
    $value = Get-EnvFileValue -Path (Join-Path $Config.appDir ".env") -Name "PORT"
    $parsed = 0
    if ($value -and [int]::TryParse($value, [ref]$parsed)) {
        return $parsed
    }
    return 4173
}

function Get-AppHost {
    param([pscustomobject]$Config)
    if ($env:HOST) {
        return [string]$env:HOST
    }
    $value = Get-EnvFileValue -Path (Join-Path $Config.appDir ".env") -Name "HOST"
    if ($value) {
        return $value
    }
    return "127.0.0.1"
}

function Get-AppUrl {
    param([pscustomobject]$Config)
    $hostName = Get-AppHost -Config $Config
    if ($hostName -eq "0.0.0.0") {
        $hostName = "127.0.0.1"
    }
    return "http://{0}:{1}" -f $hostName, (Get-AppPort -Config $Config)
}

function Test-AppHealth {
    param([pscustomobject]$Config)
    $url = "{0}/api/health" -f (Get-AppUrl -Config $Config)
    try {
        $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Get-NodeVersion {
    param([string]$NodePath)
    try {
        $raw = (& $NodePath --version 2>$null)
        if ($raw -and ($raw -match "v([0-9]+\.[0-9]+\.[0-9]+)")) {
            return [version]$matches[1]
        }
    } catch {
    }
    return $null
}

function Get-NodePath {
    param([pscustomobject]$Config)
    $candidates = @()
    if ($Config.nodePath) {
        $candidates += [string]$Config.nodePath
    }
    $runtimeDir = Join-Path (Get-CloudVmHome) "runtime"
    if (Test-Path -LiteralPath $runtimeDir) {
        $localNodes = Get-ChildItem -LiteralPath $runtimeDir -Filter node.exe -Recurse -ErrorAction SilentlyContinue
        foreach ($localNode in $localNodes) {
            $candidates += $localNode.FullName
        }
    }
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCommand) {
        $candidates += $nodeCommand.Source
    }
    foreach ($candidate in $candidates) {
        if (-not (Test-Path -LiteralPath $candidate)) {
            continue
        }
        $version = Get-NodeVersion -NodePath $candidate
        if ($version -and $version -ge [version]"20.0.0") {
            return $candidate
        }
    }
    throw "未找到 Node.js 20+。请重新运行 install.ps1 或手动安装 Node.js。"
}

function Get-NpmPath {
    param([pscustomobject]$Config, [string]$NodePath)
    if ($Config.npmPath -and (Test-Path -LiteralPath $Config.npmPath)) {
        return [string]$Config.npmPath
    }
    $nodeDir = Split-Path -Parent $NodePath
    $localNpm = Join-Path $nodeDir "npm.cmd"
    if (Test-Path -LiteralPath $localNpm) {
        return $localNpm
    }
    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($npmCommand) {
        return $npmCommand.Source
    }
    throw "未找到 npm。请重新运行 install.ps1。"
}

function Get-ProxyValue {
    param([string]$ExplicitProxy)
    if ($ExplicitProxy) {
        return $ExplicitProxy
    }
    foreach ($name in @("CLOUDVM_PROXY", "HTTPS_PROXY", "HTTP_PROXY")) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($value) {
            return $value
        }
    }
    return ""
}

function Invoke-Download {
    param(
        [string]$Url,
        [string]$OutFile
    )
    $parameters = @{
        Uri = $Url
        OutFile = $OutFile
        UseBasicParsing = $true
    }
    $proxyValue = Get-ProxyValue -ExplicitProxy $Proxy
    if ($proxyValue) {
        $parameters["Proxy"] = $proxyValue
    }
    Invoke-WebRequest @parameters
}

function Install-ProjectDependencies {
    param([pscustomobject]$Config)
    $nodePath = Get-NodePath -Config $Config
    $npmPath = Get-NpmPath -Config $Config -NodePath $nodePath
    Write-Info "安装项目依赖..."
    Push-Location -LiteralPath $Config.appDir
    try {
        & $npmPath ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            & $npmPath install --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) {
                throw "npm 依赖安装失败。"
            }
        }
    } finally {
        Pop-Location
    }
}

function Get-PidPath {
    return Join-Path (Get-CloudVmHome) "cloudvm.pid"
}

function Get-RunningProcess {
    $pidPath = Get-PidPath
    if (-not (Test-Path -LiteralPath $pidPath)) {
        return $null
    }
    $raw = Get-Content -LiteralPath $pidPath -ErrorAction SilentlyContinue | Select-Object -First 1
    $parsed = 0
    if (-not [int]::TryParse([string]$raw, [ref]$parsed)) {
        Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
        return $null
    }
    $process = Get-Process -Id $parsed -ErrorAction SilentlyContinue
    if (-not $process) {
        Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
        return $null
    }
    if ($process.ProcessName -notin @("node", "nodejs")) {
        Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
        return $null
    }
    return $process
}

function Open-App {
    param([pscustomobject]$Config)
    $url = Get-AppUrl -Config $Config
    Start-Process -FilePath $url
}

function Start-App {
    param(
        [pscustomobject]$Config,
        [switch]$SkipOpen
    )
    $url = Get-AppUrl -Config $Config
    if (Test-AppHealth -Config $Config) {
        Write-Success "CloudVMController 已在运行：$url"
        if (-not $SkipOpen) {
            Open-App -Config $Config
        }
        return
    }

    if (-not (Test-Path -LiteralPath (Join-Path $Config.appDir "node_modules"))) {
        Install-ProjectDependencies -Config $Config
    }

    $nodePath = Get-NodePath -Config $Config
    $homeDir = Get-CloudVmHome
    $logDir = Join-Path $homeDir "logs"
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    $outLog = Join-Path $logDir "cloudvm.out.log"
    $errLog = Join-Path $logDir "cloudvm.err.log"
    $pidPath = Get-PidPath

    Write-Info "启动 CloudVMController..."
    $process = Start-Process -FilePath $nodePath -ArgumentList @("server/index.js") -WorkingDirectory $Config.appDir -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
    Set-Content -LiteralPath $pidPath -Value $process.Id -Encoding ASCII

    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        if ($process.HasExited) {
            break
        }
        if (Test-AppHealth -Config $Config) {
            Write-Success "CloudVMController 已启动：$url"
            Write-Host "日志：$logDir"
            if (-not $SkipOpen) {
                Open-App -Config $Config
            }
            return
        }
    }

    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $errLog) {
        $errorText = Get-Content -LiteralPath $errLog -Tail 30 -ErrorAction SilentlyContinue
        if ($errorText) {
            Write-Warn "启动失败，错误日志："
            $errorText | ForEach-Object { Write-Host $_ }
        }
    }
    throw "CloudVMController 启动失败或超时。"
}

function Stop-App {
    param([pscustomobject]$Config)
    $process = Get-RunningProcess
    if ($process) {
        Write-Info "停止 CloudVMController（PID $($process.Id)）..."
        Stop-Process -Id $process.Id -Force
        $deadline = (Get-Date).AddSeconds(8)
        while ((Get-Date) -lt $deadline) {
            if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) {
                break
            }
            Start-Sleep -Milliseconds 300
        }
        Remove-Item -LiteralPath (Get-PidPath) -Force -ErrorAction SilentlyContinue
        Write-Success "服务已停止。"
        return
    }
    Remove-Item -LiteralPath (Get-PidPath) -Force -ErrorAction SilentlyContinue
    if (Test-AppHealth -Config $Config) {
        Write-Warn "检测到服务仍在运行，但它不是由 cloudvm 启动的，请手动停止。"
    } else {
        Write-Info "服务当前未运行。"
    }
}

function Show-Status {
    param([pscustomobject]$Config)
    $url = Get-AppUrl -Config $Config
    $process = Get-RunningProcess
    Write-Host "CloudVMController $((Get-AppVersion -Config $Config))"
    Write-Host "CLI              $ScriptVersion"
    Write-Host "安装目录         $($Config.appDir)"
    Write-Host "日志目录         $(Join-Path (Get-CloudVmHome) 'logs')"
    Write-Host "地址             $url"
    if (Test-AppHealth -Config $Config) {
        if ($process) {
            Write-Success "状态             运行中（PID $($process.Id)）"
        } else {
            Write-Success "状态             运行中（非 cloudvm 启动）"
        }
    } else {
        Write-Warn "状态             已停止"
    }
}

function Show-Logs {
    param(
        [pscustomobject]$Config,
        [switch]$Wait,
        [int]$LineCount
    )
    $logDir = Join-Path (Get-CloudVmHome) "logs"
    $outLog = Join-Path $logDir "cloudvm.out.log"
    $errLog = Join-Path $logDir "cloudvm.err.log"
    if (-not (Test-Path -LiteralPath $outLog) -and -not (Test-Path -LiteralPath $errLog)) {
        throw "暂无日志。先运行 cloudvm start。"
    }
    if (Test-Path -LiteralPath $outLog) {
        Write-Host "== stdout ==" -ForegroundColor DarkGray
        Get-Content -LiteralPath $outLog -Tail $LineCount
    }
    if (Test-Path -LiteralPath $errLog) {
        $errorText = Get-Content -LiteralPath $errLog -Tail $LineCount -ErrorAction SilentlyContinue
        if ($errorText) {
            Write-Host "== stderr ==" -ForegroundColor DarkGray
            $errorText | ForEach-Object { Write-Host $_ }
        }
    }
    if ($Wait) {
        Write-Host "== follow ==" -ForegroundColor DarkGray
        Get-Content -LiteralPath $outLog -Wait -Tail 0
    }
}

function Copy-AppFiles {
    param(
        [string]$SourceRoot,
        [string]$TargetRoot
    )
    $directories = @("public", "server", "tests", "scripts")
    foreach ($directory in $directories) {
        $source = Join-Path $SourceRoot $directory
        if (-not (Test-Path -LiteralPath $source)) {
            continue
        }
        $target = Join-Path $TargetRoot $directory
        if (Test-Path -LiteralPath $target) {
            Remove-Item -LiteralPath $target -Recurse -Force
        }
        Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
    }
    $files = @("install.ps1", "install.cmd", "install.sh", "README.md", "package.json", "package-lock.json", ".env.example", ".gitignore", ".gitattributes")
    foreach ($file in $files) {
        $source = Join-Path $SourceRoot $file
        if (Test-Path -LiteralPath $source) {
            Copy-Item -LiteralPath $source -Destination (Join-Path $TargetRoot $file) -Force
        }
    }
}

function Update-AppFromArchive {
    param([pscustomobject]$Config)
    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("cloudvm-update-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    try {
        $archiveUrl = "https://github.com/{0}/archive/refs/heads/{1}.zip" -f $Config.repository, $Config.branch
        $archivePath = Join-Path $tempRoot "source.zip"
        Write-Info "下载最新版本：$archiveUrl"
        Invoke-Download -Url $archiveUrl -OutFile $archivePath
        $extractDir = Join-Path $tempRoot "extract"
        Expand-Archive -LiteralPath $archivePath -DestinationPath $extractDir -Force
        $sourceRoot = Get-ChildItem -LiteralPath $extractDir -Directory | Select-Object -First 1
        if (-not $sourceRoot) {
            throw "无法识别下载的压缩包结构。"
        }
        Copy-AppFiles -SourceRoot $sourceRoot.FullName -TargetRoot $Config.appDir
    } finally {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Update-AppFromGit {
    param([pscustomobject]$Config)
    $gitCommand = Get-Command git -ErrorAction SilentlyContinue
    if (-not $gitCommand) {
        throw "未找到 git，无法从 Git 仓库更新。"
    }
    $gitPath = $gitCommand.Source
    $status = & $gitPath -C $Config.appDir status --porcelain
    if ($status -and -not $Force) {
        throw "安装目录存在未提交的修改。请先提交、暂存或使用 cloudvm update -Force。"
    }
    Write-Info "从 Git 更新 $($Config.branch)..."
    & $gitPath -C $Config.appDir fetch origin $Config.branch
    if ($LASTEXITCODE -ne 0) {
        throw "git fetch 失败。"
    }
    if ($Force) {
        & $gitPath -C $Config.appDir reset --hard "origin/$($Config.branch)"
    } else {
        & $gitPath -C $Config.appDir pull --ff-only origin $Config.branch
    }
    if ($LASTEXITCODE -ne 0) {
        throw "git 更新失败。"
    }
}

function Sync-LauncherScript {
    param([pscustomobject]$Config)
    if (-not $Config.installed -or -not $Config.launcherDir) {
        return
    }
    $source = Join-Path $Config.appDir "scripts/cloudvm.ps1"
    $target = Join-Path $Config.launcherDir "cloudvm.ps1"
    if ((Test-Path -LiteralPath $source) -and (Test-Path -LiteralPath $Config.launcherDir)) {
        Copy-Item -LiteralPath $source -Destination $target -Force
    }
}

function Update-App {
    param([pscustomobject]$Config)
    $oldVersion = Get-AppVersion -Config $Config
    $wasRunning = Test-AppHealth -Config $Config
    if ($wasRunning -and -not (Get-RunningProcess)) {
        throw "服务正在运行，但不是由 cloudvm 启动。请先停止该进程，再执行 cloudvm update。"
    }
    if ($wasRunning) {
        Stop-App -Config $Config
    }

    if ($Config.installMode -eq "git") {
        $gitCommand = Get-Command git -ErrorAction SilentlyContinue
        if ($gitCommand) {
            Update-AppFromGit -Config $Config
        } else {
            Write-Warn "未找到 git，改用 GitHub 压缩包更新。"
            Update-AppFromArchive -Config $Config
        }
    } else {
        Update-AppFromArchive -Config $Config
    }

    Install-ProjectDependencies -Config $Config
    Sync-LauncherScript -Config $Config
    $newVersion = Get-AppVersion -Config $Config
    Write-Success "软件已更新：$oldVersion -> $newVersion"

    if ($wasRunning -and -not $NoRestart) {
        Start-App -Config $Config
    } elseif ($wasRunning) {
        Write-Info "更新前服务正在运行，已停止；可执行 cloudvm start 重新启动。"
    }
}

function Update-Script {
    param([pscustomobject]$Config)
    if (-not $Config.installed) {
        throw "当前脚本不是通过 install.ps1 安装的，update-script 不可用。请先运行 install.ps1。"
    }
    $launcherDir = $Config.launcherDir
    if (-not $launcherDir -or -not (Test-Path -LiteralPath $launcherDir)) {
        throw "找不到快捷指令目录。请重新运行 install.ps1。"
    }
    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("cloudvm-script-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    try {
        $cliUrl = "https://raw.githubusercontent.com/{0}/{1}/scripts/cloudvm.ps1" -f $Config.repository, $Config.branch
        $installerUrl = "https://raw.githubusercontent.com/{0}/{1}/install.ps1" -f $Config.repository, $Config.branch
        $newCli = Join-Path $tempRoot "cloudvm.ps1"
        $newInstaller = Join-Path $tempRoot "install.ps1"
        Write-Info "更新 cloudvm 脚本..."
        Invoke-Download -Url $cliUrl -OutFile $newCli
        Invoke-Download -Url $installerUrl -OutFile $newInstaller

        $cliText = Get-Content -LiteralPath $newCli -Raw
        if ($cliText -notmatch '\$ScriptVersion\s*=\s*"') {
            throw "下载的 cloudvm 脚本格式不正确。"
        }
        $installerText = Get-Content -LiteralPath $newInstaller -Raw
        if ($installerText -notmatch '\$InstallerVersion\s*=\s*"') {
            throw "下载的安装脚本格式不正确。"
        }

        Move-Item -LiteralPath $newCli -Destination (Join-Path $launcherDir "cloudvm.ps1") -Force
        Move-Item -LiteralPath $newInstaller -Destination (Join-Path (Get-CloudVmHome) "install.ps1") -Force
        $newVersion = ""
        if ($cliText -match '\$ScriptVersion\s*=\s*"([^"]+)"') {
            $newVersion = $matches[1]
        }
        Write-Success "脚本已更新：$newVersion"
        Write-Host "重新打开终端或再次运行 cloudvm 即可使用新版本。"
    } finally {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Show-Version {
    param([pscustomobject]$Config)
    Write-Host "CloudVMController $((Get-AppVersion -Config $Config))"
    Write-Host "cloudvm CLI $ScriptVersion"
    Write-Host "安装目录：$($Config.appDir)"
}

function Show-Help {
    Write-Host @"
CloudVMController 命令行

用法：
  cloudvm [命令] [选项]

命令：
  start            启动服务并打开浏览器（默认）
  stop             停止由 cloudvm 启动的服务
  restart          重启服务
  status           查看运行状态
  open             打开 Web 界面
  logs             查看日志，-Follow 持续输出，-Tail N 指定行数
  update           更新软件并重新安装依赖
  update-script    从 GitHub 更新 cloudvm 脚本
  version          查看版本
  help             显示帮助

选项：
  -NoOpen          启动时不打开浏览器
  -NoRestart       更新后不自动重启
  -Force           更新时强制覆盖本地修改
  -Proxy <url>     GitHub 下载代理，例如 http://127.0.0.1:7890
"@
}

try {
    $config = Read-CloudVmConfig
    switch ($Command.ToLowerInvariant()) {
        "start" {
            Start-App -Config $config -SkipOpen:$NoOpen
            break
        }
        "stop" {
            Stop-App -Config $config
            break
        }
        "restart" {
            Stop-App -Config $config
            Start-App -Config $config -SkipOpen:$NoOpen
            break
        }
        "open" {
            if (-not (Test-AppHealth -Config $config)) {
                throw "服务未运行。先执行 cloudvm start。"
            }
            Open-App -Config $config
            break
        }
        "status" {
            Show-Status -Config $config
            break
        }
        "logs" {
            Show-Logs -Config $config -Wait:$Follow -LineCount $Tail
            break
        }
        "update" {
            Update-App -Config $config
            break
        }
        "update-script" {
            Update-Script -Config $config
            break
        }
        "version" {
            Show-Version -Config $config
            break
        }
        "help" {
            Show-Help
            break
        }
        default {
            Show-Help
            throw "未知命令：$Command"
        }
    }
} catch {
    Write-Host ""
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
