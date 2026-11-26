import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP write, read, comments, invalid update and UI resource',async()=>{
 const workspace=mkdtempSync(join(tmpdir(),'whales-cursor-'));
 const client=new Client({name:'test',version:'1'});
 const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../server.mjs',import.meta.url))],env:{...process.env,WHALES_WORKSPACE:workspace}});
 try{
  await client.connect(transport);
  const tools=await client.listTools();
  assert.ok(tools.tools.find(t=>t.name==='whales_design_write')?._meta?.ui?.resourceUri);
  const source=`import React from 'react'; export default function Board(){ return <main><h1>Hello</h1><button>Go</button></main> }`;
  const written=await client.callTool({name:'whales_design_write',arguments:{id:'home',title:'首页',source}});
  assert.equal(written.isError,undefined); assert.equal(written.structuredContent.board.id,'home');
  const wsrc=written.structuredContent.board.jsxTable.find(x=>x.tag==='button').wsrc;
  const saved=await client.callTool({name:'whales_design_comment',arguments:{id:'home',wsrc,text:'按钮改成蓝色'}});
  assert.equal(saved.structuredContent.comment.text,'按钮改成蓝色');
  const bad=await client.callTool({name:'whales_design_write',arguments:{id:'home',title:'Bad',source:'<broken'}});
  assert.equal(bad.isError,true);
  const read=await client.callTool({name:'whales_design_read',arguments:{id:'home'}});
  assert.equal(read.structuredContent.board.source,source); assert.equal(read.structuredContent.comments.length,1);
  await client.callTool({name:'whales_design_write',arguments:{id:'home',title:'首页',source,resolvesComments:[saved.structuredContent.comment.id]}});
  const after=await client.callTool({name:'whales_design_read',arguments:{id:'home'}}); assert.equal(after.structuredContent.comments.length,0);
  const resource=await client.readResource({uri:'ui://whales/design.html'}); assert.match(resource.contents[0].text,/设计画板/);
 } finally {await client.close();rmSync(workspace,{recursive:true,force:true});}
});
