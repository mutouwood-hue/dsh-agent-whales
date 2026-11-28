import { App } from '@modelcontextprotocol/ext-apps';
import {createPreviewSession, movePreview} from './preview-session.js';
const app=new App({name:'Whales Design',version:'0.2.0'}), $=id=>document.getElementById(id), frame=$('frame');
let board=null, pick=null, session=null, openSequence=0, hostFullscreen=false;
const status=text=>{$('status').textContent=text;};
function result(r){
 if(r.isError){status(r.content?.[0]?.text||'操作失败');return;}
 const data=r.structuredContent||{}; $('boards').replaceChildren();
 for(const b of data.boards||[]){const option=document.createElement('option');option.value=b.id;option.textContent=b.title||b.id;$('boards').append(option);}
 if(data.board){board=data.board;$('boards').value=board.id;start();}
 else if(data.boards?.length) open(data.boards[0].id); else status('还没有画板。请在对话中描述要设计的页面。');
}
async function open(id){const sequence=++openSequence;try{const r=await app.callServerTool({name:'whales_design_open',arguments:{id}},{timeout:12000});if(sequence===openSequence)result(r);}catch(e){if(sequence===openSequence)status('打开失败：'+e.message);}}
function start(){
 session?.dispose();pick=null;$('selected').textContent='选择「标注」后点击画面中的元素';$('title').textContent=board.title||board.id;$('fullscreen-title').textContent=board.title||board.id;
 const w=board.width==='mobile'?390:1024;$('framewrap').style.width=w+'px';frame.style.width=w+'px';frame.style.height='480px';
 session=createPreviewSession(frame,board,{
  onState:(text,failed)=>{status(text||'画板已渲染');$('render-error').hidden=!failed;$('error-text').textContent=failed?text:'';},
  onResize:height=>frame.style.height=height+'px',mark:()=>$('pick').checked,
  onPick:value=>{pick=value;const row=(board.jsxTable||[]).find(x=>x.wsrc===pick?.wsrc);$('selected').textContent='已选 '+(pick?.tag||'元素')+(row?.line?' · 第 '+row.line+' 行':'');},
  onNavigate:id=>open(id)
 },__RUNTIME__);
}
function setPick(){session?.setMark($('pick').checked);}
$('pick').addEventListener('change',setPick);$('boards').addEventListener('change',e=>open(e.target.value));
$('refresh').addEventListener('click',()=>board&&start());$('retry').addEventListener('click',()=>board&&start());
async function closeFullscreen(){
 if($('fullscreen-dialog').open)$('fullscreen-dialog').close();
 if(hostFullscreen){hostFullscreen=false;try{const r=await app.requestDisplayMode({mode:'inline'},{timeout:5000});hostFullscreen=r.mode==='fullscreen';document.body.classList.toggle('host-fullscreen',hostFullscreen);$('fullscreen').textContent=hostFullscreen?'退出全屏':'全屏';}catch{hostFullscreen=app.getHostContext()?.displayMode==='fullscreen';status('请使用宿主的退出全屏按钮，或再次点击退出全屏。');}}
}
$('fullscreen').addEventListener('click',async()=>{
 if(!board)return;
 if($('fullscreen-dialog').open||hostFullscreen){await closeFullscreen();return;}
 if(app.getHostContext()?.availableDisplayModes?.includes('fullscreen')){
  try{const r=await app.requestDisplayMode({mode:'fullscreen'},{timeout:5000});if(r.mode==='fullscreen'){hostFullscreen=true;document.body.classList.add('host-fullscreen');$('fullscreen').textContent='退出全屏';return;}}catch{}
 }
 const dialog=$('fullscreen-dialog');$('preview-home').style.height=$('preview-stage').getBoundingClientRect().height+'px';dialog.showModal();movePreview($('fullscreen-body'),$('preview-stage'),start);$('fullscreen-title').textContent=board.title||board.id;
});
$('fullscreen-close').addEventListener('click',closeFullscreen);
$('fullscreen-dialog').addEventListener('close',()=>{movePreview($('preview-home'),$('preview-stage'),start);$('preview-home').style.height='';});
app.onhostcontextchanged=()=>{if(app.getHostContext()?.displayMode!=='fullscreen'){hostFullscreen=false;document.body.classList.remove('host-fullscreen');$('fullscreen').textContent='全屏';}};
window.addEventListener('pagehide',()=>session?.dispose());
$('send').addEventListener('click',async()=>{const text=$('comment').value.trim();if(!board||!text){status('请先输入修改意见。');return;}$('send').disabled=true;try{const r=await app.callServerTool({name:'whales_design_comment',arguments:{id:board.id,wsrc:pick?.wsrc||'',text}});if(r.isError)throw Error(r.content?.[0]?.text||'保存失败');const saved=r.structuredContent.comment;const msg=`请读取画板 ${board.id} 的未处理批注并按意见修改，修改完成后在 whales_design_write 的 resolvesComments 中传入批注 ID ${saved.id}。`;try{const sent=await app.sendMessage({role:'user',content:[{type:'text',text:msg}]});if(sent.isError)throw Error('宿主拒绝');status('批注已保存并发送到对话。');}catch{status('批注已保存。请在对话中说：按画板批注修改 '+board.id);}$('comment').value='';}catch(e){status('保存失败：'+e.message);}finally{$('send').disabled=false;}});
app.ontoolresult=result;app.connect().catch(e=>status('连接失败：'+e.message));
