import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createStore} from '../core.mjs';
const require=createRequire(import.meta.url),Module=require('node:module'),original=Module._load;
test('editor watches generated boards, opens view, saves layout and feedback',async()=>{
 const workspace=mkdtempSync(join(tmpdir(),'whales-ext-')),store=createStore(workspace);store.write({id:'one',title:'设计',source:`import React from 'react';export default function Board(){return <h1>Hello</h1>}`});
 const events={},commands=[],posted=[];let provider,handler,clipboard='';const folder={name:'demo',uri:{fsPath:workspace,toString:()=>workspace}};
 const fake={Uri:{joinPath:(base,...parts)=>({fsPath:join(base.fsPath,...parts),toString:()=>join(base.fsPath,...parts)})},RelativePattern:class{constructor(f,p){this.base=f;this.pattern=p;}},workspace:{workspaceFolders:[folder],createFileSystemWatcher:()=>({onDidCreate:fn=>events.create=fn,onDidChange:fn=>events.change=fn,onDidDelete:fn=>events.delete=fn,dispose(){}}),onDidChangeWorkspaceFolders:()=>({dispose(){}})},window:{registerWebviewViewProvider:(id,p)=>{provider=p;return{dispose(){}};}},commands:{registerCommand:()=>({dispose(){}}),executeCommand:async id=>commands.push(id)},env:{clipboard:{writeText:async text=>clipboard=text}}};
 Module._load=function(request,...args){return request==='vscode'?fake:original.call(this,request,...args);};
 try{
  const ext=require('../editor-extension/extension.cjs');const context={extensionUri:{fsPath:workspace},subscriptions:[]};ext.activate(context);
  const view={webview:{cspSource:'http://localhost',asWebviewUri:u=>u.toString(),postMessage:m=>posted.push(m),onDidReceiveMessage:fn=>{handler=fn;}},onDidDispose:()=>{}};provider.resolveWebviewView(view);
  await handler({type:'ready'});assert.equal(posted.at(-1).boards[0].title,'设计');
  events.change();await new Promise(resolve=>setTimeout(resolve,400));assert.ok(commands.includes('whalesCanvas.view.focus'));
  await handler({type:'saveLayout',positions:{one:{x:20,y:30}},sizes:{one:{width:720,height:610},bad:{width:Infinity,height:450},tiny:{width:1,height:1}},edges:[]});assert.deepEqual(JSON.parse(readFileSync(join(workspace,'.whales-design','canvas.json'))).positions.one,{x:20,y:30});
  assert.deepEqual(JSON.parse(readFileSync(join(workspace,'.whales-design','canvas.json'))).sizes,{one:{width:720,height:610}});
  await handler({type:'ready'});assert.deepEqual(posted.at(-1).sizes.one,{width:720,height:610});
  await handler({type:'comment',boardId:'one',wsrc:'e0',text:'调整标题'});assert.match(clipboard,/whales_design_write/);assert.equal(store.comments()[0].text,'调整标题');
 }finally{Module._load=original;rmSync(workspace,{recursive:true,force:true});}
});
