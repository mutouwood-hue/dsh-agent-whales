import { resolve, join, isAbsolute } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { compileDesignSource } from '../lib/design/compile.js';
import { ARTBOARD_ID_RE, DESIGN_LIMITS, listEntities, readEntity, writeEntity } from '../lib/design/store.js';

export function createStore(workspace) {
  if (!workspace || !isAbsolute(workspace)) throw new Error('Set WHALES_WORKSPACE to an absolute workspace path.');
  const root = join(resolve(workspace), '.whales-design');
  const project = 'workspace';
  const commentsFile = join(root, 'comments.json');
  function comments() { try { return JSON.parse(readFileSync(commentsFile, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } }
  function saveComments(rows) { mkdirSync(root, {recursive:true}); const tmp=commentsFile+'.'+randomUUID()+'.tmp'; writeFileSync(tmp, JSON.stringify(rows,null,2)); renameSync(tmp,commentsFile); }
  function get(id) {
    if (!ARTBOARD_ID_RE.test(id)) throw Error('Invalid artboard id.');
    const row=readEntity(root, project, 'artboard', id);
    if (!row) throw Error('Artboard not found: '+id);
    return { id, title:row.meta.title, width:row.meta.width, source:row.source, code:row.compiled, jsxTable:row.meta.jsxTable||[], updatedAt:row.meta.updatedAt };
  }
  function list() { return listEntities(root,project,'artboard').map(x=>({id:x.id,title:x.title,width:x.width,updatedAt:x.updatedAt})); }
  function write({id,title,source,width='desktop'}) {
    if (!ARTBOARD_ID_RE.test(id)) throw Error('id must be 1–32 lowercase letters, numbers or hyphens.');
    if (Buffer.byteLength(source,'utf8')>DESIGN_LIMITS.sourceBytes) throw Error('Source exceeds 64 KB.');
    if (!readEntity(root,project,'artboard',id) && list().length>=DESIGN_LIMITS.artboardsPerProject) throw Error('Artboard limit reached.');
    const compiled=compileDesignSource(source,{fileName:id+'.tsx',hasPack:false,projectNames:[]});
    if (!compiled.ok) return {written:false, errors:compiled.errors};
    writeEntity(root,project,'artboard',id,{source,compiled:compiled.code,meta:{title:title.slice(0,60),width,jsxTable:compiled.jsxTable}});
    return {written:true,board:get(id)};
  }
  function addComment({id,wsrc,text}) {
    const board=get(id); const target=board.jsxTable.find(row=>row.wsrc===wsrc);
    const value={id:randomUUID(),boardId:id,wsrc:wsrc||'',line:target?.line||null,tag:target?.tag||'',sourceHash:createHash('sha256').update(board.source).digest('hex'),text:text.trim().slice(0,2000),createdAt:new Date().toISOString(),resolved:false};
    if (!value.text) throw Error('Comment cannot be empty.');
    const rows=comments(); rows.push(value); saveComments(rows); return value;
  }
  function resolveComments(boardId,ids) { const rows=comments(); for(const row of rows) if(row.boardId===boardId && ids.includes(row.id)) row.resolved=true; saveComments(rows); }
  return {root,get,list,write,addComment,comments,resolveComments};
}
