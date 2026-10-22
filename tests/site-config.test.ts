import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('部署地址配置同步 README、校验项目子路径并拒绝错误仓库', () => {
  const tempBase = realpathSync(tmpdir());
  const folder = mkdtempSync(join(tempBase, 'homeland-site-'));
  const env = { ...process.env };
  delete env.GITHUB_REPOSITORY;
  try {
    mkdirSync(join(folder, 'scripts'));
    for (const name of ['configure-site.mjs', 'site-config.mjs'])
      cpSync(new URL('../scripts/' + name, import.meta.url), join(folder, 'scripts', name));
    writeFileSync(join(folder, 'site.config.json'), '{"repositoryUrl":"","siteUrl":""}');
    writeFileSync(
      join(folder, 'README.md'),
      '# 示例\n<!-- project-links:start -->\n待配置\n<!-- project-links:end -->\n原文保留\n',
    );
    const run = (args: string[], overrides: NodeJS.ProcessEnv = {}) =>
      execFileSync(process.execPath, ['scripts/configure-site.mjs', ...args], {
        cwd: folder,
        env: { ...env, ...overrides },
        stdio: 'pipe',
      });
    assert.throws(() => run(['--check']));
    run(['--owner', 'deploy-owner']);
    assert.deepEqual(JSON.parse(readFileSync(join(folder, 'site.config.json'), 'utf8')), {
      repositoryUrl: 'https://github.com/deploy-owner/deploy-owner.github.io',
      siteUrl: 'https://deploy-owner.github.io/',
    });
    run(['--check'], { GITHUB_REPOSITORY: 'deploy-owner/deploy-owner.github.io' });
    assert.match(
      readFileSync(join(folder, 'README.md'), 'utf8'),
      /\[在线演示\]\(https:\/\/deploy-owner.github.io\/\)/,
    );
    assert.match(readFileSync(join(folder, 'README.md'), 'utf8'), /原文保留/);
    assert.throws(() => run(['--check'], { GITHUB_REPOSITORY: 'other/repo' }));
    run(['--owner', 'deploy-owner', '--repo', 'homeland']);
    run(['--check']);
    writeFileSync(
      join(folder, 'README.md'),
      readFileSync(join(folder, 'README.md'), 'utf8').replace(
        '<!-- project-links:start -->',
        '<!-- project-links:start -->\n\n',
      ),
    );
    run(['--check']);
    assert.equal(
      JSON.parse(readFileSync(join(folder, 'site.config.json'), 'utf8')).siteUrl,
      'https://deploy-owner.github.io/homeland/',
    );
    const before = readFileSync(join(folder, 'site.config.json'), 'utf8');
    assert.throws(() => run(['--owner', 'deploy-owner', '--site', 'https://other.github.io/']));
    assert.throws(() => run(['--owner', 'YOUR_GITHUB_OWNER']));
    assert.throws(() => run(['--owner', 'deploy-owner', '--site', 'javascript:alert(1)']));
    assert.equal(readFileSync(join(folder, 'site.config.json'), 'utf8'), before);
    writeFileSync(
      join(folder, 'README.md'),
      readFileSync(join(folder, 'README.md'), 'utf8').replace(
        'https://deploy-owner.github.io/homeland/',
        'https://wrong.example/',
      ),
    );
    assert.throws(() => run(['--check']));
  } finally {
    const target = realpathSync(folder);
    if (dirname(target) !== tempBase) throw new Error('临时目录超出测试范围');
    rmSync(target, { recursive: true, force: true });
  }
});
