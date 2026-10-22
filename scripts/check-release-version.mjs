import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const root = JSON.parse(readFileSync('package.json', 'utf8'));
const desktop = JSON.parse(readFileSync('apps/desktop/package.json', 'utf8'));
const tag = process.env.RELEASE_TAG || '';
if (!/^v\d+\.\d+\.\d+$/.test(tag) || tag !== `v${root.version}` || root.version !== desktop.version)
  throw new Error('发布标签与项目版本不一致');
const tagged = execFileSync('git', ['rev-parse', `${tag}^{commit}`], { encoding: 'utf8' }).trim();
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (tagged !== head) throw new Error('构建提交与发布标签不一致');
console.log(`发布 ${tag}，提交 ${head}`);
