import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { validateSiteConfig, projectLinks } from './site-config.mjs';

const root = new URL('../', import.meta.url);
const { values } = parseArgs({
  options: {
    owner: { type: 'string' },
    repo: { type: 'string' },
    site: { type: 'string' },
    check: { type: 'boolean', default: false },
  },
});
const readmeURL = new URL('README.md', root);
const configURL = new URL('site.config.json', root);
const readme = (await readFile(readmeURL, 'utf8')).replace(/\r\n/g, '\n');
const marker = /<!-- project-links:start -->[\s\S]*?<!-- project-links:end -->/;
if (
  (readme.match(/<!-- project-links:start -->/g) ?? []).length !== 1 ||
  (readme.match(/<!-- project-links:end -->/g) ?? []).length !== 1 ||
  !marker.test(readme)
)
  throw new Error('README.md 缺少唯一的 project-links 地址区块');

if (values.check) {
  if (values.owner || values.repo || values.site)
    throw new Error('--check 只检查现有配置，请与配置参数分开执行');
  const config = validateSiteConfig(JSON.parse(await readFile(configURL, 'utf8')), {
    required: true,
  });
  if (readme.match(marker)[0].replace(/\s+/g, ' ') !== projectLinks(config).replace(/\s+/g, ' '))
    throw new Error('README.md 链接与 site.config.json 不一致，请重新运行地址配置命令');
  const actualRepo = process.env.GITHUB_REPOSITORY;
  if (
    actualRepo &&
    config.repositoryUrl.toLowerCase() !== `https://github.com/${actualRepo}`.toLowerCase()
  )
    throw new Error('发布配置与本次 GitHub Actions 仓库不一致，请在提交前更新地址');
  console.log(`发布地址检查通过\n网页：${config.siteUrl}\n仓库：${config.repositoryUrl}`);
} else {
  if (!values.owner)
    throw new Error(
      '用法：node scripts/configure-site.mjs --owner GitHub用户名 [--repo 仓库名] [--site HTTPS网页地址]',
    );
  const owner = values.owner;
  const repo = values.repo ?? `${owner.toLowerCase()}.github.io`;
  const host = `${owner.toLowerCase()}.github.io`;
  const siteUrl = values.site ?? `https://${host}/${repo.toLowerCase() === host ? '' : repo + '/'}`;
  const config = validateSiteConfig(
    { repositoryUrl: `https://github.com/${owner}/${repo}`, siteUrl },
    { required: true },
  );
  await writeFile(configURL, JSON.stringify(config, null, 2) + '\n');
  await writeFile(readmeURL, readme.replace(marker, projectLinks(config)));
  console.log(
    `已更新 site.config.json 和 README.md\n网页：${config.siteUrl}\n仓库：${config.repositoryUrl}\n重新构建后，网页的“开源仓库”入口将使用此地址。`,
  );
}
