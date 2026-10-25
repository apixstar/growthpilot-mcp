import {readFile,writeFile,mkdir,lstat,realpath} from 'node:fs/promises';
import {dirname,resolve,relative,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {crc32,deflateRawSync} from 'node:zlib';

export const distributionFiles=[
  '.agents/plugins/marketplace.json',
  '.claude-plugin/marketplace.json',
  'download/INSTALL.md',
  'scripts/configure-workbuddy.mjs',
  'scripts/install-skills.mjs',
  'plugins/growthpilot/.codex-plugin/plugin.json',
  'plugins/growthpilot/.claude-plugin/plugin.json',
  'plugins/growthpilot/.mcp.json',
  'plugins/growthpilot/skills/account/SKILL.md',
  'plugins/growthpilot/skills/website-research/SKILL.md',
  'plugins/growthpilot/skills/website-research/references/source-selection.md',
];
const defaultRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');

// A small, deterministic ZIP: no runtime dependencies, timestamps or local paths.
function zip(entries){
  const local=[],central=[];let offset=0;
  for(const {name,data} of entries){
    const filename=Buffer.from(name),compressed=deflateRawSync(data,{level:9}),checksum=crc32(data);
    const header=Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);
    header.writeUInt16LE(8,8);header.writeUInt16LE(33,12); // 1980-01-01
    header.writeUInt32LE(checksum,14);header.writeUInt32LE(compressed.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(filename.length,26);
    const directory=Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);directory.writeUInt16LE(20,4);header.copy(directory,6,4,30);
    directory.writeUInt32LE(offset,42);
    local.push(header,filename,compressed);central.push(directory,filename);
    offset+=header.length+filename.length+compressed.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);
  end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}

export async function packagePlugin(root=defaultRoot){
  const base=await realpath(root),files=new Map();
  for(const name of distributionFiles){
    const path=resolve(base,name),resolved=await realpath(path),rel=relative(base,resolved);
    if((await lstat(path)).isSymbolicLink()||rel.startsWith('..'+sep)||rel==='..')throw new Error('Refusing an external or symlinked distribution file: '+name);
    files.set(name,await readFile(path));
  }
  const json=name=>JSON.parse(files.get(name).toString('utf8'));
  const codex=json('plugins/growthpilot/.codex-plugin/plugin.json'),claude=json('plugins/growthpilot/.claude-plugin/plugin.json');
  const version=codex.version;
  if(!/^\d+\.\d+\.\d+$/.test(version)||claude.version!==version)throw new Error('Plugin versions must match and use major.minor.patch.');
  for(const manifest of [codex,claude]){
    if(manifest.name!=='growthpilot'||manifest.skills!=='./skills/'||manifest.mcpServers!=='./.mcp.json')throw new Error('Update the distribution file list for the new plugin layout.');
  }
  const mcp=json('plugins/growthpilot/.mcp.json');
  if(JSON.stringify(mcp)!==JSON.stringify({mcpServers:{growthpilot:{type:'http',url:'https://grow.apixstar.com/mcp'}}}))throw new Error('Only the public OAuth MCP configuration may be distributed.');
  for(const name of ['.agents/plugins/marketplace.json','.claude-plugin/marketplace.json']){
    const marketplace=json(name),entry=marketplace.plugins?.[0];
    if(marketplace.plugins?.length!==1||entry.name!=='growthpilot'||(typeof entry.source==='string'?entry.source:entry.source.path)!=='./plugins/growthpilot')throw new Error('Unexpected marketplace layout.');
    if(entry.version!==undefined&&entry.version!==version)throw new Error('Marketplace version does not match the plugin.');
    marketplace.name='apixstar-download';
    if(marketplace.interface)marketplace.interface.displayName='Apixstar · Local download';
    files.set(name,Buffer.from(JSON.stringify(marketplace,null,2)+'\n'));
  }
  const entries=[...files].map(([name,data])=>({name:'growthpilot/'+(name==='download/INSTALL.md'?'INSTALL.md':name),data}));
  return {filename:`growthpilot-plugin-${version}.zip`,version,data:zip(entries)};
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const output=resolve(process.argv[2]??resolve(defaultRoot,'../worker/public/downloads'));
  const archive=await packagePlugin();
  await mkdir(output,{recursive:true});
  await writeFile(resolve(output,archive.filename),archive.data);
  console.log(`Packaged ${archive.filename} (${archive.data.length} bytes)`);
}
