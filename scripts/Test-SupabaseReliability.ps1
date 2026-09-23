$ErrorActionPreference = 'Stop'
$scriptFile = Join-Path $PSScriptRoot 'test-supabase-live.js'
$nodePath = 'C:\Users\nuppa\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
    $nodePath = (Get-Command node -ErrorAction Stop).Source
}
Write-Host 'This opt-in test uses ONLY the two existing disposable Supabase QA accounts.'
Write-Host 'It temporarily edits QA A, restores its starting CRM contents when safe, and consumes at most one synthetic chat. No OpenAI or Render changes.'
Write-Host 'First give QA A exactly one remaining slot. Keep both QA accounts idle while this runs; allow about six minutes.'
if ((Read-Host 'Type TEST to authorize these QA-only requests') -cne 'TEST') { Write-Host 'Cancelled. No requests sent.'; return }
$passwordA = Read-Host 'QA A temporary password (hidden)' -AsSecureString
$passwordB = Read-Host 'QA B temporary password (hidden)' -AsSecureString
$pointerA = [IntPtr]::Zero
$pointerB = [IntPtr]::Zero
$process = $null
$started = $false
try {
    $pointerA = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($passwordA)
    $pointerB = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($passwordB)
    $payload = @{
        authorization = 'TEST'
        runId = '60abf0b7-1d6c-402b-8297-dbce9727580b'
        publishableKey = 'sb_publishable_QTpUkzDxazN6L0DUhEfcwg_QthMCwGV'
        a = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointerA)
        b = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointerB)
    } | ConvertTo-Json -Compress
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $nodePath
    $info.Arguments = '"' + $scriptFile + '" --approved-qa'
    $info.WorkingDirectory = Split-Path -Parent $PSScriptRoot
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.EnvironmentVariables.Clear()
    foreach ($name in @('SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP')) {
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
        if ($line -match '^(PASS:|FAIL:|WAIT:|HOSTED RELIABILITY|Restore QA)') { Write-Host $line }
    }
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { Write-Host 'FAIL: Reliability runner did not complete. Raw diagnostic details were withheld.' }
} catch {
    Write-Host 'FAIL: Could not complete the private runner. No passwords or raw exception details were printed.'
} finally {
    $payload = $null
    if ($pointerA -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointerA) }
    if ($pointerB -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointerB) }
    $passwordA.Dispose(); $passwordB.Dispose()
    if ($process) {
        if ($started -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
        $process.Dispose()
    }
}
