import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
const here=dirname(fileURLToPath(import.meta.url));
const runtime=readFileSync(join(here,'../../lib/client.sandbox-runtime.js'),'utf8');
await build({entryPoints:[join(here,'src/canvas.jsx')],outfile:join(here,'media/canvas.js'),bundle:true,platform:'browser',format:'iife',target:'es2020',jsx:'automatic',nodePaths:[join(here,'../../tools/flow-chunk/node_modules')],define:{'process.env.NODE_ENV':'"production"',__RUNTIME__:JSON.stringify(runtime)},minify:true,legalComments:'none'});
