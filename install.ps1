#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$InstallDir = "",
    [string]$Branch = "main",
    [string]$Repository = "DoriyaNet/CloudVMController",
    [switch]$NoLaunch,
    [switch]$NoPath,
    [switch]$Force,
    [switch]$SkipDeps,
    [string]$Proxy = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$InstallerVersion = "1.0.0"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

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
    if (-not $env:LOCALAPPDATA) {
        throw "无法确定 LOCALAPPDATA 目录。"
    }
    return Join-Path $env:LOCALAPPDATA "CloudVMController"
}

function Test-LocalRepo {
    param([string]$Path)
    $packagePath = Join-Path $Path "package.json"
    if (-not (Test-Path -LiteralPath $packagePath)) {
        return $false
    }
    try {
        $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
        return $package.name -eq "cloudvmcontroller"
    } catch {
        return $false
    }
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

function Copy-AppFiles {
    param(
        [string]$SourceRoot,
        [string]$TargetRoot
    )
    New-Item -ItemType Directory -Path $TargetRoot -Force | Out-Null
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

function Install-AppArchive {
    param([string]$TargetRoot)
    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("cloudvm-install-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    try {
        $archiveUrl = "https://github.com/{0}/archive/refs/heads/{1}.zip" -f $Repository, $Branch
        $archivePath = Join-Path $tempRoot "source.zip"
        Write-Info "下载 CloudVMController：$archiveUrl"
        Invoke-Download -Url $archiveUrl -OutFile $archivePath
        $extractDir = Join-Path $tempRoot "extract"
        Expand-Archive -LiteralPath $archivePath -DestinationPath $extractDir -Force
        $sourceRoot = Get-ChildItem -LiteralPath $extractDir -Directory | Select-Object -First 1
        if (-not $sourceRoot) {
            throw "无法识别下载的压缩包结构。"
        }
        Copy-AppFiles -SourceRoot $sourceRoot.FullName -TargetRoot $TargetRoot
    } finally {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
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

function Get-LocalNode {
    param([string]$RuntimeDir)
    if (-not (Test-Path -LiteralPath $RuntimeDir)) {
        return $null
    }
    $nodes = Get-ChildItem -LiteralPath $RuntimeDir -Filter node.exe -Recurse -ErrorAction SilentlyContinue
    foreach ($node in $nodes) {
        $version = Get-NodeVersion -NodePath $node.FullName
        if ($version -and $version -ge [version]"20.0.0") {
            return $node.FullName
        }
    }
    return $null
}

function Get-SystemNode {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCommand) {
        return $null
    }
    $version = Get-NodeVersion -NodePath $nodeCommand.Source
    if ($version -and $version -ge [version]"20.0.0") {
        return $nodeCommand.Source
    }
    return $null
}

function Install-PortableNode {
    param([string]$RuntimeDir)
    $architecture = $env:PROCESSOR_ARCHITECTURE
    $nodeArch = ""
    if ($architecture -eq "AMD64") {
        $nodeArch = "x64"
    } elseif ($architecture -eq "ARM64") {
        $nodeArch = "arm64"
    } else {
        throw "仅支持 64 位 Windows（x64 或 ARM64）。请手动安装 Node.js 20+ 后重新运行。"
    }

    New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("cloudvm-node-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    try {
        Write-Info "未找到 Node.js 20+，准备下载便携版 Node.js..."
        $sumsUrl = "https://nodejs.org/dist/latest/SHASUMS256.txt"
        $sumsPath = Join-Path $tempRoot "SHASUMS256.txt"
        Invoke-Download -Url $sumsUrl -OutFile $sumsPath
        $line = Get-Content -LiteralPath $sumsPath | Where-Object { $_ -match "win-$nodeArch\.zip" } | Select-Object -First 1
        if (-not $line) {
            throw "无法在 Node.js 校验文件中找到 Windows $nodeArch 安装包。"
        }
        $parts = ($line.Trim() -split '\s+', 2)
        $expectedHash = $parts[0]
        $fileName = $parts[1]
        $nodeUrl = "https://nodejs.org/dist/latest/$fileName"
        $nodeZip = Join-Path $tempRoot $fileName
        Write-Info "下载 $fileName..."
        Invoke-Download -Url $nodeUrl -OutFile $nodeZip
        $actualHash = (Get-FileHash -LiteralPath $nodeZip -Algorithm SHA256).Hash
        if ($actualHash.ToLowerInvariant() -ne $expectedHash.ToLowerInvariant()) {
            throw "Node.js 安装包 SHA256 校验失败。"
        }
        Expand-Archive -LiteralPath $nodeZip -DestinationPath $RuntimeDir -Force
    } finally {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    $node = Get-LocalNode -RuntimeDir $RuntimeDir
    if (-not $node) {
        throw "Node.js 便携版解压失败。"
    }
    return $node
}

function Resolve-NodeRuntime {
    param([string]$RuntimeDir)
    $nodePath = Get-LocalNode -RuntimeDir $RuntimeDir
    if (-not $nodePath) {
        $nodePath = Get-SystemNode
    }
    if (-not $nodePath) {
        $nodePath = Install-PortableNode -RuntimeDir $RuntimeDir
    }
    $nodeDir = Split-Path -Parent $nodePath
    $npmPath = Join-Path $nodeDir "npm.cmd"
    if (-not (Test-Path -LiteralPath $npmPath)) {
        $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if ($npmCommand) {
            $npmPath = $npmCommand.Source
        }
    }
    if (-not (Test-Path -LiteralPath $npmPath)) {
        throw "找不到 npm.cmd。请安装完整版 Node.js 20+ 后重新运行。"
    }
    return [pscustomobject]@{
        NodePath = $nodePath
        NpmPath = $npmPath
    }
}

function Send-EnvironmentChange {
    try {
        if (-not ("CloudVmEnvironment.NativeMethods" -as [type])) {
            Add-Type -Namespace CloudVmEnvironment -Name NativeMethods -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Auto)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);
'@
        }
        $result = [UIntPtr]::Zero
        [CloudVmEnvironment.NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$result) | Out-Null
    } catch {
    }
}

function Add-UserPath {
    param([string]$PathToAdd)
    $target = $PathToAdd.TrimEnd('\')
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
    if (-not $key) {
        $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Environment")
    }
    try {
        $current = [string]$key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $entries = @()
        if ($current) {
            $entries = @($current -split ';' | Where-Object { $_.Trim() })
        }
        $exists = $false
        foreach ($entry in $entries) {
            if ($entry.Trim().TrimEnd('\') -ieq $target) {
                $exists = $true
                break
            }
        }
        if ($exists) {
            Write-Info "用户 PATH 已包含：$PathToAdd"
            return
        }
        $newPath = (@($entries) + $PathToAdd) -join ';'
        $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
        try {
            if ($key.GetValueKind("Path") -eq [Microsoft.Win32.RegistryValueKind]::String) {
                $kind = [Microsoft.Win32.RegistryValueKind]::String
            }
        } catch {
        }
        $key.SetValue("Path", $newPath, $kind)
        Send-EnvironmentChange
        Write-Success "已将快捷指令目录加入用户 PATH：$PathToAdd"
    } finally {
        $key.Close()
    }
}

function Write-Launcher {
    param(
        [string]$AppDir,
        [string]$LauncherDir
    )
    New-Item -ItemType Directory -Path $LauncherDir -Force | Out-Null
    $cliSource = Join-Path $AppDir "scripts/cloudvm.ps1"
    $cliTarget = Join-Path $LauncherDir "cloudvm.ps1"
    if (Test-Path -LiteralPath $cliSource) {
        Copy-Item -LiteralPath $cliSource -Destination $cliTarget -Force
    } else {
        $cliUrl = "https://raw.githubusercontent.com/{0}/{1}/scripts/cloudvm.ps1" -f $Repository, $Branch
        Invoke-Download -Url $cliUrl -OutFile $cliTarget
    }
    $cmdPath = Join-Path $LauncherDir "cloudvm.cmd"
    $cmdContent = @"
@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0cloudvm.ps1" %*
"@
    Set-Content -LiteralPath $cmdPath -Value $cmdContent -Encoding ASCII
    return $cmdPath
}

function Write-Config {
    param(
        [string]$AppDir,
        [string]$LauncherDir,
        [string]$NodePath,
        [string]$NpmPath,
        [string]$InstallMode
    )
    $configPath = Join-Path (Get-CloudVmHome) "config.json"
    $cliPath = Join-Path $LauncherDir "cloudvm.ps1"
    $scriptVersion = ""
    if (Test-Path -LiteralPath $cliPath) {
        $cliText = Get-Content -LiteralPath $cliPath -Raw
        if ($cliText -match '\$ScriptVersion\s*=\s*"([^"]+)"') {
            $scriptVersion = $matches[1]
        }
    }
    $config = [pscustomobject]@{
        appDir = $AppDir
        launcherDir = $LauncherDir
        nodePath = $NodePath
        npmPath = $NpmPath
        repository = $Repository
        branch = $Branch
        installMode = $InstallMode
        installed = $true
        installerVersion = $InstallerVersion
        scriptVersion = $scriptVersion
        installedAt = (Get-Date).ToString("o")
    }
    $config | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
}

$scriptRoot = $PSScriptRoot
if (-not $scriptRoot) {
    $scriptRoot = (Get-Location).Path
}
$localRepo = Test-LocalRepo -Path $scriptRoot
$homeDir = Get-CloudVmHome
$launcherDir = Join-Path $homeDir "bin"
$runtimeDir = Join-Path $homeDir "runtime"

if ($InstallDir) {
    $targetDir = [System.IO.Path]::GetFullPath($InstallDir)
} elseif ($localRepo) {
    $targetDir = [System.IO.Path]::GetFullPath($scriptRoot)
} else {
    $targetDir = Join-Path $homeDir "app"
}

Write-Info "CloudVMController 安装程序 $InstallerVersion"
Write-Host "安装目录：$targetDir"

if ($localRepo) {
    if ([System.IO.Path]::GetFullPath($scriptRoot) -ne [System.IO.Path]::GetFullPath($targetDir)) {
        Write-Info "复制本地项目文件..."
        Copy-AppFiles -SourceRoot $scriptRoot -TargetRoot $targetDir
    }
} else {
    $existingApp = Test-Path -LiteralPath (Join-Path $targetDir "package.json")
    try {
        Install-AppArchive -TargetRoot $targetDir
    } catch {
        if ($existingApp -and -not $Force) {
            Write-Warn "下载最新版本失败，继续使用现有安装：$($_.Exception.Message)"
        } else {
            throw
        }
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $targetDir "package.json"))) {
    throw "安装目录缺少 package.json：$targetDir"
}

$nodeRuntime = Resolve-NodeRuntime -RuntimeDir $runtimeDir
Write-Host "Node.js：$($nodeRuntime.NodePath)"
Write-Host "npm：$($nodeRuntime.NpmPath)"

if (-not $SkipDeps) {
    Write-Info "安装项目依赖..."
    Push-Location -LiteralPath $targetDir
    try {
        & $nodeRuntime.NpmPath ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            & $nodeRuntime.NpmPath install --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) {
                throw "npm 依赖安装失败。"
            }
        }
    } finally {
        Pop-Location
    }
}

$cmdPath = Write-Launcher -AppDir $targetDir -LauncherDir $launcherDir

if (Test-Path -LiteralPath (Join-Path $targetDir ".git")) {
    $installMode = "git"
} else {
    $installMode = "zip"
}

Write-Config -AppDir $targetDir -LauncherDir $launcherDir -NodePath $nodeRuntime.NodePath -NpmPath $nodeRuntime.NpmPath -InstallMode $installMode

if (-not $NoPath) {
    Add-UserPath -PathToAdd $launcherDir
}

Write-Host ""
Write-Success "安装完成。"
Write-Host "安装目录：$targetDir"
Write-Host "配置目录：$homeDir"
Write-Host "快捷指令：$cmdPath"
Write-Host "更新模式：$installMode"
Write-Host ""
Write-Host "可用命令："
Write-Host "  cloudvm            启动并打开浏览器"
Write-Host "  cloudvm status     查看状态"
Write-Host "  cloudvm update     更新软件"
Write-Host "  cloudvm update-script  更新 cloudvm 脚本"

if ($NoPath) {
    Write-Warn "已跳过 PATH 修改。可直接运行：$cmdPath"
} else {
    Write-Host "请打开新的终端窗口，然后运行 cloudvm。"
}

if (-not $NoLaunch) {
    Write-Host ""
    & (Join-Path $launcherDir "cloudvm.ps1") start
}
