import type { Plugin } from 'vite';
import { type SiteConfig, validateSiteConfig } from '../../scripts/site-config.mjs';

const title = '剑网3家园蓝图';
const description =
  '剑网3家园蓝图在线工具，支持剑网3家园拼豆、剑网3家园拼布图案制作，图片转墙面画与地面蓝图，提供3D家具布置、地下室编辑及蓝图导出。图片在本机处理，无需上传；仅展示部分功能，实际效果需在游戏内核对。';

export function pageSeo(config: SiteConfig): Plugin {
  const { siteUrl, repositoryUrl } = validateSiteConfig(config, { required: true });
  const sitemapUrl = new URL('sitemap.xml', siteUrl).href;
  return {
    name: 'page-seo',
    transformIndexHtml() {
      return [
        { tag: 'link', attrs: { rel: 'canonical', href: siteUrl } },
        ...Object.entries({
          robots: 'index,follow,max-image-preview:large,max-snippet:-1',
          'twitter:card': 'summary',
          'twitter:title': title,
          'twitter:description': description,
        }).map(([name, content]) => ({ tag: 'meta', attrs: { name, content } })),
        ...Object.entries({
          'og:type': 'website',
          'og:locale': 'zh_CN',
          'og:site_name': title,
          'og:title': title,
          'og:description': description,
          'og:url': siteUrl,
        }).map(([property, content]) => ({ tag: 'meta', attrs: { property, content } })),
        {
          tag: 'script',
          attrs: { type: 'application/ld+json' },
          children: JSON.stringify({
            '@context': 'https://schema.org',
            '@graph': [
              {
                '@type': 'WebSite',
                '@id': siteUrl + '#website',
                name: title,
                url: siteUrl,
                inLanguage: 'zh-CN',
              },
              {
                '@type': 'WebApplication',
                '@id': siteUrl + '#application',
                name: title,
                url: siteUrl,
                description,
                keywords: ['剑网3家园蓝图', '剑网3家园拼豆', '剑网3家园拼布'],
                inLanguage: 'zh-CN',
                applicationCategory: 'DesignApplication',
                operatingSystem: 'Web browser',
                isAccessibleForFree: true,
                license: repositoryUrl + '/blob/main/LICENSE',
                softwareHelp: siteUrl + '#site-guide-title',
                featureList: [
                  '图片转蓝图',
                  '拼布配色',
                  '墙面画与地面图案',
                  '3D家具布置',
                  '地下室编辑',
                ],
              },
            ],
          }).replaceAll('<', '\\u003c'),
        },
      ];
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'robots.txt',
        source: `User-agent: *\nAllow: /\n\nSitemap: ${sitemapUrl}\n`,
      });
      this.emitFile({
        type: 'asset',
        fileName: 'sitemap.xml',
        source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${siteUrl.replaceAll('&', '&amp;')}</loc></url>\n</urlset>\n`,
      });
      this.emitFile({
        type: 'asset',
        fileName: 'llms.txt',
        source: `# ${title}\n\n> ${description}\n\n## 在线工具\n\n- [剑网3家园蓝图](${siteUrl})：剑网3家园拼豆、剑网3家园拼布与图片转蓝图。\n- [制作说明](${siteUrl}#site-guide-title)：选择图片与尺寸、生成预览、下载蓝图及家具清单。\n\n## 使用范围\n\n- 图片在本机浏览器内处理，不上传图片，无需注册或登录。\n- 支持墙面画、地面图案，以及部分家具和地下室的 3D 布置与导出。\n- 网页仅展示部分家园功能，不是完整的游戏家园编辑器。\n- 游戏内效果、家具库存、容量、导入类型和保存结果需要玩家实际核对。\n\n## 开源资料\n\n- [源码仓库](${repositoryUrl})\n- [使用说明](${repositoryUrl}/blob/main/docs/00-user-guide.md)\n`,
      });
    },
  };
}
