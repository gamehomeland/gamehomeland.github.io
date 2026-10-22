/** 发布地址由部署者配置；留空时仍可本地构建。 */
export function validateSiteConfig(value, { required = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('site.config.json 必须是对象');
  const { repositoryUrl, siteUrl } = value;
  if (typeof repositoryUrl !== 'string' || typeof siteUrl !== 'string')
    throw new Error('repositoryUrl 和 siteUrl 必须是字符串');
  if (!repositoryUrl && !siteUrl && !required) return { repositoryUrl, siteUrl };
  const repository =
    /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+)$/.exec(
      repositoryUrl,
    );
  if (!repository || repository[2].endsWith('.git') || ['.', '..'].includes(repository[2]))
    throw new Error('请配置实际 GitHub 仓库地址：https://github.com/用户名/仓库名');
  let site;
  try {
    site = new URL(siteUrl);
  } catch {
    throw new Error('请配置实际网页地址：https://用户名.github.io/');
  }
  if (
    site.protocol !== 'https:' ||
    site.username ||
    site.password ||
    site.port ||
    site.search ||
    site.hash ||
    !siteUrl.endsWith('/') ||
    site.href !== siteUrl ||
    /[\s<>"'`\\]/.test(siteUrl)
  )
    throw new Error('网页地址必须为规范的 HTTPS 地址，以 / 结尾，不含账号、端口、查询或片段');
  if (site.hostname.endsWith('.github.io')) {
    const [, owner, repo] = repository;
    const host = owner.toLowerCase() + '.github.io';
    const path = repo.toLowerCase() === host ? '/' : '/' + repo + '/';
    if (site.hostname !== host || site.pathname !== path)
      throw new Error('GitHub Pages 地址与仓库不匹配，请核对账号和仓库名');
  }
  return { repositoryUrl, siteUrl };
}

export function projectLinks(config) {
  return `<!-- project-links:start -->\n\n[在线演示](${config.siteUrl}) · [源码仓库](${config.repositoryUrl})\n<!-- project-links:end -->`;
}
