import {execFile as run} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {cp,mkdir,rename,readFile,stat} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {promisify} from 'node:util';

const exec=promisify(run);
const assets=JSON.parse(await readFile('model-lock.json','utf8'));
await cp('site','dist',{recursive:true});
for(let i=0;i<assets.length;i+=3) {
 await Promise.all(assets.slice(i,i+3).map(async({path,url,bytes,sha256})=>{
  const destination=join('dist','models',path);
  const temp=destination+'.partial';
  await mkdir(dirname(destination),{recursive:true});
  await exec('curl',['-fsSL','--proto','=https','--proto-redir','=https','--retry','2','--connect-timeout','12','--max-time','240',url,'-o',temp]);
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(temp)) hash.update(chunk);
  if((await stat(temp)).size!==bytes||hash.digest('hex')!==sha256) throw Error('Model checksum mismatch: '+path);
  await rename(temp,destination);
  console.log('Verified '+path+' ('+bytes+' bytes)');
 }));
}
