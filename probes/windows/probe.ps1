<#
.SYNOPSIS
  Measures, on a Windows machine, what Agent Frontdesk's Mac desktop driver relies on, before it is ported.
  See probes/windows/README.md for what each step answers and what to send back.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File probes\windows\probe.ps1
  (read-only: environment, data folders, deep links, pipes, windows, and a census of each app's page)

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File probes\windows\probe.ps1 -Step settle -Engine claude
  (run it first, then start Claude: how long its page takes to reach UI Automation)

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File probes\windows\probe.ps1 -Step census -Label minimized
  (the same census, with the window minimized / covered / on another virtual desktop beforehand)

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File probes\windows\probe.ps1 -Step act -Engine claude -Scenario menu
  (presses controls in the app: use a test chat, see README)
#>
[CmdletBinding()]
param(
    [ValidateSet('read', 'settle', 'census', 'act', 'link')] [string]$Step = 'read',
    [ValidateSet('claude', 'codex')] [string[]]$Engine = @('claude', 'codex'),
    [string]$Hwnd,
    [string]$Label = 'as-is',
    [int]$SettleSeconds = 30,
    [ValidateSet('fill', 'menu', 'submenu', 'focus', 'refresh')] [string]$Scenario,
    [string]$Link,
    [switch]$Names,
    [switch]$Yes
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$profiles = Join-Path $repo 'src\server\native\profiles'
$runName = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $Step
$outDir = Join-Path $PSScriptRoot ('out\' + $runName)
# The helper (.NET Framework) and Windows PowerShell cannot write past MAX_PATH (260) unless long paths are
# switched on, so a checkout deep in the tree writes its results under %LOCALAPPDATA% instead.
if ($outDir.Length + 50 -ge 260) { $outDir = Join-Path $env:LOCALAPPDATA ('agent-frontdesk\probe\out\' + $runName) }
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$script:counter = 0
$script:summary = New-Object System.Collections.Generic.List[string]

# Which windows are whose: the desktop app's own window is a Chromium one (Claude Code's CLI is a
# claude.exe too, without one). Pass -Hwnd with a single -Engine where the guess is wrong.
$engines = @{
    claude = @{ exe = '^claude\.exe$'; profile = 'claude.json'; probeText = 'Frontdesk probe: not sent' }
    codex  = @{ exe = 'codex|chatgpt'; profile = 'codex.json'; probeText = 'Frontdesk probe: not sent' }
}

function Say([string]$line) { Write-Host $line; $script:summary.Add($line) }
function Hide-Home([string]$path) { if ($path -and $env:USERPROFILE) { return $path.Replace($env:USERPROFILE, '~') } return $path }
function Save([string]$name, $object) {
    $script:counter++
    $file = Join-Path $outDir ('{0:d2}-{1}.json' -f $script:counter, $name)
    $object | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $file -Encoding UTF8
}

# ---- the helper: compiled once per source version with the csc.exe Windows ships ----
function Get-Helper {
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if (-not (Test-Path -LiteralPath $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
    if (-not (Test-Path -LiteralPath $csc)) { throw 'csc.exe of .NET Framework 4.x not found under %WINDIR%\Microsoft.NET' }
    $source = Join-Path $PSScriptRoot 'uia-probe.cs'
    $hash = (Get-FileHash -LiteralPath $source -Algorithm SHA1).Hash.Substring(0, 12).ToLowerInvariant()
    $cache = Join-Path $env:LOCALAPPDATA 'agent-frontdesk\probe'
    New-Item -ItemType Directory -Force -Path $cache | Out-Null
    $exe = Join-Path $cache ('uia-probe-' + $hash + '.exe')
    if (-not (Test-Path -LiteralPath $exe)) {
        $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        try {
            $compiler = & $csc /nologo /target:exe /langversion:5 /platform:anycpu /optimize+ /codepage:65001 ('/out:' + $exe) `
                /reference:System.dll /reference:System.Core.dll /reference:System.Web.Extensions.dll $source 2>&1 | Out-String
        } finally { $ErrorActionPreference = $old }
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $exe)) { throw ("csc.exe failed:`n" + $compiler) }
    }
    return $exe
}
$script:helper = Get-Helper

function Probe([string]$name, [string[]]$probeArgs) {
    $script:counter++
    $file = Join-Path $outDir ('{0:d2}-{1}.json' -f $script:counter, $name)
    $all = @($probeArgs) + @('--out', $file)
    if ($Names) { $all += '--names' }
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $printed = & $script:helper @all 2>&1 | Out-String } finally { $ErrorActionPreference = $old }
    if (-not (Test-Path -LiteralPath $file)) {
        $first = ($printed -split "`r?`n" | Select-Object -First 1)
        throw ('the helper wrote no answer for ' + $name + ' (exit ' + $LASTEXITCODE + '): ' + $first)
    }
    return (Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json)
}

function Find-Window([string]$engine, $listing) {
    # $script:, because PowerShell names are case-blind and dynamically scoped: a bare $Hwnd here is the
    # caller's own $hwnd, still holding the window found for the previous engine.
    if ($script:Hwnd) { return $script:Hwnd }
    $pattern = $engines[$engine].exe
    $candidates = @($listing.windows | Where-Object { $_.exe -match $pattern -and $_.class -like 'Chrome_WidgetWin*' -and $_.title.length -gt 0 })
    if ($candidates.Count -eq 0) { return $null }
    # A visible window before a hidden one (Codex keeps a hidden one titled like its main window), then by size;
    # a minimized window's rect is only its caption, so it is not compared by size.
    return ($candidates | Sort-Object @{ e = { $_.visible }; d = $true }, @{ e = { -not $_.minimized }; d = $true }, @{ e = { $_.rect[2] * $_.rect[3] }; d = $true } | Select-Object -First 1).hwnd
}
function Profile-Of([string]$engine) { return (Join-Path $profiles $engines[$engine].profile) }

# ---- what a census says, in a few lines ----
function Show-Census([string]$engine, $c) {
    if (-not $c.ok) { Say ('  census failed: ' + $c.code + ' ' + $c.error); return }
    $w = $c.window
    Say ('== {0} [{1}] window {2} {3} title "...{4}" visible={5} minimized={6} cloaked={7} onCurrentDesktop={8} integrity={9}' -f `
        $engine, $c.label, $w.hwnd, $w.exe, $w.title.suffix, $w.visible, $w.minimized, $w.cloaked, $w.onCurrentDesktop, $w.integrity)
    Say ('  page: {0} nodes, read in {1} ms, one round trip={2}, truncated={3}' -f $c.page.nodes, $c.page.readMs, $c.page.oneRoundTrip, $c.page.truncated)
    $m = $c.marks
    Say ('  marks on web nodes: className {0}/{1}  automationId {2}  acceleratorKey {3}  ariaRole {4}  ariaProperties {5} (with haspopup {6})  isDialog {7}' -f `
        $m.className.count, $m.className.of, $m.automationId.count, $m.acceleratorKey.count, $m.ariaRole.count, $m.ariaProperties.count, $m.ariaPropertiesWithHaspopup.count, $m.isDialog.count)
    $p = $c.patterns
    Say ('  patterns: invoke {0}  expandCollapse {1}  value {2}  rangeValue {3}  scrollItem {4}  toggle {5}  selectionItem {6}  legacy {7}; buttons {8} (with expandCollapse {9}, invoke {10}); menu rows with expandCollapse {11}' -f `
        $p.invoke, $p.expandCollapse, $p.value, $p.rangeValue, $p.scrollItem, $p.toggle, $p.selectionItem, $p.legacyIAccessible, $p.buttons, $p.buttonsWithExpandCollapse, $p.buttonsWithInvoke, $p.menuItemsWithExpandCollapse)
    if ($c.PSObject.Properties['profile']) {
        $pr = $c.profile
        $tokens = @($pr.profileClassTokens.PSObject.Properties | ForEach-Object { $_.Name + '=' + $_.Value })
        Say ('  the profile''s DOM classes seen: ' + ($tokens -join '  '))
        $found = @(); $byLater = @()
        foreach ($l in $pr.locators.PSObject.Properties) {
            if ($l.Value.found -gt 0) { if ($l.Value.by -eq 0) { $found += $l.Name } else { $byLater += ($l.Name + '(way ' + $l.Value.by + ')') } }
        }
        Say ('  locators found by their first way: ' + ($found -join ', '))
        Say ('  found only by a later way: ' + ($byLater -join ', '))
        Say ('  not found: ' + (@($pr.missing) -join ', '))
        if (@($pr.several.PSObject.Properties).Count -gt 0) { Say ('  several answer (an action would be held back): ' + (@($pr.several.PSObject.Properties | ForEach-Object { $_.Name + '=' + $_.Value }) -join ', ')) }
        if (@($pr.unmappedRoles).Count -gt 0) { Say ('  Mac roles with no Windows counterpart yet: ' + (@($pr.unmappedRoles) -join ', ')) }
    }
}

function Confirm-Act([string]$what) {
    Say ('This step ' + $what + '.')
    if ($Yes) { return }
    $answer = Read-Host 'Use a test conversation with an empty composer. Type yes to go on'
    if ($answer -ne 'yes') { Say 'Stopped: nothing was done.'; exit 0 }
}

function Act([string]$engine, [string]$hwnd, [string]$name, [string[]]$actArgs) {
    $r = Probe ($engine + '-act-' + $name) (@('act', '--hwnd', $hwnd, '--profile', (Profile-Of $engine)) + $actArgs)
    $line = '  {0}: ok={1} used={2}' -f $name, $r.ok, $(if ($r.PSObject.Properties['used']) { $r.used } else { '' })
    if ($r.PSObject.Properties['code'] -and $r.code) { $line += ' code=' + $r.code }
    if ($r.PSObject.Properties['refused'] -and $r.refused) { $line += ' (' + $r.refused + ')' }
    if ($r.PSObject.Properties['error'] -and $r.error) { $line += ' error=' + $r.error }
    if ($r.PSObject.Properties['after']) {
        $line += ('  menu rows {0}->{1}  foregroundChanged={2} cameForward={3}' -f $r.before.menuItems, $r.after.menuItems, $r.foregroundChanged, $r.targetCameForward)
        # Being the foreground window is not the same as being drawn on top: say which window covers the target's centre.
        if ($r.before.PSObject.Properties['onTop'] -and $r.before.onTop -and $r.after.onTop) { $line += ('  on top {0}->{1}' -f $r.before.onTop.exe, $r.after.onTop.exe) }
        if ($r.after.PSObject.Properties['watch']) { $line += ('  {0}: {1}->{2}' -f $r.after.watch.locator, $r.before.watch.found, $r.after.watch.found) }
        if ($r.PSObject.Properties['valueTookExactly']) { $line += '  value took=' + $r.valueTookExactly }
    }
    Say $line
    return $r
}

# ---- read: everything that presses nothing ----
function Step-Read {
    $os = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    $net = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -ErrorAction SilentlyContinue)
    $envFacts = [ordered]@{
        os = ('{0} {1} build {2}.{3}' -f $os.ProductName, $(if ($os.PSObject.Properties['DisplayVersion']) { $os.DisplayVersion } else { $os.ReleaseId }), $os.CurrentBuild, $os.UBR)
        uiCulture = (Get-UICulture).Name; powershell = $PSVersionTable.PSVersion.ToString(); netRelease = $(if ($net) { $net.Release } else { $null })
        helper = (Hide-Home $script:helper)
    }
    Save 'env' $envFacts
    Say ('OS {0}; UI language {1}; PowerShell {2}; .NET release {3}' -f $envFacts.os, $envFacts.uiCulture, $envFacts.powershell, $envFacts.netRelease)

    # Where the data the console reads lives on Windows (names only, nothing is read from inside).
    $u = $env:USERPROFILE
    $places = [ordered]@{}
    foreach ($p in @("$env:APPDATA\Claude", "$env:APPDATA\Claude\claude-code", "$env:LOCALAPPDATA\AnthropicClaude", "$env:LOCALAPPDATA\Programs\Claude",
            "$u\.claude", "$u\.claude\projects", "$u\.codex", "$u\.codex\ipc", "$u\.codex\sessions", "$env:APPDATA\Codex", "$env:LOCALAPPDATA\Codex",
            "$env:LOCALAPPDATA\Programs\Antigravity", "$u\.gemini\antigravity")) {
        if (Test-Path -LiteralPath $p) {
            $kids = @(Get-ChildItem -LiteralPath $p -Force -ErrorAction SilentlyContinue)
            $shown = if ($p -like '*\projects' -or $p -like '*\sessions') { @() } else { @($kids | Select-Object -First 40 | ForEach-Object { $_.Name }) }
            $places[(Hide-Home $p)] = [ordered]@{ entries = $kids.Count; names = $shown }
        } else { $places[(Hide-Home $p)] = $null }
    }
    $clis = [ordered]@{}
    foreach ($c in @('claude', 'codex', 'agy', 'antigravity')) { $cmd = Get-Command $c -ErrorAction SilentlyContinue; $clis[$c] = $(if ($cmd) { Hide-Home $cmd.Source } else { $null }) }
    $packages = @(Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'claude|anthropic|codex|openai|chatgpt|antigravity' } |
            ForEach-Object { [ordered]@{ name = $_.Name; version = $_.Version.ToString(); family = $_.PackageFamilyName; location = (Hide-Home $_.InstallLocation) } })
    Save 'paths' ([ordered]@{ places = $places; clis = $clis; packages = $packages })
    Say ('Data folders present: ' + (@($places.Keys | Where-Object { $places[$_] }) -join ', '))
    Say ('CLIs: ' + (@($clis.Keys | ForEach-Object { $_ + '=' + $clis[$_] }) -join '  '))
    Say ('Packaged (MSIX) apps: ' + (@($packages | ForEach-Object { $_.name + ' ' + $_.version }) -join ', '))

    # Deep links the Mac flows open with `open -g` (claude://..., codex://threads/wake/...).
    $links = [ordered]@{}
    foreach ($scheme in @('claude', 'codex', 'chatgpt', 'antigravity')) {
        $command = $null
        foreach ($hive in @('HKCU:\Software\Classes', 'HKLM:\Software\Classes')) {
            $key = Join-Path $hive ($scheme + '\shell\open\command')
            if (Test-Path -LiteralPath $key) { $command = (Get-Item -LiteralPath $key).GetValue(''); break }
        }
        $links[$scheme] = (Hide-Home $command)
    }
    # A packaged (MSIX) app declares its schemes in its manifest, not under Classes: list them per app, with
    # the AppUserModelID (family!app id) that starts it.
    $declared = @()
    foreach ($pkg in @(Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'claude|anthropic|codex|openai|chatgpt|antigravity' })) {
        $manifest = $null
        try { $manifest = $pkg | Get-AppxPackageManifest -ErrorAction Stop } catch { continue }
        if (-not $manifest -or -not $manifest.Package.PSObject.Properties['Applications']) { continue }
        foreach ($app in @($manifest.Package.Applications.Application)) {
            if (-not $app) { continue }
            $schemes = @()
            if ($app.PSObject.Properties['Extensions'] -and $app.Extensions) {
                $schemes = @(@($app.Extensions.Extension) | Where-Object { $_ -and $_.Category -eq 'windows.protocol' } | ForEach-Object { $_.Protocol.Name })
            }
            $declared += [ordered]@{ aumid = ($pkg.PackageFamilyName + '!' + $app.Id); exe = $app.Executable; protocols = $schemes }
        }
    }
    Save 'links' ([ordered]@{ registry = $links; packaged = $declared })
    Say ('Deep-link handlers: ' + (@($links.Keys | ForEach-Object {
                    $s = $_; $inManifest = @($declared | Where-Object { $_.protocols -contains $s }).Count -gt 0
                    $s + '=' + $(if ($links[$s]) { 'yes' } elseif ($inManifest) { 'yes(manifest)' } else { 'no' }) }) -join '  '))
    Say ('Packaged apps and their protocols: ' + (@($declared | ForEach-Object { $_.aumid + ' [' + ($_.protocols -join ',') + ']' }) -join ', '))

    # Codex's window-to-window router is ~/.codex/ipc/ipc.sock on the Mac; on Windows a named pipe.
    $pipes = @([System.IO.Directory]::GetFiles('\\.\pipe\') | ForEach-Object { $_.Substring(9) })
    $ours = @($pipes | Where-Object { $_ -match 'codex|claude|anthropic|openai|chatgpt|antigravity|codeium|ipc' })
    Save 'pipes' ([ordered]@{ total = $pipes.Count; matching = $ours })
    Say ('Named pipes that may be the apps'': ' + ($ours -join ', '))

    $listing = Probe 'windows' @('windows')
    Say ('This shell''s integrity: {0} ({1}-bit). Windows found: {2}' -f $listing.self.integrity, $listing.self.bits, @($listing.windows).Count)
    foreach ($w in @($listing.windows)) {
        Say ('  {0} {1} class={2} title "...{3}" visible={4} minimized={5} cloaked={6} packaged={7} integrity={8}' -f $w.hwnd, $w.exe, $w.class, $w.title.suffix, $w.visible, $w.minimized, $w.cloaked, $w.packaged, $w.integrity)
    }
    foreach ($engine in $Engine) {
        $hwnd = Find-Window $engine $listing
        if (-not $hwnd) { Say ('== ' + $engine + ': no desktop window found (is it running? pass -Hwnd with -Engine ' + $engine + ')'); continue }
        Show-Census $engine (Probe ($engine + '-census') @('census', '--hwnd', $hwnd, '--profile', (Profile-Of $engine), '--label', $Label))
    }
}

function Step-Census {
    $listing = Probe 'windows' @('windows')
    foreach ($engine in $Engine) {
        $hwnd = Find-Window $engine $listing
        if (-not $hwnd) { Say ('== ' + $engine + ': no desktop window found'); continue }
        Show-Census $engine (Probe ($engine + '-census') @('census', '--hwnd', $hwnd, '--profile', (Profile-Of $engine), '--label', $Label))
    }
}

# ---- settle: start this first, then the app ----
function Step-Settle {
    foreach ($engine in $Engine) {
        Say ('Waiting up to 120 s for the ' + $engine + ' desktop window: start the app now (quit it first if it was running).')
        $deadline = (Get-Date).AddSeconds(120); $hwnd = $null
        while (-not $hwnd -and (Get-Date) -lt $deadline) {
            $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
            try { $listing = (& $script:helper windows 2>$null | Out-String) | ConvertFrom-Json } finally { $ErrorActionPreference = $old }
            $hwnd = Find-Window $engine $listing
            if (-not $hwnd) { Start-Sleep -Milliseconds 300 }
        }
        if (-not $hwnd) { Say ('  no window appeared'); continue }
        $s = Probe ($engine + '-settle') @('settle', '--hwnd', $hwnd, '--seconds', [string]$SettleSeconds)
        $rows = @($s.timeline)
        $steps = @($rows | Where-Object { $_ } | ForEach-Object { '{0}s:{1}' -f [math]::Round($_[0] / 1000, 1), $_[1] })
        Say ('  first read {0} nodes; most {1} at {2} ms' -f $s.firstRead, $s.most, $s.mostAtMs)
        Say ('  ' + ($steps -join ' '))
        Show-Census $engine (Probe ($engine + '-census') @('census', '--hwnd', $hwnd, '--profile', (Profile-Of $engine), '--label', 'after-settle'))
    }
}

# ---- act: one scenario at a time, in a test conversation ----
function Step-Act {
    if (-not $Scenario) { throw '-Scenario fill|menu|submenu|focus|refresh is required with -Step act' }
    $listing = Probe 'windows' @('windows')
    foreach ($engine in $Engine) {
        $hwnd = Find-Window $engine $listing
        if (-not $hwnd) { Say ('== ' + $engine + ': no desktop window found'); continue }
        Say ('== ' + $engine + ' ' + $Scenario + ' on ' + $hwnd)
        $text = $engines[$engine].probeText
        switch ($Scenario) {
            'fill' {
                Confirm-Act 'writes a line into the composer and clears it again (Send is never pressed)'
                $null = Act $engine $hwnd 'fill' @('--locator', 'composer', '--do', 'setvalue', '--text', $text, '--watch', 'send')
                $null = Act $engine $hwnd 'clear' @('--locator', 'composer', '--do', 'clear', '--only-if-current', $text, '--watch', 'send')
            }
            'menu' {
                Confirm-Act 'opens the model menu under the composer and closes it'
                $null = Act $engine $hwnd 'open-model-menu' @('--locator', 'modelMenu', '--do', 'press')
                $c = Act $engine $hwnd 'collapse-model-menu' @('--locator', 'modelMenu', '--do', 'collapse')
                if ($c.PSObject.Properties['after'] -and $c.after.menuItems -gt 0) { $null = Act $engine $hwnd 'press-to-close' @('--locator', 'modelMenu', '--do', 'press') }
            }
            'submenu' {
                Confirm-Act 'opens the model menu, tries to open its submenu without keys, then closes the menu'
                $null = Act $engine $hwnd 'open-model-menu' @('--locator', 'modelMenu', '--do', 'press')
                if ($engine -eq 'claude') {
                    $e = Act $engine $hwnd 'expand-effort' @('--role', 'AXMenuItem', '--prefix', 'Effort', '--do', 'expand')
                    if (-not $e.ok) { $null = Act $engine $hwnd 'press-effort' @('--role', 'AXMenuItem', '--prefix', 'Effort', '--do', 'press') }
                    $null = Act $engine $hwnd 'expand-more-models' @('--role', 'AXMenuItem', '--prefix', 'More models', '--do', 'expand')
                } else {
                    $null = Act $engine $hwnd 'inspect-power' @('--locator', 'effortRow', '--do', 'inspect')
                    $null = Act $engine $hwnd 'expand-select-model' @('--locator', 'selectModelRow', '--do', 'expand')
                }
                $c = Act $engine $hwnd 'collapse-model-menu' @('--locator', 'modelMenu', '--do', 'collapse')
                if ($c.PSObject.Properties['after'] -and $c.after.menuItems -gt 0) { $null = Act $engine $hwnd 'press-to-close' @('--locator', 'modelMenu', '--do', 'press') }
            }
            'focus' {
                Confirm-Act 'gives the composer the keyboard focus through UI Automation (it may bring the app to the front)'
                $null = Act $engine $hwnd 'focus-composer' @('--locator', 'composer', '--do', 'focus')
            }
            'refresh' {
                Say 'Before this step: minimize the window, cover it with another one, or move it to another virtual desktop, and pass that as -Label.'
                Show-Census $engine (Probe ($engine + '-census-before') @('census', '--hwnd', $hwnd, '--profile', (Profile-Of $engine), '--label', ($Label + '-before')))
                $null = Act $engine $hwnd 'scroll-composer' @('--locator', 'composer', '--do', 'scroll', '--wait', '400')
                Show-Census $engine (Probe ($engine + '-census-after') @('census', '--hwnd', $hwnd, '--profile', (Profile-Of $engine), '--label', ($Label + '-after')))
            }
        }
    }
}

# ---- link: does opening a deep link bring the app to the front? ----
function Step-Link {
    if (-not $Link) { throw '-Link <url> is required with -Step link (for example a claude:// link to a test chat)' }
    Confirm-Act ('opens ' + $Link + ' the way the console would open it')
    $before = Probe 'fg-before' @('fg')
    Start-Process $Link
    Start-Sleep -Seconds 3
    $after = Probe 'fg-after' @('fg')
    Say ('Foreground before: {0} {1}; after: {2} {3}' -f $before.foreground.exe, $before.foreground.hwnd, $after.foreground.exe, $after.foreground.hwnd)
}

if ($Hwnd -and @($Engine).Count -ne 1) { throw '-Hwnd needs a single -Engine' }
switch ($Step) {
    'read' { Step-Read }
    'settle' { Step-Settle }
    'census' { Step-Census }
    'act' { Step-Act }
    'link' { Step-Link }
}
$script:summary | Set-Content -LiteralPath (Join-Path $outDir 'summary.txt') -Encoding UTF8
Write-Host ''
Write-Host ('Everything is in ' + $outDir + ' (summary.txt first). Look it over before sharing it.')
