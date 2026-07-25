import { createServer } from "vite";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const arg=(name,fallback)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1]};
const host=arg("--host","127.0.0.1"), port=Number(arg("--port","3004"));
if(host!=="127.0.0.1"||!Number.isInteger(port)||port<3004) throw new Error("loopback port >=3004 required");
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const evidenceDir=resolve(root,"artifacts");
const ortDist=dirname(fileURLToPath(import.meta.resolve("onnxruntime-web")));
const headers={"Cache-Control":"no-store","Cross-Origin-Opener-Policy":"same-origin","Cross-Origin-Embedder-Policy":"require-corp"};
const support={name:"ort-assets-evidence",configureServer(server){
 server.middlewares.use("/ort/",(req,res)=>{const name=basename(new URL(req.url??"","http://x").pathname);if(!/^ort-wasm-[\w.-]+\.(wasm|mjs)$/.test(name)){res.statusCode=404;return res.end();}res.setHeader("content-type",name.endsWith("wasm")?"application/wasm":"text/javascript");createReadStream(join(ortDist,name)).on("error",()=>{res.statusCode=404;res.end();}).pipe(res);});
 server.middlewares.use("/evidence/browser",(req,res)=>{if(req.method!=="POST"){res.statusCode=405;return res.end();}let raw="";req.on("data",c=>raw+=c);req.on("end",async()=>{try{const parsed=JSON.parse(raw);if(parsed.platform!=="browser")throw new Error("bad envelope");await mkdir(evidenceDir,{recursive:true});const body=JSON.stringify(parsed,null,2)+"\n";await writeFile(join(evidenceDir,"browser.json"),body);res.setHeader("content-type","application/json");res.end(JSON.stringify({exists:true,byteLength:Buffer.byteLength(body)}));}catch(e){res.statusCode=400;res.end(String(e));}});});
}};
const server=await createServer({root,plugins:[support],resolve:{alias:{vgpu:resolve(root,"../../packages/vgpu-api/src/index.ts")}},server:{host,port,strictPort:true,headers},clearScreen:false});
await server.listen(); console.log(`READY http://${host}:${port}`);
