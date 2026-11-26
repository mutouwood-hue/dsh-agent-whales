import {build} from 'esbuild';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
const dir=dirname(fileURLToPath(import.meta.url));
const runtime=readFileSync(join(dir,'../lib/client.sandbox-runtime.js'),'utf8');
const output=await build({entryPoints:[join(dir,'src/app.js')],bundle:true,write:false,format:'iife',platform:'browser',target:'es2020',define:{__RUNTIME__:JSON.stringify(runtime)}});
const js=output.outputFiles[0].text.replace(/<\/script/gi,'<\\/script');
const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{font:13px system-ui;color:var(--color-text-primary,#182132);background:var(--color-background-primary,#fff)}*{box-sizing:border-box}body{margin:0}.bar{display:flex;gap:8px;align-items:center;padding:10px;border-bottom:1px solid #d9e0ea;flex-wrap:wrap}.title{font-weight:700;margin-right:auto}button,select,textarea{font:inherit}button,select{border:1px solid #cbd5e1;background:#fff;border-radius:6px;padding:6px 9px;color:#233047}button{cursor:pointer}button:disabled{opacity:.5}.viewport{overflow:auto;max-height:70vh;background:#eef2f6;padding:12px}.framewrap{background:#fff;margin:auto;overflow:auto;max-width:100%}iframe{border:0;display:block}.feedback{display:grid;gap:7px;padding:10px}.feedback textarea{width:100%;min-height:64px;border:1px solid #cbd5e1;border-radius:6px;padding:8px}.hint,.status{color:#64748b;font-size:12px}.actions button{background:#3159cb;color:white;border:0}.status{padding:0 10px 10px}
</style></head><body><div class="bar"><span id="title" class="title">设计画板</span><select id="boards" aria-label="选择画板"></select><button id="refresh">刷新</button><label><input type="checkbox" id="pick"> 标注</label></div><div class="viewport"><div class="framewrap" id="framewrap"><iframe id="frame" sandbox="allow-scripts" title="设计预览"></iframe></div></div><div class="feedback"><div id="selected" class="hint">选择「标注」后点击画面中的元素</div><textarea id="comment" placeholder="写下需要修改的地方"></textarea><div class="actions"><button id="send">保存并发送修改意见</button></div></div><div id="status" class="status">正在连接…</div><script>${js}</script></body></html>`;
mkdirSync(join(dir,'dist'),{recursive:true});writeFileSync(join(dir,'dist/app.html'),html);
