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

export function configure({configPath = join(homedir(), '.workbuddy', 'mcp.json'), serverUrl = 'https://grow.apixstar.com/mcp', launcher = process.platform === 'win32' ? 'npx.cmd' : 'npx'} = {}) {
  const url = new URL(serverUrl);
  if (url.protocol !== 'https:' || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash) throw new Error('Use the HTTPS /mcp endpoint from the installation guide.');
  serverUrl = url.href;
  configPath = resolve(configPath);
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
  return {status: 'configured_not_authorized', configPath, backup, login: {command: launcher, args: ['--yes', '--package=' + bridgePackage, 'mcp-remote-client', ...bridgeArgs(serverUrl)]}, next: 'Run the login command, complete browser authorization, verify tools/list, then load the connector in a fresh WorkBuddy task.'};
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
