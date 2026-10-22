import { BLUEPRINT_LIMITS } from './codec.js';
import { GROUP_SIZE, supportCount } from './component.js';

/** 本导出器的对象结构成本，不是玩家家园容量。 */
export function structureCost(clothCount: number): {
  furniture: number;
  nodes: number;
  maxBytes: number;
} {
  if (!Number.isSafeInteger(clothCount) || clothCount < 0) throw new Error('家具数量无效');
  const bases = supportCount(clothCount);
  // 拼布: 模型 + 两个挂面；基座: 预制体 + 内建模型 + 两个挂面；根 Holder 一个。
  const nodes = 3 * clothCount + 4 * bases + 1;
  // V7：拼布 49+5+5；非空拼布挂面另加 32；基座 49+49+5+37；文件/根/摘要共70。
  const maxBytes = 59 * clothCount + 32 * Math.ceil(clothCount / GROUP_SIZE) + 140 * bases + 70;
  return { furniture: clothCount + bases, nodes, maxBytes };
}

function maximumOutput(): number {
  let low = 0,
    high = Math.floor((BLUEPRINT_LIMITS.nodes - 1) / 3);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2),
      cost = structureCost(mid);
    if (cost.nodes <= BLUEPRINT_LIMITS.nodes && cost.maxBytes <= BLUEPRINT_LIMITS.bytes) low = mid;
    else high = mid - 1;
  }
  return low;
}

export const MAX_CLOTH_TILES = maximumOutput();
export const MAX_OUTPUT_FURNITURE = structureCost(MAX_CLOTH_TILES).furniture;
export const MIN_OUTPUT_FURNITURE = structureCost(1).furniture;
/** 采样轴保护值；二维总量还受节点和字节预算约束。 */
export const MAX_GRID_EDGE = 512;
