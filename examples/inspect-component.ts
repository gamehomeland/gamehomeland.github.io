import { mkdir, writeFile } from 'node:fs/promises';
import {
  exportImage,
  createPackage,
  decodeBlueprint,
  walkNodes,
  type BlueprintNode,
} from '../packages/core/src/index.js';

// 四格足以观察完整资源、挂接和文件结构，避免从数万个节点开始阅读。
const result = exportImage(
  {
    width: 2,
    height: 2,
    rgba: new Uint8Array([
      220, 70, 80, 255, 245, 210, 70, 255, 70, 160, 120, 255, 70, 110, 210, 255,
    ]),
  },
  { orientation: 'wall', longEdgeM: 2, maxGridEdge: 2, maxFurniture: 64 },
);
const decoded = decodeBlueprint(result.blueprint);
const names: Record<number, string> = {
  0: 'Model',
  3: 'GroupModel',
  5: 'PlaneContainer',
  6: 'SlotContainer',
  7: 'MultiPlaneContainer',
  8: 'HolderModel',
};
const rows: Record<string, unknown>[] = [];
function visit(node: BlueprintNode, path: string): void {
  rows.push({
    path,
    type: names[node.type] ?? node.type,
    instanceId: node.instanceId,
    resourceId: node.representId,
    builtin: node.builtin,
    detail: node.detail,
    anchorIndex: node.index,
    directChildren: node.children.length,
    transform: node.transform,
  });
  node.children.forEach((child, i) => visit(child, `${path}.children[${i}]`));
}
visit(decoded.root, 'root');
const report = {
  description: '从实际输出文件重新解码；变换是文件原值，不能直接当作世界坐标。',
  blueprintBytes: result.blueprint.length,
  global: decoded.global,
  nodeCount: walkNodes(decoded.root).length,
  summary: result.summary,
  materials: result.materials,
  verification: result.verification,
  nodes: rows,
};
const output = new URL('../artifacts/structure-example/', import.meta.url);
await mkdir(output, { recursive: true });
const bundle = createPackage(result);
await writeFile(new URL('four-cells.blueprintx', output), result.blueprint);
await writeFile(new URL('preview.png', output), bundle.png);
await writeFile(new URL('tree.json', output), JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify(
    {
      output: output.href,
      bytes: report.blueprintBytes,
      nodes: report.nodeCount,
      furniture: result.summary.totalCount,
      grid: [result.summary.gridWidth, result.summary.gridHeight],
      gameImportVerified: result.verification.gameImportVerified,
    },
    null,
    2,
  ),
);
