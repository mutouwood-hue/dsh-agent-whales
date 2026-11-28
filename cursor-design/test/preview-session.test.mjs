import test from 'node:test';
import assert from 'node:assert/strict';
import {createPreviewSession} from '../src/preview-session.js';

test('preview phase timeout, retry isolation, ready cleanup and source validation', async t => {
 const listeners=new Set(),states=[],posts=[];
 const oldWindow=globalThis.window;
 globalThis.window={addEventListener:(_,fn)=>listeners.add(fn),removeEventListener:(_,fn)=>listeners.delete(fn)};
 t.after(()=>{globalThis.window=oldWindow;});
 const frame={contentWindow:{postMessage:m=>posts.push(m)},srcdoc:''};
 const callbacks={onState:(message,failed)=>states.push({message,failed})};
 const board={id:'one',title:'One',code:'example'};
 const send=(data,source=frame.contentWindow)=>{for(const fn of listeners)fn({data,source,origin:'null'});};
 const boot=()=>frame.srcdoc.match(/name="whales-boot-id" content="([^"]+)"/)[1];
 const first=createPreviewSession(frame,board,callbacks,'runtime',15),oldBoot=boot();
 await new Promise(r=>setTimeout(r,30));assert.match(states.at(-1).message,/超时/);
 send({type:'booted',bootId:oldBoot});assert.equal(posts.length,0,'late boot cannot revive a timed-out attempt');
 first.dispose();
 const second=createPreviewSession(frame,board,callbacks,'runtime',15);
 send({type:'booted',bootId:oldBoot});assert.equal(posts.length,0,'old document cannot initialize retry');
 send({type:'booted',bootId:boot()},{});assert.equal(posts.length,0,'wrong source ignored');
 send({type:'booted',bootId:boot()});const nonce=posts.at(-1).nonce;
 send({type:'ready',nonce:'wrong'});assert.equal(posts.length,1);
 send({type:'ready',nonce});assert.equal(posts.at(-1).type,'render');
 send({type:'rendered',nonce,ok:true});assert.equal(states.at(-1).message,'');
 await new Promise(r=>setTimeout(r,30));assert.equal(states.at(-1).failed,false,'success clears all deadlines');
 second.dispose();assert.equal(listeners.size,0);
});

test('runtime errors immediately expose a retryable failure', () => {
 const oldWindow=globalThis.window,listeners=new Set(),posts=[],states=[];
 globalThis.window={addEventListener:(_,f)=>listeners.add(f),removeEventListener:(_,f)=>listeners.delete(f)};
 const frame={contentWindow:{postMessage:m=>posts.push(m)}};
 const session=createPreviewSession(frame,{id:'one'}, {onState:(...s)=>states.push(s)},'runtime');
 try {
  const send=data=>{for(const f of listeners)f({data,origin:'null',source:frame.contentWindow});};
  send({type:'booted',bootId:frame.srcdoc.match(/name="whales-boot-id" content="([^"]+)"/)[1]});
  send({type:'error',nonce:posts[0].nonce,message:'bad runtime'});
  assert.deepEqual(states.at(-1),['渲染出错：bad runtime',true]);
 }finally{session.dispose();globalThis.window=oldWindow;}
});
