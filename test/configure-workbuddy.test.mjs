import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, symlinkSync, lstatSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configure as configureRaw, connectionEntry as entryRaw, resolveConfigPath, setup, discover, authorize, callbackListener, importBridgeCache } from '../scripts/configure-workbuddy.mjs';

const accessToken = 'fixture-access:token';
const configure = options => configureRaw({...options, accessToken});
const connectionEntry = serverUrl => entryRaw(serverUrl, accessToken);
const endpoint = 'https://grow.apixstar.com/mcp';
function fixture(t, contents) {
  const directory = mkdtempSync(join(tmpdir(), 'growthpilot-workbuddy-test-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const configPath = join(directory, 'mcp.json');
  if (contents !== undefined) writeFileSync(configPath, contents);
  return {directory, configPath};
}

test('backs up existing settings without exposing credentials and preserves unrelated entries', t => {
  const original = JSON.stringify({custom: {enabled: true}, mcpServers: {existing: {url: 'https://example.com/mcp', headers: {Authorization: 'fixture-secret'}}}});
  const {configPath} = fixture(t, original);
  const result = configure({configPath});
  assert.equal(readFileSync(result.backup, 'utf8'), original);
  const updated = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(updated.custom, {enabled: true});
  assert.deepEqual(updated.mcpServers.existing, JSON.parse(original).mcpServers.existing);
  assert.equal(result.status, 'configured_client_load_pending');
  assert.equal(result.transport, 'http');
  assert.equal(result.clientLoad, 'not_checked');
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert.equal(statSync(result.backup).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(result).includes(accessToken));
  assert.ok(!JSON.stringify(result).includes('fixture-secret'));
});

test('creates an absent file in a confirmed directory and is idempotent', t => {
  const {directory, configPath} = fixture(t);
  assert.equal(configure({configPath}).backup, null);
  const saved = readFileSync(configPath, 'utf8');
  assert.equal(configure({configPath}).backup, null);
  assert.equal(readFileSync(configPath, 'utf8'), saved);
  assert.deepEqual(readdirSync(directory), ['mcp.json']);
});

test('rejects malformed config, name conflicts and duplicate endpoints without writing', t => {
  for (const original of ['{broken', '[]', '{"mcpServers":[]}', JSON.stringify({mcpServers: {growthpilot: {url: 'https://other.example/mcp'}}}), JSON.stringify({mcpServers: {anotherName: {url: endpoint}}})]) {
    const {directory, configPath} = fixture(t, original);
    assert.throws(() => configure({configPath}));
    assert.equal(readFileSync(configPath, 'utf8'), original);
    assert.deepEqual(readdirSync(directory), ['mcp.json']);
  }
});

test('migrates the stdio bridge to HTTP and removes its command/args', t => {
  const original = JSON.stringify({mcpServers: {growthpilot: {command: 'npx', args: ['-y', 'mcp-remote@0.15.1', endpoint], disabled: false}}});
  const {configPath} = fixture(t, original);
  const result = configure({configPath});
  assert.equal(readFileSync(result.backup, 'utf8'), original);
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).mcpServers.growthpilot, connectionEntry(endpoint));
});

test('retains a settings symlink', t => {
  const {directory, configPath} = fixture(t, '{}');
  const linked = join(directory, 'linked.json');
  symlinkSync(configPath, linked);
  configure({configPath: linked});
  assert.ok(lstatSync(linked).isSymbolicLink());
  assert.ok(JSON.parse(readFileSync(configPath, 'utf8')).mcpServers.growthpilot);
});

test('keeps alternate deployment endpoints and rejects unsafe credentials', t => {
  const {configPath} = fixture(t);
  const serverUrl = 'https://growthpilot-checkout-test.986882074.workers.dev/mcp';
  const result = configure({configPath, serverUrl});
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).mcpServers.growthpilot.url, serverUrl);
  assert.ok(!JSON.stringify(result).includes('grow.apixstar.com'));
  for (const accessToken of [undefined, '', 'token\r\nInjected: bad']) assert.throws(() => configureRaw({configPath, serverUrl, accessToken}));
});

test('refuses unknown directories and unsafe endpoint forms', t => {
  const {directory, configPath} = fixture(t);
  assert.throws(() => configure({configPath: join(directory, 'missing', 'mcp.json')}), /directory is missing/);
  for (const serverUrl of ['http://example.com/mcp', 'https://secret@example.com/mcp', 'https://example.com/mcp?token=secret']) assert.throws(() => configure({configPath, serverUrl}));
  assert.deepEqual(readdirSync(directory), []);
});

test('published template is HTTP with a token placeholder, never an executable bridge', () => {
  const template = JSON.parse(readFileSync(new URL('../clients/workbuddy.json', import.meta.url), 'utf8'));
  assert.deepEqual(template.mcpServers.growthpilot, entryRaw(endpoint, '<access_token>'));
});

test('resolves either WorkBuddy edition without creating a second configuration directory', t => {
  for (const edition of ['.workbuddy', '.workbuddy-ai']) {
    const {directory: homeDir} = fixture(t);
    mkdirSync(join(homeDir, edition));
    assert.equal(resolveConfigPath({homeDir, configDir: ''}), join(homeDir, edition, 'mcp.json'));
    assert.deepEqual(readdirSync(homeDir), [edition]);
  }
});

test('requires the active settings path when both editions or neither edition exist', t => {
  const {directory: homeDir} = fixture(t);
  assert.throws(() => resolveConfigPath({homeDir, configDir: ''}), /pass --config/);
  mkdirSync(join(homeDir, '.workbuddy'));
  mkdirSync(join(homeDir, '.workbuddy-ai'));
  assert.throws(() => resolveConfigPath({homeDir, configDir: ''}), /pass --config/);
  const configPath = join(homeDir, '.workbuddy-ai', 'mcp.json');
  assert.equal(resolveConfigPath({homeDir, configDir: join(homeDir, '.workbuddy')}), join(homeDir, '.workbuddy', 'mcp.json'));
  assert.equal(resolveConfigPath({homeDir, configDir: join(homeDir, '.workbuddy'), configPath}), configPath);
  assert.deepEqual(readdirSync(join(homeDir, '.workbuddy')), []);
  assert.deepEqual(readdirSync(join(homeDir, '.workbuddy-ai')), []);
});

const origin = 'https://grow.apixstar.com';
const metadata = {issuer: origin, authorization_endpoint: origin + '/oauth/authorize', token_endpoint: origin + '/oauth/token', registration_endpoint: origin + '/oauth/register', code_challenge_methods_supported: ['S256']};
const reply = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
function fakeServer(t, {failTools = false} = {}) {
  const seen = [];
  const fetcher = async (url, options) => {
    assert.equal(options.redirect, 'error');
    seen.push({url, options});
    if (url.endsWith('/.well-known/oauth-authorization-server')) return reply(metadata);
    if (url.endsWith('/oauth/token')) {
      assert.equal(options.body.get('grant_type'), 'refresh_token');
      assert.equal(options.body.get('resource'), endpoint);
      return reply({access_token: 'fresh-access:secret', refresh_token: 'rotated-refresh:secret', token_type: 'bearer', expires_in: 900});
    }
    if (url === endpoint) {
      assert.equal(options.headers.Authorization, 'Bearer fresh-access:secret');
      const message = JSON.parse(options.body);
      if (message.method === 'initialize') return reply({id: message.id, result: {protocolVersion: '2025-03-26', serverInfo: {name: 'growthpilot-similarweb'}}});
      if (message.method === 'notifications/initialized') return new Response(null, {status: 202});
      assert.equal(message.method, 'tools/list');
      return failTools ? reply({id: message.id, error: {message: 'fixture-secret'}}, 200) : new Response('event: message\ndata: ' + JSON.stringify({id: message.id, result: {tools: [{name: 'similarweb_query'}, {name: 'growthpilot_account_get'}]}}) + '\n\n', {headers: {'Content-Type': 'text/event-stream'}});
    }
    throw new Error('Unexpected request');
  };
  return {fetcher, seen};
}
function writeCache(configPath, extra = {}) {
  const cache = {version: 1, serverUrl: endpoint, clientId: 'fixture-client', accessToken: 'expired', refreshToken: 'old-refresh:secret', expiresAt: 0, ...extra};
  writeFileSync(configPath + '.growthpilot-oauth.json', JSON.stringify(cache), {mode: 0o600});
}
test('refreshes OAuth, persists rotation, verifies HTTP and writes direct config without credential output', async t => {
  const {configPath} = fixture(t, '{}');
  writeCache(configPath);
  const {fetcher, seen} = fakeServer(t);
  const result = await setup({configPath, fetcher});
  assert.equal(result.authentication, 'verified');
  assert.equal(result.clientLoad, 'not_checked');
  assert.equal(result.terminalVerification.tools.length, 2);
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).mcpServers.growthpilot.headers.Authorization, 'Bearer fresh-access:secret');
  assert.equal(JSON.parse(readFileSync(result.credentialCache, 'utf8')).refreshToken, 'rotated-refresh:secret');
  assert.equal(statSync(result.credentialCache).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.ok(!seen.some(({options}) => options.body?.includes?.('tools/call')));
});
test('failed HTTP verification retains rotated credentials but does not overwrite client config', async t => {
  const {configPath, directory} = fixture(t, '{}');
  writeCache(configPath);
  await assert.rejects(setup({configPath, ...fakeServer(t, {failTools: true})}), /MCP verification failed/);
  assert.equal(readFileSync(configPath, 'utf8'), '{}');
  assert.equal(JSON.parse(readFileSync(configPath + '.growthpilot-oauth.json')).refreshToken, 'rotated-refresh:secret');
  assert.ok(!readdirSync(directory).some(path => path.endsWith('.lock')));
});
test('prevents credentials being sent to an OAuth endpoint on a different origin', async () => {
  await assert.rejects(discover(endpoint, async () => reply({...metadata, token_endpoint: 'https://evil.example/token'})), /selected GrowthPilot origin/);
});
test('cached valid credentials avoid a new login and explicit refresh updates them', async t => {
  const {configPath} = fixture(t);
  writeCache(configPath, {accessToken: 'fresh-access:secret', expiresAt: Date.now() + 600000});
  const first = fakeServer(t);
  await setup({configPath, ...first});
  assert.ok(!first.seen.some(({url}) => url.endsWith('/oauth/token')));
  const second = fakeServer(t);
  await setup({configPath, refresh: true, ...second});
  assert.ok(second.seen.some(({url}) => url.endsWith('/oauth/token')));
});
test('full public-client OAuth uses random state, S256 and a loopback callback without printing codes', async t => {
  const {createHash} = await import('node:crypto');
  let authorization, registration;
  const fetcher = async (url, options) => {
    if (url.endsWith('/register')) {
      registration = JSON.parse(options.body);
      assert.equal(registration.token_endpoint_auth_method, 'none');
      assert.ok(registration.redirect_uris[0].startsWith('http://127.0.0.1:'));
      return reply({client_id: 'fixture-public-client'});
    }
    assert.equal(url, metadata.token_endpoint);
    const params = options.body;
    assert.equal(params.get('grant_type'), 'authorization_code');
    assert.equal(params.get('resource'), endpoint);
    assert.equal(params.get('code'), 'fixture-code');
    assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'), authorization.searchParams.get('code_challenge'));
    return reply({access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'Bearer', expires_in: 900});
  };
  const result = await authorize(endpoint, metadata, {fetcher, open: async url => {
    authorization = new URL(url);
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(authorization.searchParams.get('state').length >= 43);
    const callback = new URL(authorization.searchParams.get('redirect_uri'));
    callback.search = new URLSearchParams({code: 'fixture-code', state: 'wrong-state'});
    assert.equal((await fetch(callback)).status, 400);
    callback.searchParams.set('state', authorization.searchParams.get('state'));
    assert.equal((await fetch(callback)).status, 200);
  }});
  assert.equal(result.accessToken, 'new-access');
  assert.equal(result.serverUrl, endpoint);
});
test('callback times out and cleanup releases its listening socket', async () => {
  const callback = await callbackListener('fixture-state', 20);
  try { await assert.rejects(callback.code, /timed out/); }
  finally { callback.close(); }
});
test('refuses a mismatched cache before transmitting any token', async t => {
  const {configPath} = fixture(t);
  writeCache(configPath, {serverUrl: 'https://other.example/mcp'});
  const server = fakeServer(t);
  await assert.rejects(setup({configPath, ...server}), /another connection/);
  assert.equal(server.seen.length, 1);
});
test('imports only a bridge cache whose token and client issuers both match', t => {
  const {directory} = fixture(t);
  const prefix = join(directory, 'bridge');
  writeFileSync(prefix + '_tokens.json', JSON.stringify({issuer: origin, access_token: 'access:secret', refresh_token: 'refresh:secret', expires_at: 1234}));
  writeFileSync(prefix + '_client_info.json', JSON.stringify({issuer: origin, client_id: 'client'}));
  assert.deepEqual(importBridgeCache(prefix, endpoint), {version: 1, serverUrl: endpoint, clientId: 'client', accessToken: 'access:secret', refreshToken: 'refresh:secret', expiresAt: 1234});
  writeFileSync(prefix + '_client_info.json', JSON.stringify({issuer: 'https://foreign.example', client_id: 'client'}));
  assert.throws(() => importBridgeCache(prefix, endpoint), /does not belong/);
});
test('an existing setup lock prevents concurrent refresh-token consumption', async t => {
  const {configPath} = fixture(t, '{}');
  writeCache(configPath);
  writeFileSync(configPath + '.growthpilot-oauth.json.lock', 'fixture-process');
  const server = fakeServer(t);
  await assert.rejects(setup({configPath, ...server}), /Another setup may be running/);
  assert.equal(server.seen.length, 0);
  assert.equal(readFileSync(configPath + '.growthpilot-oauth.json.lock', 'utf8'), 'fixture-process');
});
