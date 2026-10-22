import { modelLibraryURL } from './model-library.js';
import {
  SceneHistory,
  emptyScene,
  editorResourceByKey,
  exportSceneBlueprint,
  importSceneBlueprint,
  readSceneProject,
  writeSceneProject,
  scenePackage,
  suggestScenePosition,
  constrainSceneItem,
  validateScene,
  sceneItemFloor,
  placeSceneItem,
  type SceneItem,
  type SceneDocument,
  type EditorResource,
} from '../../../packages/core/src/editor.js';
import type { Quat, Vec3 } from '../../../packages/core/src/types.js';
import { loadSceneViewer } from './viewer-loader.js';
import type { SceneViewer, EditMode } from './scene-viewer.js';
import { Euler, Quaternion } from 'three';
import { landPlan, landBlueprintFrame } from '../../../packages/core/src/land.js';
import { installLandPanel } from './land-panel.js';
import {
  inspectWholeBlueprint,
  mergeWholeBlueprint,
  mergeWholeBlueprintDetailed,
  readWholeBlueprintPreview,
  type WholeBlueprintPreview,
} from '../../../packages/core/src/blueprint-merge.js';
import {
  BASEMENT_LIMITS,
  basementResources,
  basementSize,
  basementGridPhase,
  basementFloor,
  basementMasks,
  basementModelResources,
  editBasement,
  type BasementCell,
} from '../../../packages/core/src/basement.js';

export function installScenePanel(
  resolveModel: (resource: EditorResource) => Promise<ArrayBuffer | undefined>,
) {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const history = new SceneHistory();
  let basementMode = false,
    basementAction: 'dig' | 'fill' | 'place' = 'dig';
  let placement: string | undefined;
  const basementLoads = new Set<number>(),
    basementFailures = new Set<number>();
  let viewer: SceneViewer | undefined,
    selected: string | undefined,
    active = false,
    epoch = 0;
  let creating: Promise<SceneViewer> | undefined;
  const urls = new Set<string>();
  const renderedFields = new Map<string, string>();
  const draftKey = 'homeland-scene-draft-v1';
  let baseBlueprint: Uint8Array | undefined,
    baseName = '',
    baseEpoch = 0;
  let basePreview: WholeBlueprintPreview | undefined,
    previewKey = '',
    mergeError = '',
    connectionCount = 0,
    attachmentTransfers = 0;
  let displayedCells: BasementCell[] = [],
    displayedMasks: ReadonlyMap<string, number> | undefined,
    readonlyRooms: string[] = [],
    referenceObjects: WholeBlueprintPreview['objects'] = [];
  const merging = () =>
    (!!history.document.basements?.length || !!baseBlueprint) &&
    el<HTMLSelectElement>('scene-export-mode').value === 'merge';
  function prepareMergeView() {
    const doc = history.document,
      key = JSON.stringify([doc, merging(), baseEpoch, !!baseBlueprint]);
    if (key === previewKey) return;
    previewKey = key;
    mergeError = '';
    connectionCount = 0;
    attachmentTransfers = 0;
    displayedCells = [...(doc.basements ?? [])];
    displayedMasks = undefined;
    readonlyRooms = [];
    referenceObjects = [];
    if (!merging() || !baseBlueprint || !basePreview) return;
    try {
      const frame = landBlueprintFrame(doc.landKey);
      if (
        Math.abs(frame.widthM - basePreview.extentM[0]) > 0.001 ||
        Math.abs(frame.depthM - basePreview.extentM[1]) > 0.001
      )
        throw new Error('原整屋与当前户型范围不一致，请选择对应户型');
      let preview = basePreview;
      if (doc.items.length || doc.basements?.length) {
        const result = mergeWholeBlueprintDetailed(
          baseBlueprint,
          exportSceneBlueprint(doc, { forMerge: true }),
        );
        preview = readWholeBlueprintPreview(result.blueprint);
        connectionCount = result.report.connections;
        attachmentTransfers = result.report.transferredAttachments.length;
      }
      const oldIds = new Set(basePreview.rooms.map((r) => r.id)),
        masks = new Map<string, number>();
      displayedCells = preview.rooms.map((room): BasementCell => {
        const size = basementResources.find((r) => r.brushId === room.brushId)!.size,
          x = (room.position[0] - frame.offset[0]) / size,
          z = (room.position[2] - frame.offset[1]) / size,
          level = -room.position[1] / size;
        const authored = oldIds.has(room.id)
          ? undefined
          : doc.basements?.find(
              (c) =>
                c.brushId === room.brushId &&
                Math.abs(c.x - x) < 1e-5 &&
                Math.abs(c.z - z) < 1e-5 &&
                Math.abs(c.level - level) < 1e-5,
            );
        const id = authored?.id ?? `original-room-${room.id}`;
        if (!authored) readonlyRooms.push(id);
        masks.set(id, room.mask);
        return { id, brushId: room.brushId, x, z, level };
      });
      displayedMasks = masks;
      const oldObjects = new Set(basePreview.objects.map((o) => o.id));
      referenceObjects = preview.objects
        .filter((o) => oldObjects.has(o.id))
        .map((o) => {
          const matrix = [...o.matrix];
          matrix[12] -= frame.offset[0];
          matrix[14] -= frame.offset[1];
          return { ...o, matrix };
        });
    } catch (error) {
      mergeError = error instanceof Error ? error.message : '合并预览失败';
    }
  }
  try {
    const saved = sessionStorage.getItem(draftKey);
    if (saved) history.commit(readSceneProject(new TextEncoder().encode(saved)));
  } catch {
    /* 损坏或不可用的会话存储不阻止用户打开工程文件。 */
  }
  const status = el('scene-status');
  const say = (text: string) => {
    status.textContent = text;
  };
  if (history.document.items.length || history.document.basements?.length)
    say(
      `已恢复暂存：${history.document.items.length} 件家具、${history.document.basements?.length ?? 0} 个地下室单元。`,
    );
  const ensure = async () => {
    if (viewer) return viewer;
    if (!creating)
      creating = loadSceneViewer()
        .then((Viewer) => {
          viewer = new Viewer(el('scene-canvas'), {
            selected: (id) => {
              selected = id;
              updateBasementView();
              renderInspector();
              renderList();
            },
            preview: (item) => renderInspector(item),
            transformed: (item) => changeItem(item),
            notice: say,
            basementAction: applyBasement,
          });
          viewer.setItems(history.document.items);
          viewer.setPlot(history.document.landKey);
          updateBasementView();
          if (history.document.items.length || history.document.basements?.length) viewer.focus();
          else if (history.document.landKey) viewer.focusPlot();
          viewer.setActive(active);
          return viewer;
        })
        .finally(() => (creating = undefined));
    return creating;
  };
  const getItem = () => history.document.items.find((i) => i.id === selected);
  async function loadMissingModels(renderer: SceneViewer) {
    const current = epoch;
    const referenceKeys = referenceObjects
      .map((o) => editorResourceByKey.get(`model-${o.resourceId}`)?.key)
      .filter((k): k is string => !!k);
    for (const key of new Set([
      ...history.document.items.map((i) => i.resourceKey),
      ...referenceKeys,
    ])) {
      if (current !== epoch) return;
      if (renderer.hasModel(key)) continue;
      try {
        const bytes = await resolveModel(editorResourceByKey.get(key)!);
        if (current !== epoch) return;
        if (bytes) await renderer.registerModel(bytes);
      } catch {
        /* 尺寸框保留资源身份，模型稍后可重新打开。 */
      }
    }
    if (current === epoch) renderInspector();
  }
  const download = (bytes: Uint8Array, name: string, type = 'application/octet-stream') => {
    const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type }));
    urls.add(url);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      urls.delete(url);
    }, 60000);
  };
  const stem = () =>
    history.document.name
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .trim()
      .slice(0, 60) || '家园布置';
  function update() {
    const doc = history.document;
    prepareMergeView();
    viewer?.setItems(doc.items);
    viewer?.setPlot(doc.landKey);
    updateBasementView();
    updatePlacements();
    void loadBasementModels();
    const ground = landPlan(doc.landKey);
    el('scene-land-name').textContent = ground
      ? `${ground.name} · ${ground.areaM2.toLocaleString('zh-CN')} 平`
      : '点击选择社区地块、私宅或面积规格';
    el('scene-land-open').classList.toggle('has-selection', !!ground);
    el<HTMLButtonElement>('scene-land-view').disabled = !ground;
    viewer?.select(selected);
    el<HTMLInputElement>('scene-name').value = doc.name;
    el<HTMLButtonElement>('scene-undo').disabled = !history.canUndo;
    el<HTMLButtonElement>('scene-redo').disabled = !history.canRedo;
    const exportDisabled =
      (!doc.items.length && !doc.basements?.length) ||
      (merging() && (!baseBlueprint || !!mergeError));
    el<HTMLButtonElement>('scene-export').disabled = exportDisabled;
    el<HTMLButtonElement>('scene-package').disabled = exportDisabled;
    el('scene-export-options').hidden = !doc.basements?.length && !baseBlueprint;
    el('scene-base-open').textContent = baseBlueprint ? '更换原整屋' : '载入原整屋';
    el('scene-base-focus').hidden = !baseBlueprint;
    el('scene-base-status').textContent = merging()
      ? baseBlueprint
        ? `原整屋：${baseName} · 已连通 ${connectionCount} 处`
        : '请载入游戏保存的原整屋。原布置只读显示，可添加家具或连通原房间。'
      : '导入将替换整个家园的布置，选择单个分区也不会仅替换该分区。';
    el('scene-original-status').textContent =
      mergeError ||
      (baseBlueprint && merging()
        ? `原布置只读显示，缺少模型时显示位置标记。${attachmentTransfers ? ` ${attachmentTransfers} 处挂件已转挂，位置和朝向保持不变。` : ''}`
        : '');
    el('scene-export').textContent = merging()
      ? '合并导出蓝图'
      : doc.basements?.length
        ? '导出整屋蓝图'
        : '导出蓝图';
    el('scene-count').textContent =
      baseBlueprint && merging()
        ? `新增 ${doc.items.length} 件家具 / ${doc.basements?.length ?? 0} 格 · 原房间 ${basePreview?.rooms.length ?? 0} 格`
        : `${doc.items.length} 件家具${doc.basements?.length ? ` · 地下室 ${doc.basements.length} 格` : ''}`;
    const cells = doc.basements ?? [];
    el('basement-summary').textContent =
      baseBlueprint && merging()
        ? `原有 ${basePreview?.rooms.length ?? 0} 格 · 新增 ${cells.length} 格`
        : cells.length
          ? `${cells.length} 个单元 · 最深 ${Math.max(...cells.map((c) => (c.level + 1) * basementSize(c)))} 米`
          : '尚无地下室单元';
    renderList();
    renderInspector();
    try {
      sessionStorage.setItem(draftKey, new TextDecoder().decode(writeSceneProject(doc)));
      el('scene-draft').textContent = '已暂存';
    } catch {
      el('scene-draft').textContent = '请保存工程';
    }
  }
  function commit(doc: SceneDocument, message?: string) {
    try {
      if (
        baseBlueprint &&
        el<HTMLSelectElement>('scene-export-mode').value === 'merge' &&
        (doc.items.length || doc.basements?.length)
      )
        mergeWholeBlueprintDetailed(baseBlueprint, exportSceneBlueprint(doc, { forMerge: true }));
      history.commit(doc);
      update();
      if (message) say(message);
    } catch (error) {
      update();
      say(error instanceof Error ? error.message : '布置修改失败');
    }
  }
  function changeItem(item: SceneItem) {
    const doc = history.document;
    const i = doc.items.findIndex((x) => x.id === item.id);
    if (i < 0) return;
    doc.items[i] = item;
    commit(doc, '布置已更新');
  }
  function renderList() {
    const list = el('scene-objects');
    list.replaceChildren();
    for (const [i, item] of history.document.items.entries()) {
      const r = editorResourceByKey.get(item.resourceKey)!,
        button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${i + 1}. ${r.name}`;
      button.setAttribute('aria-pressed', String(item.id === selected));
      button.addEventListener('click', () => {
        selected = item.id;
        updateBasementView();
        viewer?.select(selected);
        renderList();
        renderInspector();
      });
      list.append(button);
    }
  }
  function renderInspector(item = getItem()) {
    el('scene-inspector').hidden = !item || basementMode;
    el('scene-selection-empty').hidden = !!item || basementMode;
    for (const id of ['scene-copy', 'scene-delete', 'scene-ground', 'scene-focus'])
      el<HTMLButtonElement>(id).disabled = !item || basementMode;
    if (!item) return;
    const r = editorResourceByKey.get(item.resourceKey)!;
    fillFloorOptions(el<HTMLSelectElement>('scene-support'), item.basementId);
    el('scene-selected-name').textContent = r.name;
    const angles = new Euler().setFromQuaternion(new Quaternion(...item.rotation), 'YXZ');
    for (const [i, axis] of ['x', 'y', 'z'].entries()) {
      el<HTMLInputElement>(`scene-pos-${axis}`).value = item.position[i].toFixed(3);
      const rotation = el<HTMLInputElement>(`scene-rot-${axis}`);
      rotation.value = ((angles[axis as 'x'] * 180) / Math.PI).toFixed(1);
      rotation.disabled = axis !== 'y' && !r.freeRotation;
      const scale = el<HTMLInputElement>(`scene-scale-${axis}`);
      scale.value = item.scale[i].toFixed(3);
      scale.min = String(r.scaleRanges[i][0]);
      scale.max = String(r.scaleRanges[i][1]);
      scale.disabled =
        r.scaleRanges[i][0] === r.scaleRanges[i][1] || (!r.nonUniform && axis !== 'x');
    }
    el('scene-scale-label').textContent = r.nonUniform ? '分轴缩放' : '等比缩放（通过 X 调整）';
    const details = el<HTMLSelectElement>('scene-detail');
    details.replaceChildren();
    for (const v of r.details) {
      const opt = document.createElement('option');
      opt.value = String(v);
      opt.textContent = r.detailNames?.[v] || (v === r.defaultDetail ? '原始样式' : `样式 ${v}`);
      details.append(opt);
    }
    details.value = String(item.detail);
    details.disabled = r.details.length === 1;
    el('scene-resource-note').textContent =
      (!viewer?.hasModel(item.resourceKey) ? '模型未加载，显示尺寸框。' : '') +
      (r.freeRotation ? '可自由旋转。' : '仅支持水平旋转。') +
      (r.scaleRanges.every(([a, b]) => a === b) ? '使用固定比例。' : '');
    for (const field of el('scene-inspector').querySelectorAll<
      HTMLInputElement | HTMLSelectElement
    >('input,select'))
      renderedFields.set(field.id, field.value);
  }
  function readFields(event: Event) {
    const item = getItem();
    if (!item) return;
    const r = editorResourceByKey.get(item.resourceKey)!;
    const target = event.target as HTMLInputElement;
    if (renderedFields.get(target.id) === target.value) return;
    if (target.id === 'scene-support') {
      try {
        changeItem(placeSceneItem(item, history.document, target.value || undefined));
        updateBasementView();
        viewer?.focus(selected);
      } catch (error) {
        say(error instanceof Error ? error.message : '家具放置失败');
        renderInspector();
      }
      return;
    }
    const axis = target.id.slice(-1),
      index = ['x', 'y', 'z'].indexOf(axis);
    if (target.id.startsWith('scene-pos-') && index >= 0)
      item.position[index] = target.valueAsNumber;
    else if (target.id.startsWith('scene-rot-') && index >= 0) {
      const angles = new Euler().setFromQuaternion(new Quaternion(...item.rotation), 'YXZ');
      angles[axis as 'x'] = (target.valueAsNumber * Math.PI) / 180;
      item.rotation = new Quaternion().setFromEuler(angles).toArray() as Quat;
    } else if (target.id.startsWith('scene-scale-') && index >= 0) {
      item.scale[index] = target.valueAsNumber;
      if (!r.nonUniform) item.scale = [item.scale[0], item.scale[0], item.scale[0]];
    } else if (target.id === 'scene-detail') item.detail = Number(target.value);
    else return;
    changeItem(item);
  }
  el('scene-inspector').addEventListener('change', readFields);
  el('scene-inspector').addEventListener('focusout', readFields);
  const saveName = () => {
    const doc = history.document;
    doc.name = el<HTMLInputElement>('scene-name').value;
    commit(doc);
  };
  el('scene-name').addEventListener('change', saveName);
  el('scene-name').addEventListener('blur', saveName);
  for (const mode of ['translate', 'rotate', 'scale'] as const)
    el(`scene-${mode}`).addEventListener('click', () => {
      viewer?.mode(mode);
      for (const other of ['translate', 'rotate', 'scale'])
        el(`scene-${other}`).setAttribute('aria-pressed', String(mode === other));
    });
  el('scene-snap').addEventListener('change', () =>
    viewer?.snap(el<HTMLInputElement>('scene-snap').checked),
  );
  el('scene-focus').addEventListener('click', () => viewer?.focus(selected));
  el('scene-all').addEventListener('click', () => {
    if (!basementMode) {
      selected = undefined;
      viewer?.select(undefined);
      updateBasementView();
      renderInspector();
      renderList();
    }
    viewer?.focus();
  });
  el('scene-top').addEventListener('click', () => viewer?.focus(undefined, true));
  el('scene-expand').addEventListener('click', () => {
    const on = el('furniture-dialog').classList.toggle('focus-mode');
    el('scene-expand').textContent = on ? '收起工作区' : '放大工作区';
    el('scene-expand').setAttribute('aria-pressed', String(on));
  });
  const groundPanel = installLandPanel((key) => {
    const doc = history.document;
    if (key) doc.landKey = key;
    else delete doc.landKey;
    try {
      validateScene(doc);
    } catch (error) {
      return error instanceof Error ? error.message : '当前布置无法放入此地块';
    }
    commit(doc, key ? '地块范围已设置，家具位置保持不变。' : '已取消地块范围');
    if (key) viewer?.focusPlot();
    else viewer?.focus();
  });
  el('scene-land-open').addEventListener('click', () => groundPanel.open(history.document.landKey));
  el('scene-land-view').addEventListener('click', () => viewer?.focusPlot());
  function basementSelection() {
    return {
      size: Number(el<HTMLSelectElement>('basement-size').value),
      level: Number(el<HTMLSelectElement>('basement-level').value),
      action: basementAction,
    };
  }
  function updateBasementView() {
    prepareMergeView();
    const t = basementSelection();
    const cells = history.document.basements ?? [],
      owner = cells.find((c) => c.id === getItem()?.basementId);
    const cut = el<HTMLInputElement>('basement-slice').checked
      ? basementMode
        ? -t.level * t.size
        : owner
          ? -owner.level * basementSize(owner)
          : undefined
      : undefined;
    viewer?.setBasements(
      displayedCells,
      cut,
      displayedMasks,
      readonlyRooms,
      !basementMode && owner ? basementSize(owner) : t.size,
    );
    viewer?.setReferenceObjects(referenceObjects);
    viewer?.setBasementTool(basementMode ? t : undefined);
  }
  function configureBasement() {
    const size = Number(el<HTMLSelectElement>('basement-size').value),
      material = el<HTMLSelectElement>('basement-material'),
      level = el<HTMLSelectElement>('basement-level');
    const name = material.selectedOptions[0]?.textContent,
      previousLevel = Number(level.value) || 0;
    material.replaceChildren();
    for (const r of basementResources.filter((r) => r.size === size)) {
      const o = new Option(r.name, String(r.brushId));
      material.add(o);
      if (r.name === name) material.value = String(r.brushId);
    }
    level.replaceChildren();
    for (let i = 0; i < BASEMENT_LIMITS.bottomM / size; i++)
      level.add(new Option(`第 ${i + 1} 层 · ${i * size}～${(i + 1) * size} 米深`, String(i)));
    level.value = String(Math.min(previousLevel, level.options.length - 1));
    for (const id of ['basement-x', 'basement-z']) el<HTMLInputElement>(id).step = String(size);
    updateBasementView();
  }
  function applyBasement(x: number, z: number, cellId?: string) {
    if (!basementMode) return;
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      say('请输入有效坐标');
      return;
    }
    const doc = history.document,
      t = basementSelection();
    try {
      const previous = doc.basements ?? [];
      if (basementAction === 'place') {
        const target = previous.find((c) =>
          cellId
            ? c.id === cellId
            : c.x === x && c.z === z && c.level === t.level && basementSize(c) === t.size,
        );
        if (!target || !basementFloor(target, previous))
          throw new Error('该格没有可放置的地板，请选择地下室底层');
        placement = target.id;
        updatePlacements();
        const item = getItem();
        if (item) {
          changeItem(placeSceneItem(item, doc, target.id));
          setBasementMode(false);
          viewer?.focus(selected);
        } else say('已选择地下室地板，接下来从家具库添加家具。');
        return;
      }
      const next = editBasement(
        previous,
        {
          id: crypto.randomUUID(),
          brushId: Number(el<HTMLSelectElement>('basement-material').value),
          x,
          z,
          level: t.level,
        },
        basementAction,
        doc.landKey,
        !!baseBlueprint && merging(),
      );
      doc.basements = next;
      if (baseBlueprint && merging()) doc.basementMergeOnly = true;
      commit(
        doc,
        basementAction === 'dig'
          ? '地下室已更新，同规格相邻单元自动连通。'
          : '地下室已回填，可撤销。',
      );
    } catch (error) {
      say(error instanceof Error ? error.message : '地下室操作失败');
    }
  }
  function setBasementMode(on: boolean) {
    basementMode = on;
    el('basement-tools').hidden = !on;
    el('scene-basement').setAttribute('aria-pressed', String(on));
    updateBasementView();
    renderInspector();
    if (on)
      say(
        baseBlueprint
          ? '选择工作层，点击绿色可扩建格；连通结果和原家具会同步预览。'
          : '地下室挖掘：选择规格与工作层，再点击画布。拖动画布可调整视角。',
      );
  }
  el('scene-basement').addEventListener('click', () => setBasementMode(!basementMode));
  el('basement-close').addEventListener('click', () => setBasementMode(false));
  el('basement-size').addEventListener('change', configureBasement);
  for (const id of ['basement-level', 'basement-slice'])
    el(id).addEventListener('change', updateBasementView);
  for (const action of ['dig', 'fill', 'place'] as const)
    el(`basement-${action}`).addEventListener('click', () => {
      basementAction = action;
      for (const a of ['dig', 'fill', 'place'])
        el(`basement-${a}`).setAttribute('aria-pressed', String(a === action));
      el('basement-hint').textContent =
        action === 'dig'
          ? '点击格点挖掘。下层必须与地表洞口或已有通道连通。'
          : action === 'fill'
            ? '点击已有单元回填；先处理依赖此洞口的下层单元。'
            : '点击地板可迁移选中家具；未选中家具时，设置新家具位置。';
      updateBasementView();
    });
  el('basement-apply').addEventListener('click', () => {
    const size = basementSelection().size,
      x = el<HTMLInputElement>('basement-x').valueAsNumber / size,
      z = el<HTMLInputElement>('basement-z').valueAsNumber / size;
    const phase = basementGridPhase(displayedCells, size);
    if (!Number.isInteger(x - phase[0]) || !Number.isInteger(z - phase[1])) {
      say(
        `中心坐标需与当前 ${size} 米网格对齐（X 基点 ${phase[0] * size} 米，Z 基点 ${phase[1] * size} 米）`,
      );
      return;
    }
    applyBasement(x, z);
  });
  el('basement-focus').addEventListener('click', () => viewer?.focusBasements());
  function fillFloorOptions(select: HTMLSelectElement, value?: string) {
    const cells = history.document.basements ?? [],
      masks = basementMasks(cells);
    select.replaceChildren(new Option('地面', ''));
    for (const [i, c] of cells.entries()) {
      const f = basementFloor(c, cells, masks);
      if (!f) continue;
      const r = basementResources.find((r) => r.brushId === c.brushId)!;
      select.add(
        new Option(`地下 ${Math.round(-f.position[1])} 米 · ${r.name}${r.size}米 #${i + 1}`, c.id),
      );
    }
    select.value = value ?? '';
  }
  function updatePlacements() {
    const cells = history.document.basements ?? [];
    if (placement && !cells.some((c) => c.id === placement && basementFloor(c, cells)))
      placement = undefined;
    fillFloorOptions(el<HTMLSelectElement>('scene-placement'), placement);
  }
  el('scene-placement').addEventListener('change', () => {
    placement = el<HTMLSelectElement>('scene-placement').value || undefined;
    say(placement ? '新家具将自动放置在所选地下室地板。' : '新家具将放置在地面。');
  });
  function modelNote() {
    const ids = [...new Set(displayedCells.map((c) => c.brushId))],
      ready = ids.filter((id) => viewer?.hasBasementModel(id)).length;
    el('basement-model-note').textContent =
      ids.length === 0
        ? '添加单元后按需加载模型与贴图。'
        : ready === ids.length
          ? '模型与贴图已加载。'
          : basementLoads.size
            ? '正在加载地下室模型与贴图…'
            : '部分模型未加载，显示结构占位。请打开对应的地下室 GLB 文件。';
  }
  async function loadBasementModels() {
    if (!viewer) return;
    const renderer = viewer,
      ids = [...new Set(displayedCells.map((c) => c.brushId))];
    if (!modelLibraryURL('basement/manifest.json', document.baseURI)) {
      modelNote();
      return;
    }
    for (const id of ids) {
      if (renderer.hasBasementModel(id) || basementLoads.has(id) || basementFailures.has(id))
        continue;
      basementLoads.add(id);
      modelNote();
      try {
        const resource = basementModelResources.find((r) => r.brushId === id)!;
        const res = await fetch(
          modelLibraryURL(`basement/${resource.file}`, document.baseURI, resource.modelSha256)!,
          {
            signal: AbortSignal.timeout(60000),
          },
        );
        if (!res.ok || Number(res.headers.get('content-length')) > 50 * 1024 * 1024)
          throw new Error('地下室模型读取失败');
        const bytes = await res.arrayBuffer();
        await renderer.registerBasementModel(bytes);
      } catch {
        basementFailures.add(id);
      } finally {
        basementLoads.delete(id);
        modelNote();
      }
    }
    modelNote();
  }
  const basementFiles = el<HTMLInputElement>('basement-model-files');
  el('basement-model-open').addEventListener('click', () => basementFiles.click());
  basementFiles.addEventListener('change', async () => {
    const files = [...(basementFiles.files ?? [])];
    basementFiles.value = '';
    if (files.length > 6) {
      say('一次最多选择六个地下室 GLB 模型包。');
      return;
    }
    for (const file of files) {
      try {
        if (file.size > 50 * 1024 * 1024)
          throw new Error('模型文件超过 50 MiB，请选择较小的 GLB 文件。');
        await (await ensure()).registerBasementModel(await file.arrayBuffer());
      } catch (error) {
        say(error instanceof Error ? error.message : '地下室模型载入失败');
      }
    }
    modelNote();
  });
  configureBasement();
  el('scene-undo').addEventListener('click', () => {
    history.undo();
    if (!getItem()) selected = undefined;
    update();
    say('已撤销');
  });
  el('scene-redo').addEventListener('click', () => {
    history.redo();
    if (!getItem()) selected = undefined;
    update();
    say('已重做');
  });
  el('scene-delete').addEventListener('click', () => {
    if (!selected) return;
    const doc = history.document;
    doc.items = doc.items.filter((i) => i.id !== selected);
    selected = undefined;
    commit(doc, '家具已删除，可撤销');
  });
  el('scene-copy').addEventListener('click', () => {
    let item = getItem();
    if (!item) return;
    item.id = crypto.randomUUID();
    item.position[0] += 0.5;
    item.position[2] += 0.5;
    if (history.document.landKey) {
      try {
        item = constrainSceneItem(item, history.document.landKey!);
      } catch (error) {
        say(error instanceof Error ? error.message : '地块内无法放下此家具');
        return;
      }
    }
    selected = item.id;
    const doc = history.document;
    doc.items.push(item);
    commit(doc, '已复制家具');
  });
  el('scene-ground').addEventListener('click', () => {
    const item = getItem();
    if (!item || !viewer) return;
    item.position[1] = viewer.grounded(item);
    changeItem(item);
  });
  el('scene-clear').addEventListener('click', () => {
    epoch++;
    selected = undefined;
    commit(
      {
        ...emptyScene(),
        ...(history.document.landKey ? { landKey: history.document.landKey } : {}),
      },
      '已清空布置，可撤销',
    );
  });
  el('scene-save').addEventListener('click', () =>
    download(writeSceneProject(history.document), `${stem()}.homeland.json`, 'application/json'),
  );
  el('scene-export').addEventListener('click', () => {
    try {
      const addition = exportSceneBlueprint(history.document, { forMerge: merging() });
      if (merging() && !baseBlueprint) throw new Error('请先选择要保留的整屋蓝图');
      download(
        merging() ? mergeWholeBlueprint(baseBlueprint!, addition) : addition,
        `${stem()}${merging() ? '-合并' : ''}.blueprintx`,
      );
      say(
        merging()
          ? '合并蓝图已导出。原有布置保留，请使用整屋入口导入。'
          : history.document.basements?.length
            ? '整屋蓝图已导出。请先保存原有布置，再从整屋蓝图入口导入核对。'
            : '局部蓝图已导出。请从游戏的局部组件入口导入，确认后保存。',
      );
    } catch (e) {
      say(e instanceof Error ? e.message : '蓝图导出失败');
    }
  });
  el('scene-package').addEventListener('click', () => {
    try {
      if (merging() && !baseBlueprint) throw new Error('请先选择要保留的整屋蓝图');
      download(
        scenePackage(history.document, merging() ? baseBlueprint : undefined),
        `${stem()}-完整包.zip`,
        'application/zip',
      );
      say(
        merging()
          ? '完整包包含合并蓝图、原始整屋、新增工程、清单和使用说明。'
          : '完整包包含蓝图、工程、家具清单和使用说明。',
      );
    } catch (e) {
      say(e instanceof Error ? e.message : '完整包导出失败');
    }
  });
  el('scene-export-mode').addEventListener('change', update);
  el('scene-base-focus').addEventListener('click', () => {
    const first = basePreview?.rooms[0],
      resource = basementResources.find((r) => r.brushId === first?.brushId);
    if (resource) {
      el<HTMLSelectElement>('basement-size').value = String(resource.size);
      configureBasement();
      el<HTMLSelectElement>('basement-material').value = String(resource.brushId);
    }
    basementAction = 'dig';
    for (const action of ['dig', 'fill', 'place'])
      el(`basement-${action}`).setAttribute('aria-pressed', String(action === 'dig'));
    el('basement-hint').textContent =
      '绿色格可与原房间连通。选择工作层后点击格子，原家具的位置保持不变。';
    el('furniture-dialog').classList.add('focus-mode');
    el('scene-expand').textContent = '收起工作区';
    el('scene-expand').setAttribute('aria-pressed', 'true');
    setBasementMode(true);
    requestAnimationFrame(() => viewer?.focusBasements());
  });
  const baseFile = el<HTMLInputElement>('scene-base-file');
  el('scene-base-open').addEventListener('click', () => baseFile.click());
  baseFile.addEventListener('change', async () => {
    const file = baseFile.files?.[0];
    baseFile.value = '';
    if (!file) return;
    const request = ++baseEpoch;
    baseBlueprint = undefined;
    basePreview = undefined;
    baseName = '';
    update();
    try {
      if (file.size > 32_000_000) throw new Error('整屋蓝图超过 32 MB');
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (request !== baseEpoch) return;
      const info = inspectWholeBlueprint(bytes);
      baseBlueprint = bytes;
      basePreview = readWholeBlueprintPreview(bytes);
      baseName = file.name;
      if (!history.document.landKey) {
        const doc = history.document;
        doc.landKey = `blueprint:${info.widthM}:${info.depthM}`;
        history.commit(doc);
      }
      const renderer = await ensure();
      if (request !== baseEpoch) return;
      update();
      renderer.focusBasements();
      void loadMissingModels(renderer);
      say(
        mergeError ||
          `已载入 ${info.basementCount} 格原地下室。相邻同规格单元可直接连通，原家具保持位置。`,
      );
    } catch (error) {
      say(error instanceof Error ? error.message : '整屋蓝图读取失败');
    }
  });
  const file = el<HTMLInputElement>('scene-file');
  el('scene-open').addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const input = file.files?.[0];
    file.value = '';
    if (!input) return;
    if (input.size > 32_000_000) {
      say('布置文件超过 32 MB，请选择较小的工程或蓝图。');
      return;
    }
    const current = ++epoch;
    try {
      const bytes = new Uint8Array(await input.arrayBuffer());
      if (current !== epoch) return;
      const doc = input.name.toLowerCase().endsWith('.blueprintx')
        ? importSceneBlueprint(
            bytes,
            input.name.replace(/\.blueprintx$/i, ''),
            history.document.landKey,
          )
        : readSceneProject(bytes);
      validateScene(doc);
      const renderer = await ensure();
      if (current !== epoch) return;
      selected = undefined;
      commit(doc, '布置已读取，正在准备模型…');
      renderer.focus();
      for (const key of new Set(doc.items.map((i) => i.resourceKey))) {
        if (current !== epoch) return;
        if (renderer.hasModel(key)) continue;
        const bytes = await resolveModel(editorResourceByKey.get(key)!);
        if (current !== epoch) return;
        if (bytes) await renderer.registerModel(bytes);
      }
      update();
      const missing = history.document.items.filter(
        (i) => !renderer.hasModel(i.resourceKey),
      ).length;
      say(
        missing
          ? `布置已恢复，${missing} 件家具暂以尺寸框显示，可打开对应模型文件补齐预览。`
          : `已恢复 ${history.document.items.length} 件家具${history.document.basements?.length ? `、${history.document.basements.length} 个地下室单元` : ''}，可继续编辑或导出。`,
      );
    } catch (error) {
      say(error instanceof Error ? error.message : '布置读取失败');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (
      !active ||
      document.querySelector('dialog[open]') ||
      (e.target instanceof HTMLElement && e.target.closest('input,textarea,select'))
    )
      return;
    if (e.key === 'Escape' && el('furniture-dialog').classList.contains('focus-mode')) {
      e.preventDefault();
      el<HTMLButtonElement>('scene-expand').click();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      el<HTMLButtonElement>(e.shiftKey ? 'scene-redo' : 'scene-undo').click();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      el<HTMLButtonElement>('scene-redo').click();
    } else if (e.key === 'Delete') {
      e.preventDefault();
      el<HTMLButtonElement>('scene-delete').click();
    }
  });
  window.addEventListener('pagehide', () => {
    epoch++;
    viewer?.dispose();
    urls.forEach(URL.revokeObjectURL);
  });
  update();
  return {
    async show(value: boolean) {
      active = value;
      if (!value) {
        viewer?.setActive(false);
        return;
      }
      try {
        const renderer = await ensure();
        renderer.setActive(active);
        if (!active) return;
        update();
        await loadMissingModels(renderer);
      } catch {
        say('当前设备无法打开3D编辑，已有工程仍可保存和导出');
      }
    },
    async libraryReady() {
      if (viewer && active) await loadMissingModels(viewer);
    },
    async add(read: () => Promise<ArrayBuffer>) {
      const current = epoch;
      say('正在加载家具…');
      try {
        const bytes = await read(),
          renderer = await ensure();
        if (current !== epoch) return;
        const key = await renderer.registerModel(bytes);
        if (current !== epoch) return;
        const r = editorResourceByKey.get(key)!,
          doc = history.document;
        const item: SceneItem = {
          id: crypto.randomUUID(),
          resourceKey: key,
          detail: r.defaultDetail,
          position: suggestScenePosition(key, doc, placement),
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
          ...(placement ? { basementId: placement } : {}),
        };
        doc.items.push(item);
        selected = item.id;
        commit(doc, `已添加 ${r.name}`);
        if (placement) {
          setBasementMode(false);
          renderer.focusBasements();
        } else renderer.focus();
      } catch (error) {
        say(error instanceof Error ? error.message : '家具添加失败');
      }
    },
    pause() {
      active = false;
      viewer?.setActive(false);
    },
  };
}
