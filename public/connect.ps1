# Connects this Windows computer to Stazione with one command, copied from the station's Account page:
#   & ([scriptblock]::Create((irm 'https://<station>/connect.ps1'))) 'https://<station>' '<connection code>'
# It downloads the agent client from the station, trades the single-use code for the token (kept encrypted for this
# Windows user, never shown), writes the protocol for the coding agent in the folder of your projects and tests the
# connection. Nothing else is installed. Run it in the folder that holds your projects.
param([string]$Url, [string]$Code)

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }

try {
  $ErrorActionPreference = 'Stop'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  Say "`n=== STAZIONE: connecting this computer ===`n" 'Yellow'

  $Url = "$Url".Trim().TrimEnd('/')
  if ($Url -notmatch '^(https://[^\s/]+|http://(localhost|127\.0\.0\.1)(:\d+)?)$') { throw 'The command is incomplete: copy it again from the Account page of the station.' }
  if ("$Code" -notmatch '^stzc_[A-Za-z0-9_-]{20,30}$') { throw 'The connection code is missing: copy the command again from the Account page of the station.' }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js is not installed. Download it from https://nodejs.org (LTS version), install it, open a new PowerShell and run the command again.'
  }

  # 1. Which agent works here: it decides the protocol file (same rules, the file name each agent reads)
  Say 'Which coding agent will work on this computer?'
  Say '  1) Claude Code  (writes CLAUDE.md)'
  Say '  2) Codex, or another agent that reads AGENTS.md'
  $kind = ''
  while ($kind -notin @('1', '2')) { $kind = "$(Read-Host 'Choose 1 or 2')".Trim() }
  if ($kind -eq '1') { $file = 'CLAUDE.md'; $template = 'CLAUDE.template.md'; $key = 'CLAUDE' }
  else { $file = 'AGENTS.md'; $template = 'AGENTS.template.md'; $key = 'AGENT' }

  # 2. Name of the instance
  $name = ''
  while ($name.Trim().Length -lt 2 -or $name.Trim().Length -gt 40) { $name = Read-Host 'What is your agent called? (e.g. Atlas)' }
  $name = $name.Trim()
  $id = ($name.ToLower() -replace '[^a-z0-9]+', '-').Trim('-')
  if ($id.Length -lt 2) { $id = "agent-$id" }
  if ($id.Length -gt 40) { $id = $id.Substring(0, 40).Trim('-') }
  Say "Identity: $name  (id: $id)" 'Cyan'

  # 3. Folder of the projects: the protocol goes there, so the agent finds it in every project inside it
  $here = (Get-Location).Path
  $answer = Read-Host "`nFolder that holds your projects [$here]"
  $projects = if ("$answer".Trim()) { "$answer".Trim().Trim('"') } else { $here }
  if (-not (Test-Path -LiteralPath $projects -PathType Container)) { throw "The folder $projects does not exist." }
  $target = Join-Path $projects $file

  # 4. The client and the protocol template, from this station
  $dir = Join-Path $env:APPDATA 'stazione'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $cli = Join-Path $dir 'stazione.mjs'
  Invoke-WebRequest -UseBasicParsing -Uri "$Url/stazione.mjs" -OutFile $cli
  $text = (Invoke-WebRequest -UseBasicParsing -Uri "$Url/$template").Content
  if ($text -is [byte[]]) { $text = [Text.Encoding]::UTF8.GetString($text) }

  # 5. The token, once, in exchange for the code; encrypted for this Windows user only (DPAPI), never in plain text
  try { $claim = Invoke-RestMethod -Method Post -Uri "$Url/api/connect/claim" -ContentType 'application/json' -Body (@{ code = $Code } | ConvertTo-Json) }
  catch {
    $msg = $null
    try { $msg = ($_.ErrorDetails.Message | ConvertFrom-Json).error } catch { }
    if (-not $msg) { $msg = $_.Exception.Message }
    throw "The station refused the code: $msg"
  }
  $enc = ConvertTo-SecureString $claim.token -AsPlainText -Force | ConvertFrom-SecureString
  [IO.File]::WriteAllText((Join-Path $dir 'token.dpapi'), $enc)
  $claim = $null; Remove-Variable enc
  [Environment]::SetEnvironmentVariable('STAZIONE_URL', $Url, 'User')
  $env:STAZIONE_URL = $Url
  if ([Environment]::GetEnvironmentVariable('STAZIONE_TOKEN', 'User')) { [Environment]::SetEnvironmentVariable('STAZIONE_TOKEN', $null, 'User') }
  Remove-Item Env:STAZIONE_TOKEN -ErrorAction SilentlyContinue
  Say "`nToken saved encrypted for your Windows user." 'Green'

  # 6. The protocol file with this computer's identity
  $cliPath = $cli -replace '\\', '/'
  $text = $text -replace "(?m)^$($key)_NAME\s*=.*$", "$($key)_NAME  = `"$name`""
  $text = $text -replace "(?m)^$($key)_ID\s*=.*$", "$($key)_ID    = `"$id`""
  $text = $text -replace '(?m)^STAZIONE_CLI\s*=.*$', "STAZIONE_CLI = `"$cliPath`""
  if (Test-Path -LiteralPath $target) { Copy-Item -LiteralPath $target "$target.bak" -Force; Say "The existing $file was saved as $file.bak" 'DarkGray' }
  [IO.File]::WriteAllText($target, $text, (New-Object System.Text.UTF8Encoding($false)))
  Say "Protocol written to $target" 'Green'

  # 7. Connection test
  Say "`nConnecting to the station..."
  $out = & node $cli hello --as $id --name $name 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    if ($out -match 'another user') { throw "The name '$name' is already used by another user. Run the command again with a new token and another name." }
    throw "Connection failed:`n$out"
  }
  Say "`nDONE! $name is on board Stazione." 'Green'
  Say "`nLast step: close your coding agent completely and open it again in $projects (or in a project inside it), then tell it: connect to the station" 'Yellow'
}
catch {
  Say "`n$($_.Exception.Message)" 'Red'
}
