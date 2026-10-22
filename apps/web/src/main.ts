import './style.css';
import ExportWorker from './export.worker?worker&inline';
import PreviewWorker from './preview.worker?worker&inline';
import type { BlueprintScene } from '../../../packages/core/src/scene.js';
import type { BlueprintViewer } from './preview3d.js';
import { loadViewer } from './viewer-loader.js';
import { installFurniturePanel } from './furniture-panel.js';
import { decodeFile, prepareFile } from './upload.js';
import { installTheme } from './theme.js';
import {
  PROJECT_LINKS,
  EXAMPLES,
  GAME_GUIDE_HTML,
  DEVELOPER_GUIDE_HTML,
  GAME_LIMITS_HTML,
  PALETTE_GUIDE_HTML,
} from './content.generated.js';
import type {
  ExportOptions,
  ExportProgress,
  ExportResult,
} from '../../../packages/core/src/types.js';

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`界面缺少 ${id}`);
  return value as T;
}
const form = element<HTMLFormElement>('export-form');
if (PROJECT_LINKS.repositoryUrl) {
  const repositoryLink = element<HTMLAnchorElement>('repository-link');
  repositoryLink.href = PROJECT_LINKS.repositoryUrl;
  repositoryLink.removeAttribute('aria-disabled');
  repositoryLink.title = '在新标签页打开源码仓库';
}
installTheme(element<HTMLButtonElement>('theme-toggle'));
installFurniturePanel();
const fileInput = element<HTMLInputElement>('image-input');
const generate = element<HTMLButtonElement>('generate');
const cancel = element<HTMLButtonElement>('cancel');
const image = element<HTMLImageElement>('preview-image');
const status = element('status');
const meters = element<HTMLInputElement>('long-edge');
const optionsDialog = element<HTMLDialogElement>('options-dialog');
const before = element<HTMLButtonElement>('tab-before');
const after = element<HTMLButtonElement>('tab-after');
const threeTab = element<HTMLButtonElement>('tab-3d');
let previewMode: 'before' | 'after' | '3d' = 'before';
let previewInput: { blueprint: Uint8Array; summary: ExportResult['summary'] } | undefined;
let viewer: BlueprintViewer | undefined, previewWorker: Worker | undefined;
let preparingPreview = false,
  previewTimer: ReturnType<typeof setTimeout> | undefined;
const progress = element<HTMLProgressElement>('progress');
const zipLink = element<HTMLAnchorElement>('download-package');
const blueprintLink = element<HTMLAnchorElement>('download-blueprint');
zipLink.addEventListener('click', () => {
  if (zipLink.hasAttribute('href'))
    say('已发起完整包下载，请查看浏览器下载记录或系统“下载”文件夹。', 'success');
});
blueprintLink.addEventListener('click', () => {
  if (blueprintLink.hasAttribute('href'))
    say('已发起蓝图下载，请查看浏览器下载记录或系统“下载”文件夹。', 'success');
});
let source: File | undefined,
  sourceURL = '',
  resultURL = '',
  zipURL = '',
  blueprintURL = '';
let worker: Worker | undefined, clock: ReturnType<typeof setInterval> | undefined;
let revision = 0,
  loading = false,
  started = 0;
const labels: Record<ExportProgress['stage'], string> = {
  sample: '正在适配图案尺寸',
  color: '正在搭配拼布颜色',
  layout: '正在排列家具',
  verify: '正在核对蓝图文件',
  done: '正在整理下载文件',
};
const progressRanges: Record<ExportProgress['stage'], [number, number]> = {
  sample: [0, 6],
  color: [6, 70],
  layout: [70, 75],
  verify: [75, 97],
  done: [97, 100],
};

function say(message: string, kind = '') {
  status.textContent = message;
  status.className = `status ${kind}`;
}
function revoke(url: string) {
  if (url) URL.revokeObjectURL(url);
}
function setPreview(result: boolean | '3d') {
  previewMode = result === '3d' ? '3d' : result ? 'after' : 'before';
  const is3d = result === '3d';
  const url = result === true ? resultURL : sourceURL;
  image.src = url;
  image.hidden = is3d || !url;
  image.classList.toggle('pixelated', result === true);
  image.alt = result ? '从蓝图文件回读的拼布效果' : '选择的原始图片';
  element('empty-state').hidden = is3d || !!url;
  element('preview-3d').hidden = !is3d;
  for (const [button, name] of [
    [before, 'before'],
    [after, 'after'],
    [threeTab, '3d'],
  ] as const) {
    button.classList.toggle('active', previewMode === name);
    button.setAttribute('aria-pressed', String(previewMode === name));
  }
  viewer?.setActive(is3d);
  if (!is3d) expandPreview(false);
}
function expandPreview(open: boolean) {
  document.querySelector('.preview-card')!.classList.toggle('preview-expanded', open);
  document.body.classList.toggle('viewer-expanded', open);
  element('view-expand').textContent = open ? '收起预览' : '放大查看';
  element('view-expand').setAttribute('aria-pressed', String(open));
}
function stopPreviewWorker() {
  previewWorker?.terminate();
  previewWorker = undefined;
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = undefined;
  preparingPreview = false;
}
function clearPreview() {
  stopPreviewWorker();
  viewer?.dispose();
  viewer = undefined;
  previewInput = undefined;
  threeTab.disabled = true;
  element<HTMLInputElement>('view-supports').checked = false;
  element<HTMLInputElement>('view-wireframe').checked = false;
  element('view-retry').hidden = true;
  expandPreview(false);
}
async function preparePreview() {
  if (viewer || preparingPreview || !previewInput) return;
  const job = revision;
  preparingPreview = true;
  element('viewer-message').textContent = '正在读取蓝图中的家具…';
  element('view-retry').hidden = true;
  const fail = (message: string) => {
    if (job !== revision) return;
    stopPreviewWorker();
    viewer?.dispose();
    viewer = undefined;
    element('viewer-message').textContent = message;
    element('view-retry').hidden = false;
  };
  try {
    const BlueprintViewer = await loadViewer();
    if (job !== revision || !previewInput) return;
    previewWorker = new PreviewWorker();
    previewTimer = setTimeout(() => fail('3D 预览准备超时，可以重新加载；蓝图仍可下载。'), 30000);
    previewWorker.onerror = () => fail('3D 预览读取失败，可以重新加载；蓝图仍可下载。');
    previewWorker.onmessage = ({
      data,
    }: MessageEvent<
      { type: 'result'; scene: BlueprintScene } | { type: 'error'; message: string }
    >) => {
      if (job !== revision) return;
      stopPreviewWorker();
      if (data.type === 'error') {
        fail(data.message);
        return;
      }
      try {
        viewer = new BlueprintViewer(element('preview-canvas'), (message) => {
          element('viewer-message').textContent = message;
        });
        viewer.load(data.scene);
        viewer.supports(element<HTMLInputElement>('view-supports').checked);
        viewer.wireframe(element<HTMLInputElement>('view-wireframe').checked);
        viewer.setActive(previewMode === '3d');
        const count = data.scene.count;
        element('view-front').textContent = data.scene.orientation === 'ground' ? '俯视' : '正面';
        element('viewer-message').textContent =
          `显示 ${count.total.toLocaleString('zh-CN')} 件家具 · 基座按位置示意`;
        element('viewer-help').textContent = count.glass
          ? '琉璃显示轮廓，叠色参见“拼布效果”。拖动旋转，滚轮缩放。'
          : '拖动旋转 · 滚轮或双指缩放 · 右键平移';
      } catch {
        fail('当前设备无法显示 3D，可重试或切回拼布效果；蓝图仍可下载。');
      }
    };
    // 不转移下载所用的 buffer；取消预览不会影响真实文件。
    previewWorker.postMessage(previewInput);
  } catch {
    fail('3D 组件加载失败，可重试或切回拼布效果；蓝图仍可下载。');
  }
}
threeTab.addEventListener('click', () => {
  setPreview('3d');
  void preparePreview();
});
element('view-retry').addEventListener('click', () => void preparePreview());
for (const name of ['front', 'side', 'angle'] as const)
  element(`view-${name}`).addEventListener('click', () => viewer?.view(name));
element('view-reset').addEventListener('click', () => viewer?.view('front'));
element('view-supports').addEventListener('change', () =>
  viewer?.supports(element<HTMLInputElement>('view-supports').checked),
);
element('view-wireframe').addEventListener('change', () =>
  viewer?.wireframe(element<HTMLInputElement>('view-wireframe').checked),
);
element('view-expand').addEventListener('click', () =>
  expandPreview(!document.body.classList.contains('viewer-expanded')),
);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') expandPreview(false);
});
document.addEventListener('visibilitychange', () =>
  viewer?.setActive(!document.hidden && previewMode === '3d'),
);
function endWork() {
  worker?.terminate();
  worker = undefined;
  if (clock) clearInterval(clock);
  clock = undefined;
  cancel.hidden = true;
  element('progress-area').hidden = true;
  generate.disabled = !source || loading;
  generate.textContent = '生成蓝图 →';
  form.removeAttribute('aria-busy');
}
function invalidate() {
  revision++;
  endWork();
  clearPreview();
  [resultURL, zipURL, blueprintURL].forEach(revoke);
  resultURL = zipURL = blueprintURL = '';
  zipLink.removeAttribute('href');
  blueprintLink.removeAttribute('href');
  element('result-area').hidden = true;
  after.disabled = true;
  setPreview(false);
}
function currentOptions(): ExportOptions {
  const orientation = (form.elements.namedItem('orientation') as RadioNodeList).value as
    'wall' | 'ground';
  return {
    orientation,
    longEdgeM: meters.valueAsNumber,
    maxFurniture:
      element<HTMLSelectElement>('budget-mode').value === 'custom'
        ? element<HTMLInputElement>('furniture-limit').valueAsNumber
        : undefined,
    showRootHandle: element<HTMLInputElement>('root-handle').checked,
    experimentalMaterials: element<HTMLInputElement>('experimental-materials').checked,
  };
}
function updateSizes() {
  const ground = currentOptions().orientation === 'ground';
  const experimental = element<HTMLInputElement>('experimental-materials');
  experimental.disabled = ground;
  if (ground) experimental.checked = false;
  meters.max = ground ? '200' : '96';
  const sizes = ground ? [8, 20, 50, 100] : [4, 8, 12, 20];
  document.querySelectorAll<HTMLButtonElement>('[data-size]').forEach((button, i) => {
    button.dataset.size = String(sizes[i]);
    button.textContent = `${sizes[i]} 米`;
    button.classList.toggle('selected', meters.valueAsNumber === sizes[i]);
  });
}
element('budget-mode').addEventListener('change', () => {
  const custom = element<HTMLSelectElement>('budget-mode').value === 'custom';
  element('custom-budget').hidden = !custom;
  element<HTMLInputElement>('furniture-limit').disabled = !custom;
  element<HTMLInputElement>('furniture-limit').required = custom;
});
async function chooseFile(next: File) {
  loading = true;
  invalidate();
  source = undefined;
  generate.disabled = true;
  revoke(sourceURL);
  sourceURL = '';
  setPreview(false);
  element('file-info').hidden = true;
  element('preview-title').textContent = '正在读取图片';
  say('正在检查图片…');
  const selectedRevision = revision;
  try {
    const prepared = await prepareFile(next),
      header = prepared.header;
    if (selectedRevision !== revision) return;
    source = prepared.file;
    sourceURL = URL.createObjectURL(prepared.file);
    setPreview(false);
    element('file-name').textContent = next.name;
    element('file-name').title = next.name;
    element('file-size').textContent =
      `${header.width} × ${header.height} 像素 · ${next.size < 1024 ? next.size + ' B' : next.size < 1024 ** 2 ? (next.size / 1024).toFixed(1) + ' KiB' : (next.size / 1024 ** 2).toFixed(1) + ' MiB'}${prepared.firstFrameOnly ? ' · GIF 第一帧' : ''}`;
    element('file-info').hidden = false;
    element('preview-title').textContent = next.name;
    say(
      prepared.firstFrameOnly
        ? 'GIF 第一帧已加载，请设置摆放方式与尺寸。'
        : '图片已加载，请设置摆放方式与尺寸。',
    );
  } catch (error) {
    if (selectedRevision === revision) {
      element('preview-title').textContent = '重新选择图片';
      say(error instanceof Error ? error.message : '图片读取失败，请重新选择文件。', 'error');
    }
  } finally {
    if (selectedRevision === revision) {
      loading = false;
      generate.disabled = !source;
    }
  }
}
element('choose-image').addEventListener('click', () => fileInput.click());
element('change-image').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (file) void chooseFile(file);
});
const drop = element('drop-zone');
for (const name of ['dragenter', 'dragover'])
  drop.addEventListener(name, (event) => {
    event.preventDefault();
    drop.classList.add('dragover');
  });
drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
drop.addEventListener('drop', (event) => {
  event.preventDefault();
  drop.classList.remove('dragover');
  const file = event.dataTransfer?.files[0];
  if (file) void chooseFile(file);
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());
document.querySelectorAll<HTMLButtonElement>('[data-example]').forEach((button) =>
  button.addEventListener('click', () => {
    const example = EXAMPLES[button.dataset.example as keyof typeof EXAMPLES];
    const bytes = Uint8Array.from(atob(example.base64), (c) => c.charCodeAt(0));
    void chooseFile(new File([bytes], example.name, { type: example.type }));
  }),
);
function changed() {
  loading = false;
  invalidate();
  updateSizes();
  if (source) say('设置已更新，请重新生成蓝图。');
}
meters.addEventListener('input', changed);
element('furniture-limit').addEventListener('input', changed);
element('furniture-limit').addEventListener('invalid', (event) => {
  // 闭合弹窗中的必填项仍参与表单校验；先展示字段，浏览器才能定位它。
  if (!meters.validity.valid) {
    event.preventDefault();
    return;
  }
  if (!optionsDialog.open) optionsDialog.showModal();
});
form
  .querySelectorAll('input[name="orientation"],#budget-mode,#root-handle,#experimental-materials')
  .forEach((control) => control.addEventListener('change', changed));
document.querySelectorAll<HTMLButtonElement>('[data-size]').forEach((button) =>
  button.addEventListener('click', () => {
    meters.value = button.dataset.size!;
    changed();
  }),
);
before.addEventListener('click', () => setPreview(false));
after.addEventListener('click', () => {
  if (resultURL) setPreview(true);
});
cancel.addEventListener('click', () => {
  invalidate();
  say('已取消，可以调整设置后重新生成。');
});

type WorkerResult = {
  type: 'result';
  summary: ExportResult['summary'];
  verification: ExportResult['verification'];
  blueprint: Uint8Array;
  png: Uint8Array;
  zip: Uint8Array;
};
type WorkerMessage =
  WorkerResult | ({ type: 'progress' } & ExportProgress) | { type: 'error'; message: string };
function downloadStem(name: string) {
  return (
    name
      .replace(/\.[^.]+$/, '')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .slice(0, 64) || '家园图案'
  );
}
function asBlob(bytes: Uint8Array, type: string) {
  return new Blob([bytes.slice().buffer as ArrayBuffer], { type });
}
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!source || loading || !form.reportValidity()) return;
  if (optionsDialog.open) optionsDialog.close();
  const input = source,
    options = currentOptions();
  invalidate();
  const job = revision;
  generate.disabled = true;
  generate.textContent = '正在生成…';
  form.setAttribute('aria-busy', 'true');
  cancel.hidden = false;
  element('progress-area').hidden = false;
  progress.value = 0;
  started = performance.now();
  element('elapsed').textContent = '0 秒';
  element('progress-label').textContent = '正在读取图片';
  say('正在生成蓝图。');
  clock = setInterval(() => {
    element('elapsed').textContent = `${((performance.now() - started) / 1000).toFixed(1)} 秒`;
  }, 200);
  try {
    const pixels = await decodeFile(input);
    if (job !== revision) return;
    worker = new ExportWorker();
    worker.onerror = () => {
      if (job !== revision) return;
      endWork();
      say('生成中断，请重新选择图片或降低家具用量后重试。', 'error');
    };
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      if (job !== revision) return;
      const message = event.data;
      if (message.type === 'progress') {
        const [start, end] = progressRanges[message.stage];
        progress.value = Math.max(
          progress.value,
          Math.round(start + message.fraction * (end - start)),
        );
        element('progress-label').textContent = labels[message.stage];
        return;
      }
      endWork();
      if (message.type === 'error') {
        say(message.message, 'error');
        return;
      }
      if (!message.verification.roundTrip || !message.verification.geometry) {
        say('蓝图校验未通过，请重试。', 'error');
        return;
      }
      resultURL = URL.createObjectURL(asBlob(message.png, 'image/png'));
      zipURL = URL.createObjectURL(asBlob(message.zip, 'application/zip'));
      blueprintURL = URL.createObjectURL(asBlob(message.blueprint, 'application/octet-stream'));
      const stem = downloadStem(input.name),
        s = message.summary;
      previewInput = { blueprint: message.blueprint, summary: s };
      threeTab.disabled = false;
      zipLink.href = zipURL;
      zipLink.download = `${stem}-家园蓝图.zip`;
      blueprintLink.href = blueprintURL;
      blueprintLink.download = `${stem}.blueprintx`;
      element('result-size').textContent = `${s.widthM} × ${s.heightM} 米`;
      element('result-furniture').textContent = `${s.totalCount.toLocaleString('zh-CN')} 件`;
      element('result-grid').textContent = `${s.gridWidth} × ${s.gridHeight}`;
      element('result-area').hidden = false;
      after.disabled = false;
      setPreview(true);
      const notes = [
        s.backgroundFilled ? '透明区域已填充白色背景。' : '',
        s.canvasPadded ? '为保留完整图案，已添加画布留白。' : '',
      ].join('');
      const trialNote =
        s.paletteMode === 'experimental-glass'
          ? s.glassCount
            ? `试验配色采用 ${s.glassCount} 件透明材料，游戏内效果仍需核对。`
            : '试验材料未改善评分，已保留基础配色。'
          : '';
      say(`蓝图已生成，预览与下载已就绪。${notes}${trialNote}`, 'success');
    };
    worker.postMessage({ ...pixels, options }, [pixels.rgba]);
  } catch (error) {
    if (job !== revision) return;
    endWork();
    say(error instanceof Error ? error.message : '生成失败，请重试。', 'error');
  }
});
element('mechanics-content').innerHTML = GAME_GUIDE_HTML;
element('developer-content').innerHTML = DEVELOPER_GUIDE_HTML;
element('limits-content').innerHTML = GAME_LIMITS_HTML;
element('palette-content').innerHTML = PALETTE_GUIDE_HTML;
for (const name of ['mechanics', 'developer', 'limits', 'palette', 'options'])
  element(`${name}-button`).addEventListener('click', () =>
    element<HTMLDialogElement>(`${name}-dialog`).showModal(),
  );
document
  .querySelectorAll<HTMLButtonElement>('[data-close-dialog]')
  .forEach((button) => button.addEventListener('click', () => button.closest('dialog')?.close()));
for (const contentId of [
  'mechanics-content',
  'developer-content',
  'limits-content',
  'palette-content',
])
  element(contentId).addEventListener('click', (event) => {
    const anchor = (event.target as HTMLElement).closest('a');
    const href = anchor?.getAttribute('href');
    if (href?.startsWith('#')) {
      const target = document.getElementById(href.slice(1));
      if (!target) return;
      event.preventDefault();
      const sourceDialog = element(contentId).closest('dialog'),
        targetDialog = target.closest('dialog');
      if (targetDialog instanceof HTMLDialogElement && targetDialog !== sourceDialog) {
        sourceDialog?.close();
        if (!targetDialog.open) targetDialog.showModal();
      }
      if (target instanceof HTMLDetailsElement) target.open = true;
      const chapter = target?.closest('details');
      if (chapter) chapter.open = true;
      if (target) {
        const content = target.closest<HTMLElement>('.dialog-body') ?? element(contentId);
        content.scrollTo({
          top:
            content.scrollTop +
            target.getBoundingClientRect().top -
            content.getBoundingClientRect().top,
        });
      }
    }
  });
window.addEventListener('pagehide', () => {
  endWork();
  clearPreview();
  [sourceURL, resultURL, zipURL, blueprintURL].forEach(revoke);
});
updateSizes();
element<HTMLDialogElement>('developer-dialog').showModal();
