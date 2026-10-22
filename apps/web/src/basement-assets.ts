import { LoadingManager, Mesh, Material, Plane, Vector3, type Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { basementModelResources } from '../../../packages/core/src/basement.js';
import { inspectModelFile } from './model-file.js';
import { ModelAsset } from './model-assets.js';

/** 每种材质一个24形态模型包；实例共享几何和贴图，仅保存各自变换。 */
export class BasementAssets {
  private packs = new Map<number, ModelAsset>();
  private variants = new Map<number, Map<number, Object3D>>();
  private plane = new Plane(new Vector3(0, -1, 0), 0);
  private clipping = false;
  private disposed = false;
  constructor(private anisotropy: number) {}
  has(id: number) {
    return this.packs.has(id);
  }
  async register(bytes: ArrayBuffer) {
    inspectModelFile(bytes);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) =>
      v.toString(16).padStart(2, '0'),
    ).join('');
    const resource = basementModelResources.find(
      (r) => r.modelSha256 === hash || r.modelSha256Aliases?.includes(hash),
    );
    if (!resource) throw new Error('此文件不是当前目录绑定的地下室模型包');
    if (this.has(resource.brushId)) return resource.brushId;
    const manager = new LoadingManager();
    manager.setURLModifier((url) => {
      if (!url.startsWith('blob:')) throw new Error('地下室模型不能读取外部资源');
      return url;
    });
    const gltf = await new GLTFLoader(manager).parseAsync(bytes, '');
    const asset = new ModelAsset(gltf, this.anisotropy),
      variants = new Map<number, Object3D>();
    for (const node of gltf.scene.children) {
      const index = node.userData.basementVariant;
      if (!Number.isInteger(index) || index < 0 || index >= 24 || variants.has(index)) {
        asset.dispose();
        throw new Error('地下室模型形态数据无效');
      }
      variants.set(index, node);
    }
    if (variants.size !== 24 || this.disposed) {
      asset.dispose();
      throw new Error('地下室模型未完整载入');
    }
    if (this.has(resource.brushId)) {
      asset.dispose();
      return resource.brushId;
    }
    this.packs.set(resource.brushId, asset);
    this.variants.set(resource.brushId, variants);
    this.applyClipping(asset);
    return resource.brushId;
  }
  clone(brushId: number, index: number) {
    return this.variants.get(brushId)?.get(index)?.clone(true);
  }
  setSlice(y?: number) {
    const was = this.clipping;
    this.clipping = y !== undefined;
    this.plane.constant = (y ?? 0) - 0.01;
    if (was !== this.clipping) for (const a of this.packs.values()) this.applyClipping(a);
  }
  private applyClipping(asset: ModelAsset) {
    const seen = new Set<Material>();
    asset.root.traverse((o) => {
      if (o instanceof Mesh)
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) seen.add(m);
    });
    for (const material of seen) {
      material.clippingPlanes = this.clipping ? [this.plane] : [];
      material.needsUpdate = true;
    }
  }
  dispose() {
    this.disposed = true;
    for (const a of this.packs.values()) a.dispose();
    this.packs.clear();
    this.variants.clear();
  }
}
