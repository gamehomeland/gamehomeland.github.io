/** 相对页面目录加载，兼容账号主页、项目子路径和桌面只读协议。 */
export function modelLibraryURL(path: string, pageURL: string, hash?: string): URL | undefined {
  if (!/^(furniture|basement)\/(manifest\.json|[\w-]+\.glb)$/.test(path))
    throw new Error('模型库路径无效');
  const page = new URL(pageURL);
  if (!['http:', 'https:', 'homeland:'].includes(page.protocol)) return undefined;
  const result = new URL('models/' + path, page);
  if (hash) {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('模型摘要无效');
    result.searchParams.set('v', hash);
  }
  return result;
}
