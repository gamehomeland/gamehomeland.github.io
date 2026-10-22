import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const info = JSON.parse(await readFile(join(root, 'artifacts/desktop-package.json'), 'utf8'));
if (
  info.platform !== process.platform ||
  info.arch !== process.arch ||
  info.folder !== `HomelandBlueprint-${process.platform}-${process.arch}`
)
  throw new Error('当前运行环境与打包目标不一致');
const binary =
  process.platform === 'win32'
    ? 'HomelandBlueprint.exe'
    : process.platform === 'darwin'
      ? 'HomelandBlueprint.app/Contents/MacOS/HomelandBlueprint'
      : 'HomelandBlueprint';
const resultPath = join(root, `artifacts/desktop-tests-${process.platform}-${process.arch}.json`);
await rm(resultPath, { force: true });
try {
  await promisify(execFile)(join(root, 'artifacts/desktop', info.folder, binary), ['--self-test'], {
    env: { ...process.env, HOMELAND_TEST_RESULT: resultPath },
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
} catch (error) {
  console.error(String(error.stderr || error.message).slice(-12000));
  throw new Error('打包客户端的实际运行验证失败');
}
const result = JSON.parse(await readFile(resultPath, 'utf8'));
if (
  !result.ok ||
  !result.packaged ||
  result.rendererNodeAvailable ||
  result.platform !== process.platform ||
  result.arch !== process.arch ||
  result.cases?.length !== 9
)
  throw new Error('桌面验证结果不完整或运行策略不符');
console.log(
  `${process.platform}/${process.arch}：打包客户端完成 ${result.cases.length} 组真实导出检查。`,
);
