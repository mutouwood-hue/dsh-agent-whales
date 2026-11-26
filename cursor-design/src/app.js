import { App } from '@modelcontextprotocol/ext-apps';
import { sandboxSrcdoc, SANDBOX_CSP } from '../../lib/design/sandbox.js';
const app=new App({name:'Whales Design',version:'0.1.0'}), $=id=>document.getElementById(id), frame=$('frame');
let board=null, nonce='', bootId='', pick=null, ready=false;
const fresh=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');
const status=text=>{$('status').textContent=text;};
function result(r){
 if(r.isError){status(r.content?.[0]?.text||'操作失败');return;}
 const data=r.structuredContent||{}; $('boards').replaceChildren();
 for(const b of data.boards||[]){const option=document.createElement('option');option.value=b.id;option.textContent=b.title||b.id;$('boards').append(option);}
 if(data.board){board=data.board;$('boards').value=board.id;start();}
 else if(data.boards?.length) open(data.boards[0].id); else status('还没有画板。请在对话中描述要设计的页面。');
}
async function open(id){try{result(await app.callServerTool({name:'whales_design_open',arguments:{id}}));}catch(e){status('打开失败：'+e.message);}}
function start(){ready=false;pick=null;$('selected').textContent='选择「标注」后点击画面中的元素';$('title').textContent=board.title||board.id; const w=board.width==='mobile'?390:1024; $('framewrap').style.width=w+'px';frame.style.width=w+'px';frame.style.height='480px';bootId=fresh();nonce=fresh();status('正在加载设计…');frame.srcdoc=sandboxSrcdoc({csp:SANDBOX_CSP,title:board.title,bootId});}
window.addEventListener('message',event=>{
 if(event.source!==frame.contentWindow||event.origin!=='null')return; const d=event.data||{};
 if(d.type==='booted'&&d.bootId===bootId){frame.contentWindow.postMessage({type:'init',nonce,runtime:__RUNTIME__,styles:'',packCode:''},'*');return;}
 if(d.nonce!==nonce)return;
 if(d.type==='ready'){frame.contentWindow.postMessage({type:'render',nonce,runId:board.id,mountId:'main',name:board.id,code:board.code,props:{},dependencies:[],isBoard:true},'*');return;}
 if(d.type==='rendered'){ready=!!d.ok;status(d.ok?'画板已渲染':'渲染失败：'+(d.error||'画板为空'));if(d.ok)setPick();}
 if(d.type==='resize'&&Number.isFinite(d.height))frame.style.height=Math.max(200,Math.min(8000,d.height))+'px';
 if(d.type==='pick'){pick=d.pick;const row=board.jsxTable.find(x=>x.wsrc===pick.wsrc);$('selected').textContent='已选 '+(pick.tag||'元素')+(row?.line?' · 第 '+row.line+' 行':'');}
 if(d.type==='error')status('渲染出错：'+(d.message||''));
});
function setPick(){if(ready)frame.contentWindow.postMessage({type:'pick-mode',nonce,enabled:$('pick').checked},'*');}
$('pick').addEventListener('change',setPick);$('boards').addEventListener('change',e=>open(e.target.value));$('refresh').addEventListener('click',()=>board&&open(board.id));
$('send').addEventListener('click',async()=>{const text=$('comment').value.trim();if(!board||!text){status('请先输入修改意见。');return;}$('send').disabled=true;try{const r=await app.callServerTool({name:'whales_design_comment',arguments:{id:board.id,wsrc:pick?.wsrc||'',text}});if(r.isError)throw Error(r.content?.[0]?.text||'保存失败');const saved=r.structuredContent.comment;const msg=`请读取画板 ${board.id} 的未处理批注并按意见修改，修改完成后在 whales_design_write 的 resolvesComments 中传入批注 ID ${saved.id}。`;try{const sent=await app.sendMessage({role:'user',content:[{type:'text',text:msg}]});if(sent.isError)throw Error('宿主拒绝');status('批注已保存并发送到对话。');}catch{status('批注已保存。请在对话中说：按画板批注修改 '+board.id);}$('comment').value='';}catch(e){status('保存失败：'+e.message);}finally{$('send').disabled=false;}});
app.ontoolresult=result;app.connect().catch(e=>status('连接失败：'+e.message));
