/** 网页按需加载；离线构建将此适配层替换为同文件内的静态模块。 */
export async function loadViewer() {
  return (await import('./preview3d.js')).BlueprintViewer;
}
export async function loadFurnitureViewer() {
  return (await import('./furniture3d.js')).FurnitureViewer;
}
export async function loadSceneViewer() {
  return (await import('./scene-viewer.js')).SceneViewer;
}
