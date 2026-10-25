import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {distributionFiles,packagePlugin} from '../scripts/package-plugin.mjs';

const source=fileURLToPath(new URL('../',import.meta.url));
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'growthpilot-package-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  for(const file of distributionFiles){await mkdir(dirname(join(root,file)),{recursive:true});await copyFile(join(source,file),join(root,file));}
  return root;
}
async function update(root,path,edit){
  const file=join(root,path),data=JSON.parse(await readFile(file,'utf8'));
  edit(data);await writeFile(file,JSON.stringify(data));
}

test('packaging is reproducible and ignores private files outside the distribution allowlist',async t=>{
  const root=await fixture(t),before=await packagePlugin(root);
  await writeFile(join(root,'.env'),'PRIVATE_SECRET=not-for-download');
  await mkdir(join(root,'plugins/growthpilot/.git'));await writeFile(join(root,'plugins/growthpilot/.git/config'),'private repository');
  const after=await packagePlugin(root);
  assert.deepEqual(after.data,before.data);
  assert.equal(after.filename,`growthpilot-plugin-${after.version}.zip`);
});
test('rejects version drift between the plugin manifests or marketplace',async t=>{
  for(const file of ['plugins/growthpilot/.claude-plugin/plugin.json','.claude-plugin/marketplace.json']){
    const root=await fixture(t);
    await update(root,file,data=>{if(data.plugins)data.plugins[0].version='99.0.0';else data.version='99.0.0';});
    await assert.rejects(packagePlugin(root),/version/i);
  }
});
test('refuses an MCP bundle containing credentials or a non-production endpoint',async t=>{
  for(const edit of [data=>{data.mcpServers.growthpilot.headers={Authorization:'Bearer private'};},data=>{data.mcpServers.growthpilot.url='https://test.example/mcp';}]){
    const root=await fixture(t);await update(root,'plugins/growthpilot/.mcp.json',edit);
    await assert.rejects(packagePlugin(root),/public OAuth/);
  }
});
test('refuses symlinked distribution files',async t=>{
  const root=await fixture(t),target=join(root,'plugins/growthpilot/skills/account/SKILL.md');
  await rm(target);await symlink(join(source,'plugins/growthpilot/skills/account/SKILL.md'),target);
  await assert.rejects(packagePlugin(root),/external or symlinked/);
});
