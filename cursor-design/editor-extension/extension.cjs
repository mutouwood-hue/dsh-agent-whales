const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function activate(context) {
  let view, timer, selectedWorkspace;
  const workspaces = () => vscode.workspace.workspaceFolders || [];
  const rootOf = folder => path.join(folder.uri.fsPath, '.whales-design');
  function getSnapshot(folder) {
    const base = rootOf(folder), boardDir = path.join(base, 'design', 'workspace', 'artboards');
    let entries = []; try { entries=fs.readdirSync(boardDir,{withFileTypes:true}).filter(d=>d.isDirectory() && /^[a-z0-9-]{1,32}$/.test(d.name)); } catch(e) { if(e.code!=='ENOENT') throw e; }
    const boards=[];
    for (const entry of entries) {
      try { const dir=path.join(boardDir,entry.name); const meta=JSON.parse(fs.readFileSync(path.join(dir,'meta.json'),'utf8')); const code=fs.readFileSync(path.join(dir,'compiled.js'),'utf8'); if(Buffer.byteLength(code)>256*1024)continue; boards.push({id:entry.name,title:meta.title||entry.name,width:meta.width==='mobile'?'mobile':'desktop',code,jsxTable:meta.jsxTable||[]}); } catch(e) { console.warn('Whales: unable to read board',entry.name,e.message); }
    }
    boards.sort((a,b)=>a.id.localeCompare(b.id));
    let layout={}; try { layout=JSON.parse(fs.readFileSync(path.join(base,'canvas.json'),'utf8')); } catch(e) { if(e.code!=='ENOENT')console.warn('Whales: invalid canvas layout',e.message); }
    return {boards,positions:layout.positions||{},edges:layout.edges||[]};
  }
  function sendSnapshot() {
    if(!view)return;
    const folder=selectedWorkspace || workspaces()[0];
    if(!folder){view.webview.postMessage({type:'snapshot',boards:[],positions:{},edges:[],notice:'请先打开项目文件夹。'});return;}
    try { view.webview.postMessage({type:'snapshot',...getSnapshot(folder),workspace:folder.name}); }
    catch(e){view.webview.postMessage({type:'error',message:'无法读取画板：'+e.message});}
  }
  function saveLayout(msg) {
    const folder=selectedWorkspace || workspaces()[0]; if(!folder)return;
    const positions={};
    for(const [id,p] of Object.entries(msg.positions||{})) if(/^[a-z0-9-]{1,32}$/.test(id)&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&Math.abs(p.x)<100000&&Math.abs(p.y)<100000)positions[id]={x:p.x,y:p.y};
    const edges=(Array.isArray(msg.edges)?msg.edges:[]).filter(e=>typeof e.source==='string'&&typeof e.target==='string'&&/^[a-z0-9-]{1,32}$/.test(e.source)&&/^[a-z0-9-]{1,32}$/.test(e.target)).slice(0,500).map(e=>({id:String(e.id||`${e.source}-${e.target}`).slice(0,120),source:e.source,target:e.target}));
    const root=rootOf(folder), target=path.join(root,'canvas.json'); fs.mkdirSync(root,{recursive:true}); const temp=target+'.'+crypto.randomUUID()+'.tmp'; fs.writeFileSync(temp,JSON.stringify({positions,edges},null,2)); fs.renameSync(temp,target);
  }
  async function saveComment(msg) {
    const folder=selectedWorkspace||workspaces()[0]; if(!folder)throw Error('请先打开项目文件夹');
    const id=String(msg.boardId||''); if(!/^[a-z0-9-]{1,32}$/.test(id))throw Error('画板编号无效');
    const text=String(msg.text||'').trim().slice(0,2000); if(!text)throw Error('请输入修改意见');
    const root=rootOf(folder), dir=path.join(root,'design','workspace','artboards',id); const meta=JSON.parse(fs.readFileSync(path.join(dir,'meta.json'),'utf8')); const source=fs.readFileSync(path.join(dir,'source.tsx'),'utf8');
    const wsrc=String(msg.wsrc||''); const hit=(meta.jsxTable||[]).find(row=>row.wsrc===wsrc); const comment={id:crypto.randomUUID(),boardId:id,wsrc,line:hit?.line||null,tag:hit?.tag||'',sourceHash:crypto.createHash('sha256').update(source).digest('hex'),text,createdAt:new Date().toISOString(),resolved:false};
    const target=path.join(root,'comments.json'); let comments=[]; try {comments=JSON.parse(fs.readFileSync(target,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
    comments.push(comment);const temp=target+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(comments,null,2));fs.renameSync(temp,target);
    const prompt=`请读取画板 ${id} 的未处理批注并按意见修改，修改后在 whales_design_write 的 resolvesComments 中传入批注 ID ${comment.id}。`;
    await vscode.env.clipboard.writeText(prompt);
    return '批注已保存，修改请求已复制，请粘贴到 Cursor 对话。';
  }
  const provider={resolveWebviewView(webviewView){
    view=webviewView; view.webview.options={enableScripts:true,localResourceRoots:[vscode.Uri.joinPath(context.extensionUri,'media')]};
    const js=view.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri,'media','canvas.js')); const css=view.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri,'media','canvas.css')); const nonce=crypto.randomBytes(16).toString('base64');
    view.webview.html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${view.webview.cspSource} data:; style-src ${view.webview.cspSource} 'unsafe-inline'; script-src ${view.webview.cspSource} 'unsafe-inline' 'unsafe-eval'; frame-src 'self' blob: data:;"><link rel="stylesheet" href="${css}"></head><body><div id="root"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
    view.webview.onDidReceiveMessage(async msg=>{try{if(msg.type==='ready'||msg.type==='refresh')sendSnapshot();else if(msg.type==='saveLayout')saveLayout(msg);else if(msg.type==='comment'){const message=await saveComment(msg);view.webview.postMessage({type:'notice',message});}}catch(e){view.webview.postMessage({type:'error',message:e.message});}},null,context.subscriptions);
    webviewView.onDidDispose(()=>{if(view===webviewView)view=undefined;},null,context.subscriptions);
  }};
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('whalesCanvas.view',provider,{webviewOptions:{retainContextWhenHidden:true}}));
  context.subscriptions.push(vscode.commands.registerCommand('whalesCanvas.open',()=>vscode.commands.executeCommand('whalesCanvas.view.focus')));
  function watch(folder) {
    const pattern=new vscode.RelativePattern(folder,'.whales-design/design/workspace/artboards/**/meta.json'); const watcher=vscode.workspace.createFileSystemWatcher(pattern);
    const changed=()=>{clearTimeout(timer);selectedWorkspace=folder;timer=setTimeout(async()=>{sendSnapshot();await vscode.commands.executeCommand('whalesCanvas.view.focus');},300);};
    watcher.onDidCreate(changed);watcher.onDidChange(changed);watcher.onDidDelete(()=>{selectedWorkspace=folder;sendSnapshot();});context.subscriptions.push(watcher);
  }
  for(const folder of workspaces())watch(folder);
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(e=>{for(const folder of e.added)watch(folder);if(selectedWorkspace&&!workspaces().some(x=>x.uri.toString()===selectedWorkspace.uri.toString()))selectedWorkspace=undefined;sendSnapshot();}));
  context.subscriptions.push({dispose:()=>clearTimeout(timer)});
}
function deactivate(){}
module.exports={activate,deactivate};
