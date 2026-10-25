import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {setup} from '../scripts/configure-workbuddy.mjs';
import {prepareSkills, installSkills} from '../scripts/install-skills.mjs';

const source = fileURLToPath(new URL('../plugins/growthpilot/', import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'growthpilot-skills-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const skillsDir = join(root, '.codebuddy/skills'), configPath = join(root, 'mcp.json');
  return {root, skillsDir, configPath};
}

test('full setup installs both complete skills, preserves unrelated MCP settings and stays pending client verification', async t => {
  const options = fixture(t);
  writeFileSync(options.configPath, JSON.stringify({mcpServers: {unrelated: {url: 'https://other.example/mcp'}}}));
  const result = await setup(options);
  assert.equal(result.skillsLoad, 'not_checked');
  assert.equal(result.authentication, 'client_oauth_pending');
  assert.equal(result.skills.length, 2);
  for (const skill of ['website-research', 'account']) {
    const expected = readFileSync(join(source, 'skills', skill, 'SKILL.md'), 'utf8').replace('name: ' + skill + '\n', 'name: growthpilot-' + skill + '\n');
    assert.equal(readFileSync(join(options.skillsDir, 'growthpilot-' + skill, 'SKILL.md'), 'utf8'), expected);
  }
  assert.equal(readFileSync(join(options.skillsDir, 'growthpilot-website-research/references/source-selection.md'), 'utf8'), readFileSync(join(source, 'skills/website-research/references/source-selection.md'), 'utf8'));
  assert.deepEqual(JSON.parse(readFileSync(options.configPath, 'utf8')).mcpServers.unrelated, {url: 'https://other.example/mcp'});
});

test('downloaded CLI also runs when its directory is accessed through a filesystem alias', t => {
  const options = fixture(t), alias = join(options.root, 'download');
  symlinkSync(fileURLToPath(new URL('../', import.meta.url)), alias, 'dir');
  const output = execFileSync(process.execPath, [join(alias, 'scripts/configure-workbuddy.mjs'), '--skills-only', '--skills-dir', options.skillsDir], {encoding: 'utf8'});
  const result = JSON.parse(output);
  assert.equal(result.skills.length, 2);
  assert.ok(result.skills.every(skill => skill.status === 'installed_client_load_pending'));
});

test('standalone skill CLI supports TRAE, Codex and Claude directories without touching MCP or other files', t => {
  const {root} = fixture(t);
  const cli = fileURLToPath(new URL('../scripts/install-skills.mjs', import.meta.url));
  for (const client of ['.trae-cn', '.agents', '.claude']) {
    const clientRoot = join(root, client), skillsDir = join(clientRoot, 'skills');
    mkdirSync(clientRoot);
    writeFileSync(join(clientRoot, 'mcp.json'), 'untouched client settings');
    const result = JSON.parse(execFileSync(process.execPath, [cli, '--skills-dir', skillsDir], {encoding: 'utf8'}));
    assert.equal(result.status, 'skills_client_load_pending');
    assert.equal(result.skillsLoad, 'not_checked');
    assert.deepEqual(result.skills.map(skill => skill.name), ['growthpilot-website-research', 'growthpilot-account']);
    assert.ok(existsSync(join(skillsDir, 'growthpilot-website-research/references/source-selection.md')));
    assert.equal(readFileSync(join(clientRoot, 'mcp.json'), 'utf8'), 'untouched client settings');
    assert.deepEqual(readdirSync(clientRoot).sort(), ['mcp.json', 'skills']);
  }
});

test('repeat installation reuses skill files and preserves unrelated skills', async t => {
  const options = fixture(t);
  mkdirSync(join(options.skillsDir, 'unrelated'), {recursive: true});
  writeFileSync(join(options.skillsDir, 'unrelated/SKILL.md'), 'local work');
  await setup(options);
  const result = await setup(options);
  assert.ok(result.skills.every(skill => skill.status === 'already_installed'));
  assert.equal(result.backup, null);
  assert.equal(readFileSync(join(options.skillsDir, 'unrelated/SKILL.md'), 'utf8'), 'local work');
  assert.deepEqual(readdirSync(options.skillsDir).sort(), ['growthpilot-account', 'growthpilot-website-research', 'unrelated']);
});

test('skills-only mode reuses an existing connector without reading or changing MCP configuration', async t => {
  const options = fixture(t);
  writeFileSync(options.configPath, 'deliberately not valid JSON');
  const result = await setup({...options, skillsOnly: true});
  assert.equal(result.status, 'skills_client_load_pending');
  assert.equal(result.authentication, 'not_checked');
  assert.equal(readFileSync(options.configPath, 'utf8'), 'deliberately not valid JSON');
  await assert.rejects(setup({skillsOnly: true}), /requires --skills-dir/);
});

test('preflights all skill conflicts before writing any skills or changing the MCP configuration', async t => {
  const options = fixture(t);
  writeFileSync(options.configPath, '{}');
  mkdirSync(join(options.skillsDir, 'growthpilot-account'), {recursive: true});
  writeFileSync(join(options.skillsDir, 'growthpilot-account/SKILL.md'), 'user-owned');
  await assert.rejects(setup(options), /unmanaged/);
  assert.equal(readFileSync(options.configPath, 'utf8'), '{}');
  assert.deepEqual(readdirSync(options.skillsDir), ['growthpilot-account']);
});

test('invalid MCP configuration leaves the skills directory untouched', async t => {
  const options = fixture(t);
  writeFileSync(options.configPath, '{invalid');
  await assert.rejects(setup(options), /not valid JSON/);
  assert.equal(existsSync(options.skillsDir), false);
});

test('refuses guessed relative directories, symlinks and local changes', async t => {
  const options = fixture(t);
  assert.throws(() => prepareSkills({skillsDir: 'skills'}), /absolute user skill directory/);
  await setup(options);
  const skillPath = join(options.skillsDir, 'growthpilot-account/SKILL.md');
  writeFileSync(skillPath, readFileSync(skillPath, 'utf8') + '\nMy local change\n');
  await assert.rejects(setup(options), /local changes/);
  assert.ok(readFileSync(skillPath, 'utf8').endsWith('My local change\n'));
  const linked = join(options.root, 'linked-skills');
  symlinkSync(options.skillsDir, linked);
  assert.throws(() => prepareSkills({skillsDir: linked}), /real directory/);
});

test('updates unmodified managed skills while preserving a complete backup outside skill discovery', t => {
  const options = fixture(t), sourceRoot = join(options.root, 'new-plugin');
  installSkills(prepareSkills(options));
  cpSync(source, sourceRoot, {recursive: true});
  const newSkill = join(sourceRoot, 'skills/account/SKILL.md');
  writeFileSync(newSkill, readFileSync(newSkill, 'utf8') + '\nUpdated guidance\n');
  const results = installSkills(prepareSkills({...options, sourceRoot}));
  assert.equal(results[0].status, 'already_installed');
  assert.equal(results[1].status, 'installed_client_load_pending');
  assert.ok(results[1].backup.includes('growthpilot-skill-backups'));
  assert.ok(!results[1].backup.startsWith(options.skillsDir + '/'));
  assert.equal(readFileSync(join(results[1].backup, 'SKILL.md'), 'utf8'), readFileSync(join(source, 'skills/account/SKILL.md'), 'utf8').replace('name: account\n', 'name: growthpilot-account\n'));
  assert.ok(readFileSync(join(results[1].directory, 'SKILL.md'), 'utf8').endsWith('Updated guidance\n'));
});
