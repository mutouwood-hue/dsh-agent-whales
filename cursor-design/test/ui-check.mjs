import { chromium } from 'playwright-core';
import { build } from 'esbuild';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../core.mjs';
const dir=dirname(dirname(fileURLToPath(import.meta.url)));
if (!process.env.CHROME_PATH) throw new Error('Set CHROME_PATH to a Chromium or Chrome executable.');
const host=await build({entryPoints:[join(dir,'test/host-harness.mjs')],bundle:true,platform:'browser',format:'iife',write:false});
const workspace=mkdtempSync(join(tmpdir(),'whales-ui-'));const store=createStore(workspace);
const source=`import React from 'react';export default function Board(){const [n,setN]=React.useState(0);return <div style={{height:1100}}><h1>设计预览</h1><button onClick={()=>setN(n+1)}>计数 {n}</button></div>}`;
store.write({id:'demo',title:'测试画板',source});const board=store.get('demo');
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH,args:['--no-sandbox']});
try{
 const page=await browser.newPage({viewport:{width:1200,height:1000}});page.on('pageerror',e=>console.log('PAGE ERROR',String(e)));
 await page.route('**/*',async route=>{let u=route.request().url();if(u.endsWith('/app.html'))return route.fulfill({contentType:'text/html',body:readFileSync(dir+'/dist/app.html')});return route.fulfill({contentType:'text/html',body:'<html><body><iframe id="app" sandbox="allow-scripts" style="width:1100px;height:900px"></iframe></body></html>'});});
 await page.goto('http://local.test/');await page.evaluate(f=>window.fixture=f,{content:[{type:'text',text:'ok'}],structuredContent:{board,boards:store.list()}});await page.addScriptTag({content:host.outputFiles[0].text});await page.locator('#app').evaluate(f=>f.src='http://local.test/app.html');
 const app=page.frameLocator('#app');try{await app.locator('#status').getByText('画板已渲染').waitFor({timeout:6000});}catch(e){console.log('status:',await app.locator('#status').textContent(),'title:',await app.locator('#title').textContent(),'opts:',await app.locator('#boards').innerHTML());throw e;}
 const design=app.frameLocator('#frame');await design.getByText('计数 0').click();await design.getByText('计数 1').waitFor();
 await app.locator('#pick').check();await design.getByText('设计预览').click();await app.locator('#selected').getByText('已选',{exact:false}).waitFor();
 await app.locator('#comment').fill('调整标题');await app.getByText('保存并发送修改意见').click();await app.locator('#status').getByText('批注已保存并发送到对话。').waitFor();
 const output=await page.evaluate(()=>({call:window.lastCall,msg:window.lastMessage}));if(output.call.arguments.text!=='调整标题'||!output.call.arguments.wsrc||!output.msg)throw Error('Feedback payload invalid');
 console.log('MCP App host handshake, interactive sandbox, element annotation and feedback delivery passed.');
}finally{await browser.close();rmSync(workspace,{recursive:true,force:true});}
