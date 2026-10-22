import {
  ACESFilmicToneMapping,
  Box3,
  DirectionalLight,
  Group,
  HemisphereLight,
  Material,
  Mesh,
  Object3D,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Texture,
  Vector3,
  WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';

/** 按投影后的包围盒取景，横长或扁平家具不会被包围球缩成一小团。 */
export function modelViewDistance(
  box: Box3,
  direction: Vector3,
  up: Vector3,
  fov: number,
  aspect: number,
) {
  const center = box.getCenter(new Vector3()),
    right = new Vector3().crossVectors(up, direction).normalize(),
    vertical = new Vector3().crossVectors(direction, right).normalize();
  const tanY = Math.tan((fov * Math.PI) / 360),
    tanX = tanY * Math.max(aspect, 0.05);
  let distance = 0.02;
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z]) {
        const v = new Vector3(x, y, z).sub(center);
        distance = Math.max(
          distance,
          v.dot(direction) +
            Math.max(Math.abs(v.dot(right)) / tanX, Math.abs(v.dot(vertical)) / tanY),
        );
      }
  return distance * 1.12;
}

/** 中性棚光提供金属反射；游戏环境、天气和后处理并不包含在GLB里。 */
export function modelLighting(renderer: WebGLRenderer, scene: Scene) {
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  const environment = new RoomEnvironment(),
    pmrem = new PMREMGenerator(renderer);
  const target = pmrem.fromScene(environment, 0.04);
  environment.dispose();
  pmrem.dispose();
  scene.environment = target.texture;
  scene.environmentIntensity = 0.85;
  const sun = new DirectionalLight(0xfffaf5, 1.7);
  sun.position.set(5, 8, 6);
  const fill = new HemisphereLight(0xffffff, 0x737987, 0.65);
  scene.add(sun, fill);
  return () => {
    scene.environment = null;
    target.dispose();
    scene.remove(sun, fill);
  };
}

/** 按需载入材质方案，同一几何的不同实例可以各用不同样式。 */
export class ModelAsset {
  readonly root: Group;
  readonly styles: string[];
  readonly defaultDetail: number;
  private materials = new Set<Material>();
  private versions = new WeakMap<Object3D, number>();
  private disposed = false;
  constructor(
    private gltf: GLTF,
    private anisotropy = 8,
  ) {
    this.root = gltf.scene;
    const json = gltf.parser.json;
    this.styles = (json.extensions?.KHR_materials_variants?.variants ?? []).map(
      (v: { name?: unknown }, i: number) =>
        typeof v.name === 'string' ? v.name.slice(0, 80) : `样式 ${i}`,
    );
    if (!this.styles.length) this.styles = ['原始样式'];
    this.defaultDetail = Number.isInteger(json.extras?.defaultDetail)
      ? json.extras.defaultDetail
      : 0;
    this.root.traverse((node) => {
      const mesh = node as Mesh;
      if (!mesh.isMesh) return;
      const ref = gltf.parser.associations.get(mesh) as
        { meshes?: number; primitives?: number } | undefined;
      const primitive =
        ref?.meshes !== undefined && ref.primitives !== undefined
          ? json.meshes[ref.meshes].primitives[ref.primitives]
          : undefined;
      const ids = Array(this.styles.length).fill(primitive?.material ?? -1);
      for (const mapping of primitive?.extensions?.KHR_materials_variants?.mappings ?? [])
        for (const index of mapping.variants ?? [])
          if (
            Number.isInteger(index) &&
            index >= 0 &&
            index < ids.length &&
            Number.isInteger(mapping.material) &&
            mapping.material >= 0 &&
            mapping.material < json.materials.length
          )
            ids[index] = mapping.material;
      mesh.userData.homelandMaterialIds = ids;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) this.track(m);
    });
  }
  private track(material: Material) {
    this.materials.add(material);
    for (const value of Object.values(material))
      if (value instanceof Texture) value.anisotropy = this.anisotropy;
  }
  clone() {
    return this.root.clone(true);
  }
  async apply(root: Object3D, detail: number) {
    if (this.disposed) return;
    const sequence = (this.versions.get(root) ?? 0) + 1;
    this.versions.set(root, sequence);
    const index = detail >= 0 && detail < this.styles.length ? detail : this.defaultDetail;
    const changes: Promise<{ mesh: Mesh; material: Material }>[] = [];
    root.traverse((node) => {
      const mesh = node as Mesh,
        ids = mesh.userData.homelandMaterialIds;
      if (!mesh.isMesh || !Array.isArray(ids) || ids[index] < 0) return;
      changes.push(
        this.gltf.parser.getDependency('material', ids[index]).then((material: Material) => {
          this.track(material);
          return { mesh, material };
        }),
      );
    });
    const loaded = await Promise.all(changes);
    if (this.disposed) {
      this.releaseMaterials();
      return;
    }
    if (this.versions.get(root) !== sequence) return;
    for (const { mesh, material } of loaded) {
      mesh.material = material;
      this.gltf.parser.assignFinalMaterial(mesh);
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) this.track(m);
    }
  }
  private releaseMaterials() {
    const textures = new Set<Texture>();
    for (const material of this.materials) {
      for (const value of Object.values(material))
        if (value instanceof Texture) textures.add(value);
      material.dispose();
    }
    for (const texture of textures) {
      texture.dispose();
      if (texture.source.data instanceof ImageBitmap) texture.source.data.close();
    }
    this.materials.clear();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const geometries = new Set<any>();
    this.root.traverse((node) => {
      const mesh = node as Mesh;
      if (mesh.geometry) geometries.add(mesh.geometry);
    });
    for (const g of geometries) g.dispose();
    this.releaseMaterials();
  }
}
