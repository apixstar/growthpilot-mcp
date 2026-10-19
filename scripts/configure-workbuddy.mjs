import { existsSync, readFileSync, writeFileSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export const bridgePackage = 'mcp-remote@0.15.1';
export const bridgeArgs = serverUrl => [serverUrl, '--transport', 'http-only', '--auth-timeout', '300'];
export const connectionEntry = (serverUrl, launcher = 'npx') => ({command: launcher, args: ['-y', bridgePackage, ...bridgeArgs(serverUrl)]});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function resolveConfigPath({configPath, configDir = process.env.WORKBUDDY_CONFIG_DIR, homeDir = homedir()} = {}) {
  if (configPath) return resolve(configPath);
  if (configDir?.trim()) return resolve(configDir.trim(), 'mcp.json');
  const candidates = ['.workbuddy', '.workbuddy-ai'].map(name => join(homeDir, name)).filter(existsSync);
  if (candidates.length !== 1) throw new Error('Confirm Configuration File Path in WorkBuddy → Connectors → Custom connectors → Add MCP, then pass --config. Multiple or no WorkBuddy configuration directories were found; no file was changed.');
  return join(candidates[0], 'mcp.json');
}

export function configure({configPath, serverUrl = 'https://grow.apixstar.com/mcp', launcher = process.platform === 'win32' ? 'npx.cmd' : 'npx'} = {}) {
  const url = new URL(serverUrl);
  if (url.protocol !== 'https:' || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash) throw new Error('Use the HTTPS /mcp endpoint from the installation guide.');
  serverUrl = url.href;
  configPath = resolveConfigPath({configPath});
  if (!existsSync(dirname(configPath))) throw new Error('WorkBuddy configuration directory is missing. Confirm the active path in WorkBuddy, then pass --config.');
  // Follow an existing settings symlink instead of replacing it.
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
  const entry = connectionEntry(serverUrl, launcher);
  let backup = null;
  if (JSON.stringify(existing) !== JSON.stringify(entry)) {
    const id = randomUUID();
    if (original !== null) {
      backup = configPath + '.growthpilot-' + id + '.bak';
      writeFileSync(backup, original, {mode: 0o600, flag: 'wx'});
    }
    const temporary = configPath + '.growthpilot-' + id + '.tmp';
    try {
      writeFileSync(temporary, JSON.stringify({...config, mcpServers: {...servers, growthpilot: entry}}, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
      const current = existsSync(configPath) ? readFileSync(configPath, 'utf8') : null;
      if (current !== original) throw new Error('The configuration changed during installation. Read it again before retrying.');
      renameSync(temporary, configPath);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  return {
    status: 'configured_client_load_pending', configPath, backup,
    authentication: 'not_checked', clientLoad: 'not_checked',
    login: {command: launcher, args: ['--yes', '--package=' + bridgePackage, 'mcp-remote-client', ...bridgeArgs(serverUrl)]},
    next: 'Verify OAuth once, then open WorkBuddy → Experts · Skills · Connectors → Connectors → Custom connectors → Add MCP. Confirm Configuration File Path matches configPath, reload the latest file in the editor and save it there to refresh the running client. Preserve every other server. Complete any Trust prompt through WorkBuddy, confirm GrowthPilot and its tools appear in MCP Server Management, then verify a callable tool in the conversation. A new task alone may not reload a file edited outside WorkBuddy. list_installed_plugins is not the inventory of custom MCP servers.'
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const {values} = parseArgs({options: {config: {type: 'string'}, 'server-url': {type: 'string'}, launcher: {type: 'string'}}});
    console.log(JSON.stringify(configure({configPath: values.config, serverUrl: values['server-url'], launcher: values.launcher}), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
