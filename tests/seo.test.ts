import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { pageSeo } from '../apps/web/seo';

test('静态构建生成一致的 canonical、结构化数据和可发现的 sitemap', async () => {
  const title = '剑网3家园蓝图生成(家园拼豆)';
  const folder = mkdtempSync(join(tmpdir(), 'homeland-seo-'));
  try {
    writeFileSync(
      join(folder, 'index.html'),
      `<!doctype html><html lang="zh-CN"><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`,
    );
    for (const [siteUrl, xmlUrl, sitemapUrl] of [
      [
        'https://jx3homeland.com/',
        'https://jx3homeland.com/',
        'https://jx3homeland.com/sitemap.xml',
      ],
      [
        'https://example.test/tools&art/',
        'https://example.test/tools&amp;art/',
        'https://example.test/tools&art/sitemap.xml',
      ],
    ]) {
      const repositoryUrl = 'https://github.com/gamehomeland/gamehomeland.github.io';
      await build({
        configFile: false,
        root: folder,
        publicDir: false,
        logLevel: 'silent',
        plugins: [pageSeo({ siteUrl, repositoryUrl })],
      });
      const read = (name: string) => readFileSync(join(folder, 'dist', name), 'utf8');
      const html = read('index.html');
      assert.ok(html.includes(`<title>${title}</title>`));
      assert.ok(html.includes(`property="og:title" content="${title}"`));
      assert.ok(html.includes(`name="twitter:title" content="${title}"`));
      assert.ok(html.includes(`rel="canonical" href="${xmlUrl}"`));
      assert.ok(html.includes(`property="og:url" content="${xmlUrl}"`));
      const data = JSON.parse(
        /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1],
      );
      assert.equal(data['@context'], 'https://schema.org');
      assert.deepEqual(
        data['@graph'].map((item: { name: string }) => item.name),
        [title, title],
      );
      assert.deepEqual(
        data['@graph'].map((item: { url: string }) => item.url),
        [siteUrl, siteUrl],
      );
      assert.deepEqual(data['@graph'][1].keywords, [
        '剑网3家园蓝图',
        '剑网3家园拼豆',
        '剑网3家园拼布',
      ]);
      assert.equal(data['@graph'][1].license, repositoryUrl + '/blob/main/LICENSE');
      assert.ok(read('sitemap.xml').includes(`<loc>${xmlUrl}</loc>`));
      assert.equal((read('sitemap.xml').match(/<loc>/g) ?? []).length, 1);
      assert.equal(read('robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${sitemapUrl}\n`);
      assert.ok(read('llms.txt').includes(`[源码仓库](${repositoryUrl})`));
      assert.ok(read('llms.txt').includes(`[${title}](${siteUrl})`));
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
