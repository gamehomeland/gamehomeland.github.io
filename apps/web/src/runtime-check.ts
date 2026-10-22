// 独立的集成测试入口；不包含在离线单文件页面中。
import ExportWorker from './export.worker?worker&inline';
import PreviewWorker from './preview.worker?worker&inline';
import './style.css';
import { loadViewer, loadFurnitureViewer, loadSceneViewer } from './viewer-loader.js';
import {
  emptyScene,
  exportSceneBlueprint,
  importSceneBlueprint,
  placeSceneItem,
  editorResources,
} from '../../../packages/core/src/editor.js';
import { modelFixture } from '../../../tests/fixtures/model-glb.js';
import { decodeFile, prepareFile } from './upload.js';
import { EXAMPLES } from './content.generated.js';
import { modelLibraryURL } from './model-library.js';
import { basementModelResources } from '../../../packages/core/src/basement.js';
import { decodeBlueprint, encodeBlueprint } from '../../../packages/core/src/codec.js';
import {
  inspectWholeBlueprint,
  mergeWholeBlueprint,
  mergeWholeBlueprintDetailed,
  readWholeBlueprintPreview,
} from '../../../packages/core/src/blueprint-merge.js';
import { unzipSync } from 'fflate';
import jpeg from '../../../tests/fixtures/rgb.jpg?inline';
import webp from '../../../tests/fixtures/alpha.webp?inline';
import rotated from '../../../tests/fixtures/rotated.jpg?inline';
import gif from '../../../tests/fixtures/first-frame.gif?inline';
import gifLocal from '../../../tests/fixtures/first-frame-local.gif?inline';
import gifExpected from '../../../tests/fixtures/first-frame.png?inline';
import gifLocalExpected from '../../../tests/fixtures/first-frame-local.png?inline';
const sources: Record<string, { base64: string; name: string; type: string }> = {
  ...EXAMPLES,
  jpeg: { base64: jpeg.split(',')[1], name: 'rgb.jpg', type: 'image/jpeg' },
  webp: { base64: webp.split(',')[1], name: 'alpha.webp', type: 'image/webp' },
  rotated: { base64: rotated.split(',')[1], name: 'rotated.jpg', type: 'image/jpeg' },
  gif: { base64: gif.split(',')[1], name: 'first-frame.gif', type: 'image/gif' },
  gifLocal: { base64: gifLocal.split(',')[1], name: 'first-frame-local.gif', type: 'image/gif' },
};
const cases = [
  ['sample', 'wall', 8],
  ['sample', 'ground', 50],
  ['sample', 'wall', 1],
  ['sample', 'ground', 20],
  ['jpeg', 'wall', 8],
  ['webp', 'ground', 8],
  ['rotated', 'wall', 8],
  ['gif', 'wall', 8],
  ['gifLocal', 'ground', 8],
] as const;
async function run() {
  const rows = [];
  let threeD: unknown;
  for (const [id, orientation, longEdgeM] of cases) {
    const source = sources[id];
    const bytes = Uint8Array.from(atob(source.base64), (v) => v.charCodeAt(0));
    const input = await decodeFile(new File([bytes], source.name, { type: source.type }));
    if (id === 'gif' || id === 'gifLocal') {
      const expectedSource = id === 'gif' ? gifExpected : gifLocalExpected;
      const expectedBytes = Uint8Array.from(atob(expectedSource.split(',')[1]), (v) =>
        v.charCodeAt(0),
      );
      const expected = await decodeFile(
        new File([expectedBytes], 'expected.png', { type: 'image/png' }),
      );
      const shown = await prepareFile(new File([bytes], source.name, { type: source.type }));
      const preview = await decodeFile(shown.file);
      const pixels = new Uint8Array(input.rgba),
        target = new Uint8Array(expected.rgba),
        previewPixels = new Uint8Array(preview.rgba);
      if (
        input.width !== expected.width ||
        input.height !== expected.height ||
        pixels.length !== target.length ||
        pixels.some((v, i) => v !== target[i]) ||
        pixels.some((v, i) => v !== previewPixels[i])
      )
        throw new Error('GIF 首帧与预览或独立 PNG 不一致');
    }
    if (id === 'rotated' && (input.width !== 16 || input.height !== 32))
      throw new Error('EXIF 方向未正确解码');
    const start = performance.now();
    const result = await new Promise<any>((resolve, reject) => {
      const worker = new ExportWorker(),
        timeout = setTimeout(() => {
          worker.terminate();
          reject(new Error('Worker timeout'));
        }, 45000);
      worker.onerror = () => {
        clearTimeout(timeout);
        worker.terminate();
        reject(new Error('Worker failed'));
      };
      worker.onmessage = (event) => {
        if (event.data.type === 'progress') return;
        clearTimeout(timeout);
        worker.terminate();
        if (event.data.type === 'error') reject(new Error(event.data.message));
        else resolve(event.data);
      };
      worker.postMessage({ ...input, options: { orientation, longEdgeM, maxFurniture: 5000 } }, [
        input.rgba,
      ]);
    });
    const round = encodeBlueprint(decodeBlueprint(result.blueprint));
    if (round.some((v: number, i: number) => v !== result.blueprint[i]))
      throw new Error('蓝图回读不一致');
    const files = unzipSync(result.zip);
    if (
      Object.keys(files).length !== 4 ||
      files['家园蓝图.blueprintx'].some((v: number, i: number) => v !== round[i])
    )
      throw new Error('ZIP 内容不一致');
    const preview = await createImageBitmap(new Blob([result.png], { type: 'image/png' }));
    let sceneCount = 0;
    if (id === 'sample') {
      const scene = await new Promise<any>((resolve, reject) => {
        const reader = new PreviewWorker();
        const timeout = setTimeout(() => {
          reader.terminate();
          reject(new Error('预览Worker超时'));
        }, 15000);
        reader.onerror = () => {
          clearTimeout(timeout);
          reader.terminate();
          reject(new Error('预览Worker失败'));
        };
        reader.onmessage = ({ data }) => {
          clearTimeout(timeout);
          reader.terminate();
          if (data.type === 'error') reject(new Error(data.message));
          else resolve(data.scene);
        };
        reader.postMessage({ blueprint: result.blueprint, summary: result.summary });
      });
      sceneCount = scene.count.total;
      if (sceneCount !== result.summary.totalCount) throw new Error('预览数量不符');
      if (!threeD) {
        const host = document.getElementById('runtime-viewer')!;
        let component: InstanceType<Awaited<ReturnType<typeof loadViewer>>> | undefined;
        let furniture: InstanceType<Awaited<ReturnType<typeof loadFurnitureViewer>>> | undefined;
        let editor: InstanceType<Awaited<ReturnType<typeof loadSceneViewer>>> | undefined;
        try {
          const Viewer = await loadViewer();
          component = new Viewer(host, (text) => {
            throw new Error(text);
          });
          component.load(scene);
          component.view('angle');
          component.supports(true);
          component.dispose();
          component = undefined;
          const Furniture = await loadFurnitureViewer();
          furniture = new Furniture(host, (text) => {
            throw new Error(text);
          });
          const info = await furniture.load(modelFixture());
          if (!info || info.triangles !== 1 || info.geometryOnly)
            throw new Error('内嵌纹理GLB读取失败');
          const manifestResponse = await fetch(
            modelLibraryURL('furniture/manifest.json', document.baseURI)!,
          );
          if (!manifestResponse.ok) throw new Error('内置家具目录未随构建提供');
          const bundledRows = await manifestResponse.json();
          const bundledChair = bundledRows.find(
            (r: { resourceId?: number }) => r.resourceId === 19315,
          );
          if (!bundledChair) throw new Error('内置家具缺少已绑定的椅子');
          const chairResponse = await fetch(
            modelLibraryURL(
              `furniture/${bundledChair.file}`,
              document.baseURI,
              bundledChair.sha256,
            )!,
          );
          if (!chairResponse.ok) throw new Error('内置家具模型读取失败');
          const chairInfo = await furniture.load(await chairResponse.arrayBuffer());
          if (!chairInfo || chairInfo.geometryOnly || chairInfo.triangles < 2)
            throw new Error('内置家具贴图未正常解码');
          furniture.view('top');
          furniture.wireframe(true);
          furniture.dispose();
          furniture = undefined;
          const Editor = await loadSceneViewer(),
            doc = emptyScene();
          const resource = editorResources.find((r) => r.representId === 21276)!;
          doc.items = [
            {
              id: 'runtime-column',
              resourceKey: resource.key,
              detail: resource.defaultDetail,
              position: [2, 0, 1],
              rotation: [0, 0, 0, 1],
              scale: [0.25, 0.4, 0.25],
            },
          ];
          editor = new Editor(host, {
            selected: () => {},
            basementAction: () => {},
            transformed: () => {},
            preview: () => {},
            notice: (text) => {
              throw new Error(text);
            },
          });
          for (const pack of basementModelResources) {
            const response = await fetch(
              modelLibraryURL(`basement/${pack.file}`, document.baseURI, pack.modelSha256)!,
            );
            if (!response.ok) throw new Error('内置地下室模型未随构建提供');
            await editor.registerBasementModel(await response.arrayBuffer());
            if (!editor.hasBasementModel(pack.brushId)) throw new Error('内置地下室材质加载失败');
          }
          editor.setItems(doc.items);
          editor.select('runtime-column');
          editor.mode('scale');
          editor.focus();
          const restored = importSceneBlueprint(exportSceneBlueprint(doc));
          if (restored.items.length !== 1 || Math.abs(restored.items[0].scale[1] - 0.4) > 1e-6)
            throw new Error('编辑场景文件回读失败');
          doc.landKey = 'blueprint:32:40';
          doc.basements = [
            { id: 'basement-upper', brushId: 113, x: 0, z: 0, level: 0 },
            { id: 'basement-lower', brushId: 114, x: 0, z: 0, level: 1 },
          ];
          doc.items[0] = placeSceneItem(doc.items[0], doc, 'basement-lower');
          editor.setItems(doc.items);
          editor.setPlot(doc.landKey);
          editor.setBasements(doc.basements, -8);
          editor.setBasementTool({ size: 8, level: 1, action: 'dig' });
          editor.focusBasements();
          const basementBytes = exportSceneBlueprint(doc),
            basementRead = importSceneBlueprint(basementBytes);
          if (
            !basementBytes[0] ||
            basementRead.basements?.length !== 2 ||
            basementRead.basements[1].level !== 1 ||
            !basementRead.items[0].basementId ||
            basementRead.items[0].position[1] > -15
          )
            throw new Error('地下室整屋蓝图回读失败');
          const addition = {
            ...emptyScene(),
            landKey: doc.landKey,
            basements: [{ id: 'addition', brushId: 84, x: -3, z: -3, level: 0 }],
          };
          const merged = mergeWholeBlueprint(basementBytes, exportSceneBlueprint(addition));
          if (inspectWholeBlueprint(merged).basementCount !== 3)
            throw new Error('地下室合并检查失败');
          const connectedAddition = {
            ...emptyScene(),
            landKey: doc.landKey,
            basementMergeOnly: true as const,
            basements: [{ id: 'connected-lower', brushId: 114, x: 0, z: 0, level: 2 }],
          };
          const connection = mergeWholeBlueprintDetailed(
            basementBytes,
            exportSceneBlueprint(connectedAddition, { forMerge: true }),
          );
          if (
            connection.report.connections !== 1 ||
            connection.report.transferredAttachments.length !== 1
          )
            throw new Error('连通与原家具转挂检查失败');
          const connectedPreview = readWholeBlueprintPreview(connection.blueprint);
          editor.setReferenceObjects(connectedPreview.objects);
          editor.setBasements(
            connectedPreview.rooms.map((r) => ({
              id: `room-${r.id}`,
              brushId: r.brushId,
              x: r.position[0] / 8,
              z: r.position[2] / 8,
              level: -r.position[1] / 8,
            })),
            -16,
            new Map(connectedPreview.rooms.map((r) => [`room-${r.id}`, r.mask])),
            connectedPreview.rooms.map((r) => `room-${r.id}`),
          );
          editor.setBasementTool({ size: 8, level: 2, action: 'dig' });
          editor.focusBasements();
          threeD = {
            available: true,
            componentInstances: sceneCount,
            embeddedTextureGLB: true,
            bundledFurniture: true,
            bundledBasementPacks: basementModelResources.length,
            sceneEditor: true,
            nonUniformExport: true,
            basementExport: true,
            basementFurniture: true,
            basementMerge: true,
            basementConnection: true,
            originalFurniturePreview: true,
          };
        } catch (error) {
          // 没有WebGL的CI或设备也应能通过原有导出；错误范围明确记录。
          if (String(error).includes('Error creating WebGL context'))
            threeD = { available: false, reason: 'WebGL2 unavailable; export unaffected' };
          else throw error;
        } finally {
          component?.dispose();
          furniture?.dispose();
          editor?.dispose();
        }
      }
    }
    rows.push({
      id,
      orientation,
      longEdgeM,
      ms: Math.round(performance.now() - start),
      size: [preview.width, preview.height],
      summary: result.summary,
      bytes: round.length,
      sceneCount,
    });
    preview.close();
  }
  return {
    ok: true,
    cases: rows,
    threeD,
    rendererNodeAvailable: typeof (globalThis as any).require === 'function',
  };
}
run()
  .then((report) => {
    document.getElementById('report')!.textContent = JSON.stringify(report, null, 2);
    console.log('HOMELAND_RUNTIME ' + JSON.stringify(report));
  })
  .catch((error) => {
    const report = { ok: false, error: String(error) };
    document.getElementById('report')!.textContent = JSON.stringify(report);
    console.log('HOMELAND_RUNTIME ' + JSON.stringify(report));
  });
