param([switch]$ConnectionsOnly, [string]$VerifyBackup, [string]$RollbackBackup)
$ErrorActionPreference = 'Stop'
if (@(@($ConnectionsOnly.IsPresent, [bool]$VerifyBackup, [bool]$RollbackBackup) | Where-Object { $_ }).Count -gt 1) { throw 'Choose only one of ConnectionsOnly, VerifyBackup or RollbackBackup.' }
$scriptFile = Join-Path $PSScriptRoot 'supabase-restore-qa.cjs'
$nodePath = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { $nodePath = (Get-Command node -ErrorAction Stop).Source }
$consentWord = 'RESTORE'
if ($ConnectionsOnly) {
    $consentWord = 'CHECK'
    Write-Host 'READ-ONLY: connect once to each fixed Supabase project and run SELECT 1.'
    Write-Host 'Certificate/hostname verification stays enabled. No exports, restore, data reads/writes or deployment.'
} elseif ($VerifyBackup) {
    $consentWord = 'VERIFY'
    Write-Host 'READ-ONLY: verify the existing Restore QA database against the specified private backup.'
    Write-Host 'Both DATABASE passwords are needed. The source schema is read only to validate the original baseline.'
    Write-Host 'No backup replay, exports, data/schema changes, rollback probes, OpenAI calls or deployment.'
    Write-Host 'Keep both QA accounts idle. Do not reset or rerun a restore into this populated destination.'
} elseif ($RollbackBackup) {
    $consentWord = 'ROLLBACK'
    Write-Host 'QA ONLY: verify the existing restored database against this private backup, then test forced rollbacks.'
    Write-Host 'The source connection closes before any probes. Only PipeChat Restore QA receives temporary test writes.'
    Write-Host 'Deliberate constraint failures test CRM saves and chat accounting; an outer rollback removes all test changes.'
    Write-Host 'Full Auth/CRM/schema/permissions/sequence checks follow. No restore replay, OpenAI calls or deployment.'
    Write-Host 'Keep both QA accounts idle. Do not reset or restore into the populated destination.'
} else {
    Write-Host 'Read-only backup: Neelam and Ravi''s Project (nzktondjxxxiezkbrhdo).'
    Write-Host 'Restore and deliberate rollback tests: EMPTY PipeChat Restore QA (pznjcsscfthondvvdljq) ONLY.'
    Write-Host 'This copies disposable Auth accounts/password hashes, CRM data and quotas to that separate project.'
    Write-Host 'The backup is private under your Local AppData, outside GitHub. It is sensitive and must be secured afterward.'
    Write-Host 'No source writes, OpenAI calls, Render deployment or database switch. Keep both QA accounts idle.'
}
if ((Read-Host "Type $consentWord to authorize this exact test") -cne $consentWord) { Write-Host 'Cancelled.'; return }
$source = Read-Host 'SOURCE project DATABASE password (hidden; not a QA account password)' -AsSecureString
$target = Read-Host 'RESTORE QA project DATABASE password (hidden)' -AsSecureString
$pointerSource = [IntPtr]::Zero
$pointerTarget = [IntPtr]::Zero
$process = $null
$started = $false
try {
    $pointerSource = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($source)
    $pointerTarget = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($target)
    $payload = @{
        authorization = $consentWord
        sourceRef = 'nzktondjxxxiezkbrhdo'
        targetRef = 'pznjcsscfthondvvdljq'
        sourcePassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointerSource)
        targetPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointerTarget)
        backupDirectory = $(if ($RollbackBackup) { $RollbackBackup } else { $VerifyBackup })
    } | ConvertTo-Json -Compress
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $nodePath
    $info.Arguments = '"' + $scriptFile + '" --approved-qa'
    if ($ConnectionsOnly) { $info.Arguments += ' --connections-only' }
    if ($VerifyBackup) { $info.Arguments += ' --verify-only' }
    if ($RollbackBackup) { $info.Arguments += ' --rollback-only' }
    $info.WorkingDirectory = Split-Path -Parent $PSScriptRoot
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.EnvironmentVariables.Clear()
    foreach ($name in @('SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'USERDOMAIN', 'USERNAME')) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($value) { $info.EnvironmentVariables[$name] = $value }
    }
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    [void]$process.Start()
    $started = $true
    $privateErrors = $process.StandardError.ReadToEndAsync()
    $process.StandardInput.WriteLine($payload)
    $process.StandardInput.Close()
    $payload = $null
    while (-not $process.StandardOutput.EndOfStream) {
        $line = $process.StandardOutput.ReadLine()
        if ($line -match '^(PASS:|FAIL:|BACKUP:|RESTORE DATABASE)') { Write-Host $line }
    }
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
        if ($ConnectionsOnly) { Write-Host 'FAIL: Share status lines only. Do not run a restore yet.' }
        elseif ($VerifyBackup) { Write-Host 'FAIL: Read-only verification stopped. Share status lines only; do not reset or rerun the restore.' }
        elseif ($RollbackBackup) { Write-Host 'FAIL: QA rollback verification stopped. Share status lines only; do not reset or rerun the restore.' }
        else { Write-Host 'FAIL: Stop and share only status lines. Do not reset or rerun the restore destination.' }
    }
} catch {
    Write-Host 'FAIL: Private runner failed. Passwords and raw errors were not printed.'
} finally {
    $payload = $null
    if ($pointerSource -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointerSource) }
    if ($pointerTarget -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointerTarget) }
    $source.Dispose(); $target.Dispose()
    if ($process) {
        if ($started -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
        $process.Dispose()
    }
}
