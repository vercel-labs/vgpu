import { homedir } from 'node:os';
import { dirname,isAbsolute,join,parse,relative,resolve,sep } from 'node:path';
import { constants } from 'node:fs';
import { lstat,mkdir,open,rename,rm } from 'node:fs/promises';
import { filesystem,integrity } from './errors.js';
import { sha256 } from './hashing.js';

const DIR_FLAGS=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW;
const FD_ROOT=process.platform==='linux'?'/proc/self/fd':undefined;
const missing=e=>e?.code==='ENOENT';
const unsafe=e=>e?.code==='ELOOP'||e?.code==='ENOTDIR';
const safe=s=>{if(!/^[a-z0-9.-]+$/.test(s))throw integrity('Invalid cache key');return s;};

export function cacheRoot(env=process.env){return join(env.VGPU_CACHE_DIR||env.XDG_CACHE_HOME||join(homedir(),'.cache'),'vgpu','examples');}

export class ExamplesCache{
 constructor(root=cacheRoot()){this.root=resolve(root);}
 discoveryPath(){return join(this.root,'discovery.json');}
 metaPath(){return join(this.root,'discovery.meta.json');}
 revisionDir(rev){return join(this.root,'v1',safe(rev));}
 indexPath(rev){return join(this.revisionDir(rev),'index.json');}
 revisionMetaPath(rev){return join(this.revisionDir(rev),'verified.json');}
 manifestPath(rev,id){return join(this.revisionDir(rev),'manifests',`${safe(id)}.json`);}
 filePath(rev,hash){return join(this.revisionDir(rev),'files',safe(hash));}
 inside(path){const full=resolve(path),rel=relative(this.root,full);if(rel===''||(!rel.startsWith(`..${sep}`)&&rel!=='..'&&!isAbsolute(rel)))return full;throw filesystem('Cache path escapes cache root');}
 async parent(path,create,operation){
  if(!FD_ROOT)throw filesystem(`Safe cache storage is unsupported on ${process.platform}`);
  const full=this.inside(path),root=parse(this.root).root;
  const parentParts=relative(root,dirname(full)).split(sep).filter(Boolean);
  let directory;
  try{directory=await open(root,DIR_FLAGS)}catch(e){throw filesystem(`Cannot open cache filesystem root: ${e.message}`)}
  try{
   for(const part of parentParts){
    if(!part||part==='.'||part==='..')throw filesystem('Invalid cache path component');
    const child=`${FD_ROOT}/${directory.fd}/${part}`;
    let next;
    try{next=await open(child,DIR_FLAGS)}catch(e){
     if(missing(e)&&create){
      try{await mkdir(child,{mode:0o700})}catch(mkdirError){if(mkdirError?.code!=='EEXIST')throw mkdirError}
      try{next=await open(child,DIR_FLAGS)}catch(openError){if(unsafe(openError))throw filesystem(`Unsafe cache directory: ${part}`);throw openError}
     }else if(missing(e)){return}
     else if(unsafe(e)){throw filesystem(`Unsafe cache directory: ${part}`)}
     else throw e;
    }
    await directory.close();directory=next;
   }
   return await operation(`${FD_ROOT}/${directory.fd}/${full.split(sep).pop()}`);
  }catch(e){if(e?.code?.startsWith?.('VGPU-'))throw e;throw filesystem(`Cannot access cache: ${e.message}`)}
  finally{await directory?.close().catch(()=>{})}
 }
 async read(path){
  return this.parent(path,false,async leaf=>{let handle;try{handle=await open(leaf,constants.O_RDONLY|constants.O_NOFOLLOW);const stat=await handle.stat();if(!stat.isFile())throw filesystem(`Unsafe cache entry: ${path}`);return await handle.readFile()}catch(e){if(missing(e))return;if(unsafe(e))throw filesystem(`Unsafe cache entry: ${path}`);throw e}finally{await handle?.close()}});
 }
 async readJson(path){const bytes=await this.read(path);if(!bytes)return;try{return JSON.parse(bytes.toString('utf8'))}catch{throw integrity(`Corrupt cache entry: ${path}`)}}
 async write(path,bytes){
  return this.parent(path,true,async leaf=>{const name=leaf.slice(leaf.lastIndexOf('/')+1),parent=leaf.slice(0,leaf.lastIndexOf('/')),tmp=`${parent}/.${name}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;let handle;try{
   try{const stat=await lstat(leaf);if(stat.isSymbolicLink()||!stat.isFile())throw filesystem(`Unsafe cache entry: ${path}`)}catch(e){if(!missing(e))throw e}
   handle=await open(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=undefined;await rename(tmp,leaf);
  }catch(e){await handle?.close().catch(()=>{});await rm(tmp,{force:true}).catch(()=>{});throw e}});
 }
 async writeVerified(path,bytes,expected){if(sha256(bytes)!==expected)throw integrity('Cached object hash mismatch');await this.write(path,bytes);}
 async mark(rev,indexSha256,now=new Date()){await this.write(this.revisionMetaPath(rev),Buffer.from(JSON.stringify({lastVerifiedAt:now.toISOString(),indexSha256})+'\n'));}
 async clear(){
  const parent=resolve(this.root,'..'),name=this.root.split(sep).pop();
  try{return await this.parent(join(parent,name),false,async leaf=>{const stat=await lstat(leaf);if(stat.isSymbolicLink()||!stat.isDirectory())throw filesystem('Unsafe cache root');await rm(leaf,{recursive:true})})}catch(e){if(missing(e))return;if(e?.code?.startsWith?.('VGPU-'))throw e;throw filesystem(`Cannot clear cache: ${e.message}`)}
 }
}
