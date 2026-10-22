import {
  AxesHelper,
  Box3,
  BoxGeometry,
  BoxHelper,
  BufferGeometry,
  Float32BufferAttribute,
  DoubleSide,
  LineLoop,
  LineSegments,
  LineBasicMaterial,
  ShapeUtils,
  CanvasTexture,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Euler,
  GridHelper,
  Group,
  LoadingManager,
  Material,
  Mesh,
  MeshBasicMaterial,
  OctahedronGeometry,
  Object3D,
  PerspectiveCamera,
  Plane,
  Raycaster,
  Scene,
  Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  editorResourceByKey,
  editorResourceByHash,
  editorResources,
  sceneItemInsideLand,
  constrainSceneItem,
  sceneItemHeightRange,
  sceneItemFloor,
  type SceneItem,
} from '../../../packages/core/src/editor.js';
import type { Quat, Vec3 } from '../../../packages/core/src/types.js';
import { inspectModelFile } from './model-file.js';
import { ModelAsset, modelLighting, modelViewDistance } from './model-assets.js';
import {
  landPlan,
  groundBounds,
  groundGrid,
  type GroundPoint,
} from '../../../packages/core/src/land.js';
import { basementDisplay } from './basement-view.js';
import { BasementAssets } from './basement-assets.js';
import type { WholeBlueprintPreview } from '../../../packages/core/src/blueprint-merge.js';
import {
  cutBasementGround,
  basementInsideLand,
  basementSize,
  basementGridPhase,
  basementExpansionCandidates,
  type BasementCell,
} from '../../../packages/core/src/basement.js';

export type EditMode = 'translate' | 'rotate' | 'scale';
export interface SceneCallbacks {
  selected: (id?: string) => void;
  transformed: (item: SceneItem) => void;
  preview: (item: SceneItem) => void;
  notice: (message: string) => void;
  basementAction: (x: number, z: number, cellId?: string) => void;
}
function release(root: Object3D) {
  const geometry = new Set<any>(),
    materials = new Set<Material>(),
    textures = new Set<Texture>();
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (mesh.geometry) geometry.add(mesh.geometry);
    if (mesh.material)
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
        materials.add(m);
  });
  for (const g of geometry) g.dispose();
  for (const m of materials) {
    for (const t of Object.values(m)) if (t instanceof Texture) textures.add(t);
    m.dispose();
  }
  for (const t of textures) {
    t.dispose();
    if (t.source.data instanceof ImageBitmap) t.source.data.close();
  }
}

export class SceneViewer {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private world = new Group();
  private groundLayer = new Group();
  private basementLayer = new Group();
  private basementAssets: BasementAssets;
  private basementCells: BasementCell[] = [];
  private savedBasementMasks?: ReadonlyMap<string, number>;
  private readonlyBasements = new Set<string>();
  private referenceLayer = new Group();
  private expansionLayer = new Group();
  private referenceObjects: WholeBlueprintPreview['objects'] = [];
  private referenceSignature = '';
  private basementSignature = '';
  private sliceY?: number;
  private sliceDepth = 4;
  private basementTool?: { size: number; level: number; action: 'dig' | 'fill' | 'place' };
  private hoverCell?: LineLoop;
  private freeGrid: GridHelper;
  private plotKey?: string;
  private plotBounds?: Box3;
  private dragValid?: SceneItem;
  private camera = new PerspectiveCamera(40, 1, 0.01, 5000);
  private orbit: OrbitControls;
  private transform: TransformControls;
  private resize: ResizeObserver;
  private templates = new Map<string, ModelAsset>();
  private templateHashes = new Map<string, string>();
  private lightingDispose: () => void;
  private instances = new Map<string, Group>();
  private items = new Map<string, SceneItem>();
  private selected?: string;
  private outline?: BoxHelper;
  private frame = 0;
  private active = true;
  private disposed = false;
  private lost = false;
  private pointerStart?: { x: number; y: number; gizmo: boolean };
  constructor(
    private host: HTMLElement,
    private callbacks: SceneCallbacks,
  ) {
    this.renderer = new WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'low-power',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.localClippingEnabled = true;
    this.basementAssets = new BasementAssets(
      Math.min(8, this.renderer.capabilities.getMaxAnisotropy()),
    );
    this.lightingDispose = modelLighting(this.renderer, this.scene);
    const canvas = this.renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute('aria-label', '家具布置画布，点击选中家具，拖动操作轴编辑');
    host.append(canvas);
    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.enableDamping = false;
    this.orbit.addEventListener('change', this.draw);
    this.camera.position.set(12, 10, 14);
    this.orbit.target.set(0, 1, 0);
    this.orbit.update();
    this.freeGrid = new GridHelper(40, 40, 0xbda0ac, 0xdccad1);
    this.scene.add(
      this.freeGrid,
      this.groundLayer,
      new AxesHelper(2),
      this.world,
      this.basementLayer,
      this.referenceLayer,
      this.expansionLayer,
    );
    this.transform = new TransformControls(this.camera, canvas);
    this.transform.setSpace('world');
    this.scene.add(this.transform.getHelper());
    this.transform.addEventListener('dragging-changed', (event) => {
      this.orbit.enabled = !event.value;
    });
    this.transform.addEventListener('change', this.draw);
    this.transform.addEventListener('mouseDown', () => {
      this.dragValid = this.currentTransform();
    });
    this.transform.addEventListener('objectChange', () => {
      let item = this.currentTransform();
      if (item) {
        if (this.plotKey && !sceneItemInsideLand(item, this.plotKey)) {
          const object = this.instances.get(item.id)!;
          if (this.transform.mode === 'translate') {
            try {
              item = constrainSceneItem(item, this.plotKey);
            } catch {
              item = this.dragValid ?? this.items.get(item.id)!;
            }
          } else item = this.dragValid ?? this.items.get(item.id)!;
          object.position.fromArray(item.position);
          object.quaternion.fromArray(item.rotation);
          object.scale.fromArray(item.scale);
          object.updateMatrixWorld(true);
        }
        this.dragValid = structuredClone(item);
        this.callbacks.preview(item);
        this.outline?.update();
      }
      this.draw();
    });
    this.transform.addEventListener('mouseUp', () => {
      const item = this.currentTransform();
      if (item) this.callbacks.transformed(item);
      this.dragValid = undefined;
    });
    canvas.addEventListener('pointerdown', this.pointerDown);
    canvas.addEventListener('pointerup', this.pointerUp);
    canvas.addEventListener('pointermove', this.pointerMove);
    canvas.addEventListener('pointerleave', this.pointerLeave);
    canvas.addEventListener('webglcontextlost', this.contextLost);
    canvas.addEventListener('webglcontextrestored', this.contextRestored);
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
  private contextLost = (e: Event) => {
    e.preventDefault();
    this.lost = true;
    this.callbacks.notice('3D显示中断，布置数据仍保留，可以保存工程。');
  };
  private contextRestored = () => {
    this.lost = false;
    this.draw();
  };
  private draw = () => {
    if (this.frame || this.disposed || !this.active || this.lost) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (!this.disposed && this.active && !this.lost)
        this.renderer.render(this.scene, this.camera);
    });
  };
  private pointerDown = (e: PointerEvent) => {
    if (e.button === 0)
      this.pointerStart = { x: e.clientX, y: e.clientY, gizmo: !!this.transform.axis };
  };
  private pointerUp = (e: PointerEvent) => {
    const start = this.pointerStart;
    this.pointerStart = undefined;
    if (
      !start ||
      start.gizmo ||
      this.transform.dragging ||
      Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4
    )
      return;
    if (this.basementTool) {
      if (this.basementTool.action !== 'dig') {
        const rect = this.renderer.domElement.getBoundingClientRect(),
          ray = new Raycaster();
        ray.setFromCamera(
          new Vector2(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            (-(e.clientY - rect.top) / rect.height) * 2 + 1,
          ),
          this.camera,
        );
        let obj: Object3D | undefined = ray.intersectObjects(this.basementLayer.children, true)[0]
          ?.object;
        while (obj && !obj.userData.basementId) obj = obj.parent ?? undefined;
        const c = this.basementCells.find((c) => c.id === obj?.userData.basementId);
        if (c) {
          if (this.readonlyBasements.has(c.id)) {
            this.callbacks.notice('原房间只读保留；可以在相邻格挖掘，回填和放置操作用于新增房间。');
            return;
          }
          if (
            this.basementTool.action === 'fill' &&
            (c.level !== this.basementTool.level || basementSize(c) !== this.basementTool.size)
          ) {
            this.callbacks.notice('该单元不在当前规格或工作层，请先切换工作层');
            return;
          }
          this.callbacks.basementAction(c.x, c.z, c.id);
          return;
        }
      }
      const point = this.basementPoint(e);
      if (point) this.callbacks.basementAction(point[0], point[1]);
      return;
    }
    const rect = this.renderer.domElement.getBoundingClientRect(),
      ray = new Raycaster();
    ray.setFromCamera(
      new Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        (-(e.clientY - rect.top) / rect.height) * 2 + 1,
      ),
      this.camera,
    );
    const hit = ray.intersectObjects(this.world.children, true)[0];
    let obj: Object3D | undefined = hit?.object;
    while (obj && !obj.userData.itemId) obj = obj.parent ?? undefined;
    this.select(obj?.userData.itemId);
    this.callbacks.selected(this.selected);
  };
  private basementPoint(e: PointerEvent): [number, number] | undefined {
    if (!this.basementTool) return;
    const rect = this.renderer.domElement.getBoundingClientRect(),
      ray = new Raycaster(),
      tool = this.basementTool;
    ray.setFromCamera(
      new Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        (-(e.clientY - rect.top) / rect.height) * 2 + 1,
      ),
      this.camera,
    );
    const p = ray.ray.intersectPlane(
      new Plane(new Vector3(0, 1, 0), tool.level * tool.size),
      new Vector3(),
    );
    if (p) {
      const phase = basementGridPhase(this.basementCells, tool.size);
      return [
        Math.floor(p.x / tool.size - phase[0] + 0.5) + phase[0],
        Math.floor(p.z / tool.size - phase[1] + 0.5) + phase[1],
      ];
    }
  }
  private pointerMove = (e: PointerEvent) => {
    if (!this.basementTool || !this.hoverCell) return;
    if (this.basementTool.action === 'place') {
      this.hoverCell.visible = false;
      this.draw();
      return;
    }
    const p = this.basementPoint(e),
      t = this.basementTool;
    this.hoverCell.visible = !!p;
    if (p) {
      this.hoverCell.position.set(p[0] * t.size, -t.level * t.size + 0.015, p[1] * t.size);
      const valid =
        !this.plotKey ||
        basementInsideLand(
          { id: 'hover', brushId: t.size === 4 ? 74 : 113, x: p[0], z: p[1], level: t.level },
          this.plotKey,
        );
      (this.hoverCell.material as LineBasicMaterial).color.set(
        valid ? (t.action === 'dig' ? 0x288967 : 0xd26a44) : 0xd12a47,
      );
    }
    this.draw();
  };
  private pointerLeave = () => {
    if (this.hoverCell) this.hoverCell.visible = false;
    this.draw();
  };
  setBasementTool(tool?: { size: number; level: number; action: 'dig' | 'fill' | 'place' }) {
    this.basementTool = tool;
    if (this.outline) this.outline.visible = !tool;
    if (this.hoverCell) {
      this.scene.remove(this.hoverCell);
      release(this.hoverCell);
      this.hoverCell = undefined;
    }
    this.transform.detach();
    if (tool) {
      const h = tool.size / 2,
        geo = new BufferGeometry().setFromPoints([
          new Vector3(-h, 0, -h),
          new Vector3(h, 0, -h),
          new Vector3(h, 0, h),
          new Vector3(-h, 0, h),
        ]);
      this.hoverCell = new LineLoop(
        geo,
        new LineBasicMaterial({ color: 0x288967, depthTest: false }),
      );
      this.hoverCell.visible = false;
      this.hoverCell.renderOrder = 10;
      this.scene.add(this.hoverCell);
    } else this.select(this.selected);
    this.renderer.domElement.style.cursor = tool ? 'crosshair' : '';
    this.refreshExpansionCells();
    this.draw();
  }
  setBasements(
    cells: BasementCell[],
    sliceY?: number,
    savedMasks?: ReadonlyMap<string, number>,
    readonlyIds: string[] = [],
    sliceDepth = this.basementTool?.size ?? 4,
  ) {
    const signature = JSON.stringify([
      cells,
      sliceY,
      savedMasks ? [...savedMasks] : null,
      readonlyIds,
      sliceDepth,
    ]);
    if (signature === this.basementSignature) return;
    this.basementSignature = signature;
    this.basementCells = structuredClone(cells);
    this.savedBasementMasks = savedMasks;
    this.readonlyBasements = new Set(readonlyIds);
    this.sliceY = sliceY;
    this.sliceDepth = sliceDepth;
    for (const object of this.instances.values()) this.updateSliceVisibility(object);
    this.updateReferenceVisibility();
    for (const object of this.scene.children)
      if (object instanceof AxesHelper) object.visible = sliceY === undefined || sliceY >= 0;
    this.clearBasementDisplay();
    this.basementLayer.clear();
    this.basementAssets.setSlice(sliceY);
    this.basementLayer.add(
      basementDisplay(
        cells,
        sliceY,
        (id, index) => this.basementAssets.clone(id, index),
        savedMasks,
      ),
    );
    this.setPlot(this.plotKey, true);
    this.refreshExpansionCells();
    this.draw();
  }
  private clearBasementDisplay() {
    for (const root of this.basementLayer.children)
      for (const cell of root.children) if (!cell.userData.nativeBasement) release(cell);
  }
  hasBasementModel(id: number) {
    return this.basementAssets.has(id);
  }
  async registerBasementModel(bytes: ArrayBuffer) {
    const id = await this.basementAssets.register(bytes);
    this.basementSignature = '';
    this.setBasements(
      this.basementCells,
      this.sliceY,
      this.savedBasementMasks,
      [...this.readonlyBasements],
      this.sliceDepth,
    );
    return id;
  }
  focusBasements() {
    if (!this.basementCells.length) {
      this.focusPlot();
      return;
    }
    const bounds = new Box3().setFromObject(this.basementLayer);
    if (this.expansionLayer.visible) bounds.union(new Box3().setFromObject(this.expansionLayer));
    this.focusBounds(bounds, false, true);
  }
  private refreshExpansionCells() {
    release(this.expansionLayer);
    this.expansionLayer.clear();
    const tool = this.basementTool;
    this.expansionLayer.visible =
      !!tool && tool.action === 'dig' && this.readonlyBasements.size > 0;
    if (!this.expansionLayer.visible || !tool) return;
    const candidates = basementExpansionCandidates(
        this.basementCells,
        tool.size,
        tool.level,
        this.plotKey,
      ),
      lines: number[] = [],
      faces: number[] = [],
      indices: number[] = [],
      h = tool.size / 2;
    for (const c of candidates) {
      const x = c.x * tool.size,
        z = c.z * tool.size,
        y = -c.level * tool.size + 0.02,
        start = faces.length / 3;
      const corners = [
        [x - h, y, z - h],
        [x + h, y, z - h],
        [x + h, y, z + h],
        [x - h, y, z + h],
      ];
      faces.push(...corners.flat());
      indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
      for (let i = 0; i < 4; i++) lines.push(...corners[i], ...corners[(i + 1) % 4]);
      lines.push(x - 0.3, y, z, x + 0.3, y, z, x, y, z - 0.3, x, y, z + 0.3);
    }
    const fg = new BufferGeometry();
    fg.setAttribute('position', new Float32BufferAttribute(faces, 3));
    fg.setIndex(indices);
    const lg = new BufferGeometry();
    lg.setAttribute('position', new Float32BufferAttribute(lines, 3));
    this.expansionLayer.add(
      new Mesh(
        fg,
        new MeshBasicMaterial({
          color: 0x419b75,
          transparent: true,
          opacity: 0.12,
          side: DoubleSide,
          depthWrite: false,
        }),
      ),
      new LineSegments(
        lg,
        new LineBasicMaterial({ color: 0x318e69, transparent: true, opacity: 0.8 }),
      ),
    );
  }
  private clearReferenceObjects() {
    this.referenceLayer.traverse((o) => {
      if (o.userData.proxy) release(o);
    });
    this.referenceLayer.clear();
  }
  private updateReferenceVisibility() {
    for (const object of this.referenceLayer.children) {
      object.updateMatrixWorld(true);
      this.updateSliceVisibility(object as Group);
    }
  }
  setReferenceObjects(objects: WholeBlueprintPreview['objects']) {
    const signature = JSON.stringify(objects);
    if (signature === this.referenceSignature) return;
    this.referenceSignature = signature;
    this.referenceObjects = objects;
    this.clearReferenceObjects();
    for (const item of objects.slice(0, 3000)) {
      // 预制体的子模型单独显示；不为每个逻辑容器叠加一个虚构实体。
      if (item.type !== 0) continue;
      const resource = editorResources.find((r) => r.representId === item.resourceId),
        group = new Group();
      group.userData.referenceId = item.id;
      group.matrixAutoUpdate = false;
      group.matrix.fromArray(item.matrix);
      group.matrixWorldNeedsUpdate = true;
      if (resource) {
        group.add(this.makeDisplay(resource.key));
        void this.templates
          .get(resource.key)
          ?.apply(group, item.detail)
          .then(() => this.draw())
          .catch(() => this.callbacks.notice('原家具材质预览失败，蓝图数据仍完整保留。'));
      } else {
        const marker = new Mesh(
          new OctahedronGeometry(0.15),
          new MeshBasicMaterial({ color: 0x8b7180, wireframe: true }),
        );
        marker.userData.proxy = true;
        group.add(marker);
      }
      this.referenceLayer.add(group);
    }
    this.updateReferenceVisibility();
    this.draw();
  }
  private makeDisplay(key: string): Object3D {
    const cached = this.templates.get(key);
    if (cached) return cached.clone();
    const r = editorResourceByKey.get(key)!,
      size = r.boundsMax.map((v, i) => Math.max(0.01, v - r.boundsMin[i]));
    const proxy = new Mesh(
      new BoxGeometry(...(size as Vec3)),
      new MeshBasicMaterial({ color: 0xb77890, wireframe: true }),
    );
    proxy.position.fromArray(r.boundsMin.map((v, i) => (v + r.boundsMax[i]) / 2));
    proxy.userData.proxy = true;
    return proxy;
  }
  async registerModel(bytes: ArrayBuffer): Promise<string> {
    inspectModelFile(bytes);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) =>
      v.toString(16).padStart(2, '0'),
    ).join('');
    const r = editorResourceByHash.get(hash);
    if (!r) throw new Error('此模型尚未绑定可导出的游戏家具，可在单件预览中查看');
    const currentIsPreferred = () =>
      this.templateHashes.get(r.key) === hash || this.templateHashes.get(r.key) === r.modelSha256;
    if (currentIsPreferred()) return r.key;
    const manager = new LoadingManager();
    manager.setURLModifier((url) => {
      if (!url.startsWith('blob:')) throw new Error('模型不能读取外部资源');
      return url;
    });
    const gltf = await new GLTFLoader(manager).parseAsync(bytes, '');
    if (this.disposed) {
      release(gltf.scene);
      throw new Error('布置窗口已关闭');
    }
    if (currentIsPreferred()) {
      release(gltf.scene);
      return r.key;
    }
    const previous = this.templates.get(r.key);
    this.templates.set(
      r.key,
      new ModelAsset(gltf, Math.min(8, this.renderer.capabilities.getMaxAnisotropy())),
    );
    this.templateHashes.set(r.key, hash);
    for (const [id, group] of this.instances)
      if (this.items.get(id)?.resourceKey === r.key) {
        for (const child of [...group.children]) {
          if (child.userData.proxy) release(child);
          group.remove(child);
        }
        group.add(this.makeDisplay(r.key));
        delete group.userData.appliedDetail;
        this.updateStyle(group, this.items.get(id)!);
        this.updateSliceVisibility(group);
      }
    previous?.dispose();
    this.referenceSignature = '';
    this.setReferenceObjects(this.referenceObjects);
    this.outline?.update();
    this.draw();
    return r.key;
  }
  hasModel(key: string) {
    return this.templates.has(key);
  }
  private updateSliceVisibility(object: Group) {
    const box = new Box3().setFromObject(object);
    object.visible =
      this.sliceY === undefined ||
      (box.min.y <= this.sliceY + 0.01 && box.max.y >= this.sliceY - this.sliceDepth - 0.01);
  }
  setPlot(key?: string, force = false) {
    if (key === this.plotKey && !force) return;
    const plan = landPlan(key);
    if (key && !plan) throw new Error('未知地块范围');
    this.plotKey = key;
    this.plotBounds = undefined;
    release(this.groundLayer);
    this.groundLayer.clear();
    this.freeGrid.visible = !plan && !this.basementCells.length;
    this.groundLayer.visible = this.sliceY === undefined || this.sliceY >= 0;
    if (!plan && !this.basementCells.length) {
      this.draw();
      return;
    }
    const ground = plan ?? {
      points: [
        [-20, -20],
        [20, -20],
        [20, 20],
        [-20, 20],
      ] as GroundPoint[],
      regions: [],
      areaM2: 1600,
    };
    const bounds = groundBounds(ground.points);
    this.plotBounds = new Box3(
      new Vector3(bounds.min[0], 0, bounds.min[1]),
      new Vector3(bounds.max[0], 0, bounds.max[1]),
    );
    const palette = [0xcda4b8, 0xb1c6bc, 0xdcc9a5, 0xc0b5d4, 0xa8c5d4, 0xd6b9a7, 0xc3cfa6];
    const outline = (points: GroundPoint[], color: number) => {
      const geo = new BufferGeometry().setFromPoints(
        points.map((p) => new Vector3(p[0], -0.008, p[1])),
      );
      this.groundLayer.add(new LineLoop(geo, new LineBasicMaterial({ color })));
    };
    const regions = ground.regions.length ? ground.regions : [ground];
    for (const [index, region] of regions.entries()) {
      for (const piece of cutBasementGround(region.points, this.basementCells)) {
        const geo = new BufferGeometry(),
          poly = piece.map((p) => new Vector2(...p));
        geo.setAttribute(
          'position',
          new Float32BufferAttribute(
            piece.flatMap((p) => [p[0], -0.03, p[1]]),
            3,
          ),
        );
        geo.setIndex(ShapeUtils.triangulateShape(poly, []).flat());
        this.groundLayer.add(
          new Mesh(
            geo,
            new MeshBasicMaterial({
              color: palette[index % palette.length],
              side: DoubleSide,
              transparent: !this.basementCells.length,
              opacity: this.basementCells.length ? 1 : 0.27,
              depthWrite: !!this.basementCells.length,
            }),
          ),
        );
      }
      outline(region.points, 0x9c7789);
      if (ground.regions.length) {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#fffafbf0';
        ctx.beginPath();
        ctx.arc(32, 32, 30, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#513940';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = 'bold 44px "Microsoft YaHei",sans-serif';
        ctx.fillText(String(('index' in region ? region.index : undefined) ?? index + 1), 32, 34);
        const texture = new CanvasTexture(canvas);
        texture.colorSpace = SRGBColorSpace;
        const label = new Sprite(
          new SpriteMaterial({ map: texture, depthTest: false, sizeAttenuation: false }),
        );
        const center = region.points.reduce(
          (a, p) => [a[0] + p[0] / region.points.length, a[1] + p[1] / region.points.length],
          [0, 0],
        );
        label.position.set(center[0], 0.05, center[1]);
        label.scale.set(0.085, 0.085, 1);
        label.renderOrder = 5;
        this.groundLayer.add(label);
      }
    }
    const step = ground.areaM2 >= 7200 ? 4 : 1;
    const grid = new BufferGeometry().setFromPoints(
      (this.basementCells.length ? [] : groundGrid(ground.points, step)).flatMap((seg) =>
        seg.map((p) => new Vector3(p[0], -0.018, p[1])),
      ),
    );
    this.groundLayer.add(
      new LineSegments(
        grid,
        new LineBasicMaterial({ color: 0xa9939e, transparent: true, opacity: 0.34 }),
      ),
    );
    outline(ground.points, 0x8f405e);
    this.draw();
  }
  focusPlot() {
    if (!this.plotBounds) return;
    const center = this.plotBounds.getCenter(new Vector3()),
      direction = new Vector3(0, 1, 0);
    this.camera.up.set(0, 0, -1);
    this.orbit.target.copy(center);
    this.camera.position
      .copy(center)
      .addScaledVector(
        direction,
        modelViewDistance(
          this.plotBounds,
          direction,
          this.camera.up,
          this.camera.fov,
          this.camera.aspect,
        ),
      );
    this.orbit.update();
    this.draw();
  }
  setItems(items: SceneItem[]) {
    const keys = new Set(items.map((i) => i.id));
    for (const [id, obj] of this.instances)
      if (!keys.has(id)) {
        if (this.selected === id) this.select(undefined);
        obj.traverse((child) => {
          if (child.userData.proxy) release(child);
        });
        this.world.remove(obj);
        this.instances.delete(id);
      }
    this.items = new Map(items.map((i) => [i.id, structuredClone(i)]));
    for (const item of items) {
      let obj = this.instances.get(item.id);
      if (obj && obj.userData.resourceKey !== item.resourceKey)
        throw new Error('实例资源不能隐式替换');
      if (!obj) {
        obj = new Group();
        obj.userData.itemId = item.id;
        obj.userData.resourceKey = item.resourceKey;
        obj.add(this.makeDisplay(item.resourceKey));
        this.world.add(obj);
        this.instances.set(item.id, obj);
      }
      obj.position.fromArray(item.position);
      obj.quaternion.fromArray(item.rotation);
      obj.scale.fromArray(item.scale);
      obj.updateMatrixWorld(true);
      this.updateSliceVisibility(obj);
      this.updateStyle(obj, item);
    }
    if (this.selected) this.select(this.selected);
    this.draw();
  }
  private updateStyle(object: Group, item: SceneItem) {
    const asset = this.templates.get(item.resourceKey);
    if (!asset || object.userData.appliedDetail === item.detail) return;
    object.userData.appliedDetail = item.detail;
    void asset
      .apply(object, item.detail)
      .then(() => this.draw())
      .catch(() => {
        object.userData.appliedDetail = undefined;
        this.callbacks.notice('家具颜色加载失败，摆放数据仍保留。');
      });
  }
  select(id?: string) {
    this.selected = id && this.instances.has(id) ? id : undefined;
    this.transform.detach();
    if (this.outline) {
      this.scene.remove(this.outline);
      this.outline.geometry.dispose();
      (this.outline.material as Material).dispose();
      this.outline = undefined;
    }
    if (this.selected && !this.basementTool) {
      const obj = this.instances.get(this.selected)!;
      this.transform.attach(obj);
      this.outline = new BoxHelper(obj, 0xd1668f);
      this.scene.add(this.outline);
    }
    this.mode(this.transform.mode);
    this.draw();
  }
  mode(mode: EditMode) {
    this.transform.setMode(mode);
    this.transform.showX = this.transform.showY = this.transform.showZ = true;
    const item = this.selected ? this.items.get(this.selected) : undefined;
    if (item) {
      const r = editorResourceByKey.get(item.resourceKey)!;
      if (mode === 'rotate' && !r.freeRotation) this.transform.showX = this.transform.showZ = false;
      this.transform.enabled = mode !== 'scale' || r.scaleRanges.some(([min, max]) => min !== max);
    }
    this.draw();
  }
  snap(enabled: boolean) {
    this.transform.setTranslationSnap(enabled ? 0.1 : null);
    this.transform.setRotationSnap(enabled ? Math.PI / 12 : null);
    this.transform.setScaleSnap(enabled ? 0.05 : null);
  }
  private currentTransform(): SceneItem | undefined {
    const item = this.selected ? this.items.get(this.selected) : undefined,
      obj = this.selected ? this.instances.get(this.selected) : undefined;
    if (!item || !obj) return;
    const r = editorResourceByKey.get(item.resourceKey)!;
    const heightRange = sceneItemHeightRange(
      item,
      this.basementCells.filter((c) => !this.readonlyBasements.has(c.id)),
    );
    if (heightRange)
      obj.position.y = Math.min(heightRange[1], Math.max(heightRange[0], obj.position.y));
    if (!r.freeRotation) {
      const e = new Euler().setFromQuaternion(obj.quaternion, 'YXZ');
      obj.quaternion.setFromEuler(new Euler(0, e.y, 0, 'YXZ'));
    }
    if (!r.nonUniform) {
      const axis = this.transform.axis?.startsWith('Y')
        ? 'y'
        : this.transform.axis?.startsWith('Z')
          ? 'z'
          : 'x';
      obj.scale.setScalar(
        Math.min(r.scaleRanges[0][1], Math.max(r.scaleRanges[0][0], obj.scale[axis])),
      );
    } else
      for (const [i, axis] of ['x', 'y', 'z'].entries())
        obj.scale[axis as 'x'] = Math.min(
          r.scaleRanges[i][1],
          Math.max(r.scaleRanges[i][0], obj.scale[axis as 'x']),
        );
    return {
      ...item,
      position: obj.position.toArray() as Vec3,
      rotation: obj.quaternion.normalize().toArray() as Quat,
      scale: obj.scale.toArray() as Vec3,
    };
  }
  grounded(item: SceneItem): number {
    const obj = this.instances.get(item.id);
    if (!obj) return item.position[1];
    obj.updateMatrixWorld(true);
    return (
      item.position[1] -
      new Box3().setFromObject(obj).min.y +
      (sceneItemFloor(
        item,
        this.basementCells.filter((c) => !this.readonlyBasements.has(c.id)),
      )?.position[1] ?? 0)
    );
  }
  focus(id?: string, top = false) {
    const owner = id ? this.items.get(id)?.basementId : undefined;
    if (owner) {
      const room = this.basementLayer.children
        .flatMap((r) => r.children)
        .find((r) => r.userData.basementId === owner);
      if (room) {
        this.focusBounds(new Box3().setFromObject(room), top, true);
        return;
      }
    }
    const target = id ? this.instances.get(id) : this.world;
    if (!target) return;
    const box = id ? new Box3().setFromObject(target) : new Box3();
    if (!id) {
      for (const object of this.instances.values())
        if (object.visible) box.union(new Box3().setFromObject(object));
      box.union(new Box3().setFromObject(this.basementLayer));
      for (const object of this.referenceLayer.children)
        if (object.visible) box.union(new Box3().setFromObject(object));
    }
    if (box.isEmpty()) {
      if (this.plotBounds) {
        this.focusPlot();
        return;
      }
      this.camera.position.set(12, 10, 14);
      this.orbit.target.set(0, 1, 0);
      this.orbit.update();
      return;
    }
    this.focusBounds(box, top);
  }
  private focusBounds(box: Box3, top: boolean, underground = false) {
    if (box.isEmpty()) return;
    const center = box.getCenter(new Vector3());
    this.camera.up.set(0, top ? 0 : 1, top ? -1 : 0);
    this.orbit.target.copy(center);
    const direction = top
      ? new Vector3(0, 1, 0)
      : new Vector3(1, underground ? 4.5 : 0.8, 1.3).normalize();
    this.camera.position
      .copy(center)
      .addScaledVector(
        direction,
        modelViewDistance(box, direction, this.camera.up, this.camera.fov, this.camera.aspect),
      );
    this.orbit.update();
    this.draw();
  }
  setActive(active: boolean) {
    this.active = active;
    this.orbit.enabled = active;
    if (active) this.draw();
    else if (this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.orbit.dispose();
    this.transform.dispose();
    for (const t of this.templates.values()) t.dispose();
    this.clearBasementDisplay();
    this.basementLayer.clear();
    this.clearReferenceObjects();
    this.basementAssets.dispose();
    this.lightingDispose();
    this.templates.clear();
    this.world.traverse((o) => {
      if (o.userData.proxy) release(o);
    });
    for (const obj of this.scene.children)
      if (obj !== this.world && obj !== this.transform.getHelper()) release(obj);
    const c = this.renderer.domElement;
    c.removeEventListener('pointerdown', this.pointerDown);
    c.removeEventListener('pointerup', this.pointerUp);
    c.removeEventListener('pointermove', this.pointerMove);
    c.removeEventListener('pointerleave', this.pointerLeave);
    c.removeEventListener('webglcontextlost', this.contextLost);
    c.removeEventListener('webglcontextrestored', this.contextRestored);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    c.remove();
  }
}
