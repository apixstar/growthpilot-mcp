import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, symlinkSync, lstatSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configure, connectionEntry, resolveConfigPath, setup } from '../scripts/configure-workbuddy.mjs';

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

test('keeps alternate deployment endpoints without injecting credentials', t => {
  const {configPath} = fixture(t);
  const serverUrl = 'https://growthpilot-checkout-test.986882074.workers.dev/mcp';
  const result = configure({configPath, serverUrl});
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).mcpServers.growthpilot.url, serverUrl);
  assert.ok(!JSON.stringify(result).includes('grow.apixstar.com'));
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).mcpServers.growthpilot, {type: 'http', url: serverUrl});
});

test('refuses unknown directories and unsafe endpoint forms', t => {
  const {directory, configPath} = fixture(t);
  assert.throws(() => configure({configPath: join(directory, 'missing', 'mcp.json')}), /directory is missing/);
  for (const serverUrl of ['http://example.com/mcp', 'https://secret@example.com/mcp', 'https://example.com/mcp?token=secret']) assert.throws(() => configure({configPath, serverUrl}));
  assert.deepEqual(readdirSync(directory), []);
});

test('published template uses native HTTP OAuth without a fixed token or bridge', () => {
  const template = JSON.parse(readFileSync(new URL('../clients/workbuddy.json', import.meta.url), 'utf8'));
  assert.deepEqual(template.mcpServers.growthpilot, {type: 'http', url: endpoint});
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

test('migrates expired fixed headers without reading or consuming the old refresh cache', async t => {
  const original = JSON.stringify({mcpServers: {growthpilot: {type: 'http', url: endpoint, headers: {Authorization: 'Bearer expired-secret'}}}});
  const {configPath, directory} = fixture(t, original);
  const cachePath = configPath + '.growthpilot-oauth.json';
  const cache = '{"refreshToken":"private-refresh-secret"}';
  writeFileSync(cachePath, cache);
  const result = await setup({configPath});
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).mcpServers.growthpilot, {type: 'http', url: endpoint});
  assert.equal(readFileSync(result.backup, 'utf8'), original);
  assert.equal(readFileSync(cachePath, 'utf8'), cache);
  assert.equal(result.authentication, 'client_oauth_pending');
  assert.equal(result.clientLoad, 'not_checked');
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.equal(readdirSync(directory).length, 3);
});

test('default installer creates no external OAuth cache and makes no network request', async t => {
  const {configPath, directory} = fixture(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Installer must leave authorization to WorkBuddy'); };
  try {
    const result = await setup({configPath});
    assert.equal(result.authentication, 'client_oauth_pending');
    assert.deepEqual(readdirSync(directory), ['mcp.json']);
  } finally { globalThis.fetch = originalFetch; }
});
