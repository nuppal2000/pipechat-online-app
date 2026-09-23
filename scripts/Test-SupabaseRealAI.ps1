$ErrorActionPreference = 'Stop'
$scriptFile = Join-Path $PSScriptRoot 'test-supabase-real-ai.cjs'
$nodePath = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { $nodePath = (Get-Command node -ErrorAction Stop).Source }
Write-Host 'One real GPT-5.5 synthetic CSV mapping request, capped at 4,000 output tokens, with no retry.'
Write-Host 'This incurs an OpenAI API charge and one chat on disposable Supabase QA A if successful.'
Write-Host 'It runs the real app endpoint privately on localhost. CRM writes are disabled; no CSV import is confirmed.'
Write-Host 'Keep QA A idle. No Render deployment or account creation.'
if ((Read-Host 'Type AI to authorize this one paid preview') -cne 'AI') { Write-Host 'Cancelled.'; return }
$password = Read-Host 'Supabase QA A account password (hidden)' -AsSecureString
$key = Read-Host 'OpenAI API key (hidden; never paste into chat)' -AsSecureString
$pointerPassword = [IntPtr]::Zero
$pointerKey = [IntPtr]::Zero
$process = $null
$started = $false
try {
    $pointerPassword = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($password)
    $pointerKey = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($key)
    $payload = @{
        authorization = 'AI'
        password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointerPassword)
        key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointerKey)
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
        if ($line -match '^(PASS:|FAIL:|REAL AI)') { Write-Host $line }
    }
    $process.WaitForExit()
} catch {
    Write-Host 'FAIL: Private runner failed. No credentials or raw errors printed.'
} finally {
    $payload = $null
    if ($pointerPassword -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointerPassword) }
    if ($pointerKey -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointerKey) }
    $password.Dispose(); $key.Dispose()
    if ($process) {
        if ($started -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
        $process.Dispose()
    }
}
