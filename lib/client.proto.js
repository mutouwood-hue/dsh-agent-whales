/* dsh-agent-whales · client.proto.js —— 由 tools/flow-chunk/build-proto.mjs 生成，勿手改。
 * 原型帧预览 / 组件库节点 / 内置组件包。内置包按 shadcn/ui（MIT）的类名与 CSS 变量复刻外观，
 * 样式由 Tailwind CSS 3.4.19（MIT）生成。 */
window.__ModuleLoader__.load({ id: "dsh-agent-whales", chunk: "client.proto.js", factory: function (require) {
var module = { exports: {} }; var exports = module.exports;
var ie=Object.create;var j=Object.defineProperty;var se=Object.getOwnPropertyDescriptor;var le=Object.getOwnPropertyNames;var de=Object.getPrototypeOf,ce=Object.prototype.hasOwnProperty;var ue=(e,t)=>{for(var o in t)j(e,o,{get:t[o],enumerable:!0})},W=(e,t,o,a)=>{if(t&&typeof t=="object"||typeof t=="function")for(let n of le(t))!ce.call(e,n)&&n!==o&&j(e,n,{get:()=>t[n],enumerable:!(a=se(t,n))||a.enumerable});return e};var _=(e,t,o)=>(o=e!=null?ie(de(e)):{},W(t||!e||!e.__esModule?j(o,"default",{value:e,enumerable:!0}):o,e)),pe=e=>W(j({},"__esModule",{value:!0}),e);var Ce={};ue(Ce,{LibraryNode:()=>Ne,PROJECT_ISLAND_MAX:()=>D,ProjectIsland:()=>te,PrototypeEditor:()=>Se,PrototypeFrame:()=>ne,PrototypeNode:()=>ke,PuckData:()=>ae,VOCAB_NAMES:()=>be,__setSandboxSrcdoc:()=>ve,buildPuckConfig:()=>H,loadPack:()=>Q,packCoverage:()=>$});module.exports=pe(Ce);var y=_(require("react"),1),L=_(require("react-dom"),1),ge=_(require("react/jsx-runtime"),1),s=require("react/jsx-runtime");var B={Heading:{label:"\u6807\u9898",fields:{text:{type:"text"},level:{type:"select",options:["1","2","3"]}},defaults:{text:"\u9875\u9762\u6807\u9898",level:"2"}},Text:{label:"\u6BB5\u843D",fields:{text:{type:"textarea"},tone:{type:"select",options:["default","muted"]}},defaults:{text:"\u4E00\u6BB5\u8BF4\u660E\u6587\u5B57",tone:"default"}},Button:{label:"\u6309\u94AE",fields:{label:{type:"text"},variant:{type:"select",options:["primary","secondary","outline","ghost","destructive"]}},defaults:{label:"\u786E\u5B9A",variant:"primary"}},Input:{label:"\u8F93\u5165\u6846",fields:{label:{type:"text"},placeholder:{type:"text"}},defaults:{label:"\u540D\u79F0",placeholder:"\u8BF7\u8F93\u5165"}},Textarea:{label:"\u591A\u884C\u8F93\u5165",fields:{label:{type:"text"},placeholder:{type:"text"}},defaults:{label:"\u5907\u6CE8",placeholder:"\u8BF7\u8F93\u5165"}},Select:{label:"\u4E0B\u62C9\u9009\u62E9",fields:{label:{type:"text"},options:{type:"text"}},defaults:{label:"\u7C7B\u578B",options:"\u9009\u9879\u4E00,\u9009\u9879\u4E8C"}},Checkbox:{label:"\u590D\u9009\u6846",fields:{label:{type:"text"},checked:{type:"radio",options:["true","false"]}},defaults:{label:"\u6211\u5DF2\u9605\u8BFB",checked:"false"}},Switch:{label:"\u5F00\u5173",fields:{label:{type:"text"},checked:{type:"radio",options:["true","false"]}},defaults:{label:"\u542F\u7528",checked:"true"}},Badge:{label:"\u6807\u7B7E",fields:{text:{type:"text"},variant:{type:"select",options:["default","secondary","outline","destructive"]}},defaults:{text:"\u8FDB\u884C\u4E2D",variant:"default"}},Alert:{label:"\u63D0\u793A\u6761",fields:{title:{type:"text"},description:{type:"text"},variant:{type:"select",options:["info","success","warning","error"]}},defaults:{title:"\u63D0\u793A",description:"\u8FD9\u91CC\u662F\u63D0\u793A\u5185\u5BB9",variant:"info"}},Upload:{label:"\u4E0A\u4F20\u533A",fields:{label:{type:"text"},hint:{type:"text"}},defaults:{label:"\u4E0A\u4F20\u6587\u4EF6",hint:"\u652F\u6301 .xlsx / .json\uFF0C\u62D6\u5230\u8FD9\u91CC\u6216\u70B9\u51FB\u9009\u62E9"}},Table:{label:"\u8868\u683C",fields:{columns:{type:"text"},rows:{type:"number"}},defaults:{columns:"\u540D\u79F0,\u72B6\u6001,\u66F4\u65B0\u65F6\u95F4",rows:3}},Tabs:{label:"\u9875\u7B7E",fields:{tabs:{type:"text"},active:{type:"number"}},defaults:{tabs:"\u5168\u90E8,\u8FDB\u884C\u4E2D,\u5DF2\u5B8C\u6210",active:0}},Stat:{label:"\u6307\u6807\u5361",fields:{label:{type:"text"},value:{type:"text"}},defaults:{label:"\u4ECA\u65E5\u65B0\u589E",value:"128"}},Navbar:{label:"\u9876\u680F",fields:{brand:{type:"text"},links:{type:"text"}},defaults:{brand:"\u4EA7\u54C1\u540D",links:"\u9996\u9875,\u5217\u8868,\u8BBE\u7F6E"}},Sidebar:{label:"\u4FA7\u8FB9\u5BFC\u822A",fields:{items:{type:"text"},active:{type:"number"}},defaults:{items:"\u6982\u89C8,\u8868\u5355,\u6D41\u7A0B,\u8BBE\u7F6E",active:0}},Divider:{label:"\u5206\u9694\u7EBF",fields:{},defaults:{}},Image:{label:"\u56FE\u7247\u5360\u4F4D",fields:{alt:{type:"text"},height:{type:"number"}},defaults:{alt:"\u56FE\u7247",height:120}},Card:{label:"\u5361\u7247",fields:{title:{type:"text"},description:{type:"text"},content:{type:"slot"}},defaults:{title:"\u5361\u7247\u6807\u9898",description:"",content:[]}},Section:{label:"\u533A\u5757",fields:{title:{type:"text"},content:{type:"slot"}},defaults:{title:"",content:[]}},Columns:{label:"\u4E24\u680F",fields:{left:{type:"slot"},right:{type:"slot"}},defaults:{left:[],right:[]}},Dialog:{label:"\u5F39\u7A97",fields:{title:{type:"text"},description:{type:"text"},content:{type:"slot"},confirmLabel:{type:"text"},cancelLabel:{type:"text"}},defaults:{title:"\u5F39\u7A97\u6807\u9898",description:"",content:[],confirmLabel:"\u786E\u5B9A",cancelLabel:"\u53D6\u6D88"}}},v=Object.keys(B);var r=require("react/jsx-runtime"),d=(...e)=>e.filter(Boolean).join(" "),k=e=>String(e||"").split(/[,，]/).map(t=>t.trim()).filter(Boolean),N=e=>typeof e=="function"?(0,r.jsx)(e,{}):null,R={primary:"bg-primary text-primary-foreground shadow hover:bg-primary/90",secondary:"bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",outline:"border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",ghost:"hover:bg-accent hover:text-accent-foreground",destructive:"bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90"},O={default:"border-transparent bg-primary text-primary-foreground shadow",secondary:"border-transparent bg-secondary text-secondary-foreground",outline:"text-foreground",destructive:"border-transparent bg-destructive text-destructive-foreground shadow"},M={info:"bg-background text-foreground",success:"border-emerald-500/50 text-emerald-700 bg-emerald-50",warning:"border-amber-500/50 text-amber-800 bg-amber-50",error:"border-destructive/50 text-destructive bg-red-50"},S="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",A="text-sm font-medium leading-none",Y={Heading:({text:e,level:t})=>{let o=t==="1"?"text-3xl":t==="3"?"text-lg":"text-2xl";return(0,r.jsx)("h"+(t||"2"),{className:d("font-semibold tracking-tight text-foreground",o),children:e})},Text:({text:e,tone:t})=>(0,r.jsx)("p",{className:d("text-sm leading-7",t==="muted"?"text-muted-foreground":"text-foreground"),children:e}),Button:({label:e,variant:t})=>(0,r.jsx)("button",{type:"button",className:d("inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium transition-colors",R[t]||R.primary),children:e}),Input:({label:e,placeholder:t})=>(0,r.jsxs)("div",{className:"grid w-full gap-1.5",children:[e?(0,r.jsx)("label",{className:A,children:e}):null,(0,r.jsx)("input",{className:S,placeholder:t})]}),Textarea:({label:e,placeholder:t})=>(0,r.jsxs)("div",{className:"grid w-full gap-1.5",children:[e?(0,r.jsx)("label",{className:A,children:e}):null,(0,r.jsx)("textarea",{className:d(S,"min-h-[72px] h-auto py-2"),placeholder:t})]}),Select:({label:e,options:t})=>(0,r.jsxs)("div",{className:"grid w-full gap-1.5",children:[e?(0,r.jsx)("label",{className:A,children:e}):null,(0,r.jsxs)("div",{className:"flex h-9 w-full items-center justify-between whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm",children:[(0,r.jsx)("span",{children:k(t)[0]||"\u8BF7\u9009\u62E9"}),(0,r.jsx)("span",{className:"text-muted-foreground",children:"\u25BE"})]})]}),Checkbox:({label:e,checked:t})=>(0,r.jsxs)("label",{className:"flex items-center gap-2 text-sm",children:[(0,r.jsx)("span",{className:d("flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-primary text-[10px] shadow",t==="true"?"bg-primary text-primary-foreground":""),children:t==="true"?"\u2713":""}),e]}),Switch:({label:e,checked:t})=>(0,r.jsxs)("label",{className:"flex items-center gap-2 text-sm",children:[(0,r.jsx)("span",{className:d("inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent shadow-sm",t==="true"?"bg-primary":"bg-input"),children:(0,r.jsx)("span",{className:d("block h-4 w-4 rounded-full bg-background shadow-lg transition-transform",t==="true"?"translate-x-4":"translate-x-0")})}),e]}),Badge:({text:e,variant:t})=>(0,r.jsx)("span",{className:d("inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold",O[t]||O.default),children:e}),Alert:({title:e,description:t,variant:o})=>(0,r.jsxs)("div",{role:"alert",className:d("relative w-full rounded-lg border px-4 py-3 text-sm",M[o]||M.info),children:[(0,r.jsx)("h5",{className:"mb-1 font-medium leading-none tracking-tight",children:e}),t?(0,r.jsx)("div",{className:"text-sm opacity-90",children:t}):null]}),Upload:({label:e,hint:t})=>(0,r.jsxs)("div",{className:"flex w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-input bg-muted/40 px-4 py-6 text-center",children:[(0,r.jsx)("div",{className:"text-sm font-medium",children:e}),(0,r.jsx)("div",{className:"text-xs text-muted-foreground",children:t})]}),Table:({columns:e,rows:t})=>{let o=k(e),a=Math.max(0,Math.min(20,Number(t)||0));return(0,r.jsx)("div",{className:"w-full overflow-auto rounded-md border",children:(0,r.jsxs)("table",{className:"w-full caption-bottom text-sm",children:[(0,r.jsx)("thead",{children:(0,r.jsx)("tr",{className:"border-b",children:o.map(n=>(0,r.jsx)("th",{className:"h-10 px-3 text-left align-middle font-medium text-muted-foreground",children:n},n))})}),(0,r.jsx)("tbody",{children:Array.from({length:a},(n,i)=>(0,r.jsx)("tr",{className:"border-b last:border-0",children:o.map((c,l)=>(0,r.jsx)("td",{className:"p-3 align-middle",children:l===0?c+" "+(i+1):(0,r.jsx)("span",{className:"inline-block h-2.5 w-16 rounded bg-muted"})},c))},i))})]})})},Tabs:({tabs:e,active:t})=>(0,r.jsx)("div",{className:"inline-flex h-9 items-center rounded-lg bg-muted p-1 text-muted-foreground",children:k(e).map((o,a)=>(0,r.jsx)("span",{className:d("inline-flex items-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium",a===(Number(t)||0)?"bg-background text-foreground shadow":""),children:o},o))}),Stat:({label:e,value:t})=>(0,r.jsxs)("div",{className:"rounded-xl border bg-card p-4 text-card-foreground shadow",children:[(0,r.jsx)("div",{className:"text-sm text-muted-foreground",children:e}),(0,r.jsx)("div",{className:"mt-1 text-2xl font-bold",children:t})]}),Navbar:({brand:e,links:t})=>(0,r.jsxs)("div",{className:"flex h-12 w-full items-center gap-6 border-b px-4",children:[(0,r.jsx)("span",{className:"font-semibold",children:e}),(0,r.jsx)("nav",{className:"flex gap-4 text-sm text-muted-foreground",children:k(t).map((o,a)=>(0,r.jsx)("span",{className:a===0?"text-foreground":"",children:o},o))})]}),Sidebar:({items:e,active:t})=>(0,r.jsx)("div",{className:"flex w-48 flex-col gap-1 border-r p-2",children:k(e).map((o,a)=>(0,r.jsx)("span",{className:d("rounded-md px-3 py-2 text-sm",a===(Number(t)||0)?"bg-accent font-medium text-accent-foreground":"text-muted-foreground"),children:o},o))}),Divider:()=>(0,r.jsx)("div",{className:"my-2 h-px w-full shrink-0 bg-border"}),Image:({alt:e,height:t})=>(0,r.jsx)("div",{className:"flex w-full items-center justify-center rounded-md bg-muted text-xs text-muted-foreground",style:{height:Math.max(40,Math.min(600,Number(t)||120))},children:e||"\u56FE\u7247"}),Card:({title:e,description:t,content:o})=>(0,r.jsxs)("div",{className:"rounded-xl border bg-card text-card-foreground shadow",children:[(0,r.jsxs)("div",{className:"flex flex-col space-y-1.5 p-5",children:[(0,r.jsx)("h3",{className:"font-semibold leading-none tracking-tight",children:e}),t?(0,r.jsx)("p",{className:"text-sm text-muted-foreground",children:t}):null]}),(0,r.jsx)("div",{className:"flex flex-col gap-3 p-5 pt-0",children:N(o)})]}),Section:({title:e,content:t})=>(0,r.jsxs)("section",{className:"flex w-full flex-col gap-3",children:[e?(0,r.jsx)("h3",{className:"text-base font-semibold",children:e}):null,(0,r.jsx)("div",{className:"flex flex-col gap-3",children:N(t)})]}),Columns:({left:e,right:t})=>(0,r.jsxs)("div",{className:"grid w-full grid-cols-2 gap-4",children:[(0,r.jsx)("div",{className:"flex flex-col gap-3",children:N(e)}),(0,r.jsx)("div",{className:"flex flex-col gap-3",children:N(t)})]}),Dialog:({title:e,description:t,content:o,confirmLabel:a,cancelLabel:n})=>(0,r.jsxs)("div",{className:"mx-auto grid w-full max-w-lg gap-4 rounded-lg border bg-background p-6 shadow-lg",children:[(0,r.jsxs)("div",{className:"flex flex-col space-y-1.5",children:[(0,r.jsx)("h2",{className:"text-lg font-semibold leading-none tracking-tight",children:e}),t?(0,r.jsx)("p",{className:"text-sm text-muted-foreground",children:t}):null]}),(0,r.jsx)("div",{className:"flex flex-col gap-3",children:N(o)}),(0,r.jsxs)("div",{className:"flex justify-end gap-2",children:[(0,r.jsx)("button",{type:"button",className:d("inline-flex h-9 items-center rounded-md px-4 text-sm font-medium",R.outline),children:n}),(0,r.jsx)("button",{type:"button",className:d("inline-flex h-9 items-center rounded-md px-4 text-sm font-medium",R.primary),children:a})]})]})},V="flex min-h-full flex-col gap-4 bg-background p-5 text-foreground antialiased",X={default:"bg-primary text-primary-foreground shadow hover:bg-primary/90",primary:"bg-primary text-primary-foreground shadow hover:bg-primary/90",secondary:"bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",outline:"border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",ghost:"hover:bg-accent hover:text-accent-foreground",destructive:"bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90"},he="rounded-lg border bg-background text-foreground shadow-sm",me=({className:e,children:t,header:o,footer:a,...n})=>(0,r.jsxs)("div",{className:d(he,e),...n,children:[o?(0,r.jsx)("div",{className:"flex flex-col gap-1 p-5 pb-2",children:o}):null,(0,r.jsx)("div",{className:"p-5",children:t}),a?(0,r.jsx)("div",{className:"flex items-center p-5 pt-0",children:a}):null]}),q={Button:({variant:e="default",className:t,children:o,...a})=>(0,r.jsx)("button",{type:"button",className:d("inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium transition-colors",X[e]||X.default,t),...a,children:o}),Input:({className:e,...t})=>(0,r.jsx)("input",{className:d(S,e),...t}),Textarea:({className:e,rows:t=3,...o})=>(0,r.jsx)("textarea",{rows:t,className:d(S,"min-h-[72px] h-auto py-2",e),...o}),Select:({options:e,className:t,...o})=>{let a=(Array.isArray(e)?e:[]).map(n=>{let i=n&&n.value!==void 0?n.value:n,c=n&&n.label!==void 0?n.label:String(i);return{value:String(i),text:String(c)}});return(0,r.jsx)("select",{className:d(S,t),...o,children:a.map(n=>(0,r.jsx)("option",{value:n.value,children:n.text},n.value))})},Label:({className:e,children:t,...o})=>(0,r.jsx)("label",{className:d(A,e),...o,children:t}),Badge:({variant:e="default",className:t,children:o,...a})=>(0,r.jsx)("span",{className:d("inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold",O[e]||O.default,t),...a,children:o}),Card:me,CardHeader:({className:e,children:t})=>(0,r.jsx)("div",{className:d("flex flex-col gap-1 p-5 pb-2",e),children:t}),CardTitle:({className:e,children:t})=>(0,r.jsx)("div",{className:d("text-lg font-semibold leading-none tracking-tight",e),children:t}),CardDescription:({className:e,children:t})=>(0,r.jsx)("div",{className:d("text-sm text-muted-foreground",e),children:t}),CardContent:({className:e,children:t})=>(0,r.jsx)("div",{className:d("p-5",e),children:t}),Separator:({className:e})=>(0,r.jsx)("hr",{className:d("my-2 border-border",e)}),Alert:({tone:e="info",title:t,children:o,className:a})=>(0,r.jsxs)("div",{role:"alert",className:d("relative w-full rounded-lg border p-4 text-sm",M[e]||M.info,a),children:[t?(0,r.jsx)("div",{className:"mb-1 font-medium",children:t}):null,o?(0,r.jsx)("div",{children:o}):null]}),Table:({columns:e,rows:t,rowKey:o})=>(0,r.jsx)("div",{className:"w-full overflow-auto rounded-lg border",children:(0,r.jsxs)("table",{className:"w-full caption-bottom text-sm",children:[(0,r.jsx)("thead",{children:(0,r.jsx)("tr",{className:"border-b bg-muted/50",children:(e||[]).map(a=>(0,r.jsx)("th",{className:"h-10 px-3 text-left align-middle font-medium text-muted-foreground",children:a.header},a.key))})}),(0,r.jsx)("tbody",{children:(t||[]).map((a,n)=>(0,r.jsx)("tr",{className:"border-b transition-colors hover:bg-muted/50",children:(e||[]).map(i=>(0,r.jsx)("td",{className:"p-3 align-middle",children:typeof i.render=="function"?i.render(a):String(a[i.key]===void 0?"":a[i.key])},i.key))},typeof o=="function"?o(a,n):n))})]})}),Tabs:({items:e,value:t,onChange:o})=>(0,r.jsxs)("div",{className:"flex flex-col gap-3",children:[(0,r.jsx)("div",{className:"flex gap-1 border-b",children:(e||[]).map(a=>(0,r.jsx)("button",{type:"button",onClick:()=>{typeof o=="function"&&o(a.key)},className:d("px-3 py-2 text-sm font-medium",a.key===t?"border-b-2 border-primary text-foreground":"text-muted-foreground hover:text-foreground"),children:a.label},a.key))}),(0,r.jsx)("div",{children:(e||[]).filter(a=>a.key===t).map(a=>(0,r.jsx)("div",{children:a.content},a.key))})]}),Switch:({checked:e,onChange:t,className:o})=>(0,r.jsx)("button",{type:"button",role:"switch","aria-checked":!!e,onClick:()=>{typeof t=="function"&&t(!e)},className:d("relative inline-flex h-5 w-9 items-center rounded-full transition-colors",e?"bg-primary":"bg-input",o),children:(0,r.jsx)("span",{className:d("block size-4 rounded-full bg-background shadow transition-transform",e?"translate-x-4":"translate-x-0.5")})}),Checkbox:({checked:e,onChange:t,className:o,...a})=>(0,r.jsx)("input",{type:"checkbox",checked:!!e,onChange:n=>{typeof t=="function"&&t(n.target.checked)},className:d("size-4 rounded border-input accent-primary",o),...a}),EmptyState:({title:e="\u8FD8\u6CA1\u6709\u6570\u636E",hint:t,className:o})=>(0,r.jsxs)("div",{className:d("flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed p-8 text-center",o),children:[(0,r.jsx)("div",{className:"text-sm font-medium text-foreground",children:e}),t?(0,r.jsx)("div",{className:"text-xs text-muted-foreground",children:t}):null]}),Progress:({value:e=0,className:t})=>(0,r.jsx)("div",{className:d("h-2 w-full overflow-hidden rounded-full bg-muted",t),children:(0,r.jsx)("div",{className:"h-full bg-primary transition-all",style:{width:Math.max(0,Math.min(100,Number(e)||0))+"%"}})}),Avatar:({name:e="",className:t})=>(0,r.jsx)("span",{className:d("inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground",t),children:String(e).trim().slice(0,1)||"?"}),Title:({level:e=2,className:t,children:o})=>(0,r.jsx)("h"+(Number(e)>=1&&Number(e)<=6?e:2),{className:d("font-semibold tracking-tight",t),children:o}),Text:({tone:e="default",className:t,children:o})=>(0,r.jsx)("p",{className:d("text-sm leading-7",e==="muted"?"text-muted-foreground":"text-foreground",t),children:o}),Stack:({gap:e=3,className:t,children:o})=>(0,r.jsx)("div",{className:d("flex flex-col",e===1?"gap-1":e===2?"gap-2":e===4?"gap-4":"gap-3",t),children:o}),Row:({gap:e=2,className:t,children:o})=>(0,r.jsx)("div",{className:d("flex flex-row items-center",e===1?"gap-1":e===3?"gap-3":e===4?"gap-4":"gap-2",t),children:o})};var G=`*, ::before, ::after {
  --tw-border-spacing-x: 0;
  --tw-border-spacing-y: 0;
  --tw-translate-x: 0;
  --tw-translate-y: 0;
  --tw-rotate: 0;
  --tw-skew-x: 0;
  --tw-skew-y: 0;
  --tw-scale-x: 1;
  --tw-scale-y: 1;
  --tw-pan-x:  ;
  --tw-pan-y:  ;
  --tw-pinch-zoom:  ;
  --tw-scroll-snap-strictness: proximity;
  --tw-gradient-from-position:  ;
  --tw-gradient-via-position:  ;
  --tw-gradient-to-position:  ;
  --tw-ordinal:  ;
  --tw-slashed-zero:  ;
  --tw-numeric-figure:  ;
  --tw-numeric-spacing:  ;
  --tw-numeric-fraction:  ;
  --tw-ring-inset:  ;
  --tw-ring-offset-width: 0px;
  --tw-ring-offset-color: #fff;
  --tw-ring-color: rgb(59 130 246 / 0.5);
  --tw-ring-offset-shadow: 0 0 #0000;
  --tw-ring-shadow: 0 0 #0000;
  --tw-shadow: 0 0 #0000;
  --tw-shadow-colored: 0 0 #0000;
  --tw-blur:  ;
  --tw-brightness:  ;
  --tw-contrast:  ;
  --tw-grayscale:  ;
  --tw-hue-rotate:  ;
  --tw-invert:  ;
  --tw-saturate:  ;
  --tw-sepia:  ;
  --tw-drop-shadow:  ;
  --tw-backdrop-blur:  ;
  --tw-backdrop-brightness:  ;
  --tw-backdrop-contrast:  ;
  --tw-backdrop-grayscale:  ;
  --tw-backdrop-hue-rotate:  ;
  --tw-backdrop-invert:  ;
  --tw-backdrop-opacity:  ;
  --tw-backdrop-saturate:  ;
  --tw-backdrop-sepia:  ;
  --tw-contain-size:  ;
  --tw-contain-layout:  ;
  --tw-contain-paint:  ;
  --tw-contain-style:  ;
}

::backdrop {
  --tw-border-spacing-x: 0;
  --tw-border-spacing-y: 0;
  --tw-translate-x: 0;
  --tw-translate-y: 0;
  --tw-rotate: 0;
  --tw-skew-x: 0;
  --tw-skew-y: 0;
  --tw-scale-x: 1;
  --tw-scale-y: 1;
  --tw-pan-x:  ;
  --tw-pan-y:  ;
  --tw-pinch-zoom:  ;
  --tw-scroll-snap-strictness: proximity;
  --tw-gradient-from-position:  ;
  --tw-gradient-via-position:  ;
  --tw-gradient-to-position:  ;
  --tw-ordinal:  ;
  --tw-slashed-zero:  ;
  --tw-numeric-figure:  ;
  --tw-numeric-spacing:  ;
  --tw-numeric-fraction:  ;
  --tw-ring-inset:  ;
  --tw-ring-offset-width: 0px;
  --tw-ring-offset-color: #fff;
  --tw-ring-color: rgb(59 130 246 / 0.5);
  --tw-ring-offset-shadow: 0 0 #0000;
  --tw-ring-shadow: 0 0 #0000;
  --tw-shadow: 0 0 #0000;
  --tw-shadow-colored: 0 0 #0000;
  --tw-blur:  ;
  --tw-brightness:  ;
  --tw-contrast:  ;
  --tw-grayscale:  ;
  --tw-hue-rotate:  ;
  --tw-invert:  ;
  --tw-saturate:  ;
  --tw-sepia:  ;
  --tw-drop-shadow:  ;
  --tw-backdrop-blur:  ;
  --tw-backdrop-brightness:  ;
  --tw-backdrop-contrast:  ;
  --tw-backdrop-grayscale:  ;
  --tw-backdrop-hue-rotate:  ;
  --tw-backdrop-invert:  ;
  --tw-backdrop-opacity:  ;
  --tw-backdrop-saturate:  ;
  --tw-backdrop-sepia:  ;
  --tw-contain-size:  ;
  --tw-contain-layout:  ;
  --tw-contain-paint:  ;
  --tw-contain-style:  ;
}/*
! tailwindcss v3.4.19 | MIT License | https://tailwindcss.com
*//*
1. Prevent padding and border from affecting element width. (https://github.com/mozdevs/cssremedy/issues/4)
2. Allow adding a border to an element by just adding a border-width. (https://github.com/tailwindcss/tailwindcss/pull/116)
*/

*,
::before,
::after {
  box-sizing: border-box; /* 1 */
  border-width: 0; /* 2 */
  border-style: solid; /* 2 */
  border-color: #e5e7eb; /* 2 */
}

::before,
::after {
  --tw-content: '';
}

/*
1. Use a consistent sensible line-height in all browsers.
2. Prevent adjustments of font size after orientation changes in iOS.
3. Use a more readable tab size.
4. Use the user's configured \`sans\` font-family by default.
5. Use the user's configured \`sans\` font-feature-settings by default.
6. Use the user's configured \`sans\` font-variation-settings by default.
7. Disable tap highlights on iOS
*/

html,
:host {
  line-height: 1.5; /* 1 */
  -webkit-text-size-adjust: 100%; /* 2 */
  -moz-tab-size: 4; /* 3 */
  tab-size: 4; /* 3 */
  font-family: ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"; /* 4 */
  font-feature-settings: normal; /* 5 */
  font-variation-settings: normal; /* 6 */
  -webkit-tap-highlight-color: transparent; /* 7 */
}

/*
1. Remove the margin in all browsers.
2. Inherit line-height from \`html\` so users can set them as a class directly on the \`html\` element.
*/

body {
  margin: 0; /* 1 */
  line-height: inherit; /* 2 */
}

/*
1. Add the correct height in Firefox.
2. Correct the inheritance of border color in Firefox. (https://bugzilla.mozilla.org/show_bug.cgi?id=190655)
3. Ensure horizontal rules are visible by default.
*/

hr {
  height: 0; /* 1 */
  color: inherit; /* 2 */
  border-top-width: 1px; /* 3 */
}

/*
Add the correct text decoration in Chrome, Edge, and Safari.
*/

abbr:where([title]) {
  text-decoration: underline dotted;
}

/*
Remove the default font size and weight for headings.
*/

h1,
h2,
h3,
h4,
h5,
h6 {
  font-size: inherit;
  font-weight: inherit;
}

/*
Reset links to optimize for opt-in styling instead of opt-out.
*/

a {
  color: inherit;
  text-decoration: inherit;
}

/*
Add the correct font weight in Edge and Safari.
*/

b,
strong {
  font-weight: bolder;
}

/*
1. Use the user's configured \`mono\` font-family by default.
2. Use the user's configured \`mono\` font-feature-settings by default.
3. Use the user's configured \`mono\` font-variation-settings by default.
4. Correct the odd \`em\` font sizing in all browsers.
*/

code,
kbd,
samp,
pre {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; /* 1 */
  font-feature-settings: normal; /* 2 */
  font-variation-settings: normal; /* 3 */
  font-size: 1em; /* 4 */
}

/*
Add the correct font size in all browsers.
*/

small {
  font-size: 80%;
}

/*
Prevent \`sub\` and \`sup\` elements from affecting the line height in all browsers.
*/

sub,
sup {
  font-size: 75%;
  line-height: 0;
  position: relative;
  vertical-align: baseline;
}

sub {
  bottom: -0.25em;
}

sup {
  top: -0.5em;
}

/*
1. Remove text indentation from table contents in Chrome and Safari. (https://bugs.chromium.org/p/chromium/issues/detail?id=999088, https://bugs.webkit.org/show_bug.cgi?id=201297)
2. Correct table border color inheritance in all Chrome and Safari. (https://bugs.chromium.org/p/chromium/issues/detail?id=935729, https://bugs.webkit.org/show_bug.cgi?id=195016)
3. Remove gaps between table borders by default.
*/

table {
  text-indent: 0; /* 1 */
  border-color: inherit; /* 2 */
  border-collapse: collapse; /* 3 */
}

/*
1. Change the font styles in all browsers.
2. Remove the margin in Firefox and Safari.
3. Remove default padding in all browsers.
*/

button,
input,
optgroup,
select,
textarea {
  font-family: inherit; /* 1 */
  font-feature-settings: inherit; /* 1 */
  font-variation-settings: inherit; /* 1 */
  font-size: 100%; /* 1 */
  font-weight: inherit; /* 1 */
  line-height: inherit; /* 1 */
  letter-spacing: inherit; /* 1 */
  color: inherit; /* 1 */
  margin: 0; /* 2 */
  padding: 0; /* 3 */
}

/*
Remove the inheritance of text transform in Edge and Firefox.
*/

button,
select {
  text-transform: none;
}

/*
1. Correct the inability to style clickable types in iOS and Safari.
2. Remove default button styles.
*/

button,
input:where([type='button']),
input:where([type='reset']),
input:where([type='submit']) {
  -webkit-appearance: button; /* 1 */
  background-color: transparent; /* 2 */
  background-image: none; /* 2 */
}

/*
Use the modern Firefox focus style for all focusable elements.
*/

:-moz-focusring {
  outline: auto;
}

/*
Remove the additional \`:invalid\` styles in Firefox. (https://github.com/mozilla/gecko-dev/blob/2f9eacd9d3d995c937b4251a5557d95d494c9be1/layout/style/res/forms.css#L728-L737)
*/

:-moz-ui-invalid {
  box-shadow: none;
}

/*
Add the correct vertical alignment in Chrome and Firefox.
*/

progress {
  vertical-align: baseline;
}

/*
Correct the cursor style of increment and decrement buttons in Safari.
*/

::-webkit-inner-spin-button,
::-webkit-outer-spin-button {
  height: auto;
}

/*
1. Correct the odd appearance in Chrome and Safari.
2. Correct the outline style in Safari.
*/

[type='search'] {
  -webkit-appearance: textfield; /* 1 */
  outline-offset: -2px; /* 2 */
}

/*
Remove the inner padding in Chrome and Safari on macOS.
*/

::-webkit-search-decoration {
  -webkit-appearance: none;
}

/*
1. Correct the inability to style clickable types in iOS and Safari.
2. Change font properties to \`inherit\` in Safari.
*/

::-webkit-file-upload-button {
  -webkit-appearance: button; /* 1 */
  font: inherit; /* 2 */
}

/*
Add the correct display in Chrome and Safari.
*/

summary {
  display: list-item;
}

/*
Removes the default spacing and border for appropriate elements.
*/

blockquote,
dl,
dd,
h1,
h2,
h3,
h4,
h5,
h6,
hr,
figure,
p,
pre {
  margin: 0;
}

fieldset {
  margin: 0;
  padding: 0;
}

legend {
  padding: 0;
}

ol,
ul,
menu {
  list-style: none;
  margin: 0;
  padding: 0;
}

/*
Reset default styling for dialogs.
*/
dialog {
  padding: 0;
}

/*
Prevent resizing textareas horizontally by default.
*/

textarea {
  resize: vertical;
}

/*
1. Reset the default placeholder opacity in Firefox. (https://github.com/tailwindlabs/tailwindcss/issues/3300)
2. Set the default placeholder color to the user's configured gray 400 color.
*/

input::placeholder,
textarea::placeholder {
  opacity: 1; /* 1 */
  color: #9ca3af; /* 2 */
}

/*
Set the default cursor for buttons.
*/

button,
[role="button"] {
  cursor: pointer;
}

/*
Make sure disabled buttons don't get the pointer cursor.
*/
:disabled {
  cursor: default;
}

/*
1. Make replaced elements \`display: block\` by default. (https://github.com/mozdevs/cssremedy/issues/14)
2. Add \`vertical-align: middle\` to align replaced elements more sensibly by default. (https://github.com/jensimmons/cssremedy/issues/14#issuecomment-634934210)
   This can trigger a poorly considered lint error in some tools but is included by design.
*/

img,
svg,
video,
canvas,
audio,
iframe,
embed,
object {
  display: block; /* 1 */
  vertical-align: middle; /* 2 */
}

/*
Constrain images and videos to the parent width and preserve their intrinsic aspect ratio. (https://github.com/mozdevs/cssremedy/issues/14)
*/

img,
video {
  max-width: 100%;
  height: auto;
}

/* Make elements with the HTML hidden attribute stay hidden by default */
[hidden]:where(:not([hidden="until-found"])) {
  display: none;
}
	:root {
		--background: 0 0% 100%;
		--foreground: 240 10% 3.9%;
		--card: 0 0% 100%;
		--card-foreground: 240 10% 3.9%;
		--primary: 240 5.9% 10%;
		--primary-foreground: 0 0% 98%;
		--secondary: 240 4.8% 95.9%;
		--secondary-foreground: 240 5.9% 10%;
		--muted: 240 4.8% 95.9%;
		--muted-foreground: 240 3.8% 46.1%;
		--accent: 240 4.8% 95.9%;
		--accent-foreground: 240 5.9% 10%;
		--destructive: 0 84.2% 60.2%;
		--destructive-foreground: 0 0% 98%;
		--border: 240 5.9% 90%;
		--input: 240 5.9% 90%;
		--ring: 240 10% 3.9%;
		--radius: 0.5rem;
	}
	* {
  border-color: hsl(var(--border));
}
	body {
  background-color: hsl(var(--background));
  color: hsl(var(--foreground)); font-family: "Inter", "Noto Sans SC", system-ui, -apple-system, sans-serif;
}
.relative {
  position: relative;
}
.mx-auto {
  margin-left: auto;
  margin-right: auto;
}
.my-2 {
  margin-top: 0.5rem;
  margin-bottom: 0.5rem;
}
.mb-1 {
  margin-bottom: 0.25rem;
}
.mt-1 {
  margin-top: 0.25rem;
}
.block {
  display: block;
}
.inline-block {
  display: inline-block;
}
.flex {
  display: flex;
}
.inline-flex {
  display: inline-flex;
}
.table {
  display: table;
}
.grid {
  display: grid;
}
.size-4 {
  width: 1rem;
  height: 1rem;
}
.size-8 {
  width: 2rem;
  height: 2rem;
}
.h-10 {
  height: 2.5rem;
}
.h-12 {
  height: 3rem;
}
.h-2 {
  height: 0.5rem;
}
.h-2\\.5 {
  height: 0.625rem;
}
.h-4 {
  height: 1rem;
}
.h-5 {
  height: 1.25rem;
}
.h-9 {
  height: 2.25rem;
}
.h-auto {
  height: auto;
}
.h-full {
  height: 100%;
}
.h-px {
  height: 1px;
}
.min-h-\\[72px\\] {
  min-height: 72px;
}
.min-h-full {
  min-height: 100%;
}
.w-16 {
  width: 4rem;
}
.w-4 {
  width: 1rem;
}
.w-48 {
  width: 12rem;
}
.w-9 {
  width: 2.25rem;
}
.w-full {
  width: 100%;
}
.max-w-lg {
  max-width: 32rem;
}
.shrink-0 {
  flex-shrink: 0;
}
.caption-bottom {
  caption-side: bottom;
}
.translate-x-0 {
  --tw-translate-x: 0px;
  transform: translate(var(--tw-translate-x), var(--tw-translate-y)) rotate(var(--tw-rotate)) skewX(var(--tw-skew-x)) skewY(var(--tw-skew-y)) scaleX(var(--tw-scale-x)) scaleY(var(--tw-scale-y));
}
.translate-x-0\\.5 {
  --tw-translate-x: 0.125rem;
  transform: translate(var(--tw-translate-x), var(--tw-translate-y)) rotate(var(--tw-rotate)) skewX(var(--tw-skew-x)) skewY(var(--tw-skew-y)) scaleX(var(--tw-scale-x)) scaleY(var(--tw-scale-y));
}
.translate-x-4 {
  --tw-translate-x: 1rem;
  transform: translate(var(--tw-translate-x), var(--tw-translate-y)) rotate(var(--tw-rotate)) skewX(var(--tw-skew-x)) skewY(var(--tw-skew-y)) scaleX(var(--tw-scale-x)) scaleY(var(--tw-scale-y));
}
.grid-cols-2 {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.flex-row {
  flex-direction: row;
}
.flex-col {
  flex-direction: column;
}
.items-center {
  align-items: center;
}
.justify-end {
  justify-content: flex-end;
}
.justify-center {
  justify-content: center;
}
.justify-between {
  justify-content: space-between;
}
.gap-1 {
  gap: 0.25rem;
}
.gap-1\\.5 {
  gap: 0.375rem;
}
.gap-2 {
  gap: 0.5rem;
}
.gap-3 {
  gap: 0.75rem;
}
.gap-4 {
  gap: 1rem;
}
.gap-6 {
  gap: 1.5rem;
}
.space-y-1\\.5 > :not([hidden]) ~ :not([hidden]) {
  --tw-space-y-reverse: 0;
  margin-top: calc(0.375rem * calc(1 - var(--tw-space-y-reverse)));
  margin-bottom: calc(0.375rem * var(--tw-space-y-reverse));
}
.overflow-auto {
  overflow: auto;
}
.overflow-hidden {
  overflow: hidden;
}
.whitespace-nowrap {
  white-space: nowrap;
}
.rounded {
  border-radius: 0.25rem;
}
.rounded-full {
  border-radius: 9999px;
}
.rounded-lg {
  border-radius: var(--radius);
}
.rounded-md {
  border-radius: calc(var(--radius) - 2px);
}
.rounded-sm {
  border-radius: calc(var(--radius) - 4px);
}
.rounded-xl {
  border-radius: 0.75rem;
}
.border {
  border-width: 1px;
}
.border-2 {
  border-width: 2px;
}
.border-b {
  border-bottom-width: 1px;
}
.border-b-2 {
  border-bottom-width: 2px;
}
.border-r {
  border-right-width: 1px;
}
.border-dashed {
  border-style: dashed;
}
.border-amber-500\\/50 {
  border-color: rgb(245 158 11 / 0.5);
}
.border-border {
  border-color: hsl(var(--border));
}
.border-destructive\\/50 {
  border-color: hsl(var(--destructive) / 0.5);
}
.border-emerald-500\\/50 {
  border-color: rgb(16 185 129 / 0.5);
}
.border-input {
  border-color: hsl(var(--input));
}
.border-primary {
  border-color: hsl(var(--primary));
}
.border-transparent {
  border-color: transparent;
}
.bg-accent {
  background-color: hsl(var(--accent));
}
.bg-amber-50 {
  --tw-bg-opacity: 1;
  background-color: rgb(255 251 235 / var(--tw-bg-opacity, 1));
}
.bg-background {
  background-color: hsl(var(--background));
}
.bg-border {
  background-color: hsl(var(--border));
}
.bg-card {
  background-color: hsl(var(--card));
}
.bg-destructive {
  background-color: hsl(var(--destructive));
}
.bg-emerald-50 {
  --tw-bg-opacity: 1;
  background-color: rgb(236 253 245 / var(--tw-bg-opacity, 1));
}
.bg-input {
  background-color: hsl(var(--input));
}
.bg-muted {
  background-color: hsl(var(--muted));
}
.bg-muted\\/40 {
  background-color: hsl(var(--muted) / 0.4);
}
.bg-muted\\/50 {
  background-color: hsl(var(--muted) / 0.5);
}
.bg-primary {
  background-color: hsl(var(--primary));
}
.bg-red-50 {
  --tw-bg-opacity: 1;
  background-color: rgb(254 242 242 / var(--tw-bg-opacity, 1));
}
.bg-secondary {
  background-color: hsl(var(--secondary));
}
.bg-transparent {
  background-color: transparent;
}
.p-1 {
  padding: 0.25rem;
}
.p-2 {
  padding: 0.5rem;
}
.p-3 {
  padding: 0.75rem;
}
.p-4 {
  padding: 1rem;
}
.p-5 {
  padding: 1.25rem;
}
.p-6 {
  padding: 1.5rem;
}
.p-8 {
  padding: 2rem;
}
.px-2\\.5 {
  padding-left: 0.625rem;
  padding-right: 0.625rem;
}
.px-3 {
  padding-left: 0.75rem;
  padding-right: 0.75rem;
}
.px-4 {
  padding-left: 1rem;
  padding-right: 1rem;
}
.py-0\\.5 {
  padding-top: 0.125rem;
  padding-bottom: 0.125rem;
}
.py-1 {
  padding-top: 0.25rem;
  padding-bottom: 0.25rem;
}
.py-2 {
  padding-top: 0.5rem;
  padding-bottom: 0.5rem;
}
.py-3 {
  padding-top: 0.75rem;
  padding-bottom: 0.75rem;
}
.py-6 {
  padding-top: 1.5rem;
  padding-bottom: 1.5rem;
}
.pb-2 {
  padding-bottom: 0.5rem;
}
.pt-0 {
  padding-top: 0px;
}
.text-left {
  text-align: left;
}
.text-center {
  text-align: center;
}
.align-middle {
  vertical-align: middle;
}
.text-2xl {
  font-size: 1.5rem;
  line-height: 2rem;
}
.text-3xl {
  font-size: 1.875rem;
  line-height: 2.25rem;
}
.text-\\[10px\\] {
  font-size: 10px;
}
.text-base {
  font-size: 1rem;
  line-height: 1.5rem;
}
.text-lg {
  font-size: 1.125rem;
  line-height: 1.75rem;
}
.text-sm {
  font-size: 0.875rem;
  line-height: 1.25rem;
}
.text-xs {
  font-size: 0.75rem;
  line-height: 1rem;
}
.font-bold {
  font-weight: 700;
}
.font-medium {
  font-weight: 500;
}
.font-semibold {
  font-weight: 600;
}
.leading-7 {
  line-height: 1.75rem;
}
.leading-none {
  line-height: 1;
}
.tracking-tight {
  letter-spacing: -0.025em;
}
.text-accent-foreground {
  color: hsl(var(--accent-foreground));
}
.text-amber-800 {
  --tw-text-opacity: 1;
  color: rgb(146 64 14 / var(--tw-text-opacity, 1));
}
.text-card-foreground {
  color: hsl(var(--card-foreground));
}
.text-destructive {
  color: hsl(var(--destructive));
}
.text-destructive-foreground {
  color: hsl(var(--destructive-foreground));
}
.text-emerald-700 {
  --tw-text-opacity: 1;
  color: rgb(4 120 87 / var(--tw-text-opacity, 1));
}
.text-foreground {
  color: hsl(var(--foreground));
}
.text-muted-foreground {
  color: hsl(var(--muted-foreground));
}
.text-primary-foreground {
  color: hsl(var(--primary-foreground));
}
.text-secondary-foreground {
  color: hsl(var(--secondary-foreground));
}
.antialiased {
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
.accent-primary {
  accent-color: hsl(var(--primary));
}
.opacity-90 {
  opacity: 0.9;
}
.shadow {
  --tw-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1);
  --tw-shadow-colored: 0 1px 3px 0 var(--tw-shadow-color), 0 1px 2px -1px var(--tw-shadow-color);
  box-shadow: var(--tw-ring-offset-shadow, 0 0 #0000), var(--tw-ring-shadow, 0 0 #0000), var(--tw-shadow);
}
.shadow-lg {
  --tw-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
  --tw-shadow-colored: 0 10px 15px -3px var(--tw-shadow-color), 0 4px 6px -4px var(--tw-shadow-color);
  box-shadow: var(--tw-ring-offset-shadow, 0 0 #0000), var(--tw-ring-shadow, 0 0 #0000), var(--tw-shadow);
}
.shadow-sm {
  --tw-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  --tw-shadow-colored: 0 1px 2px 0 var(--tw-shadow-color);
  box-shadow: var(--tw-ring-offset-shadow, 0 0 #0000), var(--tw-ring-shadow, 0 0 #0000), var(--tw-shadow);
}
.outline {
  outline-style: solid;
}
.filter {
  filter: var(--tw-blur) var(--tw-brightness) var(--tw-contrast) var(--tw-grayscale) var(--tw-hue-rotate) var(--tw-invert) var(--tw-saturate) var(--tw-sepia) var(--tw-drop-shadow);
}
.transition-all {
  transition-property: all;
  transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
  transition-duration: 150ms;
}
.transition-colors {
  transition-property: color, background-color, border-color, text-decoration-color, fill, stroke;
  transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
  transition-duration: 150ms;
}
.transition-transform {
  transition-property: transform;
  transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
  transition-duration: 150ms;
}

/* shadcn/ui \xB7 new-york \xB7 zinc\uFF08\u6D45\u8272\uFF09\u3002\u53EA\u5728\u539F\u578B iframe \u91CC\u751F\u6548\uFF0C\u4E0D\u4F1A\u6C61\u67D3 DSH \u9875\u9762\u3002 */

.placeholder\\:text-muted-foreground::placeholder {
  color: hsl(var(--muted-foreground));
}

.last\\:border-0:last-child {
  border-width: 0px;
}

.hover\\:bg-accent:hover {
  background-color: hsl(var(--accent));
}

.hover\\:bg-destructive\\/90:hover {
  background-color: hsl(var(--destructive) / 0.9);
}

.hover\\:bg-muted\\/50:hover {
  background-color: hsl(var(--muted) / 0.5);
}

.hover\\:bg-primary\\/90:hover {
  background-color: hsl(var(--primary) / 0.9);
}

.hover\\:bg-secondary\\/80:hover {
  background-color: hsl(var(--secondary) / 0.8);
}

.hover\\:text-accent-foreground:hover {
  color: hsl(var(--accent-foreground));
}

.hover\\:text-foreground:hover {
  color: hsl(var(--foreground));
}

.focus-visible\\:outline-none:focus-visible {
  outline: 2px solid transparent;
  outline-offset: 2px;
}

.focus-visible\\:ring-1:focus-visible {
  --tw-ring-offset-shadow: var(--tw-ring-inset) 0 0 0 var(--tw-ring-offset-width) var(--tw-ring-offset-color);
  --tw-ring-shadow: var(--tw-ring-inset) 0 0 0 calc(1px + var(--tw-ring-offset-width)) var(--tw-ring-color);
  box-shadow: var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow, 0 0 #0000);
}

.focus-visible\\:ring-ring:focus-visible {
  --tw-ring-color: hsl(var(--ring));
}
`;var be=v,xe="/agent-whales/api",{useEffect:T,useMemo:I,useRef:F,useState:C}=y,K={id:"shadcn",name:"shadcn/ui\uFF08\u5185\u7F6E\uFF09",builtin:!0,components:Y,raw:q,css:G,rootClass:V},E=new Map([["shadcn",Promise.resolve(K)]]),J={react:y,"react-dom":L,"react/jsx-runtime":ge};function we(e,t,o){let a={exports:{}},n=l=>{if(J[l])return J[l];throw new Error("\u7EC4\u4EF6\u5305 "+e.id+" \u53EA\u80FD require react / react-dom / react/jsx-runtime\uFF0C\u51FA\u73B0\u4E86 "+l)};new Function("module","exports","require",t)(a,a.exports,n);let i=a.exports&&a.exports.default?a.exports.default:a.exports;typeof i=="function"&&(i=i(y));let c=i&&i.components?i.components:i;if(!c||typeof c!="object")throw new Error("\u7EC4\u4EF6\u5305 "+e.id+" \u6CA1\u6709\u5BFC\u51FA\u7EC4\u4EF6\u8868");return{id:e.id,name:e.name||e.id,builtin:!1,components:c,raw:i&&i.raw||null,css:o||"",rootClass:i&&i.rootClass||e.rootClass||""}}function Q(e){let t=e&&typeof e.id=="string"?e.id:"shadcn";if(E.has(t))return E.get(t);let o=xe+"/component-packs/"+encodeURIComponent(t),a=Promise.all([fetch(o+"/bundle.js").then(n=>{if(!n.ok)throw new Error("bundle.js "+n.status);return n.text()}),fetch(o+"/styles.css").then(n=>n.ok?n.text():"",()=>"")]).then(([n,i])=>we(e,n,i));return a.catch(()=>E.delete(t)),E.set(t,a),a}function U(e){let t=e&&e.id?e.id:"shadcn",[o,a]=C(()=>t==="shadcn"?{pack:K,error:""}:{pack:null,error:""});return T(()=>{let n=!0;return Q(e||{id:t}).then(i=>{n&&a({pack:i,error:""})},i=>{n&&a({pack:null,error:String(i&&i.message||i)})}),()=>{n=!1}},[t]),o}function Z(e){return function(){return(0,s.jsx)("div",{style:{border:"1px dashed #c4c4c4",borderRadius:6,padding:"8px 10px",fontSize:12,color:"#888",background:"#fafafa"},children:"\uFF08\u5F53\u524D\u7EC4\u4EF6\u5305\u6CA1\u6709\u300C"+e+"\u300D\uFF09"})}}function $(e){let t=v.filter(o=>e&&e.components&&typeof e.components[o]=="function");return{covered:t.length,total:v.length,missing:v.filter(o=>t.indexOf(o)<0)}}var D=30;function ye(e,t){return function(){return(0,s.jsx)("div",{style:{border:"1px dashed #c4c4c4",borderRadius:6,padding:"8px 10px",fontSize:12,color:"#888",background:"#fafafa"},children:"\uFF08\u9879\u76EE\u7EC4\u4EF6\u300C"+e+"\u300D"+(t||"\u5F53\u524D\u73AF\u5883\u4E0D\u652F\u6301\u6C99\u7BB1\u6E32\u67D3")+"\uFF09"})}}var ee=function(){let e=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'">
<meta name="whales-boot-id" content="">
<title>puck-island</title>
<style>
html,body{margin:0;padding:0;background:#fff}
body{font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#18181b}
#root{padding:0}
.wds-error{border:1px solid #dc2626;background:#fef2f2;color:#991b1b;border-radius:8px;padding:10px 12px;margin:8px;font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
.wds-pick *{cursor:crosshair !important}
.wds-pick-hover{outline:2px solid #2563eb !important;outline-offset:1px !important}
.wds-empty{display:flex;align-items:center;justify-content:center;height:100%;color:#9ca3af;font-size:12px}
</style>
</head><body><div id="root"></div>
<script>
(function () {
  "use strict";
  var parentWin = window.parent;
  var nonce = "";
  var rootEl = document.getElementById("root");
  var state = {
    pack: null,
    packTable: null,
    components: {},   // name -> \u7F16\u8BD1\u4EA7\u7269\u5BFC\u51FA\u7684\u7EC4\u4EF6
    compiled: {},     // name -> \u7F16\u8BD1\u4EA7\u7269\u6E90\u7801\uFF08\u9700\u8981\u65F6\u61D2\u52A0\u8F7D\uFF09
    mounts: {},       // mountId -> { root, options }
    consoleErrors: [],
    pickMode: false,
    pickTarget: null
  };

  function report(msg) {
    msg.nonce = nonce;
    try { parentWin.postMessage(msg, "*"); } catch (error) { /* \u7236\u9875\u9762\u4E0D\u53EF\u8FBE\u65F6\u53EA\u80FD\u9759\u9ED8 */ }
  }

  window.onerror = function (message, source, line, column) {
    report({ type: "error", phase: "onerror", message: String(message), line: line, column: column });
    return false;
  };
  window.addEventListener("unhandledrejection", function (event) {
    report({ type: "error", phase: "unhandledrejection", message: String(event.reason && event.reason.message || event.reason) });
  });
  var origError = console.error;
  console.error = function () {
    var parts = Array.prototype.slice.call(arguments).map(function (value) { return String(value); });
    state.consoleErrors.push(parts.join(" "));
    if (state.consoleErrors.length > 30) state.consoleErrors.shift();
    try { origError.apply(console, arguments); } catch (error) { /* \u5FFD\u7565 */ }
  };

  // \u2500\u2500 \u6A21\u5757\u6620\u5C04\uFF08P0 \u4E09\u6761\u5751\u90FD\u5728\u8FD9\u91CC\uFF09\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  function makeRequire(spec) {
    if (spec === "@cds") {
      if (!state.packTable) throw new Error("\u5F53\u524D\u7EC4\u4EF6\u5305\u6CA1\u6709 raw \u5BFC\u51FA\uFF1A\u4E0D\u80FD import @cds");
      return state.packTable;
    }
    if (spec.indexOf("@project/") === 0) {
      var name = spec.slice("@project/".length);
      if (!state.components[name]) throw new Error("\u6C99\u7BB1\uFF1A@project/" + name + " \u8FD8\u6CA1\u52A0\u8F7D");
      // components[name] \u73B0\u5728\u662F { component, code }\uFF08\u89C1 ensureComponent \u7684\u7F13\u5B58\u6539\u9020\uFF09
      return { __esModule: true, default: state.components[name].component };
    }
    if (window.__whalesRequire) return window.__whalesRequire(spec);
    throw new Error("\u6C99\u7BB1\uFF1A\u6CA1\u6709\u8FD0\u884C\u65F6\uFF0C\u65E0\u6CD5\u52A0\u8F7D\u6A21\u5757 " + spec);
  }

  function defineCommonJs(code, name) {
    var module = { exports: {} };
    var fn = new Function("module", "exports", "require", code + "\\n//# sourceURL=whales-design/" + String(name || "module") + ".js");
    fn(module, module.exports, makeRequire);
    return module.exports;
  }

  function exportOf(moduleExports, name) {
    // \u5FC5\u987B\u662F\u51FD\u6570\uFF08\u7EC4\u4EF6\uFF09\u2014\u2014\u62FF\u5230 React \u5143\u7D20\u5BF9\u8C61\u4F1A\u5728 createElement \u65F6\u62A5 React #31
    const candidates = [
      moduleExports && moduleExports.default,
      moduleExports && moduleExports[name],
      moduleExports
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "function") return candidate;
      // forwardRef / memo \u7ED3\u679C\u662F\u5BF9\u8C61\u4F46\u5E26 $$typeof\uFF0C\u4E5F\u662F\u5408\u6CD5\u7EC4\u4EF6\u7C7B\u578B
      if (candidate && typeof candidate === "object" && candidate.$$typeof) return candidate;
    }
    return null;
  }

  // \u2500\u2500 \u7EC4\u4EF6\u5305\uFF1ACommonJS\uFF0C\u5BFC\u51FA { components, raw, rootClass(-ish) } \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  function installPack(code) {
    var exported = defineCommonJs(code, "pack");
    state.pack = exported;
    // \u5305\u7684\u5F62\u72B6\u4E24\u79CD\u90FD\u89C1\u5F97\u5230\uFF1Amodule.exports = { components, raw }\uFF08\u5185\u7F6E/\u672C\u5730 esbuild \u4EA7\u7269\uFF09\uFF0C
    // \u6216 esbuild \u52A0\u4E86 __esModule \u540E\u7684 { default: {\u2026}, \u2026 }\u3002**\u5148\u8BA4\u81EA\u5DF1\u8EAB\u4E0A\u7684 raw**\uFF0C\u518D\u9000\u56DE default\u3002
    var ns = exported;
    if (!(ns && ns.raw) && exported && exported.default && typeof exported.default === "object") {
      ns = Object.assign({}, exported.default, exported);
    }
    var rawNs = ns && ns.raw ? ns.raw : null;
    if (rawNs) {
      // \u644A\u5E73\u6210\u666E\u901A\u5BF9\u8C61\uFF1Asucrase \u7684 import { X } from "@cds" \u4F1A\u8D70 _interopRequireDefault\uFF0C
      // \u6CA1\u6709 __esModule \u5C31\u88AB\u5305\u6210 {default: obj}\uFF0C_cds.X \u53D6\u4E0D\u5230\u3002
      var table = {};
      Object.keys(rawNs).forEach(function (key) { table[key] = rawNs[key]; });
      table.__esModule = true;
      table.default = table;
      state.packTable = table;
    }
    return { rawCount: rawNs ? Object.keys(rawNs).length : 0 };
  }

  // \u2500\u2500 \u6E32\u67D3 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  function ensureComponent(entry) {
    // entry: { name, code }  \u2014\u2014 \u7F16\u8BD1\u4EA7\u7269\u5DF2\u7ECF\u662F CommonJS \u5F62\u6001
    // \u7F13\u5B58\u8981\u6309\u300C\u540D\u5B57 + \u4EE3\u7801\u300D\u5224\uFF08P2 \u5BA1\u8BA1 I3\uFF09\uFF1A\u53EA\u6309\u540D\u5B57\u5224\u4F1A\u8BA9\u7F16\u8F91\u5668\u91CC\u6539\u5B8C\u6E90\u7801\u540E\u4ECD\u7136\u6E32\u67D3\u65E7\u7EC4\u4EF6\u3002
    // \u4EE3\u7801\u53D8\u4E86\u5C31\u91CD\u65B0\u6C42\u503C\uFF08\u540C\u4E00\u4E2A\u540D\u5B57\u7684\u65B0\u65E7\u4E24\u4EFD\u4E0D\u4F1A\u4E92\u76F8\u6C61\u67D3\uFF0C\u65E7\u7684\u81EA\u7136\u88AB\u66FF\u6362\uFF09\u3002
    var cached = state.components[entry.name];
    if (cached && cached.code === entry.code) return cached.component;
    var exported = defineCommonJs(entry.code, entry.name);
    var component = exportOf(exported, entry.name);
    if (component === null) throw new Error("\u7EC4\u4EF6 " + entry.name + " \u6CA1\u6709 export default \u4E00\u4E2A React \u7EC4\u4EF6");
    state.components[entry.name] = {
      component: component,
      code: entry.code,
      projectCss: typeof exported.__whalesProjectCss === "string" ? exported.__whalesProjectCss : "",
      css: typeof exported.css === "string" ? exported.css : ""
    };
    if (exported && exported.jsxTable) state.jsxTable = state.jsxTable || {};
    return component;
  }

  // \u9519\u8BEF\u8FB9\u754C\uFF1A\u6E32\u67D3\u51FA\u9519\u663E\u793A\u7EA2\u6846\uFF0C\u4E0D\u767D\u5C4F
  function ErrorBox(props) {
    var React = window.__whalesRuntime.React;
    var bound = React.createElement("div", { className: "wds-error" }, props.message);
    return bound;
  }

  function renderInto(container, Component, props, label) {
    var runtime = window.__whalesRuntime;
    var React = runtime.React;
    var previous = state.mounts[label];
    if (previous) { previous.root.unmount(); delete state.mounts[label]; }
    var host = document.createElement("div");
    container.innerHTML = "";
    container.appendChild(host);
    var failed = null;
    // \u9519\u8BEF\u8FB9\u754C\uFF1A\u5FC5\u987B\u662F**\u7EC4\u4EF6\u7C7B\u578B**\uFF08\u51FD\u6570\uFF09\uFF0C\u4E0D\u80FD\u628A\u5DF2\u521B\u5EFA\u7684\u5143\u7D20\u5F53\u7C7B\u578B\u4F20\u2014\u2014
    // \u90A3\u6837\u4F1A\u76F4\u63A5\u629B React error #31\uFF08objects are not valid as a React child\uFF09\u3002
    // \u7528\u7C7B\u7EC4\u4EF6\u5199\u8FB9\u754C\uFF0Cchildren \u8D70 props\uFF08element \u53EA\u4F5C\u4E3A children \u53C2\u4E0E\u6E32\u67D3\uFF0C\u6C38\u8FDC\u4E0D\u5F53\u7C7B\u578B\uFF09\u3002
    var Class = React.Component;
    function Boundary(p) { Class.call(this, p); this.state = { err: null }; }
    Boundary.prototype = Object.create(Class.prototype);
    Boundary.prototype.constructor = Boundary;
    Boundary.getDerivedStateFromError = function (error) { failed = error; return { err: error }; };
    Boundary.prototype.render = function () {
      if (this.state.err) return React.createElement("div", { className: "wds-error" }, "\u6E32\u67D3\u51FA\u9519\uFF1A" + String(this.state.err && this.state.err.message || this.state.err));
      return this.props.children;
    };
    var element = null;
    try {
      element = React.createElement(Component, props || {});
    } catch (error) {
      failed = error;
    }
    try {
      var root = runtime.createRoot(host);
      var renderElement = failed
        ? React.createElement("div", { className: "wds-error" }, "\u6E32\u67D3\u51FA\u9519\uFF1A" + String(failed && failed.message || failed))
        : React.createElement(Boundary, null, element);
      if (runtime.ReactDOM && typeof runtime.ReactDOM.flushSync === "function") {
        runtime.ReactDOM.flushSync(function () { root.render(renderElement); });
      } else root.render(renderElement);
      state.mounts[label] = { root: root, host: host };
    } catch (error) {
      failed = error;
      container.innerHTML = "";
      var box = document.createElement("div");
      box.className = "wds-error";
      box.textContent = "\u6E32\u67D3\u51FA\u9519\uFF1A" + String(error && error.message || error);
      container.appendChild(box);
    }
    return { failed: failed };
  }

  function collectDomSummary(container) {
    var text = (container.textContent || "").replace(/\\s+/g, " ").trim();
    var el = container.querySelector("*");
    var box = el ? el.getBoundingClientRect() : { width: 0, height: 0 };
    var tags = {};
    var all = container.querySelectorAll("*");
    for (var i = 0; i < all.length; i += 1) {
      var key = all[i].tagName.toLowerCase();
      tags[key] = (tags[key] || 0) + 1;
    }
    var sources = container.querySelectorAll("[data-wsrc]");
    var wsrcSeen = [];
    for (var j = 0; j < sources.length && wsrcSeen.length < 60; j += 1) wsrcSeen.push(sources[j].getAttribute("data-wsrc"));
    return {
      textLength: text.length,
      textSample: text.slice(0, 240),
      nodeCount: all.length,
      tags: tags,
      width: Math.round(box.width || 0),
      height: Math.round(box.height || 0),
      scrollHeight: Math.round(container.scrollHeight || 0),
      empty: text.length === 0,
      wsrcCount: sources.length,
      wsrc: wsrcSeen,
      buttons: container.querySelectorAll("button").length,
      inputs: container.querySelectorAll("input,textarea,select").length,
      tables: container.querySelectorAll("table").length
    };
  }

  var sizeObserver = null;
  function observeSize(container, runId) {
    if (sizeObserver) sizeObserver.disconnect();
    if (typeof ResizeObserver === "undefined") return;
    var lastHeight = 0;
    sizeObserver = new ResizeObserver(function () {
      var host = container.firstElementChild;
      if (!host) return;
      var height = Math.ceil(Math.max(host.scrollHeight, host.getBoundingClientRect().height));
      if (height > 0 && height !== lastHeight) {
        lastHeight = height;
        report({ type: "resize", runId: runId, height: height });
      }
    });
    sizeObserver.observe(container.firstElementChild || container);
  }

  function doRender(msg) {
    var started = performance.now();
    try {
      if (!window.__whalesRuntime) throw new Error("\u8FD0\u884C\u65F6\u8FD8\u6CA1\u5C31\u7EEA\uFF08\u7F3A init\uFF09");
      if (msg.packChanged && msg.packCode) installPack(msg.packCode);
      if (Array.isArray(msg.dependencies)) msg.dependencies.forEach(function (dep) { ensureComponent(dep); });
      var Component = ensureComponent({ name: msg.name, code: msg.code });
      var styles = document.getElementById("whales-design-module-styles");
      if (!styles) {
        styles = document.createElement("style");
        styles.id = "whales-design-module-styles";
        document.head.appendChild(styles);
      }
      var entries = (msg.dependencies || []).map(function (dep) { return state.components[dep.name]; });
      entries.push(state.components[msg.name]);
      var projectStyles = entries.map(function (entry) { return entry.projectCss; }).filter(Boolean);
      var ownStyles = entries.map(function (entry) { return entry.css; }).filter(Boolean);
      styles.textContent = Array.from(new Set(projectStyles)).concat(ownStyles).join("\\n");
      var slot = msg.mountId && msg.mountId !== "main" ? null : rootEl;
      if (msg.mountId && msg.mountId !== "main") {
        var mountHost = document.getElementById(msg.mountId) || (function () {
          var el = document.createElement("div");
          el.id = msg.mountId;
          document.body.appendChild(el);
          return el;
        })();
        slot = mountHost;
      }
      // \u753B\u677F\u7EA6\u5B9A Board({ navigate })\uFF08\u8BBE\u8BA1\u65B9\u6848 \xA76.2\uFF09\uFF1A\u6CE8\u5165 navigate \u540E\uFF0C\u6C99\u7BB1\u91CC\u70B9\u300C\u4E0B\u4E00\u6B65\u300D\u5C31\u53D1 navigate \u6D88\u606F\u8BA9\u7236\u9875\u9762\u5207\u9884\u89C8\u3002
      var props = msg.props || {};
      if (msg.isBoard) {
        props = Object.assign({}, props, {
          navigate: function (target) {
            report({ type: "navigate", runId: msg.runId, to: String(target || "").slice(0, 40) });
          }
        });
      }
      var result = renderInto(slot, Component, props, msg.mountId || "main");
      observeSize(slot, msg.runId);
      // React \u5DF2 flushSync \u63D0\u4EA4\u3002\u79BB\u5C4F iframe \u7684 rAF \u53EF\u80FD\u88AB\u6682\u505C\uFF0C\u8BA1\u65F6\u5668\u515C\u5E95\uFF0C\u4E14\u53EA\u56DE\u62A5\u4E00\u6B21\u3002
      var reported = false;
      var reportTimer = setTimeout(finishRender, 100);
      var reportNonce = nonce;
      var frameId = 0;
      function finishRender() {
          if (reported || nonce !== reportNonce) return;
          reported = true;
          clearTimeout(reportTimer);
          cancelAnimationFrame(frameId);
          var summary = collectDomSummary(slot);
          report(Object.assign({
            type: "rendered",
            runId: msg.runId,
            mountId: msg.mountId || "main",
            ok: !result.failed && !summary.empty,
            ms: Math.round(performance.now() - started),
            error: result.failed ? String(result.failed && result.failed.message || result.failed) : "",
            consoleErrors: state.consoleErrors.slice(-8)
          }, summary));
      }
      frameId = requestAnimationFrame(function () { frameId = requestAnimationFrame(finishRender); });
    } catch (error) {
      report({
        type: "rendered",
        runId: msg.runId,
        mountId: msg.mountId || "main",
        ok: false,
        ms: Math.round(performance.now() - started),
        error: String(error && error.message || error),
        stack: String(error && error.stack || "").slice(0, 600),
        consoleErrors: state.consoleErrors.slice(-8)
      });
    }
  }

  // \u2500\u2500 \u70B9\u9009\uFF08\u8BC4\u8BBA\u9489 / P3 \u76F4\u63A5\u6539\uFF09\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  //
  // \u4E24\u7EA7\u5B9A\u4F4D\uFF08P0 \u5BA1\u8BA1\u7ED3\u8BBA\uFF09\uFF1Adata-wsrc \u53EA\u6CE8\u5165\u5230**\u539F\u751F DOM \u5143\u7D20**\u4E0A\uFF1B\u5927\u5199\u7EC4\u4EF6\u7684 DOM
  // \u7531\u7EC4\u4EF6\u81EA\u5DF1\u4EA7\u51FA\uFF08CDS \u91CC 274/282 \u4E2A\u7EC4\u4EF6\u4E0D ...props \u900F\u4F20\uFF09\uFF0C\u6240\u4EE5\u70B9\u5230\u4E00\u4E2A\u6CA1\u6709 data-wsrc \u7684
  // \u8282\u70B9\u65F6\uFF0C\u8981**\u5411\u4E0A\u627E\u6700\u8FD1\u7684\u5E26 data-wsrc \u7684\u7956\u5148**\uFF0C\u518D\u7528\u300C\u7956\u5148\u5185\u7684 DOM \u8DEF\u5F84 + \u7956\u5148\u7684 tag \u5E8F\u5217\u300D
  // \u8BA9\u7236\u9875\u9762\u7528\u9759\u6001\u8868\u53CD\u63A8\u3002\u7236\u9875\u9762\u62FF\u4E0D\u5230 DOM\uFF0C\u6240\u4EE5\u8FD9\u91CC\u628A\u8DEF\u5F84\u672C\u8EAB\u7B97\u597D\u4F20\u51FA\u53BB\u3002
  function domPathOf(el, root) {
    var path = [];
    var node = el;
    while (node && node !== root) {
      var parent = node.parentElement;
      if (!parent) break;
      var index = 0;
      for (var i = 0; i < parent.children.length; i += 1) {
        if (parent.children[i] === node) { index = i; break; }
        index = i + 1;
      }
      path.unshift({ tag: node.tagName.toLowerCase(), index: index });
      node = parent;
    }
    return path;
  }

  function pickOf(target) {
    var el = target;
    var anchor = null;
    while (el && el !== document.body) {
      if (el.getAttribute && el.getAttribute("data-wsrc")) { anchor = el; break; }
      el = el.parentElement;
    }
    if (!anchor) {
      // \u5B8C\u5168\u6CA1\u6709 data-wsrc\uFF08\u6574\u4E2A\u6811\u90FD\u662F\u7EC4\u4EF6\u4EA7\u51FA\u7684\uFF09\uFF1A\u53EA\u80FD\u7ED9\u300C\u70B9\u51FB\u4F4D\u7F6E\u5728\u9875\u9762\u91CC\u7684\u5C42\u7EA7\u8DEF\u5F84\u300D\uFF0C
      // \u7236\u9875\u9762\u65E0\u6CD5\u636E\u6B64\u5B9A\u4F4D\u6E90\u7801\uFF0C\u5982\u5B9E\u56DE\u62A5\u300C\u8FD9\u9897\u5B50\u6811\u6CA1\u6709\u6E90\u7801\u951A\u70B9\u300D\u3002
      return {
        wsrc: "",
        anchored: false,
        tag: target && target.tagName ? target.tagName.toLowerCase() : "",
        text: target ? String(target.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120) : "",
        hint: "\u8FD9\u4E2A\u4F4D\u7F6E\u6240\u5728\u7684\u7EC4\u4EF6\u6CA1\u6709\u7ED9 DOM \u6253\u6E90\u7801\u951A\u70B9\uFF08\u7EC4\u4EF6\u5185\u90E8\u7ED3\u6784\uFF09\uFF0C\u53EA\u80FD\u6309\u300C\u6574\u5757\u300D\u63D0\u8BC4\u8BBA"
      };
    }
    var same = document.querySelectorAll('[data-wsrc="' + anchor.getAttribute("data-wsrc") + '"]');
    var nth = 0;
    for (var i = 0; i < same.length; i += 1) { if (same[i] === anchor) { nth = i; break; } }
    var box = anchor.getBoundingClientRect();
    // \u4ECE\u951A\u70B9\u5F80\u4E0B\u5230\u70B9\u51FB\u5904\u7684\u8DEF\u5F84\uFF1A\u7236\u9875\u9762\u7528\u5B83 + \u9759\u6001\u8868\u5224\u65AD\u70B9\u7684\u662F\u951A\u70B9\u672C\u8EAB\u8FD8\u662F\u5B83\u5185\u90E8\u67D0\u5C42
    var inner = target && target !== anchor ? domPathOf(target, anchor) : [];
    return {
      wsrc: anchor.getAttribute("data-wsrc"),
      anchored: true,
      tag: anchor.tagName.toLowerCase(),
      // \u70B9\u7684\u662F\u951A\u70B9\u5185\u90E8\u66F4\u6DF1\u7684\u4E00\u5C42\u65F6\uFF0C\u628A\u5185\u5C42\u8DEF\u5F84\u4E5F\u5E26\u4E0A\uFF08tag \u5E8F\u5217\u53EF\u7528\u4E8E\u300C\u7EC4\u4EF6\u7EA7\u300D\u5B9A\u4F4D\uFF09
      innerPath: inner,
      clickedTag: target && target.tagName ? target.tagName.toLowerCase() : "",
      nth: nth,
      count: same.length,
      text: (anchor.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120),
      rect: { x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) }
    };
  }

  function setPickMode(on) {
    state.pickMode = Boolean(on);
    document.body.classList.toggle("wds-pick", state.pickMode);
    if (!state.pickMode && state.pickTarget) {
      state.pickTarget.classList.remove("wds-pick-hover");
      state.pickTarget = null;
    }
  }

  document.addEventListener("mousemove", function (event) {
    if (!state.pickMode) return;
    var found = null;
    var node = event.target;
    while (node && node !== document.body) {
      if (node.getAttribute && node.getAttribute("data-wsrc")) { found = node; break; }
      node = node.parentElement;
    }
    if (found !== state.pickTarget) {
      if (state.pickTarget) state.pickTarget.classList.remove("wds-pick-hover");
      state.pickTarget = found;
      if (found) found.classList.add("wds-pick-hover");
    }
  }, true);

  document.addEventListener("click", function (event) {
    if (!state.pickMode) return;
    var hit = pickOf(event.target);
    if (!hit) return;
    event.preventDefault();
    event.stopPropagation();
    report({ type: "pick", runId: state.currentRunId, pick: hit });
  }, true);

  // \u2500\u2500 \u6D88\u606F\u5206\u53D1 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  window.addEventListener("message", function (event) {
    var data = event.data || {};
    if (data.type === "init") nonce = String(data.nonce || "");
    if (data.type === "render" || data.type === "renderBatch") nonce = String(data.nonce || "");
    if (data.type === "pick-mode" || data.type === "measure") nonce = String(data.nonce || "");
    try {
      if (data.type === "init") {
        var t0 = performance.now();
        if (data.runtime) new Function(data.runtime + "\\n//# sourceURL=whales-design/runtime.js")();
        var runtimeMs = Math.round(performance.now() - t0);
        if (data.styles) {
          var style = document.createElement("style");
          style.id = "whales-design-styles";
          style.textContent = String(data.styles);
          document.head.appendChild(style);
        }
        if (data.extraCss) {
          var extra = document.createElement("style");
          extra.id = "whales-design-extra";
          extra.textContent = String(data.extraCss);
          document.head.appendChild(extra);
        }
        var packInfo = data.packCode ? installPack(data.packCode) : { rawCount: 0 };
        report({
          type: "ready",
          info: {
            runtimeMs: runtimeMs,
            packMs: 0,
            rawCount: packInfo.rawCount,
            hasRuntime: Boolean(window.__whalesRuntime),
            jsxRuntimeOk: Boolean(window.__whalesRequire && typeof window.__whalesRequire("react/jsx-runtime").jsx === "function"),
            stylesApplied: Boolean(document.getElementById("whales-design-styles")),
            security: securityProbe()
          }
        });
        return;
      }
      if (data.type === "render") { state.currentRunId = data.runId; doRender(data); return; }
      if (data.type === "pick-mode") { setPickMode(data.enabled); report({ type: "pick-mode-ack", enabled: Boolean(data.enabled) }); return; }
      if (data.type === "measure") {
        var mount = state.mounts[data.mountId || "main"];
        var container = mount ? mount.host : rootEl;
        report({ type: "measured", runId: data.runId, mountId: data.mountId || "main", summary: collectDomSummary(container) });
        return;
      }
      if (data.type === "mounted") { return; }
    } catch (error) {
      report({ type: "error", phase: data.type, message: String(error && error.message || error), stack: String(error && error.stack || "").slice(0, 400) });
    }
  });

  function securityProbe() {
    var probe = {};
    try { probe.parentIsSelf = window.parent === window; } catch (error) { probe.parentIsSelf = "blocked"; }
    try { probe.parentTokenReadable = typeof parentWin.__whalesToken !== "undefined"; } catch (error) { probe.parentTokenReadable = "blocked"; }
    try { probe.parentDocReadable = Boolean(parentWin.document); } catch (error) { probe.parentDocReadable = "blocked"; }
    try { probe.parentStorageReadable = Boolean(parentWin.localStorage); } catch (error) { probe.parentStorageReadable = "blocked"; }
    return probe;
  }

  parentWin.postMessage({ type: "booted", bootId: document.querySelector('meta[name="whales-boot-id"]').content }, "*");
})();
<\/script>
</body></html>`;return e!==""?e:'<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>'};function ve(e){typeof e=="function"&&(ee=e)}function te({name:e,code:t,dependencies:o,props:a,title:n}){let i=F(null),[c,l]=C({status:"loading",error:"",height:160});return T(()=>{let p=i.current;if(!p)return;let u=!0,h="island-"+Math.random().toString(16).slice(2)+"-"+Date.now(),f=g=>{if(g.origin!=="null")return;let m=g.data||{};if(m.type==="ready"){if(m.nonce!==h)return;p.contentWindow.postMessage({type:"render",nonce:h,runId:"island",name:e,code:t||"",props:a||{},dependencies:o||[]},"*");return}if(m.nonce===h){if(m.type==="rendered"){if(!u)return;l({status:m.ok?"ok":"error",error:m.error||"",height:Math.max(80,Math.min(1200,(m.height||0)+8))});return}m.type==="error"&&u&&l({status:"error",error:String(m.message||"")})}};window.addEventListener("message",f);let x=!1;return(async()=>{try{let g=await fetch("/agent-whales/api/design/runtime.js"),m=g.ok?await g.text():"";if(x||!u)return;p.contentWindow.postMessage({type:"init",nonce:h,runtime:m,packCode:"",styles:""},"*")}catch(g){u&&l({status:"error",error:String(g&&g.message||g)})}})(),()=>{x=!0,u=!1,window.removeEventListener("message",f)}},[e,t,a]),(0,s.jsxs)("div",{style:{position:"relative",width:"100%",minHeight:120},children:[(0,s.jsx)("iframe",{ref:i,title:n||e,sandbox:"allow-scripts",srcDoc:ee({title:n||e}),style:{width:"100%",height:c.height,border:"0",display:"block"}}),c.status==="error"?(0,s.jsx)("div",{style:{position:"absolute",inset:"auto 0 0 0",background:"#fef2f2",color:"#991b1b",border:"1px solid #dc2626",borderRadius:6,padding:"4px 6px",fontSize:11}},"\u9879\u76EE\u7EC4\u4EF6\u6E32\u67D3\u51FA\u9519\uFF1A"+String(c.error).slice(0,200)):null]})}function H(e,t){let o={};for(let a of v){let n=B[a],i={};for(let l of Object.keys(n.fields)){let p=n.fields[l];i[l]=p.type==="select"||p.type==="radio"?{type:p.type,label:l,options:p.options.map(u=>({label:u,value:u}))}:{type:p.type,label:l}}let c=e&&e.components&&typeof e.components[a]=="function"?e.components[a]:Z(a);o[a]={label:n.label+" \xB7 "+a,fields:i,defaultProps:n.defaults,render:l=>(0,s.jsx)(c,l)}}if(t&&typeof t=="object"){let a=0;for(let n of Object.keys(t)){let i=t[n]||{},c=i.propsSchema&&typeof i.propsSchema=="object"?i.propsSchema:{},l={};for(let h of Object.keys(c)){let f=c[h]||{};if(f.type==="select"||f.type==="radio"){let x=Array.isArray(f.options)?f.options:[];l[h]={type:f.type,label:f.label||h,options:x.map(g=>({label:g,value:g}))}}else l[h]={type:f.type==="slot"?"slot":f.type||"text",label:f.label||h}}let p=Array.isArray(i.examples)&&i.examples.length>0&&i.examples[0]&&typeof i.examples[0]=="object"?i.examples[0]:{},u=a<D;u&&(a+=1),o["project:"+n]={label:"\u9879\u76EE \xB7 "+(i.title||n),fields:l,defaultProps:p,render:u?h=>(0,s.jsx)(te,{name:n,title:i.title,code:i.compiled,dependencies:i.dependencies,props:h}):ye(n,"\u8D85\u51FA\u5355\u5E27 "+D+" \u4E2A\u6C99\u7BB1\u5C9B\u7684\u4E0A\u9650")}}}return{components:o,root:{render:({children:a})=>(0,s.jsx)("div",{className:e&&e.rootClass||"",style:e&&e.rootClass?void 0:{padding:20,display:"flex",flexDirection:"column",gap:16},children:a})}}}function re(e,t,o){if(!e||!o||e.getElementById(t))return;let a=e.createElement("style");a.id=t,a.textContent=o,(e.head||e.documentElement).appendChild(a)}function oe(e,t,o){return(Array.isArray(t)?t:[]).map((a,n)=>{if(!a||typeof a.type!="string")return null;let i=e.components[a.type],c=a.props&&a.props.id||o+"-"+n;if(!i)return(0,s.jsx)(Z(a.type),{},c);let l=Object.assign({},i.defaultProps||{},a.props||{});for(let p of Object.keys(i.fields||{})){if(i.fields[p].type!=="slot")continue;let u=Array.isArray(l[p])?l[p]:[];l[p]=function(){return(0,s.jsx)(y.Fragment,{children:oe(e,u,c+"-"+p)})}}return(0,s.jsx)(y.Fragment,{children:i.render(l)},c)})}function ae({config:e,data:t}){let o=oe(e,t&&t.content,"c");return(e.root&&typeof e.root.render=="function"?e.root.render:({children:n})=>(0,s.jsx)("div",{children:n}))({children:o})}var P={mobile:390,desktop:1024};function ne({pack:e,data:t,width:o,scale:a,maxHeight:n,projectComponents:i}){let c=F(null),[l,p]=C(null),[u,h]=C(240),f=I(()=>H(e,i),[e,i]),x=P[o]||P.desktop;T(()=>{let m=c.current;if(!m)return;let w=m.contentDocument;if(!w)return;w.open(),w.write('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>'),w.close(),re(w,"whales-pack-css",e&&e.css),p(w.body);let z=typeof ResizeObserver=="function"?new ResizeObserver(()=>h(Math.max(120,w.body.scrollHeight))):null;return z&&z.observe(w.body),()=>{z&&z.disconnect()}},[e&&e.id]);let g=Math.min(n||640,Math.ceil(u*a));return(0,s.jsxs)("div",{className:"nodrag nowheel",style:{position:"relative",width:Math.ceil(x*a),height:g,overflow:"hidden",background:"#fff"},children:[(0,s.jsx)("iframe",{ref:c,title:"prototype",style:{border:0,width:x,height:u,transform:"scale("+a+")",transformOrigin:"0 0",pointerEvents:"none",display:"block"}}),l?L.createPortal((0,s.jsx)(ae,{config:f,data:t}),l):null]})}var b={card:{background:"var(--daw-surface, #fff)",border:"1px solid var(--daw-border, #dce2ee)",borderRadius:12,boxShadow:"0 6px 18px rgba(0,0,0,.06)",overflow:"hidden"},head:{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",borderBottom:"1px solid var(--daw-border, #dce2ee)",fontSize:12,cursor:"grab",whiteSpace:"nowrap"},tag:{fontSize:10,padding:"2px 6px",borderRadius:999,background:"var(--daw-accent-bg, #f9effa)",color:"var(--daw-accent, #c05bd0)",fontWeight:600},btn:{fontSize:11,padding:"3px 8px",borderRadius:6,border:"1px solid var(--daw-border, #dce2ee)",background:"var(--daw-surface, #fff)",cursor:"pointer"},muted:{color:"var(--daw-text-muted, #8a93a6)"}};function ke(e){let t=e&&e.data||{},o=t.labels||{},{pack:a,error:n}=U(t.packMeta),i=F(null),[c,l]=C(420);T(()=>{let u=i.current;if(!u)return;function h(){u.clientWidth>0&&l(u.clientWidth)}if(h(),typeof ResizeObserver=="undefined")return;let f=new ResizeObserver(h);return f.observe(u),()=>f.disconnect()},[e==null?void 0:e.fit,a]);let p=e!=null&&e.fit?Math.min(1,c/(P[t.width]||P.desktop)):t.width==="mobile"?.62:.42;return(0,s.jsxs)("div",{className:"daw-proto-node",style:b.card,children:[(0,s.jsxs)("div",{className:"daw-proto-head",style:b.head,children:[(0,s.jsx)("span",{children:"\u25A3"}),(0,s.jsx)("b",{style:{overflow:"hidden",textOverflow:"ellipsis",maxWidth:220},children:t.title||"\u539F\u578B"}),t.ai?(0,s.jsx)("span",{style:b.tag,children:"AI"}):null,(0,s.jsx)("span",{style:Object.assign({flex:1},b.muted),children:t.packMeta&&t.packMeta.name||""}),e!=null&&e.readOnly?null:(0,s.jsx)("button",{type:"button",className:"nodrag",style:b.btn,onClick:()=>t.onEdit&&t.onEdit(),children:o.edit||"\u7F16\u8F91"})]}),a?(0,s.jsx)("div",{ref:e!=null&&e.fit?i:void 0,style:e!=null&&e.fit?{display:"grid",justifyItems:"center",minWidth:0,overflow:"hidden"}:void 0,children:(0,s.jsx)(ne,{pack:a,data:t.puck,width:t.width,scale:p,projectComponents:t.projectComponents})}):(0,s.jsx)("div",{style:Object.assign({padding:16,fontSize:12},b.muted),children:n?(o.packFailed||"\u7EC4\u4EF6\u5305\u52A0\u8F7D\u5931\u8D25\uFF1A")+n:o.loading||"\u7EC4\u4EF6\u5305\u52A0\u8F7D\u4E2D\u2026"})]})}function Ne(e){let t=e&&e.data||{},o=t.labels||{},{pack:a,error:n}=U(t.packMeta),i=a?$(a):null,c=Array.isArray(t.packs)?t.packs:[];return(0,s.jsxs)("div",{className:"daw-proto-node",style:Object.assign({width:260},b.card),children:[(0,s.jsxs)("div",{className:"daw-proto-head",style:b.head,children:[(0,s.jsx)("span",{children:"\u25EB"}),(0,s.jsx)("b",{children:o.title||"\u7EC4\u4EF6\u5E93"}),(0,s.jsx)("span",{style:Object.assign({flex:1,textAlign:"right"},b.muted),children:t.usedBy?(o.usedBy||"")+t.usedBy:""})]}),(0,s.jsxs)("div",{style:{padding:10,display:"flex",flexDirection:"column",gap:8,fontSize:12},children:[(0,s.jsx)("select",{className:"nodrag",value:t.packMeta&&t.packMeta.id||"shadcn",onChange:l=>t.onSwitch&&t.onSwitch(l.target.value),style:{padding:"4px 6px",borderRadius:6,border:"1px solid var(--daw-border, #dce2ee)"},children:c.map(l=>(0,s.jsx)("option",{value:l.id,children:l.name+(l.builtin?"":" \xB7 "+(o.local||"\u672C\u5730"))},l.id))}),i?(0,s.jsx)("div",{children:(o.coverage||"\u8986\u76D6\u8BCD\u8868")+" "+i.covered+" / "+i.total+(i.missing.length>0?"\uFF08"+(o.missing||"\u7F3A")+"\uFF1A"+i.missing.join("\u3001")+"\uFF09":"")}):null,n?(0,s.jsx)("div",{style:{color:"var(--daw-danger, #d64545)"},children:n}):null,t.packMeta&&t.packMeta.license?(0,s.jsx)("div",{style:b.muted,children:"License: "+t.packMeta.license}):null,(0,s.jsx)("div",{style:Object.assign({wordBreak:"break-all"},b.muted),children:(o.importHint||"\u5BFC\u5165\u81EA\u5DF1\u7684\u7EC4\u4EF6\u5305\uFF1A")+(t.dir||"")})]})]})}function Se({Puck:e,title:t,packMeta:o,projectComponents:a,data:n,labels:i,onSave:c,onClose:l}){let p=i||{},{pack:u,error:h}=U(o),f=a?Object.keys(a).sort().join(","):"",x=I(()=>u?H(u,a):null,[u,f]),g=I(()=>({iframe:({children:m,document:w})=>(re(w,"whales-pack-css",u&&u.css),m),headerActions:({children:m})=>(0,s.jsxs)(y.Fragment,{children:[(0,s.jsx)("button",{type:"button",onClick:l,style:b.btn,children:p.close||"\u5173\u95ED"}),m]})}),[u,l]);return(0,s.jsx)("div",{className:"daw-proto-editor",style:{position:"absolute",inset:0,zIndex:40,background:"#fff",display:"flex",flexDirection:"column"},children:x&&typeof e=="function"?(0,s.jsx)(e,{config:x,data:n||{content:[],root:{props:{}}},headerTitle:t||"\u539F\u578B",onPublish:m=>c&&c(m),overrides:g,iframe:{enabled:!0,syncHostStyles:!1,waitForStyles:!1},height:"100%"}):(0,s.jsx)("div",{style:{padding:24},children:h?(p.packFailed||"\u7EC4\u4EF6\u5305\u52A0\u8F7D\u5931\u8D25\uFF1A")+h:p.loading||"\u7EC4\u4EF6\u5305\u52A0\u8F7D\u4E2D\u2026"})})}

return module.exports;
} });
