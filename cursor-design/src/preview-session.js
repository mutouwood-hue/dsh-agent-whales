import {sandboxSrcdoc, SANDBOX_CSP} from '../../lib/design/sandbox.js';
const fresh = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');

// Both Cursor surfaces share phase deadlines, nonce checks and teardown. A retry
// creates a new document so late messages cannot settle a newer attempt.
export function createPreviewSession(frame, board, callbacks = {}, runtime, timeoutMs = 8000) {
  const bootId = fresh(), nonce = fresh();
  let phase = 'boot', disposed = false, timer, ready = false;
  function state(message, failed = false) { callbacks.onState?.(message, failed); }
  function post(message) { if (!disposed) frame.contentWindow?.postMessage({...message, nonce}, '*'); }
  function fail(message) {
    if (disposed || phase === 'failed') return;
    clearTimeout(timer); phase = 'failed'; ready = false;
    state(message, true);
  }
  function deadline(label) {
    clearTimeout(timer);
    timer = setTimeout(() => fail(label + '超时，请重新渲染。'), timeoutMs);
  }
  function setMark(enabled) { if (ready) post({type: 'pick-mode', enabled}); }
  function receive(event) {
    if (disposed || phase === 'failed' || event.source !== frame.contentWindow || event.origin !== 'null') return;
    const d = event.data || {};
    if (d.type === 'booted' && d.bootId === bootId && phase === 'boot') {
      phase = 'init'; deadline('运行环境加载');
      post({type: 'init', runtime, styles: '', packCode: ''}); return;
    }
    if (d.nonce !== nonce) return;
    if (d.type === 'ready' && phase === 'init') {
      phase = 'render'; deadline('画板渲染');
      post({type: 'render', runId: board.id, mountId: 'main', name: board.id, code: board.code, props: {}, dependencies: [], isBoard: true});
    } else if (d.type === 'rendered' && phase === 'render') {
      if (!d.ok) { fail('渲染失败：' + (d.error || '画板为空')); return; }
      clearTimeout(timer); phase = 'ready'; ready = true; state(''); setMark(callbacks.mark?.() || false);
    } else if (d.type === 'resize' && Number.isFinite(d.height)) {
      callbacks.onResize?.(Math.max(200, Math.min(8000, d.height)));
    } else if (d.type === 'pick' && ready) callbacks.onPick?.(d.pick);
    else if (d.type === 'navigate' && ready) callbacks.onNavigate?.(d.to);
    else if (d.type === 'error') fail('渲染出错：' + (d.message || '未知错误'));
  }
  window.addEventListener('message', receive);
  state('正在加载设计…'); deadline('画板启动');
  frame.srcdoc = sandboxSrcdoc({csp: SANDBOX_CSP, title: board.title, bootId});
  return {setMark, dispose() { disposed = true; ready = false; clearTimeout(timer); window.removeEventListener('message', receive); }};
}

// moveBefore preserves the live iframe document (including form values). Older
// embedded browsers reload it when reparenting; callers restart the preview.
export function movePreview(target, stage, restart) {
  if (typeof target.moveBefore === 'function' && target.isConnected && stage.isConnected) target.moveBefore(stage, null);
  else { target.appendChild(stage); restart(); }
}
