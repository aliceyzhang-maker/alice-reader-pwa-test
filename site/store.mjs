const db = new Promise((resolve,reject)=>{
 const request=indexedDB.open('alice-pwa-validation',1);
 request.onupgradeneeded=()=>request.result.createObjectStore('entries');
 request.onsuccess=()=>resolve(request.result);
 request.onerror=()=>reject(request.error);
});
async function operation(mode,fn) {
 const storage=await db;
 return new Promise((resolve,reject)=>{
  const transaction=storage.transaction('entries',mode);
  const request=fn(transaction.objectStore('entries'));
  transaction.oncomplete=()=>resolve(request.result);
  transaction.onabort=()=>reject(transaction.error);
  transaction.onerror=()=>reject(transaction.error);
 });
}
export const get=key=>operation('readonly',store=>store.get(key));
export const set=(key,value)=>operation('readwrite',store=>store.put(value,key));
export async function getJob(key) {
 const job=await get('job:'+key);
 if(!job||job.blocks) return job;
 const blocks=await Promise.all(Array.from({length:job.blockCount},(_,index)=>get('block:'+key+':'+index)));
 if(blocks.some(block=>!block)) throw Error('本地断点不完整，请改用新的区间重新匹配');
 return {...job,blocks};
}
export function saveJob(key,job,block) {
 const {blocks,...state}=job;
 if(!block&&job.blockCount===undefined) return set('job:'+key,job);
 return operation('readwrite',store=>{
  if(block) store.put(block,'block:'+key+':'+(blocks.length-1));
  return store.put({...state,blockCount:blocks.length},'job:'+key);
 });
}
export async function remove(name) {
 try {await (await navigator.storage.getDirectory()).removeEntry(name);}
 catch(error) {if(error.name!=='NotFoundError') throw error;}
}
export async function file(name) {
 const root=await navigator.storage.getDirectory();
 return (await root.getFileHandle(name)).getFile();
}
export function storageJob(action,details,progress=()=>{}) {
 return new Promise((resolve,reject)=>{
  const worker=new Worker('./store-worker.mjs',{type:'module'});
  worker.onerror=error=>{worker.terminate();reject(new Error(error.message));};
  worker.onmessage=({data})=>{
   if(data.type==='progress'){progress(data.value);return;}
   worker.terminate();
   if(data.error) reject(new Error(data.error)); else resolve(data.result);
  };
  worker.postMessage({action,...details});
 });
}
