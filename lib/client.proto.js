/* dsh-agent-whales · client.proto.js —— 由 tools/flow-chunk/build-proto.mjs 生成，勿手改。
 * 原型帧预览 / 组件库节点 / 内置组件包。内置包按 shadcn/ui（MIT）的类名与 CSS 变量复刻外观，
 * 样式由 Tailwind CSS 3.4.19（MIT）生成。 */
window.__ModuleLoader__.load({ id: "dsh-agent-whales", chunk: "client.proto.js", factory: function (require) {
var module = { exports: {} }; var exports = module.exports;
var $=Object.create;var S=Object.defineProperty;var ee=Object.getOwnPropertyDescriptor;var te=Object.getOwnPropertyNames;var re=Object.getPrototypeOf,oe=Object.prototype.hasOwnProperty;var ae=(e,t)=>{for(var r in t)S(e,r,{get:t[r],enumerable:!0})},B=(e,t,r,a)=>{if(t&&typeof t=="object"||typeof t=="function")for(let n of te(t))!oe.call(e,n)&&n!==r&&S(e,n,{get:()=>t[n],enumerable:!(a=ee(t,n))||a.enumerable});return e};var j=(e,t,r)=>(r=e!=null?$(re(e)):{},B(t||!e||!e.__esModule?S(r,"default",{value:e,enumerable:!0}):r,e)),ne=e=>B(S({},"__esModule",{value:!0}),e);var fe={};ae(fe,{LibraryNode:()=>he,PrototypeEditor:()=>me,PrototypeFrame:()=>Z,PrototypeNode:()=>ue,PuckData:()=>Q,VOCAB_NAMES:()=>le,buildPuckConfig:()=>T,loadPack:()=>q,packCoverage:()=>G});module.exports=ne(fe);var f=j(require("react"),1),E=j(require("react-dom"),1),se=j(require("react/jsx-runtime"),1),s=require("react/jsx-runtime");var R={Heading:{label:"\u6807\u9898",fields:{text:{type:"text"},level:{type:"select",options:["1","2","3"]}},defaults:{text:"\u9875\u9762\u6807\u9898",level:"2"}},Text:{label:"\u6BB5\u843D",fields:{text:{type:"textarea"},tone:{type:"select",options:["default","muted"]}},defaults:{text:"\u4E00\u6BB5\u8BF4\u660E\u6587\u5B57",tone:"default"}},Button:{label:"\u6309\u94AE",fields:{label:{type:"text"},variant:{type:"select",options:["primary","secondary","outline","ghost","destructive"]}},defaults:{label:"\u786E\u5B9A",variant:"primary"}},Input:{label:"\u8F93\u5165\u6846",fields:{label:{type:"text"},placeholder:{type:"text"}},defaults:{label:"\u540D\u79F0",placeholder:"\u8BF7\u8F93\u5165"}},Textarea:{label:"\u591A\u884C\u8F93\u5165",fields:{label:{type:"text"},placeholder:{type:"text"}},defaults:{label:"\u5907\u6CE8",placeholder:"\u8BF7\u8F93\u5165"}},Select:{label:"\u4E0B\u62C9\u9009\u62E9",fields:{label:{type:"text"},options:{type:"text"}},defaults:{label:"\u7C7B\u578B",options:"\u9009\u9879\u4E00,\u9009\u9879\u4E8C"}},Checkbox:{label:"\u590D\u9009\u6846",fields:{label:{type:"text"},checked:{type:"radio",options:["true","false"]}},defaults:{label:"\u6211\u5DF2\u9605\u8BFB",checked:"false"}},Switch:{label:"\u5F00\u5173",fields:{label:{type:"text"},checked:{type:"radio",options:["true","false"]}},defaults:{label:"\u542F\u7528",checked:"true"}},Badge:{label:"\u6807\u7B7E",fields:{text:{type:"text"},variant:{type:"select",options:["default","secondary","outline","destructive"]}},defaults:{text:"\u8FDB\u884C\u4E2D",variant:"default"}},Alert:{label:"\u63D0\u793A\u6761",fields:{title:{type:"text"},description:{type:"text"},variant:{type:"select",options:["info","success","warning","error"]}},defaults:{title:"\u63D0\u793A",description:"\u8FD9\u91CC\u662F\u63D0\u793A\u5185\u5BB9",variant:"info"}},Upload:{label:"\u4E0A\u4F20\u533A",fields:{label:{type:"text"},hint:{type:"text"}},defaults:{label:"\u4E0A\u4F20\u6587\u4EF6",hint:"\u652F\u6301 .xlsx / .json\uFF0C\u62D6\u5230\u8FD9\u91CC\u6216\u70B9\u51FB\u9009\u62E9"}},Table:{label:"\u8868\u683C",fields:{columns:{type:"text"},rows:{type:"number"}},defaults:{columns:"\u540D\u79F0,\u72B6\u6001,\u66F4\u65B0\u65F6\u95F4",rows:3}},Tabs:{label:"\u9875\u7B7E",fields:{tabs:{type:"text"},active:{type:"number"}},defaults:{tabs:"\u5168\u90E8,\u8FDB\u884C\u4E2D,\u5DF2\u5B8C\u6210",active:0}},Stat:{label:"\u6307\u6807\u5361",fields:{label:{type:"text"},value:{type:"text"}},defaults:{label:"\u4ECA\u65E5\u65B0\u589E",value:"128"}},Navbar:{label:"\u9876\u680F",fields:{brand:{type:"text"},links:{type:"text"}},defaults:{brand:"\u4EA7\u54C1\u540D",links:"\u9996\u9875,\u5217\u8868,\u8BBE\u7F6E"}},Sidebar:{label:"\u4FA7\u8FB9\u5BFC\u822A",fields:{items:{type:"text"},active:{type:"number"}},defaults:{items:"\u6982\u89C8,\u8868\u5355,\u6D41\u7A0B,\u8BBE\u7F6E",active:0}},Divider:{label:"\u5206\u9694\u7EBF",fields:{},defaults:{}},Image:{label:"\u56FE\u7247\u5360\u4F4D",fields:{alt:{type:"text"},height:{type:"number"}},defaults:{alt:"\u56FE\u7247",height:120}},Card:{label:"\u5361\u7247",fields:{title:{type:"text"},description:{type:"text"},content:{type:"slot"}},defaults:{title:"\u5361\u7247\u6807\u9898",description:"",content:[]}},Section:{label:"\u533A\u5757",fields:{title:{type:"text"},content:{type:"slot"}},defaults:{title:"",content:[]}},Columns:{label:"\u4E24\u680F",fields:{left:{type:"slot"},right:{type:"slot"}},defaults:{left:[],right:[]}},Dialog:{label:"\u5F39\u7A97",fields:{title:{type:"text"},description:{type:"text"},content:{type:"slot"},confirmLabel:{type:"text"},cancelLabel:{type:"text"}},defaults:{title:"\u5F39\u7A97\u6807\u9898",description:"",content:[],confirmLabel:"\u786E\u5B9A",cancelLabel:"\u53D6\u6D88"}}},b=Object.keys(R);var o=require("react/jsx-runtime"),p=(...e)=>e.filter(Boolean).join(" "),x=e=>String(e||"").split(/[,，]/).map(t=>t.trim()).filter(Boolean),y=e=>typeof e=="function"?(0,o.jsx)(e,{}):null,C={primary:"bg-primary text-primary-foreground shadow hover:bg-primary/90",secondary:"bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",outline:"border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",ghost:"hover:bg-accent hover:text-accent-foreground",destructive:"bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90"},I={default:"border-transparent bg-primary text-primary-foreground shadow",secondary:"border-transparent bg-secondary text-secondary-foreground",outline:"text-foreground",destructive:"border-transparent bg-destructive text-destructive-foreground shadow"},D={info:"bg-background text-foreground",success:"border-emerald-500/50 text-emerald-700 bg-emerald-50",warning:"border-amber-500/50 text-amber-800 bg-amber-50",error:"border-destructive/50 text-destructive bg-red-50"},F="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",A="text-sm font-medium leading-none",U={Heading:({text:e,level:t})=>{let r=t==="1"?"text-3xl":t==="3"?"text-lg":"text-2xl";return(0,o.jsx)("h"+(t||"2"),{className:p("font-semibold tracking-tight text-foreground",r),children:e})},Text:({text:e,tone:t})=>(0,o.jsx)("p",{className:p("text-sm leading-7",t==="muted"?"text-muted-foreground":"text-foreground"),children:e}),Button:({label:e,variant:t})=>(0,o.jsx)("button",{type:"button",className:p("inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium transition-colors",C[t]||C.primary),children:e}),Input:({label:e,placeholder:t})=>(0,o.jsxs)("div",{className:"grid w-full gap-1.5",children:[e?(0,o.jsx)("label",{className:A,children:e}):null,(0,o.jsx)("input",{className:F,placeholder:t})]}),Textarea:({label:e,placeholder:t})=>(0,o.jsxs)("div",{className:"grid w-full gap-1.5",children:[e?(0,o.jsx)("label",{className:A,children:e}):null,(0,o.jsx)("textarea",{className:p(F,"min-h-[72px] h-auto py-2"),placeholder:t})]}),Select:({label:e,options:t})=>(0,o.jsxs)("div",{className:"grid w-full gap-1.5",children:[e?(0,o.jsx)("label",{className:A,children:e}):null,(0,o.jsxs)("div",{className:"flex h-9 w-full items-center justify-between whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm",children:[(0,o.jsx)("span",{children:x(t)[0]||"\u8BF7\u9009\u62E9"}),(0,o.jsx)("span",{className:"text-muted-foreground",children:"\u25BE"})]})]}),Checkbox:({label:e,checked:t})=>(0,o.jsxs)("label",{className:"flex items-center gap-2 text-sm",children:[(0,o.jsx)("span",{className:p("flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-primary text-[10px] shadow",t==="true"?"bg-primary text-primary-foreground":""),children:t==="true"?"\u2713":""}),e]}),Switch:({label:e,checked:t})=>(0,o.jsxs)("label",{className:"flex items-center gap-2 text-sm",children:[(0,o.jsx)("span",{className:p("inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent shadow-sm",t==="true"?"bg-primary":"bg-input"),children:(0,o.jsx)("span",{className:p("block h-4 w-4 rounded-full bg-background shadow-lg transition-transform",t==="true"?"translate-x-4":"translate-x-0")})}),e]}),Badge:({text:e,variant:t})=>(0,o.jsx)("span",{className:p("inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold",I[t]||I.default),children:e}),Alert:({title:e,description:t,variant:r})=>(0,o.jsxs)("div",{role:"alert",className:p("relative w-full rounded-lg border px-4 py-3 text-sm",D[r]||D.info),children:[(0,o.jsx)("h5",{className:"mb-1 font-medium leading-none tracking-tight",children:e}),t?(0,o.jsx)("div",{className:"text-sm opacity-90",children:t}):null]}),Upload:({label:e,hint:t})=>(0,o.jsxs)("div",{className:"flex w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-input bg-muted/40 px-4 py-6 text-center",children:[(0,o.jsx)("div",{className:"text-sm font-medium",children:e}),(0,o.jsx)("div",{className:"text-xs text-muted-foreground",children:t})]}),Table:({columns:e,rows:t})=>{let r=x(e),a=Math.max(0,Math.min(20,Number(t)||0));return(0,o.jsx)("div",{className:"w-full overflow-auto rounded-md border",children:(0,o.jsxs)("table",{className:"w-full caption-bottom text-sm",children:[(0,o.jsx)("thead",{children:(0,o.jsx)("tr",{className:"border-b",children:r.map(n=>(0,o.jsx)("th",{className:"h-10 px-3 text-left align-middle font-medium text-muted-foreground",children:n},n))})}),(0,o.jsx)("tbody",{children:Array.from({length:a},(n,i)=>(0,o.jsx)("tr",{className:"border-b last:border-0",children:r.map((d,l)=>(0,o.jsx)("td",{className:"p-3 align-middle",children:l===0?d+" "+(i+1):(0,o.jsx)("span",{className:"inline-block h-2.5 w-16 rounded bg-muted"})},d))},i))})]})})},Tabs:({tabs:e,active:t})=>(0,o.jsx)("div",{className:"inline-flex h-9 items-center rounded-lg bg-muted p-1 text-muted-foreground",children:x(e).map((r,a)=>(0,o.jsx)("span",{className:p("inline-flex items-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium",a===(Number(t)||0)?"bg-background text-foreground shadow":""),children:r},r))}),Stat:({label:e,value:t})=>(0,o.jsxs)("div",{className:"rounded-xl border bg-card p-4 text-card-foreground shadow",children:[(0,o.jsx)("div",{className:"text-sm text-muted-foreground",children:e}),(0,o.jsx)("div",{className:"mt-1 text-2xl font-bold",children:t})]}),Navbar:({brand:e,links:t})=>(0,o.jsxs)("div",{className:"flex h-12 w-full items-center gap-6 border-b px-4",children:[(0,o.jsx)("span",{className:"font-semibold",children:e}),(0,o.jsx)("nav",{className:"flex gap-4 text-sm text-muted-foreground",children:x(t).map((r,a)=>(0,o.jsx)("span",{className:a===0?"text-foreground":"",children:r},r))})]}),Sidebar:({items:e,active:t})=>(0,o.jsx)("div",{className:"flex w-48 flex-col gap-1 border-r p-2",children:x(e).map((r,a)=>(0,o.jsx)("span",{className:p("rounded-md px-3 py-2 text-sm",a===(Number(t)||0)?"bg-accent font-medium text-accent-foreground":"text-muted-foreground"),children:r},r))}),Divider:()=>(0,o.jsx)("div",{className:"my-2 h-px w-full shrink-0 bg-border"}),Image:({alt:e,height:t})=>(0,o.jsx)("div",{className:"flex w-full items-center justify-center rounded-md bg-muted text-xs text-muted-foreground",style:{height:Math.max(40,Math.min(600,Number(t)||120))},children:e||"\u56FE\u7247"}),Card:({title:e,description:t,content:r})=>(0,o.jsxs)("div",{className:"rounded-xl border bg-card text-card-foreground shadow",children:[(0,o.jsxs)("div",{className:"flex flex-col space-y-1.5 p-5",children:[(0,o.jsx)("h3",{className:"font-semibold leading-none tracking-tight",children:e}),t?(0,o.jsx)("p",{className:"text-sm text-muted-foreground",children:t}):null]}),(0,o.jsx)("div",{className:"flex flex-col gap-3 p-5 pt-0",children:y(r)})]}),Section:({title:e,content:t})=>(0,o.jsxs)("section",{className:"flex w-full flex-col gap-3",children:[e?(0,o.jsx)("h3",{className:"text-base font-semibold",children:e}):null,(0,o.jsx)("div",{className:"flex flex-col gap-3",children:y(t)})]}),Columns:({left:e,right:t})=>(0,o.jsxs)("div",{className:"grid w-full grid-cols-2 gap-4",children:[(0,o.jsx)("div",{className:"flex flex-col gap-3",children:y(e)}),(0,o.jsx)("div",{className:"flex flex-col gap-3",children:y(t)})]}),Dialog:({title:e,description:t,content:r,confirmLabel:a,cancelLabel:n})=>(0,o.jsxs)("div",{className:"mx-auto grid w-full max-w-lg gap-4 rounded-lg border bg-background p-6 shadow-lg",children:[(0,o.jsxs)("div",{className:"flex flex-col space-y-1.5",children:[(0,o.jsx)("h2",{className:"text-lg font-semibold leading-none tracking-tight",children:e}),t?(0,o.jsx)("p",{className:"text-sm text-muted-foreground",children:t}):null]}),(0,o.jsx)("div",{className:"flex flex-col gap-3",children:y(r)}),(0,o.jsxs)("div",{className:"flex justify-end gap-2",children:[(0,o.jsx)("button",{type:"button",className:p("inline-flex h-9 items-center rounded-md px-4 text-sm font-medium",C.outline),children:n}),(0,o.jsx)("button",{type:"button",className:p("inline-flex h-9 items-center rounded-md px-4 text-sm font-medium",C.primary),children:a})]})]})},L="flex min-h-full flex-col gap-4 bg-background p-5 text-foreground antialiased";var _=`*, ::before, ::after {
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
.h-10 {
  height: 2.5rem;
}
.h-12 {
  height: 3rem;
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
.translate-x-4 {
  --tw-translate-x: 1rem;
  transform: translate(var(--tw-translate-x), var(--tw-translate-y)) rotate(var(--tw-rotate)) skewX(var(--tw-skew-x)) skewY(var(--tw-skew-y)) scaleX(var(--tw-scale-x)) scaleY(var(--tw-scale-y));
}
.grid-cols-2 {
  grid-template-columns: repeat(2, minmax(0, 1fr));
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
.border-r {
  border-right-width: 1px;
}
.border-dashed {
  border-style: dashed;
}
.border-amber-500\\/50 {
  border-color: rgb(245 158 11 / 0.5);
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

.hover\\:bg-primary\\/90:hover {
  background-color: hsl(var(--primary) / 0.9);
}

.hover\\:bg-secondary\\/80:hover {
  background-color: hsl(var(--secondary) / 0.8);
}

.hover\\:text-accent-foreground:hover {
  color: hsl(var(--accent-foreground));
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
`;var le=b,de="/agent-whales/api",{useEffect:V,useMemo:O,useRef:ce,useState:M}=f,X={id:"shadcn",name:"shadcn/ui\uFF08\u5185\u7F6E\uFF09",builtin:!0,components:U,css:_,rootClass:L},z=new Map([["shadcn",Promise.resolve(X)]]),H={react:f,"react-dom":E,"react/jsx-runtime":se};function pe(e,t,r){let a={exports:{}},n=l=>{if(H[l])return H[l];throw new Error("\u7EC4\u4EF6\u5305 "+e.id+" \u53EA\u80FD require react / react-dom / react/jsx-runtime\uFF0C\u51FA\u73B0\u4E86 "+l)};new Function("module","exports","require",t)(a,a.exports,n);let i=a.exports&&a.exports.default?a.exports.default:a.exports;typeof i=="function"&&(i=i(f));let d=i&&i.components?i.components:i;if(!d||typeof d!="object")throw new Error("\u7EC4\u4EF6\u5305 "+e.id+" \u6CA1\u6709\u5BFC\u51FA\u7EC4\u4EF6\u8868");return{id:e.id,name:e.name||e.id,builtin:!1,components:d,css:r||"",rootClass:i&&i.rootClass||e.rootClass||""}}function q(e){let t=e&&typeof e.id=="string"?e.id:"shadcn";if(z.has(t))return z.get(t);let r=de+"/component-packs/"+encodeURIComponent(t),a=Promise.all([fetch(r+"/bundle.js").then(n=>{if(!n.ok)throw new Error("bundle.js "+n.status);return n.text()}),fetch(r+"/styles.css").then(n=>n.ok?n.text():"",()=>"")]).then(([n,i])=>pe(e,n,i));return a.catch(()=>z.delete(t)),z.set(t,a),a}function P(e){let t=e&&e.id?e.id:"shadcn",[r,a]=M(()=>t==="shadcn"?{pack:X,error:""}:{pack:null,error:""});return V(()=>{let n=!0;return q(e||{id:t}).then(i=>{n&&a({pack:i,error:""})},i=>{n&&a({pack:null,error:String(i&&i.message||i)})}),()=>{n=!1}},[t]),r}function W(e){return function(){return(0,s.jsx)("div",{style:{border:"1px dashed #c4c4c4",borderRadius:6,padding:"8px 10px",fontSize:12,color:"#888",background:"#fafafa"},children:"\uFF08\u5F53\u524D\u7EC4\u4EF6\u5305\u6CA1\u6709\u300C"+e+"\u300D\uFF09"})}}function G(e){let t=b.filter(r=>e&&e.components&&typeof e.components[r]=="function");return{covered:t.length,total:b.length,missing:b.filter(r=>t.indexOf(r)<0)}}function T(e){let t={};for(let r of b){let a=R[r],n={};for(let d of Object.keys(a.fields)){let l=a.fields[d];n[d]=l.type==="select"||l.type==="radio"?{type:l.type,label:d,options:l.options.map(c=>({label:c,value:c}))}:{type:l.type,label:d}}let i=e&&e.components&&typeof e.components[r]=="function"?e.components[r]:W(r);t[r]={label:a.label+" \xB7 "+r,fields:n,defaultProps:a.defaults,render:d=>(0,s.jsx)(i,d)}}return{components:t,root:{render:({children:r})=>(0,s.jsx)("div",{className:e&&e.rootClass||"",style:e&&e.rootClass?void 0:{padding:20,display:"flex",flexDirection:"column",gap:16},children:r})}}}function J(e,t,r){if(!e||!r||e.getElementById(t))return;let a=e.createElement("style");a.id=t,a.textContent=r,(e.head||e.documentElement).appendChild(a)}function K(e,t,r){return(Array.isArray(t)?t:[]).map((a,n)=>{if(!a||typeof a.type!="string")return null;let i=e.components[a.type],d=a.props&&a.props.id||r+"-"+n;if(!i)return(0,s.jsx)(W(a.type),{},d);let l=Object.assign({},i.defaultProps||{},a.props||{});for(let c of Object.keys(i.fields||{})){if(i.fields[c].type!=="slot")continue;let g=Array.isArray(l[c])?l[c]:[];l[c]=function(){return(0,s.jsx)(f.Fragment,{children:K(e,g,d+"-"+c)})}}return(0,s.jsx)(f.Fragment,{children:i.render(l)},d)})}function Q({config:e,data:t}){let r=K(e,t&&t.content,"c");return(e.root&&typeof e.root.render=="function"?e.root.render:({children:n})=>(0,s.jsx)("div",{children:n}))({children:r})}var Y={mobile:390,desktop:1024};function Z({pack:e,data:t,width:r,scale:a,maxHeight:n}){let i=ce(null),[d,l]=M(null),[c,g]=M(240),w=O(()=>T(e),[e]),v=Y[r]||Y.desktop;V(()=>{let k=i.current;if(!k)return;let h=k.contentDocument;if(!h)return;h.open(),h.write('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>'),h.close(),J(h,"whales-pack-css",e&&e.css),l(h.body);let N=typeof ResizeObserver=="function"?new ResizeObserver(()=>g(Math.max(120,h.body.scrollHeight))):null;return N&&N.observe(h.body),()=>{N&&N.disconnect()}},[e&&e.id]);let m=Math.min(n||640,Math.ceil(c*a));return(0,s.jsxs)("div",{className:"nodrag nowheel",style:{position:"relative",width:Math.ceil(v*a),height:m,overflow:"hidden",background:"#fff"},children:[(0,s.jsx)("iframe",{ref:i,title:"prototype",style:{border:0,width:v,height:c,transform:"scale("+a+")",transformOrigin:"0 0",pointerEvents:"none",display:"block"}}),d?E.createPortal((0,s.jsx)(Q,{config:w,data:t}),d):null]})}var u={card:{background:"var(--daw-surface, #fff)",border:"1px solid var(--daw-border, #dce2ee)",borderRadius:12,boxShadow:"0 6px 18px rgba(0,0,0,.06)",overflow:"hidden"},head:{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",borderBottom:"1px solid var(--daw-border, #dce2ee)",fontSize:12,cursor:"grab",whiteSpace:"nowrap"},tag:{fontSize:10,padding:"2px 6px",borderRadius:999,background:"var(--daw-accent-bg, #f9effa)",color:"var(--daw-accent, #c05bd0)",fontWeight:600},btn:{fontSize:11,padding:"3px 8px",borderRadius:6,border:"1px solid var(--daw-border, #dce2ee)",background:"var(--daw-surface, #fff)",cursor:"pointer"},muted:{color:"var(--daw-text-muted, #8a93a6)"}};function ue(e){let t=e&&e.data||{},r=t.labels||{},{pack:a,error:n}=P(t.packMeta),i=t.width==="mobile"?.62:.42;return(0,s.jsxs)("div",{className:"daw-proto-node",style:u.card,children:[(0,s.jsxs)("div",{className:"daw-proto-head",style:u.head,children:[(0,s.jsx)("span",{children:"\u25A3"}),(0,s.jsx)("b",{style:{overflow:"hidden",textOverflow:"ellipsis",maxWidth:220},children:t.title||"\u539F\u578B"}),t.ai?(0,s.jsx)("span",{style:u.tag,children:"AI"}):null,(0,s.jsx)("span",{style:Object.assign({flex:1},u.muted),children:t.packMeta&&t.packMeta.name||""}),(0,s.jsx)("button",{type:"button",className:"nodrag",style:u.btn,onClick:()=>t.onEdit&&t.onEdit(),children:r.edit||"\u7F16\u8F91"})]}),a?(0,s.jsx)(Z,{pack:a,data:t.puck,width:t.width,scale:i}):(0,s.jsx)("div",{style:Object.assign({padding:16,fontSize:12},u.muted),children:n?(r.packFailed||"\u7EC4\u4EF6\u5305\u52A0\u8F7D\u5931\u8D25\uFF1A")+n:r.loading||"\u7EC4\u4EF6\u5305\u52A0\u8F7D\u4E2D\u2026"})]})}function he(e){let t=e&&e.data||{},r=t.labels||{},{pack:a,error:n}=P(t.packMeta),i=a?G(a):null,d=Array.isArray(t.packs)?t.packs:[];return(0,s.jsxs)("div",{className:"daw-proto-node",style:Object.assign({width:260},u.card),children:[(0,s.jsxs)("div",{className:"daw-proto-head",style:u.head,children:[(0,s.jsx)("span",{children:"\u25EB"}),(0,s.jsx)("b",{children:r.title||"\u7EC4\u4EF6\u5E93"}),(0,s.jsx)("span",{style:Object.assign({flex:1,textAlign:"right"},u.muted),children:t.usedBy?(r.usedBy||"")+t.usedBy:""})]}),(0,s.jsxs)("div",{style:{padding:10,display:"flex",flexDirection:"column",gap:8,fontSize:12},children:[(0,s.jsx)("select",{className:"nodrag",value:t.packMeta&&t.packMeta.id||"shadcn",onChange:l=>t.onSwitch&&t.onSwitch(l.target.value),style:{padding:"4px 6px",borderRadius:6,border:"1px solid var(--daw-border, #dce2ee)"},children:d.map(l=>(0,s.jsx)("option",{value:l.id,children:l.name+(l.builtin?"":" \xB7 "+(r.local||"\u672C\u5730"))},l.id))}),i?(0,s.jsx)("div",{children:(r.coverage||"\u8986\u76D6\u8BCD\u8868")+" "+i.covered+" / "+i.total+(i.missing.length>0?"\uFF08"+(r.missing||"\u7F3A")+"\uFF1A"+i.missing.join("\u3001")+"\uFF09":"")}):null,n?(0,s.jsx)("div",{style:{color:"var(--daw-danger, #d64545)"},children:n}):null,t.packMeta&&t.packMeta.license?(0,s.jsx)("div",{style:u.muted,children:"License: "+t.packMeta.license}):null,(0,s.jsx)("div",{style:Object.assign({wordBreak:"break-all"},u.muted),children:(r.importHint||"\u5BFC\u5165\u81EA\u5DF1\u7684\u7EC4\u4EF6\u5305\uFF1A")+(t.dir||"")})]})]})}function me({Puck:e,title:t,packMeta:r,data:a,labels:n,onSave:i,onClose:d}){let l=n||{},{pack:c,error:g}=P(r),w=O(()=>c?T(c):null,[c]),v=O(()=>({iframe:({children:m,document:k})=>(J(k,"whales-pack-css",c&&c.css),m),headerActions:({children:m})=>(0,s.jsxs)(f.Fragment,{children:[(0,s.jsx)("button",{type:"button",onClick:d,style:u.btn,children:l.close||"\u5173\u95ED"}),m]})}),[c,d]);return(0,s.jsx)("div",{className:"daw-proto-editor",style:{position:"absolute",inset:0,zIndex:40,background:"#fff",display:"flex",flexDirection:"column"},children:w&&typeof e=="function"?(0,s.jsx)(e,{config:w,data:a||{content:[],root:{props:{}}},headerTitle:t||"\u539F\u578B",onPublish:m=>i&&i(m),overrides:v,iframe:{enabled:!0,syncHostStyles:!1,waitForStyles:!1},height:"100%"}):(0,s.jsx)("div",{style:{padding:24},children:g?(l.packFailed||"\u7EC4\u4EF6\u5305\u52A0\u8F7D\u5931\u8D25\uFF1A")+g:l.loading||"\u7EC4\u4EF6\u5305\u52A0\u8F7D\u4E2D\u2026"})})}

return module.exports;
} });
