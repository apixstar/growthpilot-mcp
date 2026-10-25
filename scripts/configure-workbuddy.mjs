import { existsSync, readFileSync, writeFileSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export const defaultEndpoint = 'https://grow.apixstar.com/mcp';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function endpoint(value = defaultEndpoint) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash) throw new Error('Use the HTTPS /mcp endpoint from the installation guide.');
  return url.href;
}
export function connectionEntry(serverUrl = defaultEndpoint) {
  // WorkBuddy must own OAuth credentials so it can refresh them after expiry.
  return {type: 'http', url: endpoint(serverUrl)};
}
export function resolveConfigPath({configPath, configDir = process.env.WORKBUDDY_CONFIG_DIR, homeDir = homedir()} = {}) {
  if (configPath) return resolve(configPath);
  if (configDir?.trim()) return resolve(configDir.trim(), 'mcp.json');
  const candidates = ['.workbuddy', '.workbuddy-ai'].map(name => join(homeDir, name)).filter(existsSync);
  if (candidates.length !== 1) throw new Error('Confirm Configuration File Path in WorkBuddy → Connectors → Custom connectors → Add MCP, then pass --config. Multiple or no WorkBuddy configuration directories were found; no file was changed.');
  return join(candidates[0], 'mcp.json');
}
function readConfig(configPath, serverUrl) {
  configPath = resolveConfigPath({configPath});
  if (!existsSync(dirname(configPath))) throw new Error('WorkBuddy configuration directory is missing. Confirm the active path in WorkBuddy, then pass --config.');
  if (existsSync(configPath)) configPath = realpathSync(configPath);
  const original = existsSync(configPath) ? readFileSync(configPath, 'utf8') : null;
  let config;
  try { config = original === null ? {} : JSON.parse(original); }
  catch { throw new Error('The existing MCP configuration is not valid JSON. Repair it without removing other servers, then retry.'); }
  if (!object(config) || (config.mcpServers !== undefined && !object(config.mcpServers))) throw new Error('Expected a JSON object with an mcpServers object. The file was not changed.');
  const servers = config.mcpServers ?? {};
  const matches = entry => object(entry) && (entry.url === serverUrl || (Array.isArray(entry.args) && entry.args.includes(serverUrl)));
  const matchingNames = Object.keys(servers).filter(name => matches(servers[name]));
  if (matchingNames.length > 1) throw new Error('Multiple connections already use this endpoint. Resolve the duplicate connections before installing.');
  const serverName = matchingNames[0] ?? 'growthpilot';
  const existing = servers[serverName];
  if (existing !== undefined && !matches(existing)) throw new Error('The growthpilot name is used by another configuration. Resolve the conflict before installing.');
  return {configPath, original, config, servers, existing, serverName};
}
function atomicWrite(path, content, expected) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, content, {mode: 0o600, flag: 'wx'});
    if (expected !== undefined && (existsSync(path) ? readFileSync(path, 'utf8') : null) !== expected) throw new Error('The configuration changed during installation. Read it again before retrying.');
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
export function configure({configPath, serverUrl = defaultEndpoint} = {}) {
  serverUrl = endpoint(serverUrl);
  const saved = readConfig(configPath, serverUrl);
  const {original, config, servers, existing, serverName} = saved;
  // Keep native client options and the existing name (and thus its OAuth identity).
  // Only remove legacy authentication; credentials belong to WorkBuddy.
  const entry = existing?.type === 'http' ? {...existing} : connectionEntry(serverUrl);
  if (object(entry.headers)) {
    entry.headers = Object.fromEntries(Object.entries(entry.headers).filter(([key]) => key.toLowerCase() !== 'authorization'));
    if (Object.keys(entry.headers).length === 0) delete entry.headers;
  }
  configPath = saved.configPath;
  let backup = null;
  const configurationChanged = JSON.stringify(existing) !== JSON.stringify(entry);
  if (configurationChanged) {
    if (original !== null) {
      backup = configPath + '.growthpilot-' + randomUUID() + '.bak';
      writeFileSync(backup, original, {mode: 0o600, flag: 'wx'});
    }
    atomicWrite(configPath, JSON.stringify({...config, mcpServers: {...servers, [serverName]: entry}}, null, 2) + '\n', original);
  }
  return {status: 'configured_client_load_pending', transport: 'http', configPath, serverName, configurationChanged, backup, clientLoad: 'not_checked'};
}
export async function setup(options = {}) {
  if (options.skillsOnly && options.skillsDir === undefined) throw new Error('--skills-only requires --skills-dir.');
  let skills;
  if (options.skillsDir !== undefined) {
    // Validate both targets before writing either the skills or MCP configuration.
    if (!options.skillsOnly) readConfig(options.configPath, endpoint(options.serverUrl));
    const {prepareSkills, installSkills} = await import('./install-skills.mjs');
    const plans = prepareSkills({skillsDir: options.skillsDir, sourceRoot: options.sourceRoot});
    skills = installSkills(plans);
  }
  if (options.skillsOnly) return {status: 'skills_client_load_pending', skills, skillsLoad: 'not_checked', authentication: 'not_checked', next: 'Reuse the existing connection. Load both skills through supported WorkBuddy controls and verify their source-selection reference, then call the real growthpilot_account_get MCP tool. Use a new conversation only if the current conversation cannot load them. Resume only the pending step.'};
  const result = configure(options);
  return {...result, ...(skills ? {skills, skillsLoad: 'not_checked'} : {}), authentication: 'client_oauth_pending', trust: 'not_checked', next: 'Inspect the actual connector state through supported WorkBuddy controls. Reload/save only if the entry is missing or stale. Trust is required only when WorkBuddy shows it; respect user confirmation and never modify trust records. Connect only when authentication is needed; reuse valid native OAuth. Load both installed skills and their source-selection reference, discover APIxStar Grow tools and call the real growthpilot_account_get MCP tool. Use a new conversation only if the current conversation cannot load them. Ask for only the next observed user action if client controls are unavailable, then resume. Do not run a paid query, print credentials, or test token expiry during normal installation.'};
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  try {
    const {values} = parseArgs({options: {config: {type: 'string'}, 'server-url': {type: 'string'}, 'skills-dir': {type: 'string'}, 'skills-only': {type: 'boolean'}, login: {type: 'boolean'}, refresh: {type: 'boolean'}, 'no-browser': {type: 'boolean'}, 'import-mcp-remote': {type: 'string'}}});
    if (values.login || values.refresh || values['no-browser'] || values['import-mcp-remote'] !== undefined) throw new Error('External OAuth/token refresh is no longer used. Rerun without OAuth flags, then use APIxStar Grow Connect in WorkBuddy for native authorization and renewal.');
    console.log(JSON.stringify(await setup({configPath: values.config, serverUrl: values['server-url'], skillsDir: values['skills-dir'], skillsOnly: values['skills-only']}), null, 2));
  } catch (error) {
    console.error(error instanceof SyntaxError ? 'Invalid local JSON. Inspect the configuration without printing credentials.' : error.message);
    process.exitCode = 1;
  }
}
