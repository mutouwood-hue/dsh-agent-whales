import {build} from 'esbuild';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,cpSync,readdirSync,existsSync,rmSync} from 'node:fs';
import {resolve,dirname,join,parse} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import './build.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const {version}=JSON.parse(readFileSync(join(here,'package.json'),'utf8'));
const name='whales-cursor-design-'+version,dist=join(here,'dist'),target=join(dist,name);
rmSync(target,{recursive:true,force:true});
mkdirSync(join(target,'dist'),{recursive:true});
const result=await build({entryPoints:[join(here,'server.mjs')],outfile:join(target,'server.mjs'),bundle:true,platform:'node',format:'esm',target:'node22',metafile:true,plugins:[{name:'bundle-design-compiler-deps',setup(build){
 // The DSH compiler uses createRequire to probe optional host dependencies.
 // This distribution includes them, so expose these imports to the bundler.
 build.onLoad({filter:/[/\\]design[/\\]compile\.js$/},args=>({contents:readFileSync(args.path,'utf8').replace(/\brequireHere\(/g,'require('),loader:'js',resolveDir:dirname(args.path)}));
}}],banner:{js:"import {createRequire as __createRequire} from 'node:module'; const require=__createRequire(import.meta.url);"},legalComments:'eof'});
copyFileSync(join(here,'dist/app.html'),join(target,'dist/app.html'));
cpSync(join(here,'skill'),join(target,'skill'),{recursive:true});
const notices=[];const seen=new Set();
for(const input of Object.keys(result.metafile.inputs)){
 let directory=dirname(resolve(input));
 while(directory!==parse(directory).root){
  const file=join(directory,'package.json');
  if(existsSync(file)){
   if(seen.has(file))break;seen.add(file);
   const pkg=JSON.parse(readFileSync(file,'utf8'));
   if(!pkg.name){directory=dirname(directory);continue;}
   const files=readdirSync(directory).filter(f=>/^(licen[cs]e|copying|notice)(\..*)?$/i.test(f));
   notices.push(`\n===== ${pkg.name} ${pkg.version} (${pkg.license||'see license'}) =====\n`+files.map(f=>readFileSync(join(directory,f),'utf8')).join('\n'));
   break;
  }
  directory=dirname(directory);
 }
}
for(const f of ['REACT-LICENSE.txt','REACT-FLOW-LICENSE.txt'])notices.push(readFileSync(join(here,'editor-extension',f),'utf8'));
writeFileSync(join(target,'THIRD-PARTY-NOTICES.txt'),notices.join('\n'));
copyFileSync(join(here,'editor-extension/LICENSE'),join(target,'LICENSE'));
writeFileSync(join(target,'README.md'),`# Whales Design ${version} · Cursor MCP\n\n需要 Node.js 22+。此包已包含服务依赖和设计预览，无需 npm install。另安装同版本 Whales Design Canvas VSIX。\n\n在目标项目的 .cursor/mcp.json 中合并（替换为实际绝对路径）：\n\n\`\`\`json\n{\"mcpServers\":{\"whales-design\":{\"command\":\"node\",\"args\":[\"/绝对路径/${name}/server.mjs\"],\"env\":{\"WHALES_WORKSPACE\":\"/绝对路径/你的项目\"}}}}\n\`\`\`\n\nWindows 路径使用正斜杠。重新加载 Cursor，确认 MCP 服务器连接。可将 skill/ 复制到项目的 .cursor/skills/whales-cursor-design/。在对话中要求使用 whales_design_write 生成设计。已有配置请合并，不要覆盖。\n\n画板保存在项目 .whales-design/；重渲染、全屏和画板外框缩放不会修改 TSX 源码。MCP 对话全屏优先使用宿主支持的显示模式，不支持时在当前预览内弹窗。Cursor 团队、办公室和项目文件分类不属于本设计适配层。\n`);
const archive=join(dist,name+'.zip');
rmSync(archive,{force:true});
execFileSync('zip',['-q','-r',archive,name],{cwd:dist});
console.log(archive);
