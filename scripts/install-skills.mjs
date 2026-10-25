import {existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {parseArgs} from 'node:util';

const pluginRoot = fileURLToPath(new URL('../plugins/growthpilot/', import.meta.url));
const marker = '.growthpilot-skill.json';
const definitions = [
  {source: 'website-research', name: 'growthpilot-website-research', files: ['SKILL.md', 'references/source-selection.md']},
  {source: 'account', name: 'growthpilot-account', files: ['SKILL.md']},
];
const hash = content => createHash('sha256').update(content).digest('hex');
function regularFile(path) {
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('Expected a regular skill file: ' + path);
  return readFileSync(path, 'utf8');
}
function existingFiles(path, prefix = '') {
  return readdirSync(path).flatMap(name => {
    const relative = prefix + name, info = lstatSync(join(path, name));
    if (info.isSymbolicLink()) throw new Error('Refusing a symlink inside an installed skill: ' + relative);
    return info.isDirectory() ? existingFiles(join(path, name), relative + '/') : [relative];
  });
}

// The caller confirms the directory with the running client's documentation first.
// A client's MCP config directory is not evidence of its skill discovery path.
export function prepareSkills({skillsDir, sourceRoot = pluginRoot} = {}) {
  if (!skillsDir || !isAbsolute(skillsDir)) throw new Error('Pass --skills-dir with the absolute user skill directory confirmed by your client.');
  const root = resolve(skillsDir);
  if (existsSync(root) && (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())) throw new Error('The skill directory must be a real directory.');
  const {version} = JSON.parse(regularFile(join(sourceRoot, '.codex-plugin/plugin.json')));
  const plans = definitions.map(definition => {
    const directory = join(root, definition.name);
    const files = Object.fromEntries(definition.files.map(file => {
      let content = regularFile(join(sourceRoot, 'skills', definition.source, file));
      if (file === 'SKILL.md') {
        const expected = '---\nname: ' + definition.source + '\n';
        if (!content.startsWith(expected)) throw new Error('Unexpected skill frontmatter: ' + definition.source);
        content = content.replace(expected, '---\nname: ' + definition.name + '\n');
      }
      return [file, content];
    }));
    const hashes = Object.fromEntries(Object.entries(files).map(([file, content]) => [file, hash(content)]));
    let unchanged = false;
    if (existsSync(directory)) {
      if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('Refusing to replace an existing skill path: ' + directory);
      if (!existsSync(join(directory, marker))) throw new Error('An unmanaged skill already exists. Inspect and migrate it before retrying: ' + directory);
      const previous = JSON.parse(regularFile(join(directory, marker)));
      if (previous.name !== definition.name || !previous.files || Array.isArray(previous.files) || typeof previous.files !== 'object') throw new Error('Invalid APIxStar Grow skill record: ' + directory);
      const actual = existingFiles(directory).filter(file => file !== marker).sort();
      if (JSON.stringify(actual) !== JSON.stringify(Object.keys(previous.files).sort()) || actual.some(file => hash(regularFile(join(directory, file))) !== previous.files[file])) throw new Error('The installed skill contains local changes. Back it up and resolve the changes before retrying: ' + directory);
      unchanged = actual.length === Object.keys(files).length && actual.every(file => hashes[file] === previous.files[file]);
    }
    return {root, directory, name: definition.name, version, files, hashes, unchanged};
  });
  return plans;
}

export function installSkills(plans) {
  return plans.map(plan => {
    if (plan.unchanged) return {name: plan.name, directory: plan.directory, status: 'already_installed', clientLoad: 'not_checked'};
    mkdirSync(plan.root, {recursive: true});
    const stage = join(plan.root, '.growthpilot-stage-' + randomUUID());
    let backup = null;
    try {
      mkdirSync(stage);
      for (const [file, content] of Object.entries(plan.files)) {
        mkdirSync(dirname(join(stage, file)), {recursive: true});
        writeFileSync(join(stage, file), content, {flag: 'wx'});
      }
      writeFileSync(join(stage, marker), JSON.stringify({name: plan.name, version: plan.version, files: plan.hashes}, null, 2) + '\n', {flag: 'wx'});
      if (existsSync(plan.directory)) {
        backup = join(dirname(plan.root), 'growthpilot-skill-backups', randomUUID(), plan.name);
        mkdirSync(dirname(backup), {recursive: true});
        renameSync(plan.directory, backup);
      }
      renameSync(stage, plan.directory);
    } catch (error) {
      if (backup && existsSync(backup) && !existsSync(plan.directory)) renameSync(backup, plan.directory);
      throw error;
    } finally {
      rmSync(stage, {recursive: true, force: true});
    }
    return {name: plan.name, directory: plan.directory, status: 'installed_client_load_pending', backup, clientLoad: 'not_checked'};
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  try {
    const {values} = parseArgs({options: {'skills-dir': {type: 'string'}}});
    const skills = installSkills(prepareSkills({skillsDir: values['skills-dir']}));
    console.log(JSON.stringify({status: 'skills_client_load_pending', skills, skillsLoad: 'not_checked', next: 'Reload both APIxStar Grow skills using your client controls, then verify their source-selection reference and a native growthpilot_account_get call through the separately configured MCP connection. Skill installation does not configure or authorize MCP.'}, null, 2));
  } catch (error) {
    console.error(error instanceof SyntaxError ? 'Invalid skill installation record. Inspect local files before retrying.' : error.message);
    process.exitCode = 1;
  }
}
