import { readFile, mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { colors } from '../packages/core/src/catalog.js';
import { assemble, objectNode, socketNode, importOrientation, undoImport, placedNodes } from '../packages/core/src/component.js';
import { encodeBlueprint, decodeBlueprint } from '../packages/core/src/codec.js';
import type { BlueprintNode } from '../packages/core/src/types.js';

// 真实家具试色板；仅用于游戏内核对，不接入自动配色。
const research = JSON.parse(await readFile(new URL('../docs/material-candidates.json', import.meta.url), 'utf8'));
const selected = ['灰2', '灰4', '红5', '黄4', '绿3', '蓝2'];
const bases = selected.map((key) => {
  const color = colors.find((c) => c.key === key && !c.translucent);
  if (!color) throw new Error('试色底色缺失：' + key);
  return color;
});
const candidates = research.candidates;
const nodes: BlueprintNode[] = [];
const records: { id: number; resource: number; scale: number; x: number; y: number; z: number }[] = [];
let next = 1;
function add(resource: number, scale: number, x: number, y: number, z: number, planeCount: number) {
  const id = next++;
  records.push({ id, resource, scale, x, y, z });
  nodes.push(objectNode(0, id, resource, [scale, 0, 0, 0, 1, x, y, z],
    Array.from({ length: planeCount }, (_, i) => socketNode(i))));
}
for (let row = 0; row < bases.length; row++) {
  const base = bases[row].variants.find((v) => v.sizeM === 2)!;
  for (let column = 0; column <= candidates.length; column++) {
    const x = (candidates.length / 2 - column) * 240;
    const z = (row - (bases.length - 1) / 2) * 240;
    add(base.representId, 1, x, 0, z, 2);
    if (column) {
      const candidate = candidates[column - 1];
      const variant = candidate.variants.find((v: { name: string }) => v.name.endsWith('2米'));
      const scale = variant.geometry === 'irregular-mesh' ? .25 : .5;
      assert(scale >= variant.scaleRange[0] && scale <= variant.scaleRange[1]);
      add(variant.representId, scale, x, 5, z, variant.planeCount);
    }
  }
}
const groups = [];
for (let p = 0; p < nodes.length; p += 50) groups.push(nodes.slice(p, p + 50));
const root = assemble(groups, next, [0, 0, 60], [0, 0, 60], true);
importOrientation(root, 'ground');
const bytes = encodeBlueprint({ global: false, root });
const decoded = decodeBlueprint(bytes);
assert.deepEqual(encodeBlueprint(decoded), bytes);
undoImport(decoded.root, 'ground', false);
const placed = new Map(placedNodes(decoded.root).map((v) => [v.node.instanceId, v]));
for (const expected of records) {
  const actual = placed.get(expected.id)!;
  assert.equal(actual.node.representId, expected.resource);
  assert(Math.abs(actual.node.transform![0] - expected.scale) < 1e-5);
  for (const [i, key] of ['x', 'y', 'z'].entries())
    assert(Math.abs(actual.position[i] - expected[key as 'x' | 'y' | 'z']) < .001);
}
const guide = `彩色透明材料试色板\n\n这是地面试色组件，约 16.4 × 14 米；请在有空地的设计场导入。\n从指定观察侧看，第一列为单独底色，后面依次是：${candidates.map((c: { name: string }) => c.name).join('、')}。\n行底色依次为：${selected.join('、')}。\n每格的透明材料只覆盖中间一部分，周围留底色作对照；玄雾是异形板，形状不同。\n\n已检查文件校验、资源编号、合法缩放、数量和位置回读。尚未完成游戏内导入与颜色核对。\n请固定画质、天气、时辰和观察方向，比较同一格的底色与覆盖部分。\n透明面是单面的；反面不可见，且实际颜色还受反射、阴影、透明排序影响。\n本试色板不会改变图片转换使用的正式色卡。\n`;
const output = new URL('../artifacts/material-board/', import.meta.url);
await mkdir(output, { recursive: true });
const escapeXml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1160" height="650" viewBox="0 0 1160 650"><rect width="1160" height="650" fill="#fffef8"/><g font-family="Microsoft YaHei,sans-serif" fill="#24382e"><text x="24" y="36" font-size="23">彩色材料试色布局</text><text x="24" y="63" font-size="14">颜色为中性模型估算；不是游戏截图。每格周围是底色，中间是透明材料覆盖区。</text>';
const labels = ['底色对照', ...candidates.map((c: { name: string }) => c.name.replace('琉璃七巧·', '').replace('琉璃·', ''))];
labels.forEach((label, i) => { svg += `<text x="${106+i*145}" y="103" font-size="15">${escapeXml(label)}</text>`; });
for (let row = 0; row < bases.length; row++) {
  svg += `<text x="24" y="${148+row*76}" font-size="16">${selected[row]}</text>`;
  for (let column = 0; column <= candidates.length; column++) {
    const x = 100+column*145, y = 120+row*76;
    svg += `<rect x="${x}" y="${y}" width="125" height="58" fill="rgb(${bases[row].rgb.join(',')})"/>`;
    if (column) {
      const recipe = candidates[column-1].recipes.find((r: { base: string }) => r.base === selected[row]);
      svg += `<rect x="${x+22}" y="${y+12}" width="81" height="34" fill="rgb(${recipe.rgb.join(',')})"/>`;
    }
  }
}
svg += '<text x="24" y="611" font-size="14">玄雾使用异形板，图中矩形只标识取样区域；请以导入后的真实模型为准。</text></g></svg>';
await writeFile(new URL('彩色材料试色板.blueprintx', output), bytes);
await writeFile(new URL('试色说明.txt', output), guide);
await writeFile(new URL('试色布局.svg', output), svg);
await writeFile(new URL('verification.json', output), JSON.stringify({
  roundTrip: true, positions: records.length, gameImportVerified: false, gameColorVerified: false,
  columns: ['底色', ...candidates.map((c: { name: string }) => c.name)], rows: selected,
  resources: records,
}, null, 2));
await writeFile(new URL('../jx3-homeland-material-board.zip', output), zipSync({
  '彩色材料试色板.blueprintx': bytes, '试色说明.txt': strToU8(guide),
  '试色布局.svg': strToU8(svg),
}, { level: 6 }));
console.log(JSON.stringify({ samples: bases.length * candidates.length, objects: records.length, bytes: bytes.length, gameImportVerified: false }));
