import {MelFrontend,PRE_EMPHASIS} from './vendor/align.mjs';
let engine;
let loaded;
const path=new URL('./vendor/',self.location.href).href;
const fetchJSON=async url=>{
 const response=await fetch(url);
 if(!response.ok) throw Error('本地模型资源缺失 '+url);
 return response.json();
};
async function load(mode) {
 const start=performance.now();
 const gpu=mode.endsWith('-gpu');
 const adapter=gpu?await navigator.gpu?.requestAdapter({powerPreference:'high-performance'}):null;
 if(gpu&&!adapter) throw Error('此浏览器未提供 WebGPU 适配器');
 if(mode.startsWith('whisper')) {
  const {pipeline,env}=await import('./vendor/transformers.mjs');
  env.allowRemoteModels=false;
  env.allowLocalModels=true;
  env.useBrowserCache=false;
  env.localModelPath=new URL('./models/',self.location.href).href;
  env.backends.onnx.wasm.wasmPaths=path;
  env.backends.onnx.wasm.numThreads=1;
  const dtype=gpu?(adapter.features.has('shader-f16')?'fp16':'fp32'):'q8';
  const transcribe=await pipeline('automatic-speech-recognition','Xenova/whisper-tiny.en',{device:gpu?'webgpu':'wasm',dtype});
  return {infer:async pcm=>{
   const result=await transcribe(pcm,{return_timestamps:'word',max_new_tokens:240});
   return {words:result.chunks.filter(item=>item.timestamp.every(Number.isFinite)),text:result.text};
  },dtype,loadMs:performance.now()-start,adapter:adapter?.info?.description||adapter?.info?.vendor||null};
 }
 const ort=await import('./vendor/ort.mjs');
 ort.env.wasm.numThreads=1;
 ort.env.wasm.wasmPaths=path;
 if(adapter) ort.env.webgpu.adapter=adapter;
 const config=await fetchJSON('./models/quartznet/config.json');
 const front=new MelFrontend({sampleRate:16000,melBins:config.melBins,windowSamples:config.windowSamples??320});
 const dtype='fp32';
 const model=new URL('./models/quartznet/model.onnx',self.location.href).href;
 const session=await ort.InferenceSession.create(model,{executionProviders:[gpu?'webgpu':'wasm']});
 const [first,length]=session.inputNames;
 return {infer:async pcm=>{
  let feeds;
  if(first==='signal') {
   const pad=front.fftSize/2;
   const signal=new Float32Array(pcm.length+2*pad);
   signal[pad]=pcm[0];
   for(let i=1;i<pcm.length;i++) signal[pad+i]=pcm[i]-PRE_EMPHASIS*pcm[i-1];
   for(let i=1;i<=pad;i++){
    signal[pad-i]=signal[pad+i];
    signal[pad+pcm.length-1+i]=signal[pad+pcm.length-1-i];
   }
   feeds={signal:new ort.Tensor('float32',signal,[1,1,signal.length])};
  } else {
   const {values,frames,melBins}=front.features(pcm);
   const transposed=new Float32Array(values.length);
   for(let m=0;m<melBins;m++) for(let f=0;f<frames;f++) transposed[m*frames+f]=values[f*melBins+m];
   feeds={[first]:new ort.Tensor('float32',transposed,[1,melBins,frames])};
   if(length) feeds[length]=new ort.Tensor('int64',BigInt64Array.of(BigInt(frames)),[1]);
  }
  const result=await session.run(feeds);
  const output=result[session.outputNames[0]];
  const [,frames,classes]=output.dims;
  const data=output.data.slice();
  for(let f=0;f<frames;f++) {
   const row=f*classes;
   const blank=data[row+config.blank],space=data[row];
   data[row+config.blank]=Math.max(blank,space)+Math.log1p(Math.exp(-Math.abs(blank-space)));
   data[row]=-30;
  }
  return {values:data,frames,classes,msPerFrame:1000*config.samplesPerFrame/config.sampleRate};
 },dtype,loadMs:performance.now()-start,adapter:adapter?.info?.description||adapter?.info?.vendor||null};
}
self.onmessage=async({data})=>{
 try {
  if(data.mode!==engine) {engine=data.mode;loaded=load(engine);}
  const m=await loaded;
  if(data.action==='load') {
   postMessage({ok:true,result:{dtype:m.dtype,loadMs:m.loadMs,adapter:m.adapter}});
  } else {
   const start=performance.now();
   const result=await m.infer(data.pcm);
   result.inferenceMs=performance.now()-start;
   postMessage({ok:true,result},result.values?[result.values.buffer]:[]);
  }
 } catch(error) {postMessage({error:error.message,stack:error.stack});}
};
