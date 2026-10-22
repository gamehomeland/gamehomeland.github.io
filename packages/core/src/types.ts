export type Orientation = 'wall' | 'ground';
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
/** 等比缩放、四元数 XYZW、平移 XYZ。 */
export type Transform = [number, number, number, number, number, number, number, number];
export interface Variant {
  furnitureId: number;
  representId: number;
  name: string;
  sizeM: number;
  minScale: number;
  maxScale: number;
  topSocketIndex: number;
  topSocketY: number;
  surfaceY: number;
}
export interface ClothColor {
  key: string;
  rgb: Vec3;
  translucent: boolean;
  alpha: number;
  variants: Variant[];
}
export interface Recipe {
  keys: string[];
  rgb: Vec3;
  lab: Vec3;
  depth: number;
}
export interface Tile {
  x: number;
  y: number;
  side: number;
  layer: number;
  key: string;
  variant: Variant;
  scale: number;
}
export interface BlueprintNode {
  type: number;
  children: BlueprintNode[];
  flags?: number;
  instanceId?: number;
  representId?: number;
  builtin?: number;
  detail?: number;
  index?: number;
  transform?: Transform;
  /** 资源明确要求非等比变换时使用，位置/旋转仍取transform；transform[0]保持1。 */
  axisScale?: Vec3;
  /** 级联笔刷 type9 专用字段，不复用普通家具的表现编号或flags。 */
  brushId?: number;
  mask?: number;
  cascadeState?: number;
}
export interface Blueprint {
  global: boolean;
  root: BlueprintNode;
  prefix?: Uint8Array;
}
export interface RawImage {
  width: number;
  height: number;
  rgba: Uint8Array | Uint8ClampedArray;
}
export interface ExportOptions {
  orientation: Orientation;
  longEdgeM: number;
  maxFurniture?: number;
  maxGridEdge?: number;
  showRootHandle?: boolean;
  experimentalMaterials?: boolean;
  /** candidate 只用于对照试验，即使评分未提升也保留最好的新材料候选。 */
  experimentalSelection?: 'improve' | 'candidate';
}
export interface ExportProgress {
  stage: 'sample' | 'color' | 'layout' | 'verify' | 'done';
  fraction: number;
}
export type ProgressCallback = (progress: ExportProgress) => void;
export interface MaterialItem {
  id: number;
  name: string;
  count: number;
  kind: 'cloth' | 'glass' | 'support';
}
export interface ExportResult {
  blueprint: Uint8Array;
  preview: RawImage;
  materials: MaterialItem[];
  summary: {
    widthM: number;
    heightM: number;
    gridWidth: number;
    gridHeight: number;
    orientation: Orientation;
    layout: 'native' | 'miniature';
    clothCount: number;
    supportCount: number;
    totalCount: number;
    visibleLayers: number;
    showRootHandle: boolean;
    backgroundFilled: boolean;
    canvasPadded: boolean;
    paletteMode?: 'experimental-glass';
    glassCount?: number;
  };
  verification: {
    roundTrip: true;
    geometry: true;
    visibilitySamples: number;
    gameImportVerified: false;
    overlaySamples?: number;
    gameColorVerified?: false;
  };
  experimental?: {
    materialsConsidered: number;
    candidatesEvaluated: number;
    selectedMaterials: string[];
    averageDeltaEBefore: number;
    averageDeltaEAfter: number;
    qualityBefore: number;
    qualityAfter: number;
    previewModel: 'neutral-material-mean-front-view';
    gameColorVerified: false;
    comparisonGrid: [number, number];
    outputUsesOriginalLayout: boolean;
    recommended: boolean;
    candidates: { fit: boolean; overlays: number; score: number; grain: number }[];
  };
}
