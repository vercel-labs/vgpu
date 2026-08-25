import { network, integrity } from './errors.js';
export const LIMITS={discovery:32768,index:1048576,manifest:262144,file:2097152,pull:33554432};
// Hosts the CLI will talk to. vgpu.sh is the official origin; vgpu.labs.vercel.dev stays
// accepted for --base-url during the migration. www.vgpu.sh is deliberately NOT trusted:
// it redirects to the apex, and requestBytes uses redirect:'error', so it can never work.
export const TRUSTED_HOSTS=['vgpu.sh','vgpu.labs.vercel.dev'];
export function trustedOrigin(baseUrl) {
 let u; try{u=new URL(baseUrl);}catch{throw integrity('Invalid examples API origin');}
 const loop=['127.0.0.1','localhost','::1'].includes(u.hostname);
 if (u.protocol!=='https:' && !(u.protocol==='http:'&&loop)) throw integrity('Examples API requires HTTPS');
 if (!loop && (!TRUSTED_HOSTS.includes(u.hostname)||u.port)) throw integrity('Untrusted examples API host');
 if(u.username||u.password||u.search||u.hash) throw integrity('Invalid examples API origin');
 return u.origin;
}
export function assertTrustedUrl(value, origin, revision) {
 let u; try{u=new URL(value);}catch{throw integrity(`Invalid API URL: ${value}`);}
 if(u.origin!==origin||u.username||u.password||u.search||u.hash) throw integrity(`API URL leaves trusted origin: ${value}`);
 if(revision){const match=u.pathname.match(/^\/(?:api\/)?examples\/v1\/revisions\/([a-f0-9]{64})\//);if(!match||match[1]!==revision)throw integrity(`Invalid immutable artifact URL: ${value}`);}
 return u.href;
}
function throwIfRequestAborted(url,requestSignal,signal,timeoutMessage){if(!requestSignal.aborted)return;if(signal?.aborted&&requestSignal.reason===signal.reason)throw signal.reason;throw network(`${timeoutMessage}: ${url}`);}
export async function requestBytes(url,{fetchImpl=fetch,limit,contentTypes,etag,timeoutMs=10000,signal}={}) {
 signal?.throwIfAborted();
 const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),timeoutMs),requestSignal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
 let response;
 try { response=await fetchImpl(url,{redirect:'error',signal:requestSignal,headers:etag?{'if-none-match':etag}:{}}); }
 catch(e){clearTimeout(timer);if(signal?.aborted&&requestSignal.reason===signal.reason)throw signal.reason;throw network(requestSignal.aborted?`Request timed out: ${url}`:`Request failed: ${url}`);}
 if(requestSignal.aborted){clearTimeout(timer);throwIfRequestAborted(url,requestSignal,signal,'Request timed out');}
 if(response.status===304){clearTimeout(timer);const returned=response.headers.get('etag');if(!etag||!/^"[^"\r\n]+"$/.test(etag)||returned!==etag)throw network(`Invalid conditional response from ${url}`);return {notModified:true,etag};}
 if(response.status!==200){clearTimeout(timer); throw network(`HTTP ${response.status} from ${url}`);}
 const type=(response.headers.get('content-type')||'').toLowerCase();
 if(!contentTypes.some(t=>type===t||type===`${t}; charset=utf-8`)) {clearTimeout(timer); throw integrity(`Unexpected content-type from ${url}: ${type||'(missing)'}`);}
 const length=response.headers.get('content-length'); if(length!==null&&(+length>limit||!Number.isSafeInteger(+length)||+length<0)){clearTimeout(timer); throw integrity(`Response exceeds ${limit} bytes`);}
 const chunks=[];let size=0;
 try { const reader=response.body?.getReader(); if(!reader) throw new Error('missing response body'); while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw integrity(`Response exceeds ${limit} bytes`);}chunks.push(value);} }
 catch(e){clearTimeout(timer);if(signal?.aborted&&requestSignal.reason===signal.reason)throw signal.reason;if(typeof e?.code==='string'&&e.code.startsWith('VGPU-'))throw e;throw network(`Truncated or timed out response: ${url}`);} clearTimeout(timer);throwIfRequestAborted(url,requestSignal,signal,'Truncated or timed out response');
 return {bytes:Buffer.concat(chunks.map(x=>Buffer.from(x)),size),etag:response.headers.get('etag')||undefined};
}
export async function requestJson(url,opts){const r=await requestBytes(url,opts);if(r.notModified)return r;try{return {...r,value:JSON.parse(r.bytes.toString('utf8'))};}catch{throw integrity(`Invalid JSON from ${url}`);}}
