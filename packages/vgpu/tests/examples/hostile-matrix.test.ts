import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { LIMITS, requestBytes } from "../../lib/examples/http.js";
import { pullExample } from "../../lib/examples/pull.js";
import { validateManifest } from "../../lib/examples/schema.js";
import { ExamplesCache } from "../../lib/examples/cache.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async()=>{while(cleanup.length)await cleanup.pop()!()});
async function server(handler: Parameters<typeof createServer>[0]) { const s=createServer(handler); await new Promise<void>(r=>s.listen(0,"127.0.0.1",r)); cleanup.push(()=>new Promise<void>((r,j)=>s.close(e=>e?j(e):r()))); return `http://127.0.0.1:${(s.address() as any).port}`; }

for (const [name,limit] of Object.entries({index:LIMITS.index,manifest:LIMITS.manifest,file:LIMITS.file})) test(`rejects ${name} above its ${limit} byte cap`,async()=>{
 const origin=await server((_q,r)=>{r.setHeader("content-type",name==="file"?"text/plain":"application/json");r.end(Buffer.alloc(limit+1,32))});
 await expect(requestBytes(origin,{limit,contentTypes:[name==="file"?"text/plain":"application/json"]})).rejects.toMatchObject({code:"VGPU-EXAMPLES-INTEGRITY"});
});

test.each([301,302,307,308])("rejects redirect %i without following it",async status=>{let followed=0;const origin=await server((q,r)=>{if(q.url==="/target")followed++;r.statusCode=status;r.setHeader("location","/target");r.end()});await expect(requestBytes(origin,{limit:100,contentTypes:["application/json"]})).rejects.toBeTruthy();expect(followed).toBe(0)});

test("times out a connection attempt and a stalled response body",async()=>{
 const hangingFetch:any=(_u:any,{signal}:any)=>new Promise((_r,j)=>signal.addEventListener("abort",()=>j(signal.reason),{once:true}));
 await expect(requestBytes("http://127.0.0.1:1",{fetchImpl:hangingFetch,limit:10,contentTypes:["application/json"],timeoutMs:20})).rejects.toMatchObject({code:"VGPU-EXAMPLES-NETWORK"});
 const origin=await server((_q,r)=>{r.setHeader("content-type","application/json");r.write("{")});
 await expect(requestBytes(origin,{limit:100,contentTypes:["application/json"],timeoutMs:20})).rejects.toMatchObject({code:"VGPU-EXAMPLES-NETWORK"});
});

test.each(["length","chunked"])("rejects %s-truncated bodies",async mode=>{
 const origin=await server((_q,r)=>{r.setHeader("content-type","application/json");if(mode==="length")r.setHeader("content-length","100");r.write("{\"x\":");setImmediate(()=>r.destroy())});
 await expect(requestBytes(origin,{limit:1000,contentTypes:["application/json"]})).rejects.toMatchObject({code:"VGPU-EXAMPLES-NETWORK"});
});

test("supports ETag 304 only with cached bytes and exposes the ETag",async()=>{let requests=0;const body=Buffer.from("{\"ok\":true}");const origin=await server((q,r)=>{requests++;if(q.headers["if-none-match"]==='"v1"'){r.statusCode=304;r.setHeader("etag",'"v1"');return r.end()}r.setHeader("etag",'"v1"');r.setHeader("content-type","application/json");r.end(body)});const first=await requestBytes(origin,{limit:100,contentTypes:["application/json"]});expect(first.etag).toBe('"v1"');const second=await requestBytes(origin,{limit:100,contentTypes:["application/json"],etag:first.etag});expect(second.notModified).toBe(true);expect(requests).toBe(2)});

test("rejects pull aggregate above 32 MiB before downloading",async()=>{const manifest:any={files:[{path:"a",size:LIMITS.pull,sha256:"a".repeat(64)},{path:"b",size:1,sha256:"b".repeat(64)}]};const client:any={getFile:()=>{throw Error("downloaded")}};await expect(pullExample(client,manifest,"unused")).rejects.toMatchObject({code:"VGPU-EXAMPLES-INTEGRITY"})});

test("rejects more than 128 files",()=>{const file=(i:number)=>({path:`${i}.ts`,contentType:"text/plain",size:0,sha256:"a".repeat(64),url:`https://x.test/${i}`});expect(()=>validateManifest({schemaVersion:1,contractId:"vgpu-examples/v1",revision:"a".repeat(64),id:"x",title:"x",description:"x",tags:[],capabilities:[],aggregateSha256:"b".repeat(64),files:Array.from({length:129},(_,i)=>file(i))})).toThrow()});

test("restores old destination when force publication is interrupted",async()=>{const root=await mkdtemp(join(tmpdir(),"pull-interrupt-"));cleanup.push(()=>rm(root,{recursive:true,force:true}));const out=join(root,"out");await mkdir(out);await writeFile(join(out,"old.txt"),"old");const bytes=Buffer.from("new");const manifest:any={files:[{path:"new.txt",size:3,sha256:"x"}]};const client:any={getFile:async()=>bytes};await expect(pullExample(client,manifest,out,{force:true,beforePublish:()=>{throw Error("simulated interruption")}})).rejects.toMatchObject({code:"VGPU-EXAMPLES-FILESYSTEM"});expect(await readFile(join(out,"old.txt"),"utf8")).toBe("old");await expect(readFile(join(out,"new.txt"))).rejects.toMatchObject({code:"ENOENT"})});

test("keeps concurrent writers to one cached revision atomic",async()=>{const root=await mkdtemp(join(tmpdir(),"cache-race-"));cleanup.push(()=>rm(root,{recursive:true,force:true}));const cache=new ExamplesCache(root),rev="a".repeat(64),path=cache.indexPath(rev),values=Array.from({length:16},(_,i)=>Buffer.from(String(i).repeat(1000)));await Promise.all(values.map(value=>cache.write(path,value)));const actual=await cache.read(path);expect(values.some(value=>value.equals(actual!))).toBe(true)});

test("serializes concurrent pulls to one destination without merging",async()=>{const root=await mkdtemp(join(tmpdir(),"pull-race-"));cleanup.push(()=>rm(root,{recursive:true,force:true}));const out=join(root,"out"), bytes=Buffer.from("ok"), manifest:any={files:[{path:"only.txt",size:2,sha256:"x"}]};let release!:()=>void;const gate=new Promise<void>(r=>release=r);let first=true;const client:any={getFile:async()=>{if(first){first=false;await gate}return bytes}};const one=pullExample(client,manifest,out);await new Promise(r=>setTimeout(r,10));const two=pullExample(client,manifest,out);release();const results=await Promise.allSettled([one,two]);expect(results.filter(x=>x.status==="fulfilled")).toHaveLength(1);const rejection=results.find(x=>x.status==="rejected") as PromiseRejectedResult;expect(rejection.reason.code).toBe("VGPU-EXAMPLES-DESTINATION-EXISTS");expect(await readFile(join(out,"only.txt"),"utf8")).toBe("ok")});
