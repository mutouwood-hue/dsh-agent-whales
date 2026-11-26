import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import { PostMessageTransport } from '@modelcontextprotocol/ext-apps';
const frame=document.getElementById('app');
const bridge=new AppBridge(null,{name:'test-host',version:'1'},{});
bridge.oninitialized=async()=>{await bridge.sendToolInput({arguments:{id:'demo'}});await bridge.sendToolResult(window.fixture);};
bridge.oncalltool=async params=>{window.lastCall=params;return {content:[{type:'text',text:'saved'}],structuredContent:{comment:{id:'comment-1'}}};};
bridge.onmessage=async params=>{window.lastMessage=params;return {};};
bridge.connect(new PostMessageTransport(frame.contentWindow,frame.contentWindow));
