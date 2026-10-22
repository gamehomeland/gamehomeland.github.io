import {
  BoxGeometry,
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  NoToneMapping,
  OrthographicCamera,
  Quaternion,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { BlueprintScene } from '../../../packages/core/src/scene.js';

export type ViewDirection = 'front' | 'side' | 'angle';

/** 与导出核心隔离。按需重绘；切页不运行动画循环。 */
export class BlueprintViewer {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private objects = new Group();
  private camera = new OrthographicCamera(-1, 1, 1, -1, 0.01, 2000);
  private controls: OrbitControls;
  private resize: ResizeObserver;
  private meshes: InstancedMesh[] = [];
  private center = new Vector3();
  private radius = 1;
  private aspect = 1;
  private active = true;
  private disposed = false;
  private frame = 0;
  private lost = false;
  private data?: BlueprintScene;

  constructor(
    private host: HTMLElement,
    private notice: (message: string) => void,
  ) {
    this.renderer = new WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'low-power',
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = NoToneMapping;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setClearColor(0, 0);
    const canvas = this.renderer.domElement;
    canvas.setAttribute('aria-label', '蓝图三维预览，拖动旋转，滚轮缩放，右键拖动平移');
    canvas.tabIndex = 0;
    canvas.addEventListener('webglcontextlost', this.contextLost);
    canvas.addEventListener('webglcontextrestored', this.contextRestored);
    host.append(canvas);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = false;
    this.controls.minZoom = 0.15;
    this.controls.maxZoom = 32;
    this.controls.addEventListener('change', this.schedule);
    this.controls.listenToKeyEvents(canvas);
    // 游戏组件与网页相机的左右手约定不同，反射整棵树而非重排图案。
    this.objects.scale.x = -1;
    this.scene.add(this.objects);
    this.resize = new ResizeObserver(() => this.resizeToHost());
    this.resize.observe(host);
  }

  private contextLost = (event: Event) => {
    event.preventDefault();
    this.lost = true;
    this.notice('3D 显示暂时中断，可切回拼布效果；蓝图下载仍可使用。');
  };
  private contextRestored = () => {
    this.lost = false;
    this.notice('3D 预览已恢复。');
    this.schedule();
  };
  private schedule = () => {
    if (this.disposed || !this.active || this.lost || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (!this.disposed && this.active && !this.lost)
        this.renderer.render(this.scene, this.camera);
    });
  };
  private resizeToHost() {
    const { width, height } = this.host.getBoundingClientRect();
    if (!width || !height) return;
    this.aspect = width / height;
    const h = this.radius * 1.2;
    this.camera.left = -h * this.aspect;
    this.camera.right = h * this.aspect;
    this.camera.top = h;
    this.camera.bottom = -h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.schedule();
  }
  load(data: BlueprintScene) {
    this.clear();
    this.data = data;
    const matrix = new Matrix4(),
      p = new Vector3(),
      q = new Quaternion(),
      s = new Vector3();
    for (const batch of data.batches) {
      const geometry = batch.triangles ? new BufferGeometry() : new BoxGeometry(1, 1, 1);
      if (batch.triangles)
        geometry.setAttribute('position', new Float32BufferAttribute(batch.triangles, 3));
      else {
        // 上下表面保持色卡值，仅侧壁变暗以辨认厚度。
        const normals = geometry.getAttribute('normal'),
          shades = [];
        for (let i = 0; i < normals.count; i++) {
          const v = Math.abs(normals.getY(i)) > 0.9 ? 1 : 0.62;
          shades.push(v, v, v);
        }
        geometry.setAttribute('color', new Float32BufferAttribute(shades, 3));
      }
      const material = new MeshBasicMaterial({
        color: new Color().setRGB(
          ...(batch.rgb.map((v) => v / 255) as [number, number, number]),
          SRGBColorSpace,
        ),
        vertexColors: !batch.triangles,
        transparent: batch.opacity < 1,
        opacity: batch.opacity,
        depthWrite: batch.opacity >= 1,
        side: DoubleSide,
        wireframe: batch.kind === 'support' || batch.kind === 'glass',
      });
      const mesh = new InstancedMesh(geometry, material, batch.instanceIds.length);
      mesh.name = batch.name;
      mesh.userData.kind = batch.kind;
      // 不在逐帧渲染中反复计算大批实例包围球，整体组件只需少量批次。
      mesh.frustumCulled = false;
      mesh.visible = batch.kind !== 'support';
      for (let i = 0; i < batch.instanceIds.length; i++) {
        const off = i * 10;
        p.fromArray(batch.transforms, off);
        q.fromArray(batch.transforms, off + 3);
        s.fromArray(batch.transforms, off + 7);
        mesh.setMatrixAt(i, matrix.compose(p, q, s));
      }
      mesh.instanceMatrix.needsUpdate = true;
      this.meshes.push(mesh);
      this.objects.add(mesh);
    }
    const { min, max } = data.bounds;
    this.center.set(-(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    this.radius = Math.max(0.1, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
    this.camera.far = Math.max(2000, this.radius * 20);
    this.resizeToHost();
    this.view('front');
  }
  view(direction: ViewDirection) {
    if (!this.data) return;
    const front = new Vector3(...this.data.front),
      up = new Vector3(...this.data.up);
    const right = new Vector3().crossVectors(up, front).normalize();
    const offset =
      direction === 'front'
        ? front
        : direction === 'side'
          ? right
          : front
              .multiplyScalar(1.4)
              .addScaledVector(right, 0.9)
              .addScaledVector(up, 0.6)
              .normalize();
    this.camera.up.copy(up);
    this.camera.position.copy(this.center).addScaledVector(offset, this.radius * 4 + 1);
    this.controls.target.copy(this.center);
    this.camera.zoom = 1;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.schedule();
  }
  supports(show: boolean) {
    for (const mesh of this.meshes) if (mesh.userData.kind === 'support') mesh.visible = show;
    this.schedule();
  }
  wireframe(show: boolean) {
    for (const mesh of this.meshes)
      if (mesh.userData.kind === 'cloth') (mesh.material as MeshBasicMaterial).wireframe = show;
    this.schedule();
  }
  setActive(active: boolean) {
    this.active = active;
    this.controls.enabled = active;
    if (active) this.resizeToHost();
    else if (this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
  }
  private clear() {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      (mesh.material as MeshBasicMaterial).dispose();
      mesh.dispose();
      this.objects.remove(mesh);
    }
    this.meshes = [];
    this.data = undefined;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.controls.dispose();
    this.clear();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('webglcontextlost', this.contextLost);
    canvas.removeEventListener('webglcontextrestored', this.contextRestored);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    canvas.remove();
  }
}
