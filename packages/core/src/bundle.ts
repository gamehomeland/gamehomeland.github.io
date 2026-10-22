import { zipSync, strToU8 } from 'fflate';
import type { ExportResult } from './types.js';
import { encodePng } from './png.js';

export const PACKAGE_NAMES = [
  '家园蓝图.blueprintx',
  '效果预览.png',
  '家具清单.txt',
  '使用说明.txt',
] as const;
export function materialText(result: ExportResult): string {
  const lines = [
    '家具清单',
    '',
    `共需 ${result.summary.totalCount.toLocaleString('zh-CN')} 件家具`,
    '',
    '拼布',
  ];
  for (const row of result.materials.filter((x) => x.kind === 'cloth'))
    lines.push(`${row.name} × ${row.count.toLocaleString('zh-CN')} 件`);
  const glass = result.materials.filter((x) => x.kind === 'glass');
  if (glass.length) {
    lines.push('', '彩色透明材料');
    for (const row of glass) lines.push(`${row.name} × ${row.count.toLocaleString('zh-CN')} 件`);
  }
  lines.push('', '基座');
  for (const row of result.materials.filter((x) => x.kind === 'support'))
    lines.push(`${row.name} × ${row.count.toLocaleString('zh-CN')} 件`);
  lines.push('', '已有库存可复用，请按缺少的数量补齐家具。');
  return lines.join('\n') + '\n';
}
export function guideText(result: ExportResult): string {
  const s = result.summary,
    lines = [
      '家园蓝图',
      '',
      `摆放：${s.orientation === 'wall' ? '墙面' : '地面'}`,
      `尺寸：${s.widthM} × ${s.heightM} 米`,
      `所需家具：${s.totalCount.toLocaleString('zh-CN')} 件`,
      '',
      '导入步骤',
      '1. 解压完整包。',
      '2. 按“家具清单.txt”补齐家具，留出足够的空间和家具容量。',
      '3. 在家园的局部组件入口，选择“家园蓝图.blueprintx”。',
      '4. 调整位置和方向，确认后保存。',
      '',
      '移动或旋转时请选择整个组件，避免拆散图案。',
      s.orientation === 'wall'
        ? '墙面画从正面查看，游戏光照会影响颜色。'
        : '地面图从上方查看，游戏光照会影响颜色。',
    ];
  if (s.backgroundFilled) lines.push('原图透明区域已填充白色背景。');
  if (s.canvasPadded) lines.push('为保留完整图案，已添加画布留白。');
  if (s.paletteMode === 'experimental-glass')
    lines.push(
      '',
      '本蓝图采用试验配色。预览基于正视角度与中性光照，透明材料的游戏显示效果需进行实景验证。',
      '请先在设计场试放，确认透明面的朝向、颜色及接缝，再用于正式家园。',
    );
  return lines.join('\n') + '\n';
}
export function createPackage(result: ExportResult): {
  zip: Uint8Array;
  png: Uint8Array;
  materials: string;
  guide: string;
} {
  const scale = Math.max(
      1,
      Math.floor(720 / Math.max(result.preview.width, result.preview.height)),
    ),
    png = encodePng(result.preview, scale);
  const materials = materialText(result),
    guide = guideText(result);
  const zip = zipSync(
    {
      '家园蓝图.blueprintx': result.blueprint,
      '效果预览.png': png,
      '家具清单.txt': strToU8(materials),
      '使用说明.txt': strToU8(guide),
    },
    { level: 6, mtime: new Date(2000, 0, 1) },
  );
  return { zip, png, materials, guide };
}
