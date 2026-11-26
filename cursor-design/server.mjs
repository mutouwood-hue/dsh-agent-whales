import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { createStore } from './core.mjs';

const uri='ui://whales/design.html';
export function createServer(workspace) {
 const store=createStore(workspace);
 const server=new McpServer({name:'whales-cursor-design',version:'0.1.0'});
 const ui={ui:{resourceUri:uri}};
 const result=(data, text) => ({content:[{type:'text',text}],structuredContent:data});
 const boardResult=(id) => result({board:store.get(id),boards:store.list()}, '画板已保存并打开。请检查交互和视觉效果；编译成功不代表已完成视觉验证。');
 registerAppTool(server,'whales_design_write',{description:'创建或更新可交互设计画板。source 是完整 TSX，默认导出 React 组件；只允许从 react 导入。按用户需求构建设计，使用真实交互和清晰的视觉层级。更新前先读取画板和批注。编译失败时修复错误后重试。',inputSchema:{id:z.string(),title:z.string(),source:z.string(),width:z.enum(['desktop','mobile']).optional(),resolvesComments:z.array(z.string()).optional()},_meta:ui},async args=>{
   const output=store.write(args); if(!output.written) return {isError:true,content:[{type:'text',text:JSON.stringify(output.errors)}]};
   if(args.resolvesComments?.length) store.resolveComments(args.id,args.resolvesComments);
   return boardResult(args.id);
 });
 registerAppTool(server,'whales_design_open',{description:'打开已有画板，或无参数列出画板；设计预览出现在对话中。',inputSchema:{id:z.string().optional()},_meta:ui},async ({id})=>id?boardResult(id):result({boards:store.list()},'当前工作区的画板列表。'));
 server.registerTool('whales_design_read',{description:'读取画板 TSX 源码和待处理批注；修改前调用。',inputSchema:{id:z.string()}},async ({id})=>result({board:store.get(id),comments:store.comments().filter(c=>c.boardId===id&&!c.resolved)},'读取画板与未处理批注。'));
 server.registerTool('whales_design_comment',{description:'保存用户对画板元素的修改意见。',inputSchema:{id:z.string(),wsrc:z.string().optional(),text:z.string().min(1).max(2000)}},async args=>result({comment:store.addComment(args)},'批注已保存；请读取并修改画板。'));
 registerAppResource(server,'whales-design',uri,{mimeType:RESOURCE_MIME_TYPE},async()=>({contents:[{uri,mimeType:RESOURCE_MIME_TYPE,text:readFileSync(fileURLToPath(new URL('./dist/app.html',import.meta.url)),'utf8')}]}));
 return server;
}
if (process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]) {
 const server=createServer(process.env.WHALES_WORKSPACE);
 await server.connect(new StdioServerTransport());
}
