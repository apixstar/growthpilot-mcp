import { existsSync, readFileSync, writeFileSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export const defaultEndpoint = 'https://grow.apixstar.com/mcp';
const scope = 'tasks:read tasks:write billing:read';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const token = value => typeof value === 'string' && /^[\x21-\x7e]{1,4096}$/.test(value);
export function endpoint(value = defaultEndpoint) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash) throw new Error('Use the HTTPS /mcp endpoint from the installation guide.');
  return url.href;
}
export function connectionEntry(serverUrl, accessToken) {
  if (!token(accessToken)) throw new Error('A valid OAuth access token is required; credentials must not be passed as command-line arguments.');
  return {type: 'http', url: endpoint(serverUrl), headers: {Authorization: 'Bearer ' + accessToken}};
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
export function configure({configPath, serverUrl = defaultEndpoint, accessToken} = {}) {
  serverUrl = endpoint(serverUrl);
  const entry = connectionEntry(serverUrl, accessToken);
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
async function request(url, options, fetcher) {
  // Never follow a redirect carrying a credential to another endpoint.
  let response;
  try { response = await fetcher(url, {...options, redirect: 'error', signal: AbortSignal.timeout(30000)}); }
  catch { throw new Error('Network request failed. Check connectivity to the GrowthPilot endpoint and retry.'); }
  if (!response.ok) throw new Error(`GrowthPilot request failed (HTTP ${response.status}). For an expired or revoked grant, rerun with --login.`);
  return response;
}
async function jsonRequest(url, options, fetcher) {
  const response = await request(url, options, fetcher);
  try { return await response.json(); }
  catch { throw new Error('GrowthPilot returned an invalid JSON response.'); }
}
export async function discover(serverUrl, fetcher = fetch) {
  const origin = new URL(endpoint(serverUrl)).origin;
  const metadata = await jsonRequest(origin + '/.well-known/oauth-authorization-server', {}, fetcher);
  if (metadata.issuer !== origin) throw new Error('OAuth issuer does not match the selected GrowthPilot endpoint.');
  for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
    const url = new URL(metadata[key]);
    if (url.origin !== origin || url.username || url.password || url.hash || url.search) throw new Error('OAuth endpoints must remain on the selected GrowthPilot origin.');
  }
  if (!metadata.code_challenge_methods_supported?.includes('S256')) throw new Error('The OAuth server must support PKCE S256.');
  return metadata;
}
function cacheTokens(data, previous, serverUrl, clientId, now) {
  if (!token(data.access_token) || data.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || (data.refresh_token !== undefined && !token(data.refresh_token))) throw new Error('OAuth returned an invalid token response.');
  return {version: 1, serverUrl, clientId, accessToken: data.access_token, refreshToken: data.refresh_token ?? previous?.refreshToken, expiresAt: now + data.expires_in * 1000};
}
function saveCache(path, cache) { atomicWrite(path, JSON.stringify(cache) + '\n'); }
export function importBridgeCache(prefix, serverUrl) {
  const tokens = JSON.parse(readFileSync(prefix + '_tokens.json', 'utf8'));
  const client = JSON.parse(readFileSync(prefix + '_client_info.json', 'utf8'));
  const origin = new URL(serverUrl).origin;
  if (tokens.issuer !== origin || client.issuer !== origin || !client.client_id || !token(tokens.refresh_token)) throw new Error('The selected bridge cache does not belong to this GrowthPilot OAuth issuer.');
  return {version: 1, serverUrl, clientId: client.client_id, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: tokens.expires_at};
}
export async function refreshCredentials(cache, metadata, fetcher = fetch, now = Date.now()) {
  if (!token(cache.refreshToken)) throw new Error('No refresh token is available. Rerun with --login.');
  const data = await jsonRequest(metadata.token_endpoint, {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({grant_type: 'refresh_token', client_id: cache.clientId, refresh_token: cache.refreshToken, resource: cache.serverUrl})}, fetcher);
  return cacheTokens(data, cache, cache.serverUrl, cache.clientId, now);
}
export async function callbackListener(state, timeoutMs = 300000) {
  let resolveCode, rejectCode;
  const code = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // Attach an error handler immediately while registration/browser startup is pending.
  code.catch(() => {});
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    if (req.method !== 'GET' || url.pathname !== '/callback' || url.searchParams.get('state') !== state) { res.writeHead(400).end('Invalid OAuth callback.'); return; }
    if (url.searchParams.has('error')) { res.writeHead(400).end('Authorization was not granted.'); rejectCode(new Error('OAuth authorization was declined.')); return; }
    const value = url.searchParams.get('code');
    if (!value) { res.writeHead(400).end('Missing authorization code.'); return; }
    res.end('GrowthPilot authorized. Return to WorkBuddy while setup finishes.');
    resolveCode(value);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const timer = setTimeout(() => rejectCode(new Error('OAuth timed out. Rerun setup when ready to sign in.')), timeoutMs);
  return {redirectUri: `http://127.0.0.1:${server.address().port}/callback`, code, close: () => { clearTimeout(timer); server.close(); server.closeAllConnections(); }};
}
function openBrowser(url) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  const child = spawn(command, args, {stdio: 'ignore'});
  child.on('error', () => {}); child.unref();
}
export async function authorize(serverUrl, metadata, {fetcher = fetch, onAuthorization = () => {}, open = openBrowser} = {}) {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const callback = await callbackListener(state);
  try {
    const client = await jsonRequest(metadata.registration_endpoint, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({client_name: 'GrowthPilot for WorkBuddy', redirect_uris: [callback.redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope})}, fetcher);
    if (typeof client.client_id !== 'string' || !client.client_id) throw new Error('OAuth registration did not return a client ID.');
    const url = new URL(metadata.authorization_endpoint);
    url.search = new URLSearchParams({response_type: 'code', client_id: client.client_id, redirect_uri: callback.redirectUri, scope, resource: serverUrl, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256'}).toString();
    onAuthorization(url.href);
    await open(url.href);
    const code = await callback.code;
    const data = await jsonRequest(metadata.token_endpoint, {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier, redirect_uri: callback.redirectUri, resource: serverUrl})}, fetcher);
    return cacheTokens(data, null, serverUrl, client.client_id, Date.now());
  } finally { callback.close(); }
}
export async function verifyHttp(serverUrl, accessToken, fetcher = fetch) {
  const headers = {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: connectionEntry(serverUrl, accessToken).headers.Authorization};
  const rpc = async (method, params, id) => {
    const response = await request(serverUrl, {method: 'POST', headers, body: JSON.stringify({jsonrpc: '2.0', ...(id === undefined ? {} : {id}), method, params})}, fetcher);
    const session = response.headers.get('mcp-session-id');
    if (session) headers['Mcp-Session-Id'] = session;
    if (id === undefined) { await response.body?.cancel(); return; }
    const text = await response.text();
    let result;
    try {
      result = response.headers.get('content-type')?.includes('text/event-stream')
        ? text.split(/\r?\n\r?\n/).map(event => event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')).filter(Boolean).map(data => JSON.parse(data)).find(data => data.id === id)
        : JSON.parse(text);
    } catch { throw new Error('MCP returned an invalid response.'); }
    if (!result || result.id !== id || result.error || !result.result) throw new Error('MCP verification failed; no client success is claimed.');
    return result.result;
  };
  const init = await rpc('initialize', {protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {name: 'growthpilot-workbuddy-setup', version: '2.0.0'}}, 1);
  headers['MCP-Protocol-Version'] = init.protocolVersion;
  await rpc('notifications/initialized', {}, undefined);
  const listed = await rpc('tools/list', {}, 2);
  const names = listed.tools?.map(tool => tool.name);
  if (!names?.includes('similarweb_query') || !names.includes('growthpilot_account_get')) throw new Error('The expected GrowthPilot tools were not returned.');
  return {server: init.serverInfo?.name, tools: names};
}
export async function setup({configPath, serverUrl = defaultEndpoint, login = false, refresh = false, importPrefix, fetcher = fetch, onAuthorization, open} = {}) {
  serverUrl = endpoint(serverUrl);
  configPath = readConfig(configPath, serverUrl).configPath;
  const cachePath = configPath + '.growthpilot-oauth.json';
  const lockPath = cachePath + '.lock';
  try { writeFileSync(lockPath, String(process.pid), {mode: 0o600, flag: 'wx'}); }
  catch { throw new Error('Another setup may be running. Wait for it; remove the setup lock only after confirming that process has stopped.'); }
  try {
    const metadata = await discover(serverUrl, fetcher);
    let cache = !login && existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : null;
    if (!login && !cache && importPrefix) cache = importBridgeCache(importPrefix, serverUrl);
    if (cache && (cache.version !== 1 || cache.serverUrl !== serverUrl || typeof cache.clientId !== 'string')) throw new Error('OAuth cache belongs to another connection. Rerun with --login for this endpoint.');
    if (!cache) cache = await authorize(serverUrl, metadata, {fetcher, onAuthorization, open});
    else if (refresh || !token(cache.accessToken) || !(cache.expiresAt > Date.now() + 60000)) cache = await refreshCredentials(cache, metadata, fetcher);
    // Persist rotated refresh tokens before any later verification/configuration can fail.
    saveCache(cachePath, cache);
    const verification = await verifyHttp(serverUrl, cache.accessToken, fetcher);
    const result = configure({configPath, serverUrl, accessToken: cache.accessToken});
    return {...result, authentication: 'verified', terminalVerification: verification, credentialCache: cachePath, accessTokenExpiresAt: new Date(cache.expiresAt).toISOString(), next: 'Open a NEW WorkBuddy conversation and call growthpilot_account_get through its actual MCP tool. A terminal check is not proof of client loading. If absent, reload/save this file in the supported WorkBuddy MCP editor and inspect Trust/Enable, then verify again. Static HTTP headers do not auto-refresh: rerun this script with --refresh and reload the client after token expiry. Never print credentials or modify trust records.'};
  } finally { unlinkSync(lockPath); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const {values} = parseArgs({options: {config: {type: 'string'}, 'server-url': {type: 'string'}, login: {type: 'boolean'}, refresh: {type: 'boolean'}, 'no-browser': {type: 'boolean'}, 'import-mcp-remote': {type: 'string'}}});
    if (values.login && values.refresh) throw new Error('Choose --login or --refresh, not both.');
    const result = await setup({configPath: values.config, serverUrl: values['server-url'], login: values.login, refresh: values.refresh, importPrefix: values['import-mcp-remote'], open: values['no-browser'] ? () => {} : undefined, onAuthorization: url => console.error('Sign in and approve GrowthPilot in your browser. Keep this process running:\n' + url)});
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    // Avoid printing response bodies, token-bearing URLs or untrusted parse errors.
    console.error(error instanceof SyntaxError ? 'Invalid local JSON. Inspect the configuration/cache without printing credentials.' : error.message);
    process.exitCode = 1;
  }
}
