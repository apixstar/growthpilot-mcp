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
  const existing = servers.growthpilot;
  const matches = entry => object(entry) && (entry.url === serverUrl || (Array.isArray(entry.args) && entry.args.includes(serverUrl)));
  if (existing !== undefined && !matches(existing)) throw new Error('The growthpilot name is used by another configuration. Resolve the conflict before installing.');
  if (Object.entries(servers).some(([name, entry]) => name !== 'growthpilot' && matches(entry))) throw new Error('This endpoint already exists under another server name. Reuse that connection instead of adding a duplicate.');
  return {configPath, original, config, servers, existing};
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
  const entry = connectionEntry(serverUrl);
  const saved = readConfig(configPath, serverUrl);
  const {original, config, servers, existing} = saved;
  configPath = saved.configPath;
  let backup = null;
  if (JSON.stringify(existing) !== JSON.stringify(entry)) {
    if (original !== null) {
      backup = configPath + '.growthpilot-' + randomUUID() + '.bak';
      writeFileSync(backup, original, {mode: 0o600, flag: 'wx'});
    }
    atomicWrite(configPath, JSON.stringify({...config, mcpServers: {...servers, growthpilot: entry}}, null, 2) + '\n', original);
  }
  return {status: 'configured_client_load_pending', transport: 'http', configPath, backup, clientLoad: 'not_checked'};
}
export async function setup(options = {}) {
  const result = configure(options);
  return {...result, authentication: 'client_oauth_pending', next: 'Reload/save this configuration in WorkBuddy. In Connectors → Custom connectors, use GrowthPilot Connect to complete native OAuth; WorkBuddy owns the access and refresh tokens. Respect any required Trust/consent confirmation. Open a NEW conversation, discover all seven GrowthPilot tools and call growthpilot_account_get through its actual MCP tool. For renewal regression testing, repeat after 15 minutes. Never substitute a terminal check, print credentials, or modify trust records.'};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const {values} = parseArgs({options: {config: {type: 'string'}, 'server-url': {type: 'string'}, login: {type: 'boolean'}, refresh: {type: 'boolean'}, 'no-browser': {type: 'boolean'}, 'import-mcp-remote': {type: 'string'}}});
    if (values.login || values.refresh || values['no-browser'] || values['import-mcp-remote'] !== undefined) throw new Error('External OAuth/token refresh is no longer used. Rerun without OAuth flags, then use GrowthPilot Connect in WorkBuddy for native authorization and renewal.');
    console.log(JSON.stringify(await setup({configPath: values.config, serverUrl: values['server-url']}), null, 2));
  } catch (error) {
    console.error(error instanceof SyntaxError ? 'Invalid local JSON. Inspect the configuration without printing credentials.' : error.message);
    process.exitCode = 1;
  }
}
