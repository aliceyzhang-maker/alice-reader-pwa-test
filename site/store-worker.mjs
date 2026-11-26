import {sha256} from './vendor/hash.mjs';
const block=4*1024*1024;
self.onmessage=async({data})=>{
 let access;
 try {
  const start=performance.now();
  const root=await navigator.storage.getDirectory();
  const target=await root.getFileHandle(data.name,{create:data.action==='write'});
  access=await target.createSyncAccessHandle();
  const source=data.source;
  const writing=data.action==='write';
  const size=writing?source.size:access.getSize();
  if(writing) access.truncate(0);
  const digest=sha256.create();
  let reported=-10;
  for(let offset=0;offset<size;offset+=block) {
   const length=Math.min(block,size-offset);
   const bytes=writing?new Uint8Array(await source.slice(offset,offset+length).arrayBuffer()):new Uint8Array(length);
   const count=writing?access.write(bytes,{at:offset}):access.read(bytes,{at:offset});
   if(count!==length) throw Error('OPFS 读写长度不一致');
   digest.update(bytes);
   const percent=Math.floor((offset+length)*100/size);
   if(percent>=reported+5){reported=percent;postMessage({type:'progress',value:percent});}
  }
  if(writing) access.flush();
  access.close();
  access=null;
  const hash=Array.from(digest.digest(),b=>b.toString(16).padStart(2,'0')).join('');
  postMessage({type:'done',result:{size,hash,ms:performance.now()-start}});
 } catch(error) {postMessage({type:'error',error:error.message});}
 finally {access?.close();}
};
