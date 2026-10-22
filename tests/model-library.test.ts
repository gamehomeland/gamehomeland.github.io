import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  cpSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { modelLibraryURL } from '../apps/web/src/model-library.js';
import { inspectModelFile } from '../apps/web/src/model-file.js';
import { editorResources } from '../packages/core/src/editor.js';

test('模型 URL 跟随 Pages 子路径和桌面协议，拒绝越界路径', () => {
  const cases = [
    ['https://sample.github.io/', 'https://sample.github.io/models/furniture/manifest.json'],
    [
      'https://sample.github.io/homeland/#editor',
      'https://sample.github.io/homeland/models/furniture/manifest.json',
    ],
    [
      'https://example.test/tools/index.html',
      'https://example.test/tools/models/furniture/manifest.json',
    ],
    ['homeland://app/runtime-check.html', 'homeland://app/models/furniture/manifest.json'],
  ];
  for (const [base, expected] of cases)
    assert.equal(modelLibraryURL('furniture/manifest.json', base)?.href, expected);
  assert.equal(modelLibraryURL('furniture/manifest.json', 'file:///tmp/offline.html'), undefined);
  assert.throws(() => modelLibraryURL('../private/file.glb', cases[0][0]));
  assert.throws(() => modelLibraryURL('furniture/a.glb', cases[0][0], 'bad-hash'));
  assert.equal(
    modelLibraryURL('basement/basement-74.glb', cases[1][0], 'a'.repeat(64))?.searchParams.get('v'),
    'a'.repeat(64),
  );
});

test('压缩材质 GLB 可被实际导入检查器接受，旧绑定仍可识别', () => {
  const bytes = readFileSync(new URL('../assets/models/furniture/model-4.glb', import.meta.url));
  const result = inspectModelFile(Uint8Array.from(bytes).buffer);
  assert.equal(result.geometryOnly, false);
  assert.ok(result.json.images.some((i: { mimeType: string }) => i.mimeType === 'image/webp'));
  assert.ok(result.json.extensionsRequired.includes('EXT_texture_webp'));
  const chair = editorResources.find((r) => r.representId === 19315)!;
  assert.ok(
    chair.modelSha256Aliases?.includes(
      '78b106b6f305c66db0887dc5b79e838715851dcac0085646aa7576a8fa9f0715',
    ),
  );
});

test('新增模型脚本保留既有清单和资源编号，重复身份不能覆盖库', () => {
  const base = realpathSync(tmpdir()),
    folder = mkdtempSync(join(base, 'homeland-library-'));
  try {
    mkdirSync(join(folder, 'scripts'));
    mkdirSync(join(folder, 'input'));
    mkdirSync(join(folder, 'assets/models/furniture'), { recursive: true });
    for (const file of ['model-library.mjs', 'prepare-furniture.mjs'])
      cpSync(new URL('../scripts/' + file, import.meta.url), join(folder, 'scripts', file));
    const source = new URL('../assets/models/furniture/model-2.glb', import.meta.url);
    cpSync(source, join(folder, 'input/new.glb'));
    const old = {
      file: 'old.glb',
      name: '旧家具',
      category: '示例',
      note: '',
      sha256: '1'.repeat(64),
    };
    writeFileSync(join(folder, 'assets/models/furniture/manifest.json'), JSON.stringify([old]));
    const input = {
      file: 'new.glb',
      name: '新家具',
      category: '示例',
      note: '',
      resourceId: 12345,
    };
    writeFileSync(join(folder, 'input/manifest.json'), JSON.stringify([input]));
    const run = () =>
      execFileSync(process.execPath, ['scripts/prepare-furniture.mjs', 'input/manifest.json'], {
        cwd: folder,
        stdio: 'pipe',
      });
    run();
    const path = join(folder, 'assets/models/furniture/manifest.json');
    const rows = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(rows[0], old);
    assert.equal(rows[1].resourceId, 12345);
    assert.match(rows[1].sha256, /^[0-9a-f]{64}$/);
    run();
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).length, 2);
    cpSync(source, join(folder, 'input/duplicate.glb'));
    writeFileSync(
      join(folder, 'input/manifest.json'),
      JSON.stringify([{ ...input, file: 'duplicate.glb' }]),
    );
    const before = readFileSync(path, 'utf8');
    assert.throws(run);
    assert.equal(readFileSync(path, 'utf8'), before);
  } finally {
    const target = realpathSync(folder);
    if (dirname(target) !== base) throw new Error('临时目录范围无效');
    rmSync(target, { recursive: true, force: true });
  }
});
