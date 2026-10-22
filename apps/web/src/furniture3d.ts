import {
  Box3,
  Color,
  GridHelper,
  Group,
  LoadingManager,
  Material,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Texture,
  Vector3,
  WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { inspectModelFile } from './model-file.js';
import { ModelAsset, modelLighting, modelViewDistance } from './model-assets.js';

export interface ModelInfo {
  size: number[];
  meshes: number;
  vertices: number;
  triangles: number;
  geometryOnly: boolean;
  styles: string[];
  defaultDetail: number;
}
function disposeTree(root: Group) {
  const geometries = new Set<unknown>(),
    materials = new Set<Material>(),
    textures = new Set<Texture>();
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (mesh.geometry && !geometries.has(mesh.geometry)) {
      geometries.add(mesh.geometry);
      mesh.geometry.dispose();
    }
    if (mesh.material)
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
        materials.add(material);
  });
  for (const material of materials) {
    for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
    material.dispose();
  }
  for (const texture of textures) {
    texture.dispose();
    if (texture.source.data instanceof ImageBitmap) texture.source.data.close();
  }
}

export class FurnitureViewer {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(35, 1, 0.01, 1000);
  private controls: OrbitControls;
  private resize: ResizeObserver;
  private root?: Group;
  private asset?: ModelAsset;
  private lightingDispose: () => void;
  private grid?: GridHelper;
  private center = new Vector3();
  private bounds = new Box3();
  private radius = 1;
  private active = true;
  private disposed = false;
  private sequence = 0;
  private frame = 0;
  private lost = false;
  constructor(
    private host: HTMLElement,
    private notice: (message: string) => void,
  ) {
    this.renderer = new WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'low-power',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.lightingDispose = modelLighting(this.renderer, this.scene);
    const canvas = this.renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute('aria-label', '家具三维模型，拖动旋转，滚轮缩放');
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
    host.append(canvas);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = false;
    this.controls.listenToKeyEvents(canvas);
    this.controls.addEventListener('change', this.draw);
    this.resize = new ResizeObserver(() => {
      const { width, height } = host.getBoundingClientRect();
      if (!width || !height) return;
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height, false);
      this.draw();
    });
    this.resize.observe(host);
  }
  private onLost = (event: Event) => {
    event.preventDefault();
    this.lost = true;
    this.notice('3D 显示暂时中断，请关闭后重新打开家具预览。');
  };
  private onRestored = () => {
    this.lost = false;
    this.notice('3D 显示已恢复。');
    this.draw();
  };
  private draw = () => {
    if (!this.active || this.disposed || this.lost || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.active && !this.disposed && !this.lost)
        this.renderer.render(this.scene, this.camera);
    });
  };
  async load(bytes: ArrayBuffer): Promise<ModelInfo | undefined> {
    const serial = ++this.sequence;
    const checked = inspectModelFile(bytes);
    const manager = new LoadingManager();
    manager.setURLModifier((url) => {
      if (!url.startsWith('blob:')) throw new Error('不加载模型外部资源');
      return url;
    });
    const gltf = await new GLTFLoader(manager).parseAsync(bytes, '');
    if (serial !== this.sequence || this.disposed) {
      disposeTree(gltf.scene);
      return;
    }
    const root = gltf.scene;
    const box = new Box3().setFromObject(root),
      size = box.getSize(new Vector3());
    if (
      box.isEmpty() ||
      ![...size, ...box.min, ...box.max].every(Number.isFinite) ||
      size.length() > 10000
    ) {
      disposeTree(root);
      throw new Error('模型没有可显示的有效几何。');
    }
    let meshes = 0,
      vertices = 0,
      triangles = 0;
    root.traverse((obj) => {
      const mesh = obj as Mesh;
      if (mesh.isMesh) {
        meshes++;
        vertices += mesh.geometry.getAttribute('position')?.count ?? 0;
        triangles +=
          (mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position')?.count ?? 0) / 3;
      }
    });
    if (!meshes || triangles > 1000000) {
      disposeTree(root);
      throw new Error('模型为空或三角形过多。');
    }
    if (this.root) {
      this.scene.remove(this.root);
      this.asset?.dispose();
    }
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      (this.grid.material as Material).dispose();
    }
    this.root = root;
    this.asset = new ModelAsset(gltf, Math.min(8, this.renderer.capabilities.getMaxAnisotropy()));
    this.scene.add(root);
    box.getCenter(this.center);
    this.bounds.copy(box);
    this.radius = Math.max(size.length() / 2, 0.01);
    this.grid = new GridHelper(Math.max(size.x, size.z, size.y) * 1.5, 10, 0xc3a6b0, 0xd8c7ce);
    this.grid.position.set(this.center.x, box.min.y - this.radius * 0.01, this.center.z);
    this.scene.add(this.grid);
    this.camera.near = Math.max(0.001, this.radius / 1000);
    this.camera.far = Math.max(100, this.radius * 30);
    this.controls.minDistance = this.radius * 0.05;
    this.controls.maxDistance = this.radius * 20;
    this.camera.updateProjectionMatrix();
    this.view('angle');
    return {
      size: size.toArray(),
      meshes,
      vertices,
      triangles: Math.round(triangles),
      geometryOnly: checked.geometryOnly,
      styles: this.asset.styles,
      defaultDetail: this.asset.defaultDetail,
    };
  }
  cancelPending() {
    this.sequence++;
  }
  async style(detail: number) {
    const asset = this.asset,
      root = this.root;
    if (!asset || !root) return;
    await asset.apply(root, detail);
    if (this.asset === asset) this.draw();
  }
  view(mode: 'front' | 'side' | 'top' | 'angle') {
    const offsets = { front: [0, 0, 1], side: [1, 0, 0], top: [0, 1, 0], angle: [1, 0.65, 1.25] };
    const v = new Vector3(...offsets[mode]).normalize();
    this.camera.up.set(0, mode === 'top' ? 0 : 1, mode === 'top' ? -1 : 0);
    const distance = modelViewDistance(
      this.bounds,
      v,
      this.camera.up,
      this.camera.fov,
      this.camera.aspect,
    );
    this.camera.position.copy(this.center).addScaledVector(v, distance);
    this.controls.target.copy(this.center);
    this.controls.update();
    this.draw();
  }
  wireframe(enabled: boolean) {
    this.root?.traverse((obj) => {
      const mesh = obj as Mesh;
      if (!mesh.isMesh) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
        (material as MeshStandardMaterial).wireframe = enabled;
    });
    this.draw();
  }
  setActive(active: boolean) {
    this.active = active;
    this.controls.enabled = active;
    if (active) this.draw();
    else if (this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.sequence++;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.controls.dispose();
    this.asset?.dispose();
    this.lightingDispose();
    if (this.grid) {
      this.grid.geometry.dispose();
      (this.grid.material as Material).dispose();
    }
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('webglcontextlost', this.onLost);
    canvas.removeEventListener('webglcontextrestored', this.onRestored);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    canvas.remove();
  }
}
