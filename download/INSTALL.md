# Install the downloaded APIxStar Grow package

The package contains MCP configuration, website-research and account skills, the source-selection reference, local Codex/Claude marketplaces, and local installation helpers. Downloading or extracting it does not install or authorize anything.

## Let your agent finish setup

Extract the complete `growthpilot` folder, including hidden files, to a permanent location. Give its absolute path to a local Codex, Claude Code, WorkBuddy or TRAE conversation:

> Follow INSTALL.md in the APIxStar Grow folder to install, authorize and verify APIxStar Grow for me. If I am using ChatGPT Work or Codex desktop, also create and open a new APIxStar Grow research conversation for me.

> 阅读 APIxStar Grow 目录中的 INSTALL.md，帮我完成安装、授权和验证。如果我使用 ChatGPT Work 或 Codex 桌面版，也请为我创建并打开新的 APIxStar Grow 研究对话。

## Check the client and preserve existing setup

Act only on the user's installation request. Inspect the running client/version and its existing APIxStar Grow plugins, MCP connections and skills. Reuse a correct installation. Record the affected identity, scope, paths, endpoint and enabled state for rollback before migration. Back up local modifications. Preserve unrelated configuration and credentials, and do not leave duplicate active APIxStar Grow servers or skills. Restore the old setup if migration fails.

The plugin manifests target the production service. If the agent is following a test deployment's guide, use that guide's explicit MCP endpoint and the native MCP + standalone Skills method below; do not authorize a test account against the production plugin accidentally. Leave optional OAuth client ID/secret empty unless the client explicitly requires an existing registered client.

## Codex / local ChatGPT Work

Run setup on the user's local desktop app. A web conversation or isolated remote workspace cannot install into that app; direct the user to a local desktop conversation with the prompt above. Prefer supported native plugin and connection controls when available. Otherwise locate the CLI bundled with the running desktop app; replace `<BUNDLED_CODEX>` in every command below with its absolute path. Do not fall back to an unrelated `codex` on PATH or install another CLI. In PowerShell, prefix a quoted executable path with `&`. Check `"<BUNDLED_CODEX>" plugin --help`, existing marketplaces/plugins, and `"<BUNDLED_CODEX>" mcp list --json`.

The prompt above explicitly requests a new research conversation. Continue authorized steps without repeated confirmation, reuse matching installations and valid sign-in, and stage files in the current writable workspace. Do not change approval modes, broaden permissions or edit private trust records to remove prompts. If the host requires approval, use its supported flow for the specific action. Skip optional installation reporting if it would require additional permissions; browser sign-in and consent remain required when no valid authorization exists.

For the production plugin, substitute the permanent extracted directory:

```sh
"<BUNDLED_CODEX>" plugin marketplace add "/absolute/path/to/growthpilot"
"<BUNDLED_CODEX>" plugin add growthpilot@apixstar-download
"<BUNDLED_CODEX>" plugin list --marketplace apixstar-download --json
"<BUNDLED_CODEX>" mcp list --json
```

Reuse `apixstar-download` only if it points to the intended APIxStar Grow directory. Where CLI plugin installation is unavailable, use the client's supported Plugins UI. The marketplace must be installed/enabled, not merely registered.

For clients supporting local skills and native MCP but not plugins, or for a test endpoint, use the standalone installer below. Confirm the user skill path for the running client (current Codex documentation uses `~/.agents/skills/`), then add the native server only if an equivalent connection is absent:

```sh
"<BUNDLED_CODEX>" mcp add growthpilot --url https://grow.apixstar.com/mcp
```

For either method, read the actual APIxStar Grow server name from the MCP list. Plugin names may be namespaced. Reuse valid authorization; otherwise run:

```sh
"<BUNDLED_CODEX>" mcp login <actual-server-name> --scopes tasks:read,tasks:write,billing:read
```

Keep one login process running while the user completes browser sign-in and consent. Retry a transient failed step after inspecting its result; do not reopen authorization if the user cancelled or declined it. Verify the package is installed/enabled, both skills and the reference exist, and the server has the intended endpoint. Do not reinstall or repeat login just because this installation conversation cannot see newly added tools.

### Required desktop handoff

After installation and authorization, create and open the new conversation requested by the user. Do not stop with instructions to open one manually. Follow the full handoff in the current deployment's `/chatgpt` guide (production: https://grow.apixstar.com/chatgpt); the steps below also work from this download:

1. Discover available and deferred host tools for `create_thread`, `list_projects`, `navigate_to_codex_page` and `wait_threads`, or supported equivalents. Use the actual tool discovery mechanism, not an assumed tool name.
2. Resolve the current project and execution host. Use the returned project ID with `target: {type: "project", projectId, environment: {type: "local"}}`, or `target: {type: "projectless"}` when the current conversation is projectless. Do not create a worktree or cloud task, guess a project ID or discard project context. If context cannot be preserved, explain that exact limitation.
3. Call `create_thread` once with the target and the complete first message below as `prompt`, using the user's language and model settings. Include the actual method, version, endpoint, server name, skill paths, authorization result. Never include credentials or callback URLs. Resolve an uncertain creation outcome before retrying; an empty conversation is not a completed handoff.
4. Open the returned real `threadId` with `navigate_to_codex_page`. Resolve pending creation through supported status controls before using its ID; a temporary `clientThreadId` is not a thread ID. If switching fails, retain the created conversation and give its ID instead of making a duplicate. Where available, inspect the new conversation's result using `wait_threads`; keep pending verification explicit.

First message when installation and authorization are confirmed:

> Finish APIxStar Grow verification and help me start my first research task. Confirm both website-research/account skills (or growthpilot-website-research/growthpilot-account) are loaded, read references/source-selection.md from the research skill, and call the real growthpilot_account_get MCP tool. After success, briefly report connection, credits and subscription status and introduce website traffic, keyword, competitor and trend research. Keep any research goal I already supplied; otherwise ask which website or question I want to research. Do not run a paid query, change my account, reinstall or repeat login for verification. If anything is missing, report the exact pending step without claiming setup is complete.

> 请完成 APIxStar Grow 验证并帮我开始第一个研究任务：确认两项网站研究和账户技能已加载，读取网站研究技能的 references/source-selection.md，再调用真实 growthpilot_account_get MCP 工具。成功后简要报告连接、额度和订阅状态，介绍网站流量、关键词、竞品和趋势研究能力。沿用我已提供的目标；没有目标时，问我想研究哪个网站或问题。安装验证不要发起付费查询、修改账户、重装或重复登录；缺少任何一项时说明准确的未完成步骤，不要宣称安装完成。

If installation or authorization is incomplete, use a recovery message instead: state that setup is incomplete, attach the exact pending step and sanitized error, and ask the new conversation to resume that step using the current deployment's `/chatgpt` guide. Only after installation and authorization succeed should recovery create and open a fresh research conversation with the verification prompt. If the same blocker persists, explain it without creating further recovery conversations. A recovery handoff is not success.

If tools are unavailable after discovery, project context cannot be resolved, a required call fails or a restart genuinely needs the user, provide the complete handoff prompt and exact remaining action. Preserve ongoing work. Report installation, skill/reference loading, endpoint authorization and native account verification separately; only all four passing means setup is complete. Otherwise report the new conversation's title/ID and the precise pending status.

## Claude Code

Use this prompt in local Claude Code (remove `/goal` if this client does not support it):

> /goal Read INSTALL.md in the APIxStar Grow folder to install APIxStar Grow and sign me in. After checking installation and authorization, introduce what you can do and guide me to start my first website research task in a new session.

> /goal 阅读 APIxStar Grow 目录中的 INSTALL.md，帮我安装并登录 APIxStar Grow，完成安装和授权检查后，介绍你能做什么，并引导我在新会话开始第一个网站研究任务。

Use the executable and configuration environment belonging to the running local client. Check `claude --version`, `claude plugin --help`, `claude mcp login --help`, existing marketplaces/plugins and `claude mcp list`. Resolve an existing executable if PATH is stale; do not install another client. Stage files in the writable workspace, reuse matching installation and authorization, and continue the requested steps without redundant confirmation. Do not change permission modes or private trust records. Skip optional reporting that requires an additional permission request.

Use this complete downloaded package as the default source. An older Git marketplace can lack both skills; keep it only if the actual version and all required files satisfy the current guide. Back up and migrate only the affected APIxStar Grow instance, preserve valid authorization when the endpoint and identity match, and keep one active connection. For the production plugin:

```sh
claude plugin marketplace add "/absolute/path/to/growthpilot"
claude plugin install growthpilot@apixstar-download --scope user
claude plugin list
```

Reuse only a matching marketplace and use the existing installation scope for updates. For a test endpoint or a client with local skills/native MCP but without plugin support, use the standalone installer below with the confirmed personal skills directory (normally `~/.claude/skills/`). Add a native server only if absent:

```sh
claude mcp add --transport http --scope user growthpilot https://grow.apixstar.com/mcp
```

Read the actual server name and endpoint from the client; a plugin name can be namespaced, such as `plugin:growthpilot:growthpilot`. Do not assume the name from an example. If authorization is needed, the agent starts native login:

```sh
claude mcp login <actual-server-name>
```

Keep that process running in an interactive terminal while the user completes browser sign-in and consent. If the supported login requires a terminal and the agent has none, an already available Python 3.9+ on macOS/Linux can provide a pseudo-terminal without a helper file:

```sh
python3 -c 'import os,pty,sys; sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))' claude mcp login <actual-server-name>
```

Use a supported real console on Windows. If this client lacks native CLI login or no supported terminal is available, guide the user to `/mcp`, the actual APIxStar Grow server, then Authenticate. Do not silently install runtimes or another client. Only one login attempt may be active. Require an explicit authenticated result and successful exit; `Connected`, plugin lists or a browser page alone are insufficient. Reuse valid authorization. If its state is unknown, keep it pending for the native account check rather than logging in again because discovery is slow.

Check the installed version, both skills, their source-selection reference and the endpoint. Then briefly introduce traffic, keyword, competitor and trend research and hand off to **New session** in Claude Code Desktop, or a fresh terminal session in the same project. Include a brief record of the actual version, method, scope, endpoint, server name, confirmed skill locations and any known research goal, without secrets. A natural request naming APIxStar Grow is enough; no long fixed verification prompt is required. Desktop/non-interactive sessions do not apply plugin MCP changes via `/reload-plugins`; interactive terminal behavior can differ. Do not substitute Codex conversation tools or a background agent for the user's session.

Report **installed and authorized; new-session verification pending** only when those facts are confirmed, and finish the installation goal at that handoff. Do not leave `/goal` looping while it waits for another session. In the new session, load `growthpilot:website-research`, `growthpilot:account` and `references/source-selection.md` (standalone names are `growthpilot-website-research` and `growthpilot-account`), discover actual tools, and call the real `growthpilot_account_get` before reporting readiness. Report credits and subscription status, then continue the known research goal or ask for the first website/question. Do not submit a paid query for verification.

Poll an existing slow operation instead of starting another. Retry confirmed transient failures with backoff; reuse only an actually configured proxy. After a login failure, wait for the process to exit before retrying once. Stop on user cancellation or denial. Preserve installed files and resume only the failed step. Missing or slow tools need fresh-session discovery/read-only verification, not automatic reinstallation or reauthentication. Report the exact pending step and sanitized error when blocked.

Claude web/Cowork/cloud environments do not necessarily read these local directories. A custom MCP connector alone does not satisfy the full local Skills installation. Report the unsupported part if local skills or file access are unavailable.

## WorkBuddy

Resolve the active `mcp.json` from the running client's `WORKBUDDY_CONFIG_DIR`, or inspect Connectors → Custom connectors → Add MCP → Configuration File Path if ambiguous. The helper also resolves a single existing WorkBuddy edition directory. Do not ask the user to supply information your tools already establish. Independently confirm the user skill directory through the running client's built-in skill-creator or supported skill-management information. WorkBuddy AI 5.8.4's bundled creator uses `~/.codebuddy/skills/`; confirm the installed version before using it and expand it to an absolute path.

Inspect both scripts, then run from this extracted root:

```sh
node scripts/configure-workbuddy.mjs --server-url https://grow.apixstar.com/mcp --skills-dir "/absolute/path/to/confirmed/user/skills"
```

Add `--config "/absolute/path/to/active/mcp.json"` when the active path cannot be resolved automatically. Use the explicit endpoint from a test deployment's guide instead when appropriate. A single equivalent connector is reused under its existing name; `serverName` identifies it and `configurationChanged` says whether its file changed. For a skills-only repair, use `--skills-only --skills-dir "/absolute/path/to/confirmed/user/skills"`. Do not register the Codex/Claude marketplaces in WorkBuddy.

The helper backs up changed MCP settings, preserves unrelated entries and installs both complete skills. Inspect the actual client state using supported controls: reload/save only if missing or stale, handle Trust only when displayed, and use **Connect** only if authentication is needed. WorkBuddy owns access/refresh tokens. `not_checked` means unknown, not that the user must authorize again. A marketplace plugin list cannot establish the custom MCP state.

Check installation and native authorization. Load both skills and `references/source-selection.md`, and invoke the real `growthpilot_account_get` if the current conversation can load the tools. If loading is pending, carry that check into the new session without reinstalling or logging in again. A client control limitation should prompt only the next observed user action. Never invent a login command, use private IPC, modify trust records or substitute a terminal request for native verification. Token-expiry tests run only when requested.

Briefly introduce the research capabilities actually available, then guide the user to open a **new session in WorkBuddy** for their first website research task, even if the current conversation already works. Preserve the project and any existing research goal. Keep the handoff short: carry the actual version, endpoint, server name, skill paths, authorization state and pending checks without credentials. A natural request naming APIxStar Grow and a website/question is enough; no long technical verification prompt is required. Finish the installation handoff without waiting or looping for the new session. Report pending verification accurately.

In that new session, load both skills and the source-selection reference, discover actual tools and call `growthpilot_account_get` before reporting readiness. Then continue the existing research request or ask which website and question the user wants to research. Do not begin website research in the installation conversation or submit a paid query to verify setup.

## TRAE / Trae Work

Complete the local work first and ask for only the next action that actually needs the user's input. Reuse an existing correct installation and native authorization. Save, trust confirmation and browser authorization depend on the actual client state; the first website research task starts in a new session.

Use a local desktop task. Confirm the active MCP configuration from Settings → MCP; the tested TRAE CN macOS file is `~/Library/Application Support/Trae CN/User/mcp.json`, but other editions differ. Confirm the skill location independently in the running client's skill settings. CN documentation uses `~/.trae-cn/skills/` (Windows: `%USERPROFILE%/.trae-cn/skills/`) for global skills and `.trae/skills/` in the project for project-only skills. Prefer the confirmed global directory for cross-task use.

Run the standalone installer below for both Skills. Then privately back up and merge this MCP entry, preserving unrelated settings or reusing the equivalent existing server:

```json
{
  "mcpServers": {
    "growthpilot": {
      "url": "https://grow.apixstar.com/mcp"
    }
  }
}
```

Use the explicit endpoint from a test deployment's guide when needed. Do not run the WorkBuddy configuration helper in TRAE or register the Codex/Claude marketplaces. Replace only obsolete APIxStar Grow bridge/fixed-token configuration; do not edit internal credentials or trust records.

Inspect the actual server state through supported client controls or native tool discovery. Save/reload only if the connection is missing or stale, enable it if disabled, and handle trust only when TRAE displays it. Use **Go to verify / 前往验证** only when native browser authorization is required, with one flow active at a time. Keep TRAE running for the callback. A saved file or `client_oauth_pending` status does not establish that authorization is missing; reuse a connected server without logging in again. If the installed edition lacks local skills or native OAuth, report that limitation rather than changing authentication methods or upgrading the client automatically.

Check the installed version, both skills and their source-selection reference, the intended endpoint and native authorization. If the current conversation can load the tools, invoke the real `growthpilot_account_get`; otherwise carry that check forward as pending without reinstalling or repeating login. Do not assume a fixed tool count or substitute a terminal request for native verification. If a client control is unavailable, finish independent work and report the observed state plus one smallest next action. If the state is unknown, ask the user to open MCP settings rather than asserting that authorization is missing.

Briefly introduce the research capabilities actually available, then guide the user to open a **new session / new local task in TRAE** for their first website research task, even if the current conversation already works. Preserve the current project and any existing research goal. Carry a brief record of the actual version, endpoint, server name, confirmed skill paths, authorization state and pending check, without credentials. A natural request naming APIxStar Grow and a website/question is enough; no long technical verification prompt is required. Create or open a session only when authorized and supported by available client tools; never substitute a background agent. Finish the installation handoff without waiting or looping for the new session, and report pending verification accurately.

In the new session, load both skills and `references/source-selection.md`, discover available tools (including deferred tools), and invoke the real `growthpilot_account_get` before reporting readiness. Then continue the existing research request or ask which website and question the user wants to research. Do not begin website research in the installation conversation, submit a paid verification query or delay setup with an unrequested renewal test.

## Standalone skill installation

Used by WorkBuddy/TRAE and the full native alternatives for Codex/Claude Code. Inspect `scripts/install-skills.mjs`, then run with Node.js LTS and the confirmed absolute skills directory:

```sh
node scripts/install-skills.mjs --skills-dir "/absolute/path/to/confirmed/user/skills"
```

This installs all three files from the shared plugin sources:

- `growthpilot-website-research/SKILL.md`
- `growthpilot-website-research/references/source-selection.md`
- `growthpilot-account/SKILL.md`

Only the two frontmatter names are namespaced. Identical installations are reused. Unmanaged or locally edited targets are not overwritten; inspect and back up conflicts before migrating. Managed updates keep the old directories in `growthpilot-skill-backups/` beside the skills directory. The helper makes no network calls and does not configure or authorize MCP. `skills_client_load_pending` means that client loading still needs verification.

If Node is unavailable, use permitted file operations to copy both complete folders from `plugins/growthpilot/skills/` into the confirmed directory. Apply the two names above to both folder names and frontmatter, retain the reference unchanged, and back up existing targets first. Do not install copies into several guessed directories. If using TRAE's Upload Skill control, each archive must have its own `SKILL.md` at the root with that skill's references; the full marketplace ZIP is not an individual skill archive.

## Verify the complete workflow

Use supported reload/new-conversation controls and carry the actual installation method, version, scope, endpoint, server name, skill paths and pending steps into the handoff without secrets. For ChatGPT Work / Codex desktop, follow the required handoff above: the supplied install prompt already requests the new conversation, so do not ask again. For other clients, create a new task only when the installation request authorizes it. If client control is unavailable, explain the smallest required action and provide the verification prompt instead of pretending to have completed it.

1. Confirm both skills are actually available in the verification conversation, using the plugin namespace or standalone names for the selected method. WorkBuddy and TRAE check installation and authorization, introduce their capabilities, and guide the first website research task into a new session; load and verify the skills and native account tool there before reporting readiness.
2. Load the website-research skill and read `references/source-selection.md`. Check that an explicit provider choice wins and otherwise metrics use the best available source: Similarweb for whole-site traffic, Semrush for SEO/PPC, available Ahrefs for backlinks (check its discovery and report schema; Semrush is the fallback for unavailable coverage), and enabled Google Trends for relative interest.
3. Confirm the intended MCP endpoint and native authorization. Discover the current tools, including deferred tools; never assume a fixed count.
4. Use the account skill to call the actual `growthpilot_account_get` MCP tool. Account reads do not consume query credits. Do not submit a paid data query or change the account to verify installation.
5. Report package installation, both skills/reference loading, authorization and the native call separately. Files, plugin lists, terminal tool lists and browser callbacks alone do not prove completion. Resume only the failed/pending step. Test token renewal separately only if requested.

Use the client's native OAuth controls for missing/expired authorization. Never ask the user to paste passwords, cookies, API keys or tokens; never put a fixed Bearer token in configuration. Trust and browser consent confirmations remain with the user when required by the client.

## Update, rollback and uninstall

A local marketplace does not automatically download new ZIP releases. Extract a new release into a fresh staging directory, inspect it, back up the previous permanent folder, then replace the local source and reapply the installed plugin through supported controls. Codex's marketplace upgrade command refreshes Git sources, not a downloaded local folder. Claude Code can refresh the local marketplace with `claude plugin marketplace update apixstar-download`, then update the actual plugin selector/scope. Reload and repeat verification.

For standalone skills, rerun the new release's installer with the same confirmed directory and retain the native MCP connection. Preserve local modifications; restore the recorded old setup if an update fails.

Only on a requested uninstall, remove the actual APIxStar Grow plugin selector through client controls (`codex plugin remove ...` or `claude plugin uninstall ...`), or remove its native MCP entry plus its two standalone skill directories. Remove a marketplace or extracted source only when unused by other installations. Revoke OAuth access separately in APIxStar Grow's Connected apps. Uninstalling does not cancel a subscription.

The full client guides are at https://grow.apixstar.com/chatgpt, https://grow.apixstar.com/claude, https://grow.apixstar.com/workbuddy and https://grow.apixstar.com/trae-work. This package is not a self-hosted server; online data/account access still requires APIxStar Grow authorization.
