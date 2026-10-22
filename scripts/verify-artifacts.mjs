import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {unzipSync,strFromU8} from 'fflate';
const root=new URL('../',import.meta.url),html=await readFile(new URL('artifacts/家园蓝图-离线版.html',root),'utf8');
const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
const style=html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
if(!script||!style)throw new Error('离线页面缺少内嵌脚本或样式');
for(const content of [script,style]){
 const hash=createHash('sha256').update(content).digest('base64');
 if(!html.includes('sha256-'+hash))throw new Error('离线页面完整性策略不匹配');
}
if(/<script[^>]*\ssrc\s*=/.test(html)||/<link[^>]*\shref\s*=/.test(html))throw new Error('离线页面存在外部加载项');
const archive=unzipSync(await readFile(new URL('artifacts/jx3-homeland-blueprint-source.zip',root)));
const names=Object.keys(archive);
if(names.some(x=>/node_modules|artifacts\/|(^|\/)app\.py$|\.dll$|\.exe$|\.env/.test(x)))throw new Error('源码包含非源码交付内容');
const packageName='jx3-homeland-blueprint/package.json';
if(JSON.parse(strFromU8(archive[packageName])).name!=='jx3-homeland-blueprint')throw new Error('源码包入口不正确');
console.log(JSON.stringify({offlineBytes:Buffer.byteLength(html),inlinePolicyMatches:true,externalAssets:false,sourceFiles:names.length}));
const outputs=['家园蓝图-离线版.html','家园蓝图-Windows-x64.zip','jx3-homeland-blueprint-source.zip'];
const hashes=[];
for(const name of outputs){const bytes=await readFile(new URL('artifacts/'+name,root));hashes.push(createHash('sha256').update(bytes).digest('hex')+'  '+name);}
await writeFile(new URL('artifacts/checksums.sha256',root),hashes.join('\n')+'\n');
