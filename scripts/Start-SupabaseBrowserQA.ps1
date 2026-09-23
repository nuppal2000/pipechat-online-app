param([switch]$RestoredReadOnly)
$ErrorActionPreference = 'Stop'

# Public project configuration only. Account passwords stay in the browser.
$node = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$runner = Join-Path $PSScriptRoot 'start-supabase-browser-qa.js'
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
    throw 'The bundled Node executable was not found. No QA server was started.'
}
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) {
    throw 'The QA JavaScript runner was not found. No QA server was started.'
}
if ($RestoredReadOnly) {
    Write-Host 'Open the restored QA project through a localhost-only app. Existing QA accounts only.'
    Write-Host 'CRM/schema/usage writes, new accounts and AI calls are blocked. Sign in with original QA passwords in the browser.'
    Write-Host 'Authentication creates/refreshes/revokes test sessions and can update login metadata. No source or live app changes.'
    if ((Read-Host 'Type RESTORELOGIN to authorize this restored-account check') -cne 'RESTORELOGIN') { Write-Host 'Cancelled.'; return }
}

$previousUrl = $env:SUPABASE_URL
$previousKey = $env:SUPABASE_PUBLISHABLE_KEY
$previousRun = $env:PIPECHAT_QA_RUN_ID
$previousRestore = $env:PIPECHAT_SUPABASE_RESTORE_QA
try {
    $env:SUPABASE_URL = 'https://nzktondjxxxiezkbrhdo.supabase.co'
    $env:SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_QTpUkzDxazN6L0DUhEfcwg_QthMCwGV'
    $env:PIPECHAT_QA_RUN_ID = '60abf0b7-1d6c-402b-8297-dbce9727580b'
    $env:PIPECHAT_SUPABASE_RESTORE_QA = '0'
    if ($RestoredReadOnly) {
        $env:SUPABASE_URL = 'https://pznjcsscfthondvvdljq.supabase.co'
        $env:SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_VhMykcdVFgzJMQDPicBwIw_SH4OaXl9'
        $env:PIPECHAT_SUPABASE_RESTORE_QA = '1'
    }
    & $node $runner --approved-qa
    if ($LASTEXITCODE -ne 0) { throw 'QA startup or shutdown failed. No live app settings were changed.' }
} finally {
    $env:SUPABASE_URL = $previousUrl
    $env:SUPABASE_PUBLISHABLE_KEY = $previousKey
    $env:PIPECHAT_QA_RUN_ID = $previousRun
    $env:PIPECHAT_SUPABASE_RESTORE_QA = $previousRestore
}
