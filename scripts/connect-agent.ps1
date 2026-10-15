# Connects this computer to Stazione: saves URL and token, writes the protocol for the coding agent (CLAUDE.md for
# Claude Code, AGENTS.md for Codex and the other agents that read it) and tests the connection.
# Started with a double click on "CONNECT AGENT.cmd" in the repository's main folder.
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot           # ...\stazione
$projects = Split-Path -Parent $repo               # folder that holds the projects
$cli = (Join-Path $repo 'client\stazione.mjs') -replace '\\', '/'

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Stop-Here($text) { Say "`n$text" 'Red'; Read-Host "`nPress Enter to close"; exit 1 }

Clear-Host
Say "=== STAZIONE: connecting this computer ===`n" 'Yellow'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Stop-Here "Node.js is not installed. Download it from https://nodejs.org (LTS version), install it and start this script again."
}

# 0. Address of the station (your deployment)
$Url = [Environment]::GetEnvironmentVariable('STAZIONE_URL', 'User')
$answer = Read-Host "Address of the station (e.g. https://your-station.vercel.app)$(if ($Url) { " [$Url]" })"
if ($answer.Trim()) { $Url = $answer.Trim() }
$Url = "$Url".TrimEnd('/')
if ($Url -notmatch '^https://[^\s/]+') { Stop-Here "The HTTPS address of the station is needed, e.g. https://your-station.vercel.app" }

# 1. Which agent works here: it decides the protocol file (same rules, the file name each agent reads)
Say "`nWhich coding agent will work on this computer?"
Say "  1) Claude Code  (writes CLAUDE.md)"
Say "  2) Codex, or another agent that reads AGENTS.md"
$kind = ''
while ($kind -notin @('1', '2')) { $kind = "$(Read-Host 'Choose 1 or 2')".Trim() }
if ($kind -eq '1') { $file = 'CLAUDE.md'; $template = Join-Path $repo 'docs\CLAUDE.template.md'; $key = 'CLAUDE' }
else { $file = 'AGENTS.md'; $template = Join-Path $repo 'docs\AGENTS.template.md'; $key = 'AGENT' }
$target = Join-Path $projects $file

# 2. Name of the instance
$name = ''
while ($name.Trim().Length -lt 2 -or $name.Trim().Length -gt 40) {
  $name = Read-Host 'What is your agent called? (e.g. Atlas)'
}
$name = $name.Trim()
$id = ($name.ToLower() -replace '[^a-z0-9]+', '-').Trim('-')
if ($id.Length -lt 2) { $id = "agent-$id" }
if ($id.Length -gt 40) { $id = $id.Substring(0, 40).Trim('-') }
Say "Identity: $name  (id: $id)" 'Cyan'

# 3. Token, read hidden: it never shows on screen or in the history
Say "`nOpen $Url/account, create a token and copy it."
$secure = Read-Host 'Paste the token here (it stays hidden while you paste) and press Enter' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr).Trim() }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
if ($token -notmatch '^stz_[A-Za-z0-9_-]{40,60}$') {
  Stop-Here "This does not look like a Stazione token (it must start with stz_). Copy it again from the Account page and retry."
}

# 4. The address as a user variable; the token encrypted for this Windows user only (DPAPI), never in plain text.
#    The client decrypts it when it starts (only this user, on this computer, can).
[Environment]::SetEnvironmentVariable('STAZIONE_URL', $Url, 'User')
$env:STAZIONE_URL = $Url
$dir = Join-Path $env:APPDATA 'stazione'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$enc = ConvertTo-SecureString $token -AsPlainText -Force | ConvertFrom-SecureString
[IO.File]::WriteAllText((Join-Path $dir 'token.dpapi'), $enc)
Remove-Variable token, enc
# Older versions kept the token in plain text in the user variables: remove it, or it would win over the encrypted one.
if ([Environment]::GetEnvironmentVariable('STAZIONE_TOKEN', 'User')) {
  [Environment]::SetEnvironmentVariable('STAZIONE_TOKEN', $null, 'User')
  Say "The old plain-text token in your Windows user variables was removed." 'DarkGray'
}
Remove-Item Env:STAZIONE_TOKEN -ErrorAction SilentlyContinue
Say "`nToken saved encrypted for your Windows user ($dir\token.dpapi)." 'Green'

# 5. The protocol file with this computer's identity
$text = [IO.File]::ReadAllText($template)
$text = $text -replace "(?m)^$($key)_NAME\s*=.*$", "$($key)_NAME  = `"$name`""
$text = $text -replace "(?m)^$($key)_ID\s*=.*$", "$($key)_ID    = `"$id`""
$text = $text -replace '(?m)^STAZIONE_CLI\s*=.*$', "STAZIONE_CLI = `"$cli`""
if (Test-Path $target) {
  Copy-Item $target "$target.bak" -Force
  Say "The existing $file was saved as $file.bak" 'DarkGray'
}
[IO.File]::WriteAllText($target, $text, (New-Object System.Text.UTF8Encoding($false)))
Say "Protocol written to $target" 'Green'

# 6. Connection test
Say "`nConnecting to the station..."
$out = & node $cli hello --as $id --name $name 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
  if ($out -match 'another user') { Stop-Here "The name '$name' is already used by another user. Start the script again and choose another one." }
  if ($out -match '401') { Stop-Here "Invalid or expired token. Create a new one from the Account page and start the script again." }
  Stop-Here "Connection failed:`n$out"
}
Say "`nDONE! $name is on board Stazione." 'Green'
Say "`nLast step: close your coding agent completely and open it again in $projects (or in a project inside it), then tell it: connect to the station" 'Yellow'
Read-Host "`nPress Enter to close"
