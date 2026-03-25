$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$workspace = Join-Path $root "e2e-fixtures\claude-code-workspace"
$logDir = Join-Path $root "e2e-logs"
$reportPath = Join-Path $logDir "live-e2e-report.md"
$results = New-Object System.Collections.Generic.List[object]

function Add-Result {
  param(
    [string]$Name,
    [bool]$Passed,
    [string]$Details
  )

  $results.Add([pscustomobject]@{
      Name = $Name
      Passed = $Passed
      Details = $Details
    })

  if ($Passed) {
    Write-Host "[PASS] $Name" -ForegroundColor Green
  } else {
    Write-Host "[FAIL] $Name :: $Details" -ForegroundColor Red
    throw "Live E2E failed at ${Name}: $Details"
  }
}

function Invoke-ClaudeText {
  param(
    [string]$Prompt,
    [string]$Workdir,
    [string[]]$ExtraArgs = @()
  )

  $env:ANTHROPIC_BASE_URL = "http://localhost:4000"
  $env:ANTHROPIC_API_KEY = "sk-ant-placeholder"
  Push-Location $Workdir
  try {
    $output = & claude -p --permission-mode bypassPermissions @ExtraArgs -- $Prompt 2>&1
  } finally {
    Pop-Location
  }
  if ($LASTEXITCODE -ne 0) {
    throw ($output -join "`n")
  }
  return ($output -join "`n").Trim()
}

function Invoke-ClaudeJson {
  param(
    [string]$Prompt,
    [string]$Workdir,
    [string[]]$ExtraArgs = @()
  )

  $text = Invoke-ClaudeText -Prompt $Prompt -Workdir $Workdir -ExtraArgs (@("--output-format", "json") + $ExtraArgs)
  return $text | ConvertFrom-Json
}

function Invoke-ClaudeStreamJson {
  param(
    [string]$Prompt,
    [string]$Workdir,
    [string[]]$ExtraArgs = @()
  )

  $env:ANTHROPIC_BASE_URL = "http://localhost:4000"
  $env:ANTHROPIC_API_KEY = "sk-ant-placeholder"
  Push-Location $Workdir
  try {
    $raw = & claude -p --verbose --permission-mode bypassPermissions --output-format stream-json --include-partial-messages @ExtraArgs -- $Prompt 2>&1
  } finally {
    Pop-Location
  }
  if ($LASTEXITCODE -ne 0) {
    throw ($raw -join "`n")
  }
  return $raw
}

function Assert-Contains {
  param(
    [string]$Haystack,
    [string]$Needle,
    [string]$Message
  )

  if (-not $Haystack.Contains($Needle)) {
    throw $Message
  }
}

function Normalize-PlainResult {
  param([string]$Text)

  if ($null -eq $Text) {
    return ""
  }

  return $Text.Trim().Trim([char]96).Trim()
}

function Wait-ForProxy {
  param([int]$TimeoutSeconds = 60)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing http://localhost:4000/health -TimeoutSec 5
      if ($response.Content -match '"status":"ok"') {
        return
      }
    } catch {
      Start-Sleep -Seconds 1
    }
  }

  throw "Proxy did not become healthy within $TimeoutSeconds seconds."
}

function Reset-WorkspaceArtifacts {
  $paths = @(
    (Join-Path $workspace ".claude\e2e-hook-log.jsonl"),
    (Join-Path $workspace ".claude\e2e-hook-log.txt"),
    (Join-Path $workspace ".mcp.json"),
    (Join-Path $workspace "todo-artifact.txt"),
    (Join-Path $workspace "hook-target.txt"),
    (Join-Path $workspace "mcp-tool-debug.txt"),
    (Join-Path $workspace "mcp-prompt-debug.txt"),
    (Join-Path $workspace "plugin-command-debug.txt"),
    (Join-Path $workspace "subagent-debug.txt"),
    (Join-Path $workspace "todo-debug.txt"),
    (Join-Path $workspace "hook-debug.txt"),
    (Join-Path $workspace "skill-debug.txt"),
    (Join-Path $workspace "agent-direct-debug.txt"),
    (Join-Path $workspace "resume-session-id.txt"),
    (Join-Path $workspace "resume-case")
  )

  foreach ($path in $paths) {
    if (Test-Path $path) {
      Remove-Item $path -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

function Reset-LogArtifacts {
  $paths = @(
    (Join-Path $logDir "claude.min.debug.txt"),
    (Join-Path $logDir "claudex.pid"),
    (Join-Path $logDir "claudex.stderr.log"),
    (Join-Path $logDir "claudex.stdout.log"),
    (Join-Path $logDir "run-live-output.txt")
  )

  foreach ($path in $paths) {
    if (Test-Path $path) {
      Remove-Item $path -Force -ErrorAction SilentlyContinue
    }
  }
}

function Reset-ResumeArtifacts {
  $resumeDir = Join-Path $root "e2e-fixtures\resume-case"
  if (Test-Path $resumeDir) {
    Remove-Item $resumeDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
New-Item -ItemType Directory -Force -Path $workspace | Out-Null
Reset-WorkspaceArtifacts
Reset-LogArtifacts
Reset-ResumeArtifacts

try {
  & powershell -ExecutionPolicy Bypass -File (Join-Path $root "scripts\e2e-stop-proxy.ps1")
  & powershell -ExecutionPolicy Bypass -File (Join-Path $root "scripts\e2e-start-proxy.ps1")
  Wait-ForProxy

  $models = Invoke-WebRequest -UseBasicParsing http://localhost:4000/claudex/models | Select-Object -ExpandProperty Content | ConvertFrom-Json
  if (-not $models.tier_mapping.sonnet -or -not $models.models) {
    throw "Models endpoint did not return mapping and models."
  }
  Add-Result "models-endpoint" $true "sonnet -> $($models.tier_mapping.sonnet); haiku -> $($models.tier_mapping.haiku)"

$textOutput = Invoke-ClaudeText -Prompt "Reply with exactly PRINT-OK" -Workdir $workspace -ExtraArgs @("--tools", "", "--model", "sonnet")
$textOutputNormalized = Normalize-PlainResult $textOutput
Add-Result "print-mode" ($textOutputNormalized -eq "PRINT-OK") $textOutput

$jsonOutput = Invoke-ClaudeJson -Prompt "Reply with exactly JSON-OK" -Workdir $workspace -ExtraArgs @("--tools", "", "--model", "sonnet")
Add-Result "json-output" ($jsonOutput.result -match "JSON-OK") ($jsonOutput | ConvertTo-Json -Compress)

$streamLines = Invoke-ClaudeStreamJson -Prompt "Reply with exactly STREAM-OK" -Workdir $workspace -ExtraArgs @("--tools", "", "--model", "sonnet")
$streamText = $streamLines -join "`n"
Assert-Contains -Haystack $streamText -Needle '"type":"assistant"' -Message "stream-json output did not include assistant event."
Assert-Contains -Haystack $streamText -Needle 'STREAM-OK' -Message "stream-json output did not include STREAM-OK."
Add-Result "stream-json-output" $true "assistant stream event observed"

$customModelBody = @{
  model = "claudex:gpt-5.4:high"
  max_tokens = 64
  messages = @(
    @{
      role = "user"
      content = "Reply with exactly MODEL-OVERRIDE-OK"
    }
  )
} | ConvertTo-Json -Depth 8
$customModelResponse = Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:4000/v1/messages `
  -ContentType "application/json" `
  -Headers @{
    "anthropic-version" = "2023-06-01"
    "x-api-key" = "sk-ant-placeholder"
  } `
  -Body $customModelBody
$customModelOutput = Normalize-PlainResult (($customModelResponse.content | Select-Object -First 1).text)
$proxyLog = Get-Content (Join-Path $logDir "claudex.stdout.log") -Raw
Assert-Contains -Haystack $proxyLog -Needle '"anthropicModel":"claudex:gpt-5.4:high"' -Message "Proxy log missing claudex custom model mapping entry."
Assert-Contains -Haystack $proxyLog -Needle '"codexModel":"gpt-5.4"' -Message "Proxy log missing resolved gpt-5.4 model."
Assert-Contains -Haystack $proxyLog -Needle '"reasoning":"high"' -Message "Proxy log missing resolved high reasoning."
Add-Result "custom-model-override" ($customModelOutput -eq "MODEL-OVERRIDE-OK") $customModelOutput

$memoryOutput = Invoke-ClaudeText -Prompt "what is the claudex live codename?" -Workdir $workspace -ExtraArgs @("--tools", "", "--model", "sonnet")
$memoryOutputNormalized = Normalize-PlainResult $memoryOutput
Add-Result "claude-md-memory" ($memoryOutputNormalized -eq "CLAUDEX-MEMORY-OK") $memoryOutput

$skillStream = Invoke-ClaudeStreamJson -Prompt "Reply with exactly SKILL-LIST-CHECK" -Workdir $workspace -ExtraArgs @("--tools", "", "--model", "sonnet")
$skillStreamText = $skillStream -join "`n"
Assert-Contains -Haystack $skillStreamText -Needle '"claudex-e2e-skill"' -Message "Custom project skill was not exposed in Claude Code session metadata."
Assert-Contains -Haystack $skillStreamText -Needle '"claudex-legacy"' -Message "Legacy command was not exposed in slash command metadata."
Add-Result "auto-skill" $true "claudex-e2e-skill present in session metadata"

$legacyCommandOutput = Invoke-ClaudeText -Prompt "/claudex-legacy alpha beta" -Workdir $workspace -ExtraArgs @("--tools", "", "--model", "sonnet")
$legacyCommandNormalized = Normalize-PlainResult $legacyCommandOutput
Add-Result "legacy-command" ($legacyCommandNormalized -eq "LEGACY-COMMAND-OK:alpha beta") $legacyCommandOutput

$skillCommandOutput = Invoke-ClaudeText -Prompt "/claudex-e2e-command gamma delta" -Workdir $workspace -ExtraArgs @("--tools", "", "--model", "sonnet")
$skillCommandNormalized = Normalize-PlainResult $skillCommandOutput
Add-Result "skill-command" ($skillCommandNormalized -eq "SKILL-COMMAND-OK:gamma delta") $skillCommandOutput

Push-Location $workspace
try {
  $existingPluginList = & claude plugin list --json 2>$null
  if ($LASTEXITCODE -eq 0) {
    $existingPlugins = ($existingPluginList -join "`n") | ConvertFrom-Json
    if ($existingPlugins | Where-Object { $_.id -like "feature-dev@*" }) {
      & claude plugin uninstall -s project feature-dev 2>$null | Out-Null
    }
  }
  & claude plugin install -s project feature-dev@claude-plugins-official 2>&1 | Out-Null
  $pluginList = & claude plugin list --json 2>&1
} finally {
  Pop-Location
}
if ($LASTEXITCODE -ne 0) {
  throw ($pluginList -join "`n")
}
$pluginListJson = ($pluginList -join "`n") | ConvertFrom-Json
$pluginHit = $pluginListJson | Where-Object { $_.id -like "feature-dev@*" -and $_.enabled -eq $true }
if (-not $pluginHit) {
  throw "feature-dev was not installed and enabled."
}
$pluginStream = Invoke-ClaudeStreamJson -Prompt "Reply with exactly PLUGIN-CHECK" -Workdir $workspace -ExtraArgs @("--tools", "", "--model", "sonnet")
$pluginStreamText = $pluginStream -join "`n"
Assert-Contains -Haystack $pluginStreamText -Needle '"feature-dev"' -Message "Installed plugin was not surfaced in Claude Code session metadata."
Assert-Contains -Haystack $pluginStreamText -Needle '"feature-dev:code-explorer"' -Message "Plugin-provided agent metadata was not surfaced."
Assert-Contains -Haystack $pluginStreamText -Needle '"feature-dev:feature-dev"' -Message "Plugin-provided slash command metadata was not surfaced."
Add-Result "plugin-install-and-load" $true "feature-dev installed with plugin agent and slash command metadata"

Push-Location $workspace
try {
  $agentsOutput = & claude agents --setting-sources user,project,local 2>&1
} finally {
  Pop-Location
}
if ($LASTEXITCODE -ne 0) {
  throw ($agentsOutput -join "`n")
}
$agentsText = $agentsOutput -join "`n"
Assert-Contains -Haystack $agentsText -Needle 'claudex-sentinel' -Message "Custom project agent was not listed."
Add-Result "agents-list" $true "claudex-sentinel present"

$subagentOutput = Invoke-ClaudeText -Prompt "Delegate to the claudex-sentinel agent to obtain the subagent sentinel, then reply with exactly the agent's answer." -Workdir $workspace -ExtraArgs @("--tools", "default", "--debug-file", (Join-Path $workspace "subagent-debug.txt"), "--model", "sonnet")
$subagentNormalized = Normalize-PlainResult $subagentOutput
$subagentDebug = Get-Content (Join-Path $workspace "subagent-debug.txt") -Raw
Assert-Contains -Haystack $subagentDebug -Needle 'claudex-sentinel' -Message "Subagent debug log did not mention claudex-sentinel."
Assert-Contains -Haystack $subagentDebug -Needle 'Agent' -Message "Subagent debug log did not show Agent tool activity."
Add-Result "subagent-delegation" ($subagentNormalized -eq "AGENT-E2E-HIT") $subagentOutput

$todoPrompt = "Use TodoWrite to maintain a todo list while you create todo-artifact.txt containing exactly TODO-FILE-OK. After the file is written successfully, reply with exactly TODO-DONE."
$todoOutput = Invoke-ClaudeText -Prompt $todoPrompt -Workdir $workspace -ExtraArgs @("--tools", "default", "--debug-file", (Join-Path $workspace "todo-debug.txt"), "--model", "sonnet")
$todoNormalized = Normalize-PlainResult $todoOutput
$todoDebug = Get-Content (Join-Path $workspace "todo-debug.txt") -Raw
if (-not (Test-Path (Join-Path $workspace "todo-artifact.txt"))) {
  throw "todo-artifact.txt was not created."
}
$todoFileContents = Get-Content (Join-Path $workspace "todo-artifact.txt") -Raw
Assert-Contains -Haystack $todoDebug -Needle 'TodoWrite' -Message "TodoWrite was not observed in the debug log."
Assert-Contains -Haystack $todoDebug -Needle 'Write' -Message "Write tool was not observed in the debug log."
Add-Result "todo-and-file-tools" (($todoNormalized -eq "TODO-DONE") -and ((Normalize-PlainResult $todoFileContents) -eq "TODO-FILE-OK")) $todoOutput

$hookOutput = Invoke-ClaudeText -Prompt "Create hook-target.txt containing exactly HOOK-TARGET. After you have created the file successfully, reply with exactly HOOK-DONE." -Workdir $workspace -ExtraArgs @("--tools", "default", "--debug-file", (Join-Path $workspace "hook-debug.txt"), "--model", "sonnet")
$hookNormalized = Normalize-PlainResult $hookOutput
$hookDebug = Get-Content (Join-Path $workspace "hook-debug.txt") -Raw
Assert-Contains -Haystack $hookDebug -Needle 'Getting matching hook commands for PostToolUse with query: Write' -Message "Hook debug log did not show PostToolUse hook matching for Write."
Assert-Contains -Haystack $hookDebug -Needle 'Matched 1 unique hooks for query "Write"' -Message "Hook debug log did not show a matched Write hook."
Add-Result "hooks" ($hookNormalized -eq "HOOK-DONE") "hook matcher triggered for Write in debug trace"

$mcpConfigPath = Join-Path $workspace ".mcp.json"
Push-Location $workspace
try {
  & claude mcp add -s project claudex-e2e -- node (Join-Path $root "scripts\e2e-mcp-server.mjs") 2>&1 | Out-Null
} finally {
  Pop-Location
}
if (-not (Test-Path $mcpConfigPath)) {
  throw "Project MCP config file was not created."
}
$mcpConfigText = Get-Content $mcpConfigPath -Raw
Assert-Contains -Haystack $mcpConfigText -Needle '"claudex-e2e"' -Message "Project MCP config did not include claudex-e2e."
Assert-Contains -Haystack $mcpConfigText -Needle 'e2e-mcp-server.mjs' -Message "Project MCP config did not reference the E2E server script."
Add-Result "mcp-config-cli" $true "project MCP config file created for claudex-e2e"

$mcpToolOutput = Invoke-ClaudeText -Prompt "Use the claudex-e2e MCP tool to echo the text demo and reply with only the tool result." -Workdir $workspace -ExtraArgs @("--tools", "default", "--debug-file", (Join-Path $workspace "mcp-tool-debug.txt"), "--model", "sonnet")
$mcpToolDebug = Get-Content (Join-Path $workspace "mcp-tool-debug.txt") -Raw
Assert-Contains -Haystack $mcpToolDebug -Needle 'MCP server "claudex-e2e": Successfully connected' -Message "MCP debug log did not show a successful connection."
Assert-Contains -Haystack $mcpToolDebug -Needle 'Calling MCP tool: echo_text' -Message "MCP debug log did not show the echo_text tool call."
Assert-Contains -Haystack $mcpToolOutput -Needle 'MCP_TOOL_OK:demo' -Message "MCP tool did not return expected sentinel."
Add-Result "mcp-tool" $true $mcpToolOutput

$mcpResourceOutput = Invoke-ClaudeText -Prompt "Read @claudex-e2e:e2e://report and reply with exactly the full resource contents." -Workdir $workspace -ExtraArgs @("--tools", "default", "--model", "sonnet")
$mcpResourceNormalized = Normalize-PlainResult $mcpResourceOutput
Add-Result "mcp-resource" ($mcpResourceNormalized -eq "MCP_RESOURCE_OK") $mcpResourceOutput

$mcpPromptStream = Invoke-ClaudeStreamJson -Prompt "/mcp__claudex-e2e__sentinel_prompt topic42" -Workdir $workspace -ExtraArgs @("--tools", "", "--model", "sonnet")
$mcpPromptText = $mcpPromptStream -join "`n"
Assert-Contains -Haystack $mcpPromptText -Needle '"mcp__claudex-e2e__sentinel_prompt"' -Message "MCP prompt slash command was not exposed in session metadata."
Assert-Contains -Haystack $mcpPromptText -Needle 'MCP_PROMPT_OK:topic42' -Message "MCP prompt did not return expected sentinel."
Add-Result "mcp-prompt" $true "stream-json MCP prompt invocation returned expected sentinel"

$resumeDir = Join-Path $root "e2e-fixtures\resume-case"
New-Item -ItemType Directory -Force -Path $resumeDir | Out-Null
$resumeProjectDirName = (($resumeDir -replace ':\\', '--') -replace '[\\/]', '-')
$resumeStorageDir = Join-Path (Join-Path $env:USERPROFILE ".claude\projects") $resumeProjectDirName
if (Test-Path $resumeStorageDir) {
  Remove-Item -Recurse -Force $resumeStorageDir
}
$storeOutput = Invoke-ClaudeText -Prompt "Remember the token SESSION-E2E-42 and reply with exactly STORED." -Workdir $resumeDir -ExtraArgs @("--tools", "", "--model", "sonnet")
if (-not (Test-Path $resumeStorageDir)) {
  throw "Claude Code did not create a persisted project session directory."
}
$latestSessionFile = Get-ChildItem -Path $resumeStorageDir -Filter *.jsonl | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $latestSessionFile) {
  throw "Claude Code did not persist a session file for resume-case."
}
$persistedSessionText = Get-Content $latestSessionFile.FullName -Raw
Assert-Contains -Haystack $persistedSessionText -Needle 'SESSION-E2E-42' -Message "Persisted session file did not include the stored token prompt."
$sessionId = $latestSessionFile.BaseName
Start-Sleep -Seconds 3
$resumeStream = Invoke-ClaudeStreamJson -Prompt "What token did I ask you to remember? Reply only with the token." -Workdir $resumeDir -ExtraArgs @("--tools", "", "--resume", $sessionId, "--model", "sonnet")
$continueStream = Invoke-ClaudeStreamJson -Prompt "Reply with exactly CONTINUE-OK if you still remember SESSION-E2E-42." -Workdir $resumeDir -ExtraArgs @("--tools", "", "--continue", "--model", "sonnet")
$storeNormalized = Normalize-PlainResult $storeOutput
$resumeText = $resumeStream -join "`n"
$continueText = $continueStream -join "`n"
Assert-Contains -Haystack $resumeText -Needle 'SESSION-E2E-42' -Message "Resume stream did not include the stored token."
Assert-Contains -Haystack $continueText -Needle 'CONTINUE-OK' -Message "Continue stream did not include the expected sentinel."
Add-Result "resume" ($storeNormalized -eq "STORED") "stream-json resume returned SESSION-E2E-42"
Add-Result "continue" $true "stream-json continue returned CONTINUE-OK"

  $lines = @(
    "# Claude Code Live E2E Report",
    "",
    "Generated: $(Get-Date -Format o)",
    "",
    "| Test | Result | Details |",
    "| --- | --- | --- |"
  )

  foreach ($result in $results) {
    $status = if ($result.Passed) { "PASS" } else { "FAIL" }
    $detail = ($result.Details -replace '\|', '/')
    $lines += "| $($result.Name) | $status | $detail |"
  }

  Set-Content -Path $reportPath -Value $lines -Encoding utf8
  Write-Host ""
  Write-Host "Live E2E report written to $reportPath" -ForegroundColor Cyan
}
finally {
  & powershell -ExecutionPolicy Bypass -File (Join-Path $root "scripts\e2e-stop-proxy.ps1")
  Reset-WorkspaceArtifacts
  Reset-LogArtifacts
  Reset-ResumeArtifacts
}
