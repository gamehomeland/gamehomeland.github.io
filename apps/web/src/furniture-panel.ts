import { loadFurnitureViewer } from './viewer-loader.js';
import type { FurnitureViewer } from './furniture3d.js';
import { MAX_MODEL_BYTES } from './model-file.js';
import { installScenePanel } from './scene-panel.js';
import { editorResourceByHash } from '../../../packages/core/src/editor.js';
import { modelLibraryURL } from './model-library.js';

type Sample = { file: string; name: string; note: string; category?: string; sha256?: string };
export function installFurniturePanel() {
  const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const dialog = get<HTMLElement>('furniture-dialog');
  const visible = () => !dialog.hidden;
  const input = get<HTMLInputElement>('furniture-file');
  const status = get('furniture-status');
  let viewer: FurnitureViewer | undefined,
    sequence = 0,
    samples: Sample[] | undefined;
  let initializing: Promise<FurnitureViewer> | undefined;
  let editing = false;
  let opened = false;
  const readSample = async (row: Sample) => {
    const url = modelLibraryURL(`furniture/${row.file}`, document.baseURI, row.sha256);
    if (!url) throw new Error('单文件离线页请通过“打开模型文件”选择 GLB，桌面版内置完整样本库。');
    const res = await fetch(url, {
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error('家具模型文件读取失败。');
    if (Number(res.headers.get('content-length')) > MAX_MODEL_BYTES)
      throw new Error('模型超过 50 MiB，请选择较小的文件。');
    return res.arrayBuffer();
  };
  const scenePanel = installScenePanel(async (resource) => {
    const row = samples?.find((row) => row.sha256 === resource.modelSha256);
    return row ? readSample(row) : undefined;
  });
  const changeMode = (edit: boolean) => {
    editing = edit;
    get('scene-placement-label').hidden = !edit;
    dialog.classList.toggle('editor-mode', edit);
    get('scene-workspace').hidden = !edit;
    (dialog.querySelector('.furniture-view') as HTMLElement).hidden = edit;
    get('furniture-preview-tab').classList.toggle('active', !edit);
    get('furniture-edit-tab').classList.toggle('active', edit);
    get('furniture-preview-tab').setAttribute('aria-pressed', String(!edit));
    get('furniture-edit-tab').setAttribute('aria-pressed', String(edit));
    if (visible())
      get<HTMLButtonElement>(edit ? 'furniture-edit-tab' : 'furniture-preview-tab').focus();
    get('furniture-mode-help').textContent = edit
      ? '选择家具加入布置；灰色条目请在“单件预览”中查看。'
      : '选择家具后，可查看材质、结构线和模型尺寸。';
    for (const b of get('furniture-samples').querySelectorAll('button'))
      b.disabled = edit && b.dataset.editable !== 'true';
    viewer?.setActive(!edit && visible());
    void scenePanel.show(edit && visible());
  };
  get('furniture-preview-tab').addEventListener('click', () => changeMode(false));
  get('furniture-edit-tab').addEventListener('click', () => changeMode(true));
  const ensure = async () => {
    if (viewer) return viewer;
    if (!initializing)
      initializing = loadFurnitureViewer()
        .then((Viewer) => {
          viewer = new Viewer(get('furniture-canvas'), (text) => {
            status.textContent = text;
          });
          return viewer;
        })
        .finally(() => {
          initializing = undefined;
        });
    return initializing;
  };
  async function display(read: () => Promise<ArrayBuffer>, name: string, note = '') {
    const serial = ++sequence;
    viewer?.cancelPending();
    status.textContent = '正在读取家具模型…';
    try {
      const [bytes, renderer] = await Promise.all([read(), ensure()]);
      if (serial !== sequence) return;
      const info = await renderer.load(bytes);
      if (serial !== sequence || !info) return;
      get('furniture-name').textContent = name;
      const styles = get<HTMLSelectElement>('furniture-style');
      styles.replaceChildren(...info.styles.map((name, index) => new Option(name, String(index))));
      styles.value = String(info.defaultDetail);
      styles.disabled = info.styles.length < 2;
      renderer.wireframe(get<HTMLInputElement>('furniture-wire').checked);
      renderer.setActive(visible() && !document.hidden);
      get('furniture-stats').textContent =
        `模型 XYZ：${info.size.map((v) => v.toFixed(3)).join(' × ')} 米 · ${info.triangles.toLocaleString('zh-CN')} 个三角形`;
      get('furniture-note').textContent =
        note ||
        (info.geometryOnly ? '几何预览，未包含完整游戏材质。' : '显示模型内嵌材质，采用中性照明。');
      status.textContent = '拖动旋转 · 滚轮或双指缩放 · 右键平移';
      get('furniture-empty').hidden = true;
    } catch (error) {
      if (serial === sequence)
        status.textContent =
          error instanceof Error ? error.message : '家具预览打开失败，请重新选择模型文件。';
    }
  }
  async function loadLibrary() {
    if (samples) return;
    const url = modelLibraryURL('furniture/manifest.json', document.baseURI);
    if (!url) {
      get('furniture-mode-help').textContent =
        '单文件离线页可手动打开 GLB；桌面版已内置家具与地下室模型。';
      return;
    }
    samples = [];
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('模型目录加载失败');
      const data = await response.json();
      if (!Array.isArray(data) || data.length > 1000) throw new Error('模型目录无效');
      samples = data.filter(
        (row: Sample) =>
          typeof row.name === 'string' &&
          row.name.length <= 80 &&
          typeof row.file === 'string' &&
          /^[\w-]+\.glb$/.test(row.file) &&
          typeof row.note === 'string' &&
          typeof row.sha256 === 'string' &&
          /^[0-9a-f]{64}$/.test(row.sha256),
      );
      const list = get('furniture-samples');
      const category = get<HTMLSelectElement>('furniture-category');
      const categories = [...new Set(samples.map((row) => row.category || '其他'))];
      for (const name of categories) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        category.append(option);
      }
      for (const row of samples) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = row.name;
        button.dataset.category = row.category || '其他';
        button.dataset.editable = String(!!row.sha256 && editorResourceByHash.has(row.sha256));
        button.disabled = editing && button.dataset.editable !== 'true';
        button.title =
          button.dataset.editable === 'true'
            ? '可加入布置并导出蓝图'
            : '此模型仅支持单件预览，暂不支持布置导出';
        button.addEventListener('click', () => {
          for (const b of list.querySelectorAll('button'))
            b.setAttribute('aria-pressed', String(b === button));
          if (editing) void scenePanel.add(() => readSample(row));
          else void display(() => readSample(row), row.name, row.note);
        });
        list.append(button);
      }
      get('furniture-samples-section').hidden = !samples.length;
      void scenePanel.libraryReady();
      filter();
      if (visible() && sequence === 0)
        (list.querySelector('button') as HTMLButtonElement | null)?.click();
    } catch {
      samples = undefined;
      get('furniture-mode-help').textContent =
        '内置模型目录加载失败，可重新进入此工作区，或打开本机 GLB 文件。';
    }
  }
  function filter() {
    const word = get<HTMLInputElement>('furniture-search').value.trim().toLocaleLowerCase();
    const category = get<HTMLSelectElement>('furniture-category').value;
    let count = 0;
    for (const button of get('furniture-samples').querySelectorAll('button')) {
      button.hidden =
        !button.textContent?.toLocaleLowerCase().includes(word) ||
        (category !== '' && button.dataset.category !== category);
      if (!button.hidden) count++;
    }
    get('furniture-count').textContent = `显示 ${count} / ${samples?.length ?? 0} 件`;
    get('furniture-no-match').hidden = count > 0;
  }
  get('furniture-search').addEventListener('input', filter);
  get('furniture-category').addEventListener('change', filter);
  const selectMain = (furniture: boolean) => {
    dialog.hidden = !furniture;
    get('image-workspace').hidden = furniture;
    for (const id of ['mode-image', 'furniture-button']) {
      const active = (id === 'furniture-button') === furniture;
      get(id).classList.toggle('active', active);
      get(id).setAttribute('aria-selected', String(active));
      get(id).tabIndex = active ? 0 : -1;
    }
  };
  for (const id of ['furniture-button', 'furniture-shortcut'])
    get(id).addEventListener('click', () => {
      selectMain(true);
      changeMode(id === 'furniture-shortcut' ? false : opened ? editing : true);
      opened = true;
      void loadLibrary();
    });
  get('furniture-button').tabIndex = -1;
  for (const id of ['mode-image', 'furniture-button'])
    get(id).addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const target =
        event.key === 'Home'
          ? 'mode-image'
          : event.key === 'End'
            ? 'furniture-button'
            : id === 'mode-image'
              ? 'furniture-button'
              : 'mode-image';
      get(target).click();
      get(target).focus();
    });
  get('furniture-open').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.glb') || file.size > MAX_MODEL_BYTES) {
      status.textContent = '请选择不超过 50 MiB 的 GLB 模型。';
      return;
    }
    for (const b of get('furniture-samples').querySelectorAll('button'))
      b.setAttribute('aria-pressed', 'false');
    if (editing) void scenePanel.add(() => file.arrayBuffer());
    else void display(() => file.arrayBuffer(), file.name);
  });
  for (const mode of ['front', 'side', 'top', 'angle'] as const)
    get(`furniture-${mode}`).addEventListener('click', () => viewer?.view(mode));
  get('furniture-wire').addEventListener('change', () =>
    viewer?.wireframe(get<HTMLInputElement>('furniture-wire').checked),
  );
  get('furniture-style').addEventListener('change', async () => {
    try {
      await viewer?.style(Number(get<HTMLSelectElement>('furniture-style').value));
      viewer?.wireframe(get<HTMLInputElement>('furniture-wire').checked);
    } catch {
      status.textContent = '材质样式加载失败，请重新选择家具。';
    }
  });
  get('mode-image').addEventListener('click', () => {
    selectMain(false);
    viewer?.setActive(false);
    scenePanel.pause();
  });
  document.addEventListener('visibilitychange', () => {
    viewer?.setActive(!editing && visible() && !document.hidden);
    if (editing) void scenePanel.show(visible() && !document.hidden);
  });
  window.addEventListener('pagehide', () => {
    sequence++;
    viewer?.dispose();
    viewer = undefined;
  });
}
