import {Input,BlobSource,MP4,AudioSampleSink} from './vendor/media.mjs';
import {ctcForcedAlign,ctcGreedyDecode,findCtcBoundaries,diffArrays} from './vendor/align.mjs';

export async function extractAudio(file,start,end) {
 const input=new Input({source:new BlobSource(file),formats:[MP4]});
 try {
  const track=await input.getPrimaryAudioTrack();
  if(!track || !(await track.canDecode())) throw Error('浏览器无法以 WebCodecs 解码此 M4B 的音轨');
  const sink=new AudioSampleSink(track);
  const rate=await track.getSampleRate();
  const mono=new Float32Array(Math.ceil((end-start)*rate));
  let frames=0;
  for await(const sample of sink.samples(start-.025,end)) {
   try {
    const offset=Math.round((sample.timestamp-start)*rate);
    const scratch=new Float32Array(sample.numberOfFrames);
    for(let c=0;c<sample.numberOfChannels;c++){
     sample.copyTo(scratch,{planeIndex:c,format:'f32-planar'});
     for(let j=Math.max(0,-offset);j<Math.min(scratch.length,mono.length-offset);j++) mono[offset+j]+=scratch[j]/sample.numberOfChannels;
    }
    frames+=scratch.length;
   } finally {sample.close();}
  }
  if(!frames) throw Error('指定区间无可解码音频');
  const ctx=new OfflineAudioContext(1,Math.round((end-start)*16000),16000);
  const buffer=ctx.createBuffer(1,mono.length,rate);
  buffer.copyToChannel(mono,0);
  const source=ctx.createBufferSource();
  source.buffer=buffer;
  source.connect(ctx.destination);
  source.start();
  return (await ctx.startRendering()).getChannelData(0).slice();
 } finally {input.dispose();}
}

const wordList=text=>(text.toLowerCase().replace(/[’‘]/g,"'").match(/[a-z0-9]+(?:'[a-z]+)*/g)||[]);
const chars=text=>text.normalize('NFKD').toLowerCase().replace(/[’‘]/g,"'").replace(/[^a-z']/g,'');
const vocabulary=new Map([['|',0],...[...'abcdefghijklmnopqrstuvwxyz\''].map((c,i)=>[c,i+1]),['<blank>',28]]);
// QuartzNet boundary corrections published by ghost-story 0.3.4.
const quartznetStartOffset=-.28;
const quartznetEndOffset=-.12;
function joinEmissions(blocks) {
 const total=blocks.reduce((n,b)=>n+b.frames,0);
 const classes=blocks[0].classes;
 const values=new Float32Array(total*classes);
 let cursor=0;
 for(const b of blocks){values.set(b.values,cursor);cursor+=b.values.length;}
 return {values,frames:total,classes};
}
function referenceChars(sentences) {
 let text='';
 return {ranges:sentences.map((sentence,index)=>{
  const from=text.length;
  text+=chars(sentence.text);
  return {index,from,to:text.length};
 }),get text(){return text;}};
}

function nearReference(decoded,reference) {
 const hits=[];
 const span=18;
 for(let i=0;i<=decoded.length-span;i+=7) {
  const needle=decoded.slice(i,i+span);
  const offset=reference.indexOf(needle);
  if(offset>=0&&reference.indexOf(needle,offset+1)<0) hits.push(offset);
 }
 if(hits.length<5) throw Error('CTC 找不到足够的文本锚点，请检查章节与音频区间');
 const ordered=hits.toSorted((a,b)=>a-b);
 return [ordered[1],ordered.at(-2)+span];
}
function ctcTime(job,frame) {
 const per=job.blocks[0].frames;
 const i=Math.min(Math.floor(frame/per),job.blocks.length-1);
 return job.blocks[i].from+(frame-i*per)*job.blocks[i].msPerFrame/1000;
}
async function ctcMap(sentences,job) {
 const emissions=joinEmissions(job.blocks);
 const reader={vocab:vocabulary,blankId:28,numFrames:emissions.frames,async *blocks(){yield emissions;}};
 const ref=referenceChars(sentences);
 const {text:decoded}=await ctcGreedyDecode(reader);
 const [left,right]=nearReference(decoded,ref.text);
 const ranges=ref.ranges.filter(r=>r.to>r.from&&r.from>=left-80&&r.to<=right+85);
 if(!ranges.length) throw Error('区间内没有完整句子');
 const origin=ranges[0].from;
 const query=ref.text.slice(origin,ranges.at(-1).to);
 const info=await findCtcBoundaries(query,reader,[]);
 if(!info) throw Error('stalign CTC 无法确认此区间边界');
 const first=Math.max(0,info.start);
 const last=Math.min(emissions.frames,info.end+1);
 const local={
  frames:last-first,classes:emissions.classes,
  values:emissions.values.subarray(first*emissions.classes,last*emissions.classes),
 };
 const anchors=info.anchors.filter(a=>a.position>first&&a.position<last&&a.offset>0&&a.offset<query.length)
  .map(a=>({...a,position:a.position-first}));
 const aligned=ctcForcedAlign(query,local,anchors,vocabulary,28);
 const out=[];
 for(const range of ranges) {
  const tokens=aligned.slice(range.from-origin,range.to-origin);
  if(tokens.length!==range.to-range.from||tokens.some(t=>!t||!Number.isFinite(t.score))) continue;
  const usable=tokens.filter(t=>t.score>=-4).length/tokens.length;
  const start=Math.max(job.start,ctcTime(job,first+tokens[0].startFrame)+quartznetStartOffset);
  const end=Math.min(job.next,ctcTime(job,first+tokens.at(-1).endFrame+1)+quartznetEndOffset);
  const maxGap=tokens.slice(1).reduce((gap,t,i)=>Math.max(gap,t.startFrame-tokens[i].endFrame),0);
  if(usable>=.7&&end>start&&end<=job.next+.04&&maxGap<130) out.push({index:range.index,start,end,confidence:usable});
 }
 return {mapped:out,candidates:ranges.length,characters:decoded.length};
}
function whisperMap(sentences,job) {
 const tokens=[];
 const bySentence=Array(sentences.length).fill(0);
 sentences.forEach((sentence,index)=>wordList(sentence.text).forEach(word=>{
  tokens.push({word,index});bySentence[index]++;
 }));
 const spoken=job.blocks.flatMap(block=>block.words.flatMap(word=>wordList(word.text).map(text=>({
  word:text,start:block.from+word.timestamp[0],end:block.from+word.timestamp[1]
 }))));
 if(!spoken.length) throw Error('Whisper 未生成单词时间戳');
 const regions=[];
 let a=0,b=0;
 const edits=diffArrays(tokens.map(t=>t.word),spoken.map(t=>t.word));
 for(const edit of edits) {
  if(edit.removed) {a+=edit.count;continue;}
  if(edit.added) {b+=edit.count;continue;}
  for(let k=0;k<edit.count;k++) {
   const t=tokens[a++],match=spoken[b++];
   const region=regions[t.index]??={count:0,start:match.start,end:match.end};
   region.count++;
   region.end=match.end;
  }
 }
 const out=[];
 regions.forEach((r,index)=>{
  const confidence=r.count/bySentence[index];
  if(confidence>=.7&&r.end>r.start&&r.end<=job.next+.05&&r.end-r.start<Math.max(8,bySentence[index]*1.2)) {
   out.push({index,start:r.start,end:r.end,confidence});
  }
 });
 return {mapped:out,candidates:regions.filter(Boolean).length,words:spoken.length};
}
export const calculate=(sentences,job)=>job.mode.startsWith('ctc')?ctcMap(sentences,job):whisperMap(sentences,job);
