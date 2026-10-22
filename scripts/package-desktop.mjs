import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packager } from '@electron/packager';
import { zipSync } from 'fflate';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
const { values } = parseArgs({
  options: {
    platform: { type: 'string', default: process.platform },
    arch: { type: 'string', default: process.arch },
  },
});
const { platform, arch } = values;
const labels = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
if (!Object.hasOwn(labels, platform) || !['x64', 'arm64'].includes(arch))
  throw new Error('仅支持 Windows、macOS、Linux 的 x64 和 ARM64');
if (platform !== process.platform || arch !== process.arch)
  throw new Error('请在目标系统及架构构建，以便验证实际运行结果');
const root = new URL('../', import.meta.url);
await mkdir(new URL('artifacts/', root), { recursive: true });
const buildRoot = await realpath(fileURLToPath(new URL('artifacts/', root)));
// 每次使用空的临时目录，避免旧版网页和旧示例混入发行包。
const stagingPath = await mkdtemp(join(buildRoot, 'desktop-stage-'));
const stage = pathToFileURL(stagingPath + sep);
try {
  for (const name of ['main.cjs', 'policy.cjs', 'package.json'])
    await cp(new URL('apps/desktop/' + name, root), new URL(name, stage));
  await cp(new URL('apps/web/dist/', root), new URL('web/', stage), { recursive: true });
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md'])
    await cp(new URL(name, root), new URL(name, stage));
  await cp(new URL('site.config.json', root), new URL('site.config.json', stage));
  const electronPackage = JSON.parse(
    await readFile(new URL('node_modules/electron/package.json', root), 'utf8'),
  );
  const paths = await packager({
    dir: fileURLToPath(stage),
    out: fileURLToPath(new URL('artifacts/desktop/', root)),
    name: 'HomelandBlueprint',
    executableName: 'HomelandBlueprint',
    platform,
    arch,
    electronVersion: electronPackage.version,
    overwrite: true,
    asar: true,
    prune: false,
    appCopyright: 'JX3 Homeland contributors',
    ...(platform === 'win32'
      ? { win32metadata: { ProductName: '家园蓝图', FileDescription: '家园蓝图本地导出工具' } }
      : {}),
    ...(platform === 'darwin' ? { appBundleId: 'io.github.jx3homeland.blueprint' } : {}),
  });
  const launcher =
    platform === 'win32'
      ? 'HomelandBlueprint.exe'
      : platform === 'darwin'
        ? 'HomelandBlueprint.app'
        : './HomelandBlueprint';
  for (const path of paths)
    await writeFile(
      join(path, '使用说明.txt'),
      `家园蓝图 · ${labels[platform]} ${arch}\n\n完整解压后运行 ${launcher}，保留整个应用目录。\n\n图片转蓝图：选择图片，设置墙面或地面及成品长边，生成后下载完整包。\n3D家园布置：加载家具模型，选择地块，布置家具或地下室，再保存工程和蓝图。内置部分家具与地下室模型及贴图，选择后按需加载。\n保留原家园：含地下室时选择“合并到现有整屋”，载入游戏保存的原蓝图，再导出；完整包包含原文件和新增工程。\n“新建整屋”会替换整个家园，选择单个分区也不会只替换该分区。\n\n界面用于基础展示与技术参考。使用说明、家园限制及开发文档位于应用顶部。\n`,
    );
  console.log('桌面版：' + paths.join('\n'));
  if (paths.length !== 1) throw new Error('桌面打包目录数量异常');
  const archiveName = `家园蓝图-${labels[platform]}-${arch}.${platform === 'linux' ? 'tar.gz' : 'zip'}`;
  const archivePath = fileURLToPath(new URL('artifacts/' + archiveName, root));
  if (platform === 'win32') {
    const archive = {};
    async function collect(folder, prefix) {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name),
          name = prefix + entry.name;
        if (entry.isDirectory()) await collect(path, name + '/');
        else if (entry.isFile()) archive[name] = new Uint8Array(await readFile(path));
        else throw new Error('Windows 桌面目录存在未识别的文件类型');
      }
    }
    await collect(paths[0], basename(paths[0]) + '/');
    await writeFile(archivePath, zipSync(archive, { level: 6, mtime: new Date(2000, 0, 1) }));
  } else if (platform === 'darwin') {
    // .app 内含 Framework 符号链接；使用系统打包工具保留链接与权限。
    execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', paths[0], archivePath], {
      stdio: 'inherit',
    });
  } else {
    execFileSync('tar', ['-czf', archivePath, '-C', dirname(paths[0]), basename(paths[0])], {
      stdio: 'inherit',
    });
  }
  await writeFile(
    new URL('artifacts/desktop-package.json', root),
    JSON.stringify({ platform, arch, folder: basename(paths[0]), archive: archiveName }, null, 2) +
      '\n',
  );
  console.log('桌面发行包：' + archiveName);
} finally {
  const resolved = await realpath(stagingPath);
  if (dirname(resolved) !== buildRoot || !basename(resolved).startsWith('desktop-stage-'))
    throw new Error('临时构建路径异常，停止清理');
  await rm(resolved, { recursive: true, force: true });
}
