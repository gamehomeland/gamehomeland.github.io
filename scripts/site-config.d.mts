export type SiteConfig = { repositoryUrl: string; siteUrl: string };

export function validateSiteConfig(value: unknown, options?: { required?: boolean }): SiteConfig;
export function projectLinks(config: SiteConfig): string;
