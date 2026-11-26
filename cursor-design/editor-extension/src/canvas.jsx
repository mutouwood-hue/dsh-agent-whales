import React, {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ReactFlow, Background, Controls, MiniMap, Handle, Position, applyNodeChanges, addEdge} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {sandboxSrcdoc,SANDBOX_CSP} from '../../../lib/design/sandbox.js';
import './canvas.css';
const vscode=acquireVsCodeApi();
const fresh=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join('');
function Preview({board,onNavigate}) {
 const ref=useRef(null), [height,setHeight]=useState(480), [message,setMessage]=useState('渲染中…'), [mark,setMark]=useState(false), [picked,setPicked]=useState(null), [comment,setComment]=useState('');
 const nonceRef=useRef(''),ready=useRef(false), markRef=useRef(false);markRef.current=mark;
 useEffect(()=>{
  const frame=ref.current;if(!frame)return;const bootId=fresh(),nonce=fresh();nonceRef.current=nonce;ready.current=false;setHeight(480);setMessage('渲染中…');setPicked(null);
  const handler=event=>{if(event.source!==frame.contentWindow||event.origin!=='null')return;const d=event.data||{};
   if(d.type==='booted'&&d.bootId===bootId){frame.contentWindow.postMessage({type:'init',nonce,runtime:__RUNTIME__,styles:'',packCode:''},'*');return;}
   if(d.nonce!==nonce)return;
   if(d.type==='ready'){frame.contentWindow.postMessage({type:'render',nonce,runId:board.id,mountId:'main',name:board.id,code:board.code,props:{},dependencies:[],isBoard:true},'*');return;}
   if(d.type==='rendered'){ready.current=!!d.ok;setMessage(d.ok?'':('渲染失败：'+(d.error||'画板为空')));if(d.ok)frame.contentWindow.postMessage({type:'pick-mode',nonce,enabled:markRef.current},'*');}
   if(d.type==='resize'&&Number.isFinite(d.height))setHeight(Math.max(200,Math.min(8000,d.height)));
   if(d.type==='pick')setPicked(d.pick);
   if(d.type==='navigate'&&typeof onNavigate==='function')onNavigate(d.to);
   if(d.type==='error')setMessage('渲染出错：'+(d.message||''));
  };
  window.addEventListener('message',handler);frame.srcdoc=sandboxSrcdoc({csp:SANDBOX_CSP,title:board.title,bootId});
  const timeout=setTimeout(()=>{if(!ready.current)setMessage('加载时间较长，请刷新画布重试。');},12000);
  return()=>{clearTimeout(timeout);window.removeEventListener('message',handler);};
 },[board.id,board.code,board.title]);
 useEffect(()=>{if(ready.current&&ref.current)ref.current.contentWindow.postMessage({type:'pick-mode',nonce:nonceRef.current,enabled:mark},'*');},[mark]);
 const pageWidth=board.width==='mobile'?390:1024;const scale=board.width==='mobile'?0.8:0.48;const selected=(board.jsxTable||[]).find(x=>x.wsrc===picked?.wsrc);
 return <><div className="preview" style={{width:pageWidth*scale,height:height*scale}}><iframe ref={ref} title={board.title} sandbox="allow-scripts" className="nodrag nowheel" style={{width:pageWidth,height,transform:`scale(${scale})`}}/>{message&&<div className="preview-message">{message}</div>}</div>
 <div className="board-actions nodrag"><button className={mark?'active':''} onClick={()=>setMark(v=>!v)}>{mark?'退出标注':'标注修改'}</button><span>{picked?'已选 '+(picked.tag||'元素')+(selected?.line?' · 第 '+selected.line+' 行':''):''}</span></div>
 {mark&&<div className="feedback nodrag"><textarea aria-label="修改意见" value={comment} onChange={e=>setComment(e.target.value)} placeholder="写下修改意见"/><button onClick={()=>{if(comment.trim()){vscode.postMessage({type:'comment',boardId:board.id,wsrc:picked?.wsrc||'',text:comment});setComment('');}}}>保存并复制修改请求</button></div>}</>;
}
function BoardNode({data}) {return <div className="board"><Handle type="target" position={Position.Left}/><div className="board-head"><div className="board-title">{data.board.title}</div><span>{data.board.width==='mobile'?'手机':'桌面'}</span></div><Preview board={data.board} onNavigate={data.onNavigate}/><Handle type="source" position={Position.Right}/></div>;}
const types={board:BoardNode};
function Canvas(){
 const [nodes,setNodes]=useState([]),[edges,setEdges]=useState([]),[notice,setNotice]=useState(''),[workspace,setWorkspace]=useState('');const nodesRef=useRef([]),edgesRef=useRef([]),flowRef=useRef(null);nodesRef.current=nodes;edgesRef.current=edges;
 const navigate=useCallback(target=>{const node=nodesRef.current.find(item=>item.id===target);if(!node){setNotice('未找到画板「'+target+'」。');return;}setNotice('已切换到「'+node.data.board.title+'」。');flowRef.current?.fitView({nodes:[{id:target}],padding:0.2,duration:250});},[]);
 const onNodesChange=useCallback(changes=>setNodes(current=>applyNodeChanges(changes,current)),[]);
 const persist=(ns,es)=>vscode.postMessage({type:'saveLayout',positions:Object.fromEntries(ns.map(n=>[n.id,n.position])),edges:es.map(({id,source,target})=>({id,source,target}))});
 const connect=useCallback(connection=>setEdges(current=>{const next=addEdge({...connection,animated:false},current);persist(nodesRef.current,next);return next;}),[]);
 useEffect(()=>{const handler=e=>{const d=e.data||{};if(d.type==='snapshot'){
  setWorkspace(d.workspace||'');setNotice(d.notice||'');const current=new Map(nodesRef.current.map(n=>[n.id,n]));
  setNodes((d.boards||[]).map((board,i)=>({id:board.id,type:'board',position:d.positions?.[board.id]||current.get(board.id)?.position||{x:(i%3)*560,y:Math.floor(i/3)*650},data:{board,onNavigate:navigate},dragHandle:'.board-head'})));
  const ids=new Set((d.boards||[]).map(b=>b.id));setEdges((d.edges||[]).filter(edge=>ids.has(edge.source)&&ids.has(edge.target)).map(edge=>({...edge,type:'smoothstep'})));
 }else if(d.type==='notice'||d.type==='error')setNotice(d.message||'');};window.addEventListener('message',handler);vscode.postMessage({type:'ready'});return()=>window.removeEventListener('message',handler);},[navigate]);
 return <div className="shell"><header><div><strong>设计画布</strong><span>{workspace||'当前项目'}</span></div><button onClick={()=>vscode.postMessage({type:'refresh'})}>刷新</button></header>{notice&&<div role="status" className="notice">{notice}</div>}<main><ReactFlow onInit={instance=>{flowRef.current=instance;}} nodes={nodes} edges={edges} nodeTypes={types} onNodesChange={onNodesChange} onConnect={connect} onNodeDragStop={(_,node)=>persist(nodesRef.current.map(item=>item.id===node.id?{...item,position:node.position}:item),edgesRef.current)} onEdgesDelete={deleted=>setEdges(current=>{const removed=new Set(deleted.map(e=>e.id));const next=current.filter(e=>!removed.has(e.id));persist(nodesRef.current,next);return next;})} fitView minZoom={0.08} maxZoom={2} proOptions={{hideAttribution:true}}><Background gap={22} size={1}/><Controls/><MiniMap pannable zoomable/></ReactFlow>{nodes.length===0&&<div className="empty"><strong>画布还没有设计</strong><p>在 Cursor 对话中描述页面，生成后会自动出现在这里。</p></div>}</main><footer>拖动画板标题调整位置，拖动圆点连接画板。</footer></div>;
}
createRoot(document.getElementById('root')).render(<Canvas/>);
