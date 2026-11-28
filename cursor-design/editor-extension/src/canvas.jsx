import React, {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ReactFlow, Background, Controls, MiniMap, Handle, Position, NodeResizer, applyNodeChanges, addEdge} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {createPreviewSession,movePreview} from '../../src/preview-session.js';
import './canvas.css';
const vscode=acquireVsCodeApi();
function Preview({board,onNavigate,revision,onRetry,full,onClose}) {
 const ref=useRef(null),home=useRef(null),stage=useRef(null),dialog=useRef(null),body=useRef(null),viewport=useRef(null),session=useRef(null);
 const [height,setHeight]=useState(480),[width,setWidth]=useState(490),[message,setMessage]=useState('渲染中…'),[failed,setFailed]=useState(false),[mark,setMark]=useState(false),[picked,setPicked]=useState(null),[comment,setComment]=useState('');
 const markRef=useRef(false),navigateRef=useRef(onNavigate);markRef.current=mark;navigateRef.current=onNavigate;
 useEffect(()=>{
  setHeight(480);setPicked(null);
  session.current=createPreviewSession(ref.current,board,{
   onState:(text,error)=>{setMessage(text);setFailed(error);},onResize:setHeight,onPick:setPicked,
   onNavigate:target=>navigateRef.current?.(target),mark:()=>markRef.current
  },__RUNTIME__);
  return()=>{session.current?.dispose();session.current=null;};
 },[board.id,board.code,board.title,revision]);
 useEffect(()=>session.current?.setMark(mark),[mark]);
 useEffect(()=>{const el=viewport.current;const observer=new ResizeObserver(()=>setWidth(el.clientWidth));observer.observe(el);return()=>observer.disconnect();},[]);
 useLayoutEffect(()=>{
  const d=dialog.current;
  if(full){d.showModal();movePreview(body.current,stage.current,onRetry);}
  return()=>{if(full){movePreview(home.current,stage.current,onRetry);d.close();}};
 },[full]);
 const pageWidth=board.width==='mobile'?390:1024,scale=Math.min(1,width/pageWidth),selected=(board.jsxTable||[]).find(x=>x.wsrc===picked?.wsrc);
 return <><div className="preview-home" ref={home}><div className="preview-stage" ref={stage}>
 <div className="preview nowheel nodrag" ref={viewport}><div style={{width:pageWidth*scale,height:height*scale,margin:'auto'}}><iframe ref={ref} title={board.title} sandbox="allow-scripts" style={{width:pageWidth,height,transform:`scale(${scale})`}}/></div>{message&&<div className="preview-message" role={failed?'alert':'status'}><span>{message}</span>{failed&&<button onClick={onRetry}>重新渲染</button>}</div>}</div>
 <div className="board-actions nodrag"><button className={mark?'active':''} onClick={()=>setMark(v=>!v)}>{mark?'退出标注':'标注修改'}</button><span>{picked?'已选 '+(picked.tag||'元素')+(selected?.line?' · 第 '+selected.line+' 行':''):''}</span></div>
 {mark&&<div className="feedback nodrag"><textarea aria-label="修改意见" value={comment} onChange={e=>setComment(e.target.value)} placeholder="写下修改意见"/><button onClick={()=>{if(comment.trim()){vscode.postMessage({type:'comment',boardId:board.id,wsrc:picked?.wsrc||'',text:comment});setComment('');}}}>保存并复制修改请求</button></div>}
 </div></div><dialog ref={dialog} className="board-dialog nodrag nowheel" aria-label={board.title+' · 全屏预览'} onClose={onClose} onCancel={onClose}><div className="dialog-head"><strong>{board.title}</strong><button onClick={onRetry}>重新渲染</button><button onClick={onClose}>关闭</button></div><div className="dialog-body" ref={body}/></dialog></>;
}
function BoardNode({id,data,selected}) {
 const [revision,setRevision]=useState(0),[full,setFull]=useState(false);const retry=useCallback(()=>setRevision(v=>v+1),[]),close=useCallback(()=>setFull(false),[]);
 return <div className="board"><NodeResizer minWidth={280} minHeight={240} maxWidth={1800} maxHeight={1800} isVisible={selected} onResizeEnd={(_,p)=>data.onResize(id,p.width,p.height)}/><Handle type="target" position={Position.Left}/><div className="board-head"><div className="board-title">{data.board.title}</div><span>{data.board.width==='mobile'?'手机':'桌面'}</span><button className="nodrag" onClick={retry}>重新渲染</button><button className="nodrag" onClick={()=>setFull(true)}>全屏</button></div><Preview board={data.board} onNavigate={data.onNavigate} revision={revision} onRetry={retry} full={full} onClose={close}/><Handle type="source" position={Position.Right}/></div>;
}
const types={board:BoardNode};
function Canvas(){
 const [nodes,setNodes]=useState([]),[edges,setEdges]=useState([]),[notice,setNotice]=useState(''),[workspace,setWorkspace]=useState('');const nodesRef=useRef([]),edgesRef=useRef([]),flowRef=useRef(null);nodesRef.current=nodes;edgesRef.current=edges;
 const navigate=useCallback(target=>{const node=nodesRef.current.find(item=>item.id===target);if(!node){setNotice('未找到画板「'+target+'」。');return;}setNotice('已切换到「'+node.data.board.title+'」。');flowRef.current?.fitView({nodes:[{id:target}],padding:0.2,duration:250});},[]);
 const onNodesChange=useCallback(changes=>setNodes(current=>applyNodeChanges(changes,current)),[]);
 const persist=(ns,es)=>vscode.postMessage({type:'saveLayout',positions:Object.fromEntries(ns.map(n=>[n.id,n.position])),sizes:Object.fromEntries(ns.map(n=>[n.id,{width:n.style?.width||496,height:n.style?.height||520}])),edges:es.map(({id,source,target})=>({id,source,target}))});
 const resize=useCallback((id,width,height)=>{setNodes(current=>{const next=current.map(n=>n.id===id?{...n,style:{...n.style,width,height}}:n);persist(next,edgesRef.current);return next;});},[]);
 const connect=useCallback(connection=>setEdges(current=>{const next=addEdge({...connection,animated:false},current);persist(nodesRef.current,next);return next;}),[]);
 useEffect(()=>{const handler=e=>{const d=e.data||{};if(d.type==='snapshot'){
  setWorkspace(d.workspace||'');setNotice(d.notice||'');const current=new Map(nodesRef.current.map(n=>[n.id,n]));
  setNodes((d.boards||[]).map((board,i)=>({id:board.id,type:'board',position:d.positions?.[board.id]||current.get(board.id)?.position||{x:(i%3)*560,y:Math.floor(i/3)*650},style:d.sizes?.[board.id]||current.get(board.id)?.style||{width:board.width==='mobile'?320:496,height:520},data:{board,onNavigate:navigate,onResize:resize},dragHandle:'.board-head'})));
  const ids=new Set((d.boards||[]).map(b=>b.id));setEdges((d.edges||[]).filter(edge=>ids.has(edge.source)&&ids.has(edge.target)).map(edge=>({...edge,type:'smoothstep'})));
 }else if(d.type==='notice'||d.type==='error')setNotice(d.message||'');};window.addEventListener('message',handler);vscode.postMessage({type:'ready'});return()=>window.removeEventListener('message',handler);},[navigate,resize]);
 return <div className="shell"><header><div><strong>设计画布</strong><span>{workspace||'当前项目'}</span></div><button onClick={()=>vscode.postMessage({type:'refresh'})}>刷新</button></header>{notice&&<div role="status" className="notice">{notice}</div>}<main><ReactFlow onInit={instance=>{flowRef.current=instance;}} nodes={nodes} edges={edges} nodeTypes={types} onNodesChange={onNodesChange} onConnect={connect} onNodeDragStop={(_,node)=>persist(nodesRef.current.map(item=>item.id===node.id?{...item,position:node.position}:item),edgesRef.current)} onEdgesDelete={deleted=>setEdges(current=>{const removed=new Set(deleted.map(e=>e.id));const next=current.filter(e=>!removed.has(e.id));persist(nodesRef.current,next);return next;})} fitView minZoom={0.08} maxZoom={2} proOptions={{hideAttribution:true}}><Background gap={22} size={1}/><Controls/><MiniMap pannable zoomable/></ReactFlow>{nodes.length===0&&<div className="empty"><strong>画布还没有设计</strong><p>在 Cursor 对话中描述页面，生成后会自动出现在这里。</p></div>}</main><footer>拖动标题移动，选中画板后拖动边框调整大小，拖动圆点连接画板。</footer></div>;
}
createRoot(document.getElementById('root')).render(<Canvas/>);
