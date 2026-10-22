import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';

const tag = process.env.RELEASE_TAG || '';
const repository = process.env.GITHUB_REPOSITORY || '';
if (!/^v\d+\.\d+\.\d+$/.test(tag) || !/^[\w.-]+\/[\w.-]+$/.test(repository))
  throw new Error('发布目标无效');
const folder = 'artifacts/release';
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
function verifyRemoteTag() {
  const remote = execFileSync('gh', ['api', `repos/${repository}/commits/${tag}`, '--jq', '.sha'], {
    encoding: 'utf8',
  }).trim();
  if (remote !== commit) throw new Error('发布标签已移动，停止发布过时构建');
}
verifyRemoteTag();
const files = ['家园蓝图-离线版.html', 'jx3-homeland-blueprint-source.zip'];
const checks = [];
for (const [platform, label] of [
  ['win32', 'Windows'],
  ['darwin', 'macOS'],
  ['linux', 'Linux'],
]) {
  for (const arch of ['x64', 'arm64']) {
    const name = `家园蓝图-${label}-${arch}.${platform === 'linux' ? 'tar.gz' : 'zip'}`;
    const report = JSON.parse(
      await readFile(join(folder, `desktop-tests-${platform}-${arch}.json`), 'utf8'),
    );
    if (
      !report.ok ||
      !report.packaged ||
      report.rendererNodeAvailable ||
      report.platform !== platform ||
      report.arch !== arch ||
      report.cases?.length !== 9
    )
      throw new Error(`${platform}/${arch} 运行检查不完整`);
    files.push(name);
    checks.push({
      platform,
      arch,
      runtimeCases: report.cases.length,
      electron: report.versions.electron,
    });
  }
}
const sizes = new Map();
const hashes = [];
for (const name of files) {
  const bytes = await readFile(join(folder, name));
  if (!bytes.length) throw new Error('发行文件为空：' + name);
  sizes.set(name, bytes.length);
  hashes.push(createHash('sha256').update(bytes).digest('hex') + '  ' + name);
}
await writeFile(join(folder, 'checksums.sha256'), hashes.join('\n') + '\n');
await writeFile(
  join(folder, 'build-verification.json'),
  JSON.stringify(
    {
      tag,
      commit,
      run: `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`,
      builds: checks,
    },
    null,
    2,
  ) + '\n',
);
files.push('checksums.sha256', 'build-verification.json');
for (const name of files) sizes.set(name, (await stat(join(folder, name))).size);
const notes = `# 家园蓝图 ${tag}\n\n将图片导出为家园墙面画或地面图案，尺寸和摆放方式可选。\n\n- [源码与使用说明](https://github.com/${repository})\n- Windows：选择 x64 或 ARM64 ZIP，完整解压后运行 HomelandBlueprint.exe。\n- macOS：Intel 选择 x64，Apple Silicon 选择 arm64；解压后打开 HomelandBlueprint.app。\n- Linux：选择对应架构的 tar.gz，完整解压后运行 HomelandBlueprint。\n- 同时提供源码 ZIP、离线网页、校验值和构建验证记录。\n\n六个客户端均由 GitHub Actions 在对应系统和架构构建，并通过真实运行导出检查。Windows 未配置发布者签名，macOS 未配置 Developer ID 签名与公证。\n\n项目采用 MIT-0；完整使用、开发和家园机制说明见仓库文档。\n`;
await writeFile(join(folder, 'release-notes.md'), notes);
const args = ['--repo', repository];
const existing = spawnSync('gh', ['release', 'view', tag, ...args, '--json', 'isDraft,url'], {
  encoding: 'utf8',
});
if (existing.status === 0) {
  if (!JSON.parse(existing.stdout).isDraft) throw new Error('该版本已发布，拒绝覆盖公开版本');
} else if (/release not found|HTTP 404/i.test(existing.stderr)) {
  execFileSync(
    'gh',
    [
      'release',
      'create',
      tag,
      ...args,
      '--verify-tag',
      '--draft',
      '--title',
      `家园蓝图 ${tag}`,
      '--notes-file',
      join(folder, 'release-notes.md'),
    ],
    { stdio: 'inherit' },
  );
} else throw new Error('读取发布状态失败：' + existing.stderr);
execFileSync(
  'gh',
  ['release', 'upload', tag, ...args, ...files.map((name) => join(folder, name)), '--clobber'],
  { stdio: 'inherit' },
);
const uploaded = JSON.parse(
  execFileSync('gh', ['release', 'view', tag, ...args, '--json', 'assets'], { encoding: 'utf8' }),
);
for (const name of files)
  if (
    !uploaded.assets.some(
      (asset) =>
        asset.name === name && asset.size === sizes.get(name) && asset.state === 'uploaded',
    )
  )
    throw new Error('发行附件上传不完整：' + name);
verifyRemoteTag();
execFileSync('gh', ['release', 'edit', tag, ...args, '--draft=false', '--latest'], {
  stdio: 'inherit',
});
console.log('首版全部客户端、源码和离线页已发布。');
