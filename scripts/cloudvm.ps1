#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Command = "",
    [switch]$Force,
    [switch]$NoRestart,
    [switch]$NoOpen,
    [switch]$Follow,
    [int]$Tail = 40,
    [string]$Proxy = "",
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$EnvArguments = @()
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$ScriptVersion = "1.3.0"

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
    $lines = @(Get-Content -LiteralPath $Path)
    $pattern = "^\s*" + [regex]::Escape($Name) + "\s*=\s*(.*)$"
    for ($index = 0; $index -lt $lines.Count; $index += 1) {
        $line = [string]$lines[$index]
        if ($line -match $pattern) {
            $value = $matches[1].Trim()
            if ($value.Length -gt 0) {
                $quote = [string]$value[0]
                $quoted = $quote -eq '"' -or $quote -eq "'"
                if ($quoted -and -not ($value.Length -gt 1 -and $value.EndsWith($quote))) {
                    $parts = New-Object System.Collections.Generic.List[string]
                    [void]$parts.Add($value.Substring(1))
                    while ($index + 1 -lt $lines.Count) {
                        $index += 1
                        $nextLine = [string]$lines[$index]
                        if ($nextLine.EndsWith($quote)) {
                            [void]$parts.Add($nextLine.Substring(0, $nextLine.Length - 1))
                            break
                        }
                        [void]$parts.Add($nextLine)
                    }
                    return ($parts -join "`n").Trim()
                }
                if ($quoted -and $value.Length -gt 1 -and $value.EndsWith($quote)) {
                    return $value.Substring(1, $value.Length - 2)
                }
            }
            return $value
        }
    }
    return ""
}

function Ensure-AppEnvFile {
    param([pscustomobject]$Config)
    $envPath = Join-Path $Config.appDir ".env"
    if ((Test-Path -LiteralPath $envPath) -and ((Get-Item -LiteralPath $envPath).Length -gt 0)) {
        return $envPath
    }
    $examplePath = Join-Path $Config.appDir ".env.example"
    if (Test-Path -LiteralPath $examplePath) {
        Copy-Item -LiteralPath $examplePath -Destination $envPath -Force
    } else {
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($envPath, "HOST=127.0.0.1`nPORT=4173`n", $utf8)
    }
    Write-Info "已创建环境文件：$envPath"
    return $envPath
}

function Get-EnvQuoteState {
    param([string]$Line)
    $separator = $Line.IndexOf("=")
    if ($separator -lt 0) {
        return [pscustomobject]@{ Multiline = $false; Quote = "" }
    }
    $value = $Line.Substring($separator + 1).Trim()
    if ($value.Length -gt 0) {
        $quote = [string]$value[0]
        if (($quote -eq '"' -or $quote -eq "'") -and -not ($value.Length -gt 1 -and $value.EndsWith($quote))) {
            return [pscustomobject]@{ Multiline = $true; Quote = $quote }
        }
    }
    return [pscustomobject]@{ Multiline = $false; Quote = "" }
}

function Test-EnvKeyName {
    param([string]$Name)
    if ($Name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
        throw "无效的环境变量名：$Name"
    }
}

function Resolve-EnvInput {
    param([string]$Value)
    if ($Value.StartsWith("@")) {
        $filePath = $Value.Substring(1)
        if (Test-Path -LiteralPath $filePath -PathType Leaf) {
            $text = [System.IO.File]::ReadAllText([System.IO.Path]::GetFullPath($filePath))
            $text = $text.TrimEnd([char[]]"`r`n")
            $text = $text.Replace("`r`n", "`n").Replace("`r", "`n")
            return $text.Replace("`n", "\n")
        }
    }
    if ($Value.Contains("`r") -or $Value.Contains("`n")) {
        throw "值包含换行。请先把内容保存到文件，再使用 KEY=@/path/to/file。"
    }
    return $Value
}

function Set-EnvEntry {
    param(
        [string]$Path,
        [string]$Name,
        [string]$Value
    )
    $lines = @()
    if (Test-Path -LiteralPath $Path) {
        $lines = @(Get-Content -LiteralPath $Path)
    }
    $pattern = "^\s*" + [regex]::Escape($Name) + "\s*="
    $result = New-Object System.Collections.Generic.List[string]
    $written = $false
    $skipping = $false
    $quote = ""
    foreach ($line in $lines) {
        if ($skipping) {
            $end = ([string]$line).TrimEnd([char]13)
            if ($end.EndsWith($quote)) {
                $skipping = $false
            }
            continue
        }
        if ($line -match $pattern) {
            if (-not $written) {
                [void]$result.Add("$Name=$Value")
                $written = $true
            }
            $state = Get-EnvQuoteState -Line ([string]$line)
            if ($state.Multiline) {
                $skipping = $true
                $quote = [string]$state.Quote
            }
            continue
        }
        [void]$result.Add([string]$line)
    }
    if (-not $written) {
        [void]$result.Add("$Name=$Value")
    }
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines([System.IO.Path]::GetFullPath($Path), $result, $utf8)
}

function Remove-EnvEntry {
    param(
        [string]$Path,
        [string]$Name
    )
    if (-not (Test-Path -LiteralPath $Path)) {
        return 0
    }
    $pattern = "^\s*" + [regex]::Escape($Name) + "\s*="
    $result = New-Object System.Collections.Generic.List[string]
    $removed = 0
    $skipping = $false
    $quote = ""
    foreach ($line in @(Get-Content -LiteralPath $Path)) {
        if ($skipping) {
            $end = ([string]$line).TrimEnd([char]13)
            if ($end.EndsWith($quote)) {
                $skipping = $false
            }
            continue
        }
        if ($line -match $pattern) {
            $removed += 1
            $state = Get-EnvQuoteState -Line ([string]$line)
            if ($state.Multiline) {
                $skipping = $true
                $quote = [string]$state.Quote
            }
            continue
        }
        [void]$result.Add([string]$line)
    }
    if ($removed -gt 0) {
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllLines([System.IO.Path]::GetFullPath($Path), $result, $utf8)
    }
    return $removed
}

function Show-EnvList {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "未找到 .env：$Path"
    }
    $skipping = $false
    $quote = ""
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($skipping) {
            $end = ([string]$line).TrimEnd([char]13)
            if ($end.EndsWith($quote)) {
                $skipping = $false
            }
            continue
        }
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=') {
            $name = $matches[1]
            if ($name -match '(?i)(SECRET|TOKEN|PASSWORD|PRIVATE_KEY|PROXY)') {
                Write-Output "$name=***"
            } else {
                Write-Output $line
            }
            $state = Get-EnvQuoteState -Line ([string]$line)
            if ($state.Multiline) {
                $skipping = $true
                $quote = [string]$state.Quote
            }
        }
    }
}

function Get-EnvEntry {
    param(
        [string]$Path,
        [string]$Name
    )
    $found = $false
    if (Test-Path -LiteralPath $Path) {
        foreach ($line in Get-Content -LiteralPath $Path) {
            if ($line -match ("^\s*" + [regex]::Escape($Name) + "\s*=")) {
                $found = $true
                break
            }
        }
    }
    if (-not $found) {
        throw "$Name 未设置。"
    }
    return Get-EnvFileValue -Path $Path -Name $Name
}

function Show-EnvHelp {
    Write-Host @'
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
  - 多行内容（例如 PEM）可保存为文件后用 KEY=@C:\path\to\file 写入。
'@
}

function Invoke-EnvCommand {
    param(
        [pscustomobject]$Config,
        [string[]]$Arguments
    )
    $envPath = Ensure-AppEnvFile -Config $Config
    $action = "list"
    $rest = @()
    if ($Arguments -and $Arguments.Count -gt 0) {
        $action = [string]$Arguments[0]
        if ($Arguments.Count -gt 1) {
            $rest = @($Arguments[1..($Arguments.Count - 1)])
        }
    }
    switch ($action.ToLowerInvariant()) {
        "list" {
            Show-EnvList -Path $envPath
            break
        }
        "ls" {
            Show-EnvList -Path $envPath
            break
        }
        "get" {
            if ($rest.Count -ne 1) {
                throw "用法：cloudvm env get <KEY>"
            }
            Get-EnvEntry -Path $envPath -Name ([string]$rest[0])
            break
        }
        "set" {
            if ($rest.Count -eq 0) {
                throw "用法：cloudvm env set <KEY=VALUE> [KEY=VALUE ...]"
            }
            $assignments = New-Object System.Collections.Generic.List[string]
            $index = 0
            while ($index -lt $rest.Count) {
                $token = [string]$rest[$index]
                if ($token.Contains("=")) {
                    [void]$assignments.Add($token)
                    $index += 1
                } else {
                    if ($index + 1 -ge $rest.Count) {
                        throw "用法：cloudvm env set <KEY=VALUE> [KEY=VALUE ...]"
                    }
                    [void]$assignments.Add($token + "=" + [string]$rest[$index + 1])
                    $index += 2
                }
            }
            foreach ($assignment in $assignments) {
                $separator = $assignment.IndexOf("=")
                $name = $assignment.Substring(0, $separator)
                $value = $assignment.Substring($separator + 1)
                Test-EnvKeyName -Name $name
                $value = Resolve-EnvInput -Value $value
                Set-EnvEntry -Path $envPath -Name $name -Value $value
                Write-Success "$name 已更新。"
            }
            Write-Host "配置文件：$envPath"
            if (Get-RunningProcess) {
                Write-Info "服务正在运行，重启后生效：cloudvm restart"
            }
            break
        }
        "unset" {
            if ($rest.Count -lt 1) {
                throw "用法：cloudvm env unset <KEY> [KEY ...]"
            }
            foreach ($name in $rest) {
                Test-EnvKeyName -Name ([string]$name)
                $removed = Remove-EnvEntry -Path $envPath -Name ([string]$name)
                if ($removed -eq 0) {
                    Write-Info "$name 未设置。"
                } else {
                    Write-Success "$name 已删除。"
                }
            }
            if (Get-RunningProcess) {
                Write-Info "服务正在运行，重启后生效：cloudvm restart"
            }
            break
        }
        "remove" {
            Invoke-EnvCommand -Config $Config -Arguments (@("unset") + $rest)
            break
        }
        "rm" {
            Invoke-EnvCommand -Config $Config -Arguments (@("unset") + $rest)
            break
        }
        "help" {
            Show-EnvHelp
            break
        }
        "-h" {
            Show-EnvHelp
            break
        }
        "--help" {
            Show-EnvHelp
            break
        }
        default {
            throw "未知 env 命令：$action"
        }
    }
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
    param([pscustomobject]$Config)
    Ensure-AppEnvFile -Config $Config | Out-Null
    $url = Get-AppUrl -Config $Config
    if (Test-AppHealth -Config $Config) {
        Write-Success "CloudVMController 已在运行：$url"
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
    $directories = @("public", "server", "tests", "scripts", "docs")
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

function Clear-MenuScreen {
    if (-not [Console]::IsOutputRedirected) {
        Clear-Host
    }
}

function Test-SensitiveEnvName {
    param([string]$Name)
    return $Name -match '(?i)(SECRET|TOKEN|PASSWORD|PRIVATE_KEY|PROXY)'
}

function Get-MenuHeaderLines {
    param([pscustomobject]$Config)
    $process = Get-RunningProcess
    if ($process) {
        $state = "运行中（PID $($process.Id)）"
    } elseif (Test-AppHealth -Config $Config) {
        $state = "运行中（非 cloudvm 启动）"
    } else {
        $state = "已停止"
    }
    return @(
        " CloudVMController 控制台",
        " 版本    $((Get-AppVersion -Config $Config))",
        " CLI     $ScriptVersion",
        " 地址    $(Get-AppUrl -Config $Config)",
        " 状态    $state",
        " 安装    $($Config.appDir)",
        " 配置    $(Join-Path $Config.appDir '.env')"
    )
}

function Invoke-MenuStart {
    param([pscustomobject]$Config)
    Start-App -Config $Config
}

function Invoke-MenuStop {
    param([pscustomobject]$Config)
    Stop-App -Config $Config
}

function Invoke-MenuRestart {
    param([pscustomobject]$Config)
    Stop-App -Config $Config
    Start-App -Config $Config
}

function Invoke-MenuStatus {
    param([pscustomobject]$Config)
    Show-Status -Config $Config
}

function Invoke-MenuLogs {
    param([pscustomobject]$Config)
    Show-Logs -Config $Config -LineCount 40
}

function Invoke-MenuOpen {
    param([pscustomobject]$Config)
    if (-not (Test-AppHealth -Config $Config)) {
        throw "服务未运行。先启动服务。"
    }
    Open-App -Config $Config
}

function Invoke-MenuUpdate {
    param([pscustomobject]$Config)
    Update-App -Config $Config
}

function Invoke-MenuAction {
    param(
        [string]$Command,
        [object[]]$Arguments = @(),
        [string]$PauseMessage = "按回车返回主菜单"
    )
    Clear-MenuScreen
    try {
        & $Command @Arguments
    } catch {
        Write-Host ""
        Write-Host $_.Exception.Message -ForegroundColor Red
    }
    Write-Host ""
    Read-Host $PauseMessage | Out-Null
}

function Read-EnvMenuValue {
    param([string]$Name)
    if (Test-SensitiveEnvName -Name $Name) {
        $secure = Read-Host -AsSecureString "新值（留空清除，支持 @文件路径，输入不显示）"
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try {
            return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
    }
    return Read-Host "新值（留空清除，支持 @文件路径）"
}

function Read-TuiMenu {
    param(
        [string[]]$HeaderLines,
        [string[]]$Items,
        [string]$Footer = "↑/↓ 选择  Enter 确认  Q 返回"
    )
    if (-not $Items -or $Items.Count -eq 0) {
        return -1
    }
    $selected = 0
    while ($true) {
        Clear-MenuScreen
        if ($HeaderLines) {
            foreach ($line in $HeaderLines) {
                Write-Host $line
            }
        }
        Write-Host ""
        for ($index = 0; $index -lt $Items.Count; $index += 1) {
            if ($index -eq $selected) {
                Write-Host (" > " + $Items[$index]) -ForegroundColor Black -BackgroundColor Cyan
            } else {
                Write-Host ("   " + $Items[$index])
            }
        }
        Write-Host ""
        Write-Host $Footer -ForegroundColor DarkGray
        $keyInfo = [Console]::ReadKey($true)
        switch ([string]$keyInfo.Key) {
            "UpArrow" {
                if ($selected -gt 0) {
                    $selected -= 1
                }
            }
            "DownArrow" {
                if ($selected -lt $Items.Count - 1) {
                    $selected += 1
                }
            }
            "Enter" {
                return $selected
            }
            "Escape" {
                return -1
            }
            "Q" {
                return -1
            }
            default {
                $charText = [string]$keyInfo.KeyChar
                if ($charText -match '^[1-9]$') {
                    $numericIndex = [int]$charText - 1
                    if ($numericIndex -ge 0 -and $numericIndex -lt $Items.Count) {
                        return $numericIndex
                    }
                }
            }
        }
    }
}

function Format-MenuValue {
    param(
        [string]$Value,
        [int]$MaxLength = 40
    )
    $flat = $Value -replace "`r?`n", " "
    if ($flat.Length -gt $MaxLength) {
        return $flat.Substring(0, $MaxLength - 3) + "..."
    }
    return $flat
}

function Get-EnvLabel {
    param([string]$Key)
    switch ($Key) {
        "HOST" { return "监听地址 HOST" }
        "PORT" { return "端口 PORT" }
        "CLOUDVM_AUTH_MODE" { return "认证模式" }
        "GITHUB_APP_ID" { return "GitHub App ID" }
        "GITHUB_APP_CLIENT_ID" { return "GitHub Client ID" }
        "GITHUB_APP_CLIENT_SECRET" { return "GitHub Client Secret" }
        "GITHUB_APP_PRIVATE_KEY" { return "GitHub App 私钥" }
        "GITHUB_APP_SLUG" { return "GitHub App Slug" }
        "SESSION_SECRET" { return "会话密钥 SESSION_SECRET" }
        "APP_ORIGIN" { return "外部访问地址 APP_ORIGIN" }
        "CLOUDVM_ALLOWED_GITHUB_USERS" { return "GitHub 用户白名单" }
        "CLOUDVM_ALLOWED_GITHUB_IDS" { return "GitHub 用户 ID 白名单" }
        "CLOUDVM_ALLOW_ANY_GITHUB_USER" { return "允许任意 GitHub 用户（谨慎）" }
        "CLOUDVM_TRUST_PROXY" { return "信任反向代理" }
        "CLOUDVM_SECURE_COOKIES" { return "强制 Secure Cookie" }
        "CLOUDVM_ALLOW_INSECURE_REMOTE" { return "允许本地模式远程监听（谨慎）" }
        "LINODE_API_TOKEN" { return "Linode API Token" }
        "CLOUDVM_DATA_DIR" { return "数据目录 CLOUDVM_DATA_DIR" }
        "LINODE_API_BASE" { return "Linode API 地址" }
        default { return $Key }
    }
}

function Get-EnvDisplayValue {
    param(
        [string]$Path,
        [string]$Key
    )
    $value = Get-EnvFileValue -Path $Path -Name $Key
    if (Test-SensitiveEnvName -Name $Key) {
        if ($value) { return "(已设置)" }
        return "(未设置)"
    }
    if ($Key -eq "CLOUDVM_AUTH_MODE") {
        if (-not $value) { return "自动" }
        return $value
    }
    if ($Key -in @(
        "CLOUDVM_ALLOW_ANY_GITHUB_USER",
        "CLOUDVM_TRUST_PROXY",
        "CLOUDVM_SECURE_COOKIES",
        "CLOUDVM_ALLOW_INSECURE_REMOTE"
    )) {
        if ($value -eq "1") { return "启用" }
        return "禁用"
    }
    if ($value) {
        return Format-MenuValue -Value $value -MaxLength 40
    }
    return "(未设置)"
}

function Generate-SessionSecret {
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $bytes = New-Object byte[] 48
        $random.GetBytes($bytes)
        return [Convert]::ToBase64String($bytes)
    } finally {
        $random.Dispose()
    }
}

function Set-MenuEnvValue {
    param(
        [pscustomobject]$Config,
        [string]$Key,
        [string]$Value
    )
    Clear-MenuScreen
    try {
        if ([string]::IsNullOrEmpty($Value)) {
            Invoke-EnvCommand -Config $Config -Arguments @("unset", $Key)
        } else {
            Invoke-EnvCommand -Config $Config -Arguments @("set", "$Key=$Value")
        }
    } catch {
        Write-Host ""
        Write-Host $_.Exception.Message -ForegroundColor Red
    }
    Write-Host ""
    Read-Host "按回车返回环境变量列表" | Out-Null
}

function Edit-EnvKey {
    param(
        [pscustomobject]$Config,
        [string]$Key
    )
    $envPath = Ensure-AppEnvFile -Config $Config
    $current = Get-EnvDisplayValue -Path $envPath -Key $Key
    if ($Key -in @(
        "CLOUDVM_ALLOW_ANY_GITHUB_USER",
        "CLOUDVM_TRUST_PROXY",
        "CLOUDVM_SECURE_COOKIES",
        "CLOUDVM_ALLOW_INSECURE_REMOTE"
    )) {
        $header = @(
            " 环境变量管理 / $(Get-EnvLabel -Key $Key)",
            "",
            "当前值：$current"
        )
        if ($Key -eq "CLOUDVM_ALLOW_ANY_GITHUB_USER") {
            $header += @("", "警告：启用后任何 GitHub 用户都可访问，请确保已配置 HTTPS 和反向代理。")
        } elseif ($Key -eq "CLOUDVM_ALLOW_INSECURE_REMOTE") {
            $header += @("", "警告：仅应在反向代理已强制 HTTPS 和身份认证时启用。")
        }
        $choice = Read-TuiMenu -HeaderLines $header -Items @("启用 (1)", "禁用 / 清除", "取消")
        switch ($choice) {
            0 { Set-MenuEnvValue -Config $Config -Key $Key -Value "1"; return }
            1 { Set-MenuEnvValue -Config $Config -Key $Key -Value ""; return }
            default { return }
        }
    }
    switch ($Key) {
        "HOST" {
            $choice = Read-TuiMenu -HeaderLines @(
                " 环境变量管理 / 监听地址 HOST",
                "",
                "当前值：$current",
                "",
                "0.0.0.0 会监听所有网卡；本地模式还需要鉴权或显式允许不安全远程访问。"
            ) -Items @(
                "127.0.0.1（仅本机，推荐）",
                "0.0.0.0（监听所有网卡）",
                "自定义...",
                "清除（默认 127.0.0.1）",
                "取消"
            )
            switch ($choice) {
                0 { Set-MenuEnvValue -Config $Config -Key $Key -Value "127.0.0.1"; return }
                1 { Set-MenuEnvValue -Config $Config -Key $Key -Value "0.0.0.0"; return }
                2 {
                    $value = Read-Host "监听地址"
                    if ($value) {
                        Set-MenuEnvValue -Config $Config -Key $Key -Value $value
                    }
                    return
                }
                3 { Set-MenuEnvValue -Config $Config -Key $Key -Value ""; return }
                default { return }
            }
        }
        "PORT" {
            Write-Host ""
            Write-Host "端口 PORT"
            Write-Host "当前值：$current"
            $value = Read-Host "新端口（1-65535，留空清除）"
            if ($value) {
                $port = 0
                if (-not [int]::TryParse($value, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
                    Write-Warn "端口必须是 1-65535 之间的数字。"
                    Read-Host "按回车返回环境变量列表" | Out-Null
                    return
                }
            }
            Set-MenuEnvValue -Config $Config -Key $Key -Value $value
            return
        }
        "CLOUDVM_AUTH_MODE" {
            $choice = Read-TuiMenu -HeaderLines @(
                " 环境变量管理 / 认证模式",
                "",
                "当前值：$current",
                "",
                "自动：填写完整 GitHub App 配置时使用 github，否则使用 local。"
            ) -Items @(
                "自动（留空）",
                "github（GitHub App + 私有仓库保险库）",
                "local（本机加密设置）",
                "取消"
            )
            switch ($choice) {
                0 { Set-MenuEnvValue -Config $Config -Key $Key -Value ""; return }
                1 { Set-MenuEnvValue -Config $Config -Key $Key -Value "github"; return }
                2 { Set-MenuEnvValue -Config $Config -Key $Key -Value "local"; return }
                default { return }
            }
        }
        "SESSION_SECRET" {
            $choice = Read-TuiMenu -HeaderLines @(
                " 环境变量管理 / 会话密钥 SESSION_SECRET",
                "",
                "当前值：$current",
                "",
                "至少 32 字节，用于加密 OAuth / 会话 Cookie。"
            ) -Items @("自动生成（推荐）", "手动输入", "清除", "取消")
            switch ($choice) {
                0 {
                    Set-MenuEnvValue -Config $Config -Key $Key -Value (Generate-SessionSecret)
                    return
                }
                1 {
                    $value = Read-EnvMenuValue -Name $Key
                    Set-MenuEnvValue -Config $Config -Key $Key -Value $value
                    return
                }
                2 { Set-MenuEnvValue -Config $Config -Key $Key -Value ""; return }
                default { return }
            }
        }
        "GITHUB_APP_PRIVATE_KEY" {
            $choice = Read-TuiMenu -HeaderLines @(
                " 环境变量管理 / GitHub App 私钥",
                "",
                "当前值：$current",
                "",
                "推荐从 PEM 文件读取，脚本会保存为单行 \n 转义格式。"
            ) -Items @("从文件读取", "手动输入单行内容", "清除", "取消")
            switch ($choice) {
                0 {
                    $path = Read-Host "私钥文件路径"
                    if ($path -and $path.StartsWith("@")) {
                        $path = $path.Substring(1)
                    }
                    if (-not $path -or -not (Test-Path -LiteralPath $path -PathType Leaf)) {
                        Write-Warn "文件不存在：$path"
                        Read-Host "按回车返回环境变量列表" | Out-Null
                        return
                    }
                    $storedPath = "@" + $path
                    Set-MenuEnvValue -Config $Config -Key $Key -Value $storedPath
                    return
                }
                1 {
                    $value = Read-EnvMenuValue -Name $Key
                    Set-MenuEnvValue -Config $Config -Key $Key -Value $value
                    return
                }
                2 { Set-MenuEnvValue -Config $Config -Key $Key -Value ""; return }
                default { return }
            }
        }
        default {
            Write-Host ""
            Write-Host (Get-EnvLabel -Key $Key)
            Write-Host "当前值：$current"
            $value = Read-EnvMenuValue -Name $Key
            Set-MenuEnvValue -Config $Config -Key $Key -Value $value
            return
        }
    }
}

function Show-EnvGroupMenu {
    param(
        [pscustomobject]$Config,
        [string]$Title,
        [string[]]$Keys
    )
    $envPath = Ensure-AppEnvFile -Config $Config
    while ($true) {
        $items = @()
        foreach ($key in $Keys) {
            $items += "$(Get-EnvLabel -Key $key) = $(Get-EnvDisplayValue -Path $envPath -Key $key)"
        }
        $items += "返回"
        $choice = Read-TuiMenu -HeaderLines @(
            " 环境变量管理 / $Title",
            "",
            "配置文件：$envPath"
        ) -Items $items
        if ($choice -lt 0 -or $choice -eq $Keys.Count) {
            return
        }
        Edit-EnvKey -Config $Config -Key $Keys[$choice]
    }
}

function Show-EnvMenu {
    param([pscustomobject]$Config)
    $envPath = Ensure-AppEnvFile -Config $Config
    while ($true) {
        $choice = Read-TuiMenu -HeaderLines @(
            " 环境变量管理",
            "",
            "配置文件：$envPath"
        ) -Items @(
            "基础连接（HOST / PORT）",
            "GitHub 鉴权与保险库",
            "访问控制与反向代理",
            "数据与 API",
            "查看全部（密钥隐藏）",
            "返回主菜单"
        )
        if ($choice -lt 0 -or $choice -eq 5) {
            return
        }
        switch ($choice) {
            0 { Show-EnvGroupMenu -Config $Config -Title "基础连接" -Keys @("HOST", "PORT") }
            1 {
                Show-EnvGroupMenu -Config $Config -Title "GitHub 鉴权与保险库" -Keys @(
                    "CLOUDVM_AUTH_MODE",
                    "GITHUB_APP_ID",
                    "GITHUB_APP_CLIENT_ID",
                    "GITHUB_APP_CLIENT_SECRET",
                    "GITHUB_APP_PRIVATE_KEY",
                    "GITHUB_APP_SLUG",
                    "SESSION_SECRET",
                    "APP_ORIGIN"
                )
            }
            2 {
                Show-EnvGroupMenu -Config $Config -Title "访问控制与反向代理" -Keys @(
                    "CLOUDVM_ALLOWED_GITHUB_USERS",
                    "CLOUDVM_ALLOWED_GITHUB_IDS",
                    "CLOUDVM_ALLOW_ANY_GITHUB_USER",
                    "CLOUDVM_TRUST_PROXY",
                    "CLOUDVM_SECURE_COOKIES",
                    "CLOUDVM_ALLOW_INSECURE_REMOTE"
                )
            }
            3 {
                Show-EnvGroupMenu -Config $Config -Title "数据与 API" -Keys @(
                    "LINODE_API_TOKEN",
                    "CLOUDVM_DATA_DIR",
                    "LINODE_API_BASE"
                )
            }
            4 {
                Clear-MenuScreen
                Show-EnvList -Path $envPath
                Write-Host ""
                Read-Host "按回车返回环境变量菜单" | Out-Null
            }
        }
    }
}

function Invoke-InteractiveMenu {
    param([pscustomobject]$Config)
    if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) {
        throw "交互菜单需要终端。可执行 cloudvm help 查看命令。"
    }
    Ensure-AppEnvFile -Config $Config | Out-Null
    $items = @(
        "启动服务",
        "停止服务",
        "重启服务",
        "查看状态",
        "查看日志",
        "环境变量管理",
        "更新软件（含脚本）",
        "打开 Web 界面（桌面环境）",
        "退出"
    )
    while ($true) {
        $header = Get-MenuHeaderLines -Config $Config
        $choice = Read-TuiMenu -HeaderLines $header -Items $items -Footer "↑/↓ 选择  Enter 确认  Q 退出"
        if ($choice -lt 0) {
            Clear-MenuScreen
            return
        }
        switch ($choice) {
            0 {
                Invoke-MenuAction -Command "Invoke-MenuStart" -Arguments @($Config)
            }
            1 {
                Invoke-MenuAction -Command "Invoke-MenuStop" -Arguments @($Config)
            }
            2 {
                Invoke-MenuAction -Command "Invoke-MenuRestart" -Arguments @($Config)
            }
            3 {
                Invoke-MenuAction -Command "Invoke-MenuStatus" -Arguments @($Config)
            }
            4 {
                Invoke-MenuAction -Command "Invoke-MenuLogs" -Arguments @($Config)
            }
            5 {
                Show-EnvMenu -Config $Config
            }
            6 {
                Invoke-MenuAction -Command "Invoke-MenuUpdate" -Arguments @($Config)
            }
            7 {
                Invoke-MenuAction -Command "Invoke-MenuOpen" -Arguments @($Config)
            }
            8 {
                Clear-MenuScreen
                return
            }
        }
    }
}

function Show-Help {
    Write-Host @"
CloudVMController 命令行

用法：
  cloudvm [命令] [选项]
  cloudvm            进入交互菜单
                     非交互环境等价于 cloudvm start

命令：
  menu             打开交互菜单（tui 同义）
  start            启动服务（不打开浏览器）
  stop             停止由 cloudvm 启动的服务
  restart          重启服务
  status           查看运行状态
  open             在桌面环境中打开 Web 界面
  logs             查看日志，-Follow 持续输出，-Tail N 指定行数
  update           更新软件并重新安装依赖
  update-script    从 GitHub 更新 cloudvm 脚本
  env              查看或修改 .env 配置
  version          查看版本
  help             显示帮助

选项：
  -NoRestart       更新后不自动重启
  -Force           更新时强制覆盖本地修改
  -Proxy <url>     GitHub 下载代理，例如 http://127.0.0.1:7890

环境变量：
  cloudvm env list
  cloudvm env get PORT
  cloudvm env set HOST=0.0.0.0 PORT=8080
  cloudvm env set GITHUB_APP_PRIVATE_KEY=@C:\path\to\key.pem
  cloudvm env unset PORT
"@
}

try {
    $config = Read-CloudVmConfig
    $commandName = $Command.Trim()
    if (-not $commandName) {
        if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) {
            $commandName = "start"
        } else {
            $commandName = "menu"
        }
    }
    switch ($commandName.ToLowerInvariant()) {
        "start" {
            Start-App -Config $config
            break
        }
        "stop" {
            Stop-App -Config $config
            break
        }
        "restart" {
            Stop-App -Config $config
            Start-App -Config $config
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
        "menu" {
            Invoke-InteractiveMenu -Config $config
            break
        }
        "tui" {
            Invoke-InteractiveMenu -Config $config
            break
        }
        "env" {
            Invoke-EnvCommand -Config $config -Arguments $EnvArguments
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
