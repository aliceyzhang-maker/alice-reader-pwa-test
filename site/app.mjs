import {makeBook} from './vendor/foliate/view.js';
import {get,set,getJob,saveJob,file,remove,storageJob} from './store.mjs';
import {extractAudio,calculate} from './matching.mjs';

const el=id=>document.getElementById(id);
const audio=el('audio');
const chapterPicker=el('sections');
const segmenter=new Intl.Segmenter('en',{granularity:'sentence'});
const state={job:null,book:null,section:0,sentences:[],file:null,blob:null,view:null,stopping:false,playing:null,ready:false};
const debug=window.aliceValidation={runs:[]};
let saveTimer=0;
let readerSectionVersion=0;
let busy=false;
const bytes=n=>(n/1e6).toFixed(2)+' MB';
const fixed=(n,places=2)=>n.toFixed(places);
const clock=n=>Math.floor(n/3600)+':'+[Math.floor(n/60)%60,Math.floor(n)%60].map(v=>String(v).padStart(2,'0')).join(':');
const describeError=err=>err?.message||String(err);
const title=()=>Object.values(state.book?.metadata?.title||{}).join('').trim()||'本地有声书';
function status(id,message){el(id).textContent=message;}
async function capabilities() {
 const parts=['安全上下文 '+(window.isSecureContext?'是':'否')];
 parts.push(navigator.storage?.getDirectory?'OPFS 可用':'OPFS 不可用');
 let adapter=null;
 if(navigator.gpu) {
  try {adapter=await navigator.gpu.requestAdapter();} catch {}
 }
 debug.cap={secure:isSecureContext,opfs:Boolean(navigator.storage?.getDirectory),webgpu:Boolean(adapter),
  gpu:adapter?.info?.architecture||adapter?.info?.description,fp16:adapter?.features.has('shader-f16')||false,
  audioDecoder:typeof AudioDecoder==='function',standalone:matchMedia('(display-mode: standalone)').matches,
  userAgent:navigator.userAgent};
 parts.push(adapter?'WebGPU 可用':'WebGPU 不可用');
 parts.push(debug.cap.audioDecoder?'音频 WebCodecs 可用':'音频 WebCodecs 不可用');
 if(debug.cap.standalone) parts.push('主屏幕模式');
 status('cap',parts.join(' · '));
}
async function offlineStatus() {
 if(!navigator.serviceWorker) return;
 const registration=await navigator.serviceWorker.register('./sw.js');
 await navigator.serviceWorker.ready;
 if(!navigator.serviceWorker.controller) await new Promise(resolve=>{
  navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true});
  if(navigator.serviceWorker.controller) resolve();
 });
 debug.offlineReady=Boolean(registration.active&&navigator.serviceWorker.controller);
 el('cap').textContent+=' · 已缓存离线页面';
}
async function storageStatus(prefix) {
 const estimated=await navigator.storage.estimate();
 const persistent=await navigator.storage.persisted();
 debug.storage={...estimated,persistent};
 status('storage',prefix+' · 来源用量 '+bytes(estimated.usage||0)+' · 设备给此来源的配额 '+bytes(estimated.quota||0)+' · '+(persistent?'已授予持久存储':'普通存储，可被系统清退'));
}
async function saveMediaPosition() {
 if(!state.ready||!state.meta||!Number.isFinite(audio.currentTime)) return;
 const reading=el('text').hidden?null:[...el('text').querySelectorAll('[data-index]')].find(node=>{
  const box=node.getBoundingClientRect();
  return box.bottom>24&&box.top<window.innerHeight;
 })?.dataset.index;
 await set('position:'+state.meta.id,{section:state.section,time:audio.currentTime,reading});
}
function scheduleSave() {
 if(saveTimer||!state.ready) return;
 saveTimer=setTimeout(()=>{saveTimer=0;void saveMediaPosition().catch(()=>{});},900);
}
function changeMediaTime() {
 const time=audio.currentTime;
 if(!Number.isFinite(time)) return;
 status('point',clock(time));
 const next=state.timeline?.find(row=>row.start<=time&&row.end>time);
 if(next?.index===state.playing) return;
 if(state.playing!==null) el('text').querySelector('.active')?.classList.remove('active');
 state.playing=next?.index??null;
 if(next) {
  const node=el('text').querySelector('[data-index="'+next.index+'"]');
  node?.classList.add('active');
  if(node&&!audio.paused) {
   const r=node.getBoundingClientRect();
   if(r.top<0||r.bottom>window.innerHeight-110) node.scrollIntoView({block:'center'});
  }
 }
}
function bindMediaSession() {
 if(!('mediaSession' in navigator)) return;
 try {
  navigator.mediaSession.metadata=new MediaMetadata({title:title(),artist:'Alice PWA 验证'});
  for(const [k,v] of [
   ['play',()=>audio.play()],['pause',()=>audio.pause()],
   ['seekbackward',d=>{audio.currentTime=Math.max(0,audio.currentTime-(d.seekOffset||15));}],
   ['seekforward',d=>{audio.currentTime=Math.min(audio.duration,audio.currentTime+(d.seekOffset||15));}],
   ['seekto',d=>{if(Number.isFinite(d.seekTime))audio.currentTime=d.seekTime;}],
  ]) {try {navigator.mediaSession.setActionHandler(k,v);} catch {}}
 } catch {}
}
function render() {
 const scored=new Map((state.timeline||[]).map(row=>[row.index,row]));
 const article=el('text');
 const buffer=document.createDocumentFragment();
 let paragraph=null,last=null;
 state.sentences.forEach((sentence,index)=>{
  if(sentence.paragraph!==last){
   paragraph=document.createElement('p');
   buffer.append(paragraph);
   last=sentence.paragraph;
  }
  const span=document.createElement('span');
  const range=scored.get(index);
  span.textContent=sentence.text;
  span.dataset.index=index;
  if(range) {
   span.dataset.start=range.start;
   span.dataset.end=range.end;
   span.tabIndex=0;
   span.onclick=()=>{
    if(getSelection()?.toString()) return;
    audio.currentTime=range.start+.015;
    changeMediaTime();
    void audio.play().catch(error=>status('job',describeError(error)));
   };
   span.onkeydown=event=>{
    if(event.key==='Enter'||event.key===' '){event.preventDefault();span.click();}
   };
  }
  paragraph.append(span,document.createTextNode(' '));
 });
 article.replaceChildren(buffer);
 state.playing=null;
 changeMediaTime();
}
function keyForJob(section=state.section,mode=el('engine').value,start=Number(el('start').value),end=Number(el('end').value)){
 return [state.meta.id,section,mode,start,end].join(':');
}
async function loadSection(index,{restore=true}={}) {
 const version=++readerSectionVersion;
 const document=await state.book.sections[index].createDocument();
 if(version!==readerSectionVersion) return;
 const paragraphs=[...document.querySelectorAll('body p, body h1, body h2, body h3, body blockquote')].filter(node=>!node.querySelector('p,h1,h2,h3'));
 const fallback=document.querySelector('body')||document.documentElement;
 const readable=paragraphs.length?paragraphs:[fallback];
 state.section=index;
 state.sentences=readable.flatMap((node,paragraph)=>[...segmenter.segment(node.textContent.replace(/\s+/g,' ').trim())]
  .map(item=>({paragraph,text:item.segment.trim()})).filter(item=>item.text));
 state.timeline=restore?(await get('map:'+state.meta.id+':'+index))?.mapped||[]:[];
 if(version!==readerSectionVersion) return;
 chapterPicker.value=String(index);
 render();
 if(state.view) await state.view.goTo(index);
}
async function initBook(meta) {
 state.ready=false;
 state.meta=meta;
 const ebook=await file(meta.epub);
 state.file=await file(meta.m4b);
 state.book=await makeBook(new File([ebook],meta.epubLabel,{type:'application/epub+zip'}));
 if(state.blob) URL.revokeObjectURL(state.blob);
 state.blob=URL.createObjectURL(state.file.slice(0,state.file.size,'audio/mp4'));
 chapterPicker.replaceChildren(...state.book.sections.map((section,index)=>{
  const option=document.createElement('option');
  option.value=index;
  const titles=state.book.toc?.flatMap(item=>[item,...(item.subitems||[])])||[];
  const toc=titles.findLast(item=>item.href?.split('#')[0]===section.id);
  option.textContent=toc?.label||('第 '+(index+1)+' 个 EPUB 分段 · '+section.id);
  return option;
 }));
 const saved=await get('position:'+meta.id);
 const chosen=saved?.section??(state.book.sections.findIndex(section=>/chapter.?0?1(\D|$)/i.test(section.id)));
 await loadSection(chosen>=0?chosen:(state.book.sections.length>3?3:0));
 const savedJob=await get('lastJob:'+meta.id);
 if(savedJob) {
  el('engine').value=savedJob.mode;
  el('start').value=savedJob.start;
  el('end').value=savedJob.end;
  const found=await getJob(keyForJob());
  if(found){
   status('job',found.complete?'已有匹配结果 · '+found.blocks.length+' 块':'已有断点 · '+found.blocks.length+' 块，继续自 '+fixed(found.next)+' 秒');
   el('report').disabled=!found.result;
  }
 }
 audio.onloadedmetadata=()=>{
  if(saved?.time>0&&saved.time<audio.duration) audio.currentTime=saved.time;
  state.ready=true;
  changeMediaTime();
  if(saved?.reading>0) el('text').querySelector('[data-index="'+saved.reading+'"]')?.scrollIntoView({block:'start'});
  debug.media={epubBytes:ebook.size,m4bBytes:state.file.size,duration:audio.duration,restoredSection:state.section,restoredTime:saved?.time||0};
 };
 audio.src=state.blob;
 el('book').hidden=false;
 el('tools').hidden=false;
 el('player').hidden=false;
 bindMediaSession();
 await storageStatus('已导入 '+bytes(meta.files.m4b.size)+' 音频 · '+fixed(meta.importMs/1000)+' 秒');
}
function inference(mode) {
 const worker=new Worker('./infer-worker.mjs',{type:'module'});
 const ask=(action,pcm)=>new Promise((resolve,reject)=>{
  worker.onerror=event=>reject(Error(event.message));
  worker.onmessage=({data})=>data.ok?resolve(data.result):reject(Error(data.error));
  worker.postMessage({action,mode,pcm},pcm?[pcm.buffer]:[]);
 });
 return {ask,close:()=>worker.terminate()};
}
async function maybePublish(job,key) {
 try {
  const tick=performance.now();
  job.result=await calculate(state.sentences,job);
  job.alignMs=performance.now()-tick;
  state.timeline=job.result.mapped;
  await set('map:'+state.meta.id+':'+state.section,job.result);
  await saveJob(key,job);
  render();
  el('report').disabled=false;
  return '';
 } catch(error) {
  job.mappingError=describeError(error);
  await saveJob(key,job);
  return ' · '+job.mappingError;
 }
}
async function run() {
 if(busy) return;
 const mode=el('engine').value,start=Number(el('start').value),end=Number(el('end').value);
 if(!state.ready||!state.sentences.length||start<0||end-start<5||end>audio.duration) throw Error('请选择相应章节和至少 5 秒有效音频');
 const key=keyForJob();
 const old=await getJob(key);
 const job=old||{mode,start,end,section:state.section,next:start,blocks:[],blockCount:0,complete:false,timings:[]};
 state.stopping=false;
 busy=true;
 for(const id of ['run','engine','start','end','sections','epub','m4b']) el(id).disabled=true;
 el('stop').disabled=false;
 const started=performance.now();
 const originalCount=job.blocks.length;
 let worker;
 try {
  if(!job.complete){
   await set('lastJob:'+state.meta.id,{mode,start,end});
   await saveMediaPosition();
   status('job','加载本地模型…');
   worker=inference(mode);
   job.model=await worker.ask('load');
   const blockLength=mode.startsWith('whisper')?24:18;
   while(job.next<end){
    const from=job.next;
    const to=Math.min(end,from+blockLength);
    const decodeStart=performance.now();
    const decoded=await extractAudio(state.file,from,to);
    const decodeMs=performance.now()-decodeStart;
    const block=await worker.ask('infer',decoded);
    if(block.values&&to-from>=blockLength-.001) {
     const expected=Math.round(blockLength/(block.msPerFrame/1000));
     block.frames=Math.min(block.frames,expected);
     block.values=block.values.slice(0,block.frames*block.classes);
    }
    Object.assign(block,{from,to,decodeMs});
    job.blocks.push(block);
    job.next=to;
    if(job.blockCount===undefined) await set('job:'+key,job);
    else await saveJob(key,job,block);
    debug.checkpoint={count:job.blocks.length,next:job.next,section:job.section};
    status('job','断点已保存 · '+job.blocks.length+' 块 · '+fixed(job.next)+' / '+fixed(end)+' 秒');
    if(state.stopping) break;
   }
  }
  job.complete=job.next>=end;
  job.timings.push({ms:performance.now()-started,fromBlock:originalCount,toBlock:job.blocks.length});
  const problem=await maybePublish(job,key);
  const summary=jobSummary(job);
  debug.runs.push(summary);
  status('job',(job.complete?'匹配任务结束':'已暂停，可恢复')+' · '+job.blocks.length+' 块 · '+(job.result?.mapped.length||0)+' 个有效句'+problem);
 } finally {
  worker?.close();
  busy=false;
  for(const id of ['run','engine','start','end','sections','epub','m4b']) el(id).disabled=false;
  el('stop').disabled=true;
 }
}
function jobSummary(job) {
 return {mode:job.mode,start:job.start,end:job.end,section:job.section,checkpoint:job.next,complete:job.complete,
  model:job.model,timings:job.timings,alignMs:job.alignMs,result:job.result,mappingError:job.mappingError,
  blocks:job.blocks.map(({from,to,decodeMs,inferenceMs,text,words,frames,classes})=>({from,to,decodeMs,inferenceMs,text,words:words?.length,frames,classes}))};
}
const showError=(where,err)=>status(where,describeError(err));
el('import').onsubmit=async event=>{
 event.preventDefault();
 if(busy) return;
 busy=true;
 const button=el('import').querySelector('button');
 button.disabled=true;
 const former=state.meta;
 const start=performance.now(),id=crypto.randomUUID();
 const epub=id+'.epub',m4b=id+'.m4b';
 let committed=false;
 try {
  const selection=[el('epub').files[0],el('m4b').files[0]];
  if(!selection.every(f=>f&&f.size)) throw Error('请选择 EPUB 和 M4B');
  const files={};
  for(const [i,name,slot] of [[0,epub,'epub'],[1,m4b,'m4b']]){
   files[slot]=await storageJob('write',{name,source:selection[i]},n=>status('storage',slot.toUpperCase()+' 写入 '+n+'%'));
  }
  const meta={id,epub,m4b,files,epubLabel:selection[0].name,m4bLabel:selection[1].name,importMs:performance.now()-start};
  await initBook(meta);
  await set('current',meta);
  committed=true;
  debug.import=meta;
  if(former) {
   await remove(former.epub);await remove(former.m4b);
  }
 } catch(err) {
  if(!committed) {await remove(epub).catch(()=>{});await remove(m4b).catch(()=>{});}
  showError('storage',err);
 } finally {button.disabled=false;busy=false;}
};
chapterPicker.onchange=()=>{void loadSection(Number(chapterPicker.value)).then(saveMediaPosition).catch(err=>showError('job',err));};
el('match').onsubmit=event=>{event.preventDefault();void run().catch(err=>{debug.lastError=describeError(err);showError('job',err);});};
el('stop').onclick=()=>{state.stopping=true;el('stop').disabled=true;};
el('persist').onclick=async()=>{
 try {await navigator.storage.persist();await storageStatus('持久存储申请已完成');}
 catch(err) {showError('storage',err);}
};
el('validate').onclick=async()=>{
 const button=el('validate');
 button.disabled=true;
 try {
  const result=await storageJob('hash',{name:state.meta.m4b},n=>status('storage','读取校验 '+n+'%'));
  debug.verification={...result,match:result.size===state.meta.files.m4b.size&&result.hash===state.meta.files.m4b.hash};
  await storageStatus('SHA‑256 '+(debug.verification.match?'一致':'不一致')+' · '+fixed(result.ms/1000)+' 秒');
 } catch(err) {showError('storage',err);} finally {button.disabled=false;}
};
el('report').onclick=async()=>{
 const job=await getJob(keyForJob());
 if(!job) return;
 const blob=new Blob([JSON.stringify(jobSummary(job),null,2)],{type:'application/json'});
 const a=document.createElement('a');
 a.href=URL.createObjectURL(blob);
 a.download='alice-pwa-validation.json';
 a.click();
 setTimeout(()=>URL.revokeObjectURL(a.href),500);
};
el('original').onclick=async()=>{
 const wrap=el('original-wrap');
 wrap.hidden=!wrap.hidden;
 el('text').hidden=!wrap.hidden;
 if(!state.view){
  state.view=window.document.createElement('foliate-view');
  wrap.append(state.view);
  try {await state.view.open(state.book);await state.view.goTo(state.section);}
  catch(err) {showError('job',err);}
 }
};
el('previous').onclick=()=>state.view?.prev();
el('next').onclick=()=>state.view?.next();
audio.ontimeupdate=()=>{changeMediaTime();scheduleSave();};
audio.onseeked=()=>{changeMediaTime();void saveMediaPosition().catch(()=>{});};
audio.onpause=()=>void saveMediaPosition().catch(()=>{});
audio.onerror=()=>status('job','本地音频无法播放（'+audio.error?.code+'）');
document.addEventListener('visibilitychange',()=>{if(document.hidden) void saveMediaPosition().catch(()=>{});});
window.addEventListener('scroll',scheduleSave,{passive:true});
void (async()=>{
 await capabilities();
 void offlineStatus().catch(err=>{debug.offlineError=describeError(err);status('cap',el('cap').textContent+' · 离线缓存失败');});
 if(!navigator.storage?.getDirectory) {
  status('storage','需在可信 HTTPS 或 Mac 本机 localhost 打开测试台。');
  return;
 }
 const meta=await get('current');
 if(meta) {
  debug.import=meta;
  await initBook(meta);
 } else await storageStatus('等待导入');
})().catch(err=>showError('storage',err));
