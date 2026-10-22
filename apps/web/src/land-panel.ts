import {
  groundBounds,
  landCatalog,
  landPlan,
  type LandPlot,
} from '../../../packages/core/src/land.js';

export function installLandPanel(apply: (key?: string) => string | undefined) {
  const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const dialog = get<HTMLDialogElement>('land-dialog'),
    location = get<HTMLSelectElement>('land-location');
  const ns = 'http://www.w3.org/2000/svg';
  let selected: string | undefined;
  const group = (label: string, rows: { key: string; name: string }[]) => {
    const node = document.createElement('optgroup');
    node.label = label;
    for (const row of rows) node.append(new Option(row.name, row.key));
    location.append(node);
  };
  group(
    '通用户型',
    landCatalog.presets.map((p) => ({
      key: p.key,
      name: `${p.name} · ${p.lengthM} × ${p.widthM} 米`,
    })),
  );
  group(
    '私宅全布局',
    landCatalog.maps.filter((m) => m.kind === 'private'),
  );
  group(
    '社区总览',
    landCatalog.maps.filter((m) => m.kind === 'community'),
  );
  function render() {
    get('land-error').textContent = '';
    const preset = landCatalog.presets.find((p) => p.key === location.value),
      map = landCatalog.maps.find((m) => m.key === location.value);
    const plots: LandPlot[] = preset ? [preset] : (map?.plots ?? []);
    const svg = get('land-map'),
      list = get('land-plots');
    svg.replaceChildren();
    list.replaceChildren();
    const allPoints = plots.flatMap((p) => p.points);
    if (!allPoints.length) return;
    const bounds = groundBounds(allPoints),
      w = bounds.max[0] - bounds.min[0],
      h = bounds.max[1] - bounds.min[1],
      pad = Math.max(w, h) * 0.04;
    svg.setAttribute(
      'viewBox',
      `${bounds.min[0] - pad} ${bounds.min[1] - pad} ${w + 2 * pad} ${h + 2 * pad}`,
    );
    svg.setAttribute('aria-label', `${preset?.name ?? map?.name}地块平面布局`);
    get('land-caption').textContent = preset
      ? `${preset.lengthM} × ${preset.widthM} 米${preset.privateOnly ? ' · 私宅设计预设' : ''}`
      : map?.kind === 'private'
        ? `完整私宅 ${map.whole!.areaM2.toLocaleString('zh-CN')} 平 · ${plots.length} 个分区`
        : `${map?.name} · ${plots.length} 处地块`;
    const pick = (key: string) => {
      selected = key;
      render();
    };
    const button = (plot: LandPlot, label = plot.name) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `${label} · ${plot.areaM2.toLocaleString('zh-CN')} 平`;
      b.setAttribute('aria-pressed', String(selected === plot.key));
      b.addEventListener('click', () => pick(plot.key));
      list.append(b);
    };
    if (map?.whole) button(map.whole, '整个私宅');
    for (const [i, plot] of plots.entries()) {
      const node = document.createElementNS(ns, 'g'),
        poly = document.createElementNS(ns, 'polygon');
      node.setAttribute('role', 'button');
      node.setAttribute('tabindex', '0');
      node.setAttribute('aria-label', `${plot.name}，${plot.areaM2} 平`);
      node.setAttribute('aria-pressed', String(selected === plot.key));
      node.classList.add('land-shape');
      node.style.setProperty('--land-index', String(i % 7));
      poly.setAttribute('points', plot.points.map((p) => `${p[0]},${p[1]}`).join(' '));
      poly.setAttribute('vector-effect', 'non-scaling-stroke');
      const center = plot.points.reduce(
        (a, p) => [a[0] + p[0] / plot.points.length, a[1] + p[1] / plot.points.length],
        [0, 0],
      );
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', String(center[0]));
      label.setAttribute('y', String(center[1]));
      label.setAttribute('font-size', String(Math.max(w, h) / 32));
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('dominant-baseline', 'central');
      label.textContent = preset
        ? preset.name
        : map?.kind === 'private'
          ? `${plot.index}区`
          : `${plot.index}`;
      node.append(poly, label);
      node.addEventListener('click', () => pick(plot.key));
      node.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          pick(plot.key);
        }
      });
      svg.append(node);
      button(plot, preset ? `${preset.lengthM} × ${preset.widthM} 米` : plot.name);
    }
    const current = selected ? landPlan(selected) : undefined;
    get<HTMLButtonElement>('land-apply').disabled = !current;
    get('land-selected').textContent = current
      ? `${current.name} · ${current.areaM2.toLocaleString('zh-CN')} 平`
      : '点击图中的地块编号，或从列表选择。';
    if (current) {
      const edges = [
        Math.hypot(
          current.points[1][0] - current.points[0][0],
          current.points[1][1] - current.points[0][1],
        ),
        Math.hypot(
          current.points[2][0] - current.points[1][0],
          current.points[2][1] - current.points[1][1],
        ),
      ].sort((a, b) => a - b);
      get('land-size').textContent = `边长约 ${edges.map((n) => Math.round(n)).join(' × ')} 米`;
    } else get('land-size').textContent = '';
  }
  location.addEventListener('change', () => {
    selected =
      landCatalog.presets.find((p) => p.key === location.value)?.key ??
      landCatalog.maps.find((m) => m.key === location.value)?.whole?.key;
    render();
  });
  get('land-close').addEventListener('click', () => dialog.close());
  get('land-apply').addEventListener('click', () => {
    if (selected) {
      const error = apply(selected);
      if (error) get('land-error').textContent = error;
      else dialog.close();
    }
  });
  get('land-none').addEventListener('click', () => {
    apply(undefined);
    dialog.close();
  });
  return {
    open(current?: string) {
      selected = current;
      location.value =
        landCatalog.presets.find((p) => p.key === current)?.key ??
        landCatalog.maps.find(
          (m) => !!current && (m.whole?.key === current || m.plots.some((p) => p.key === current)),
        )?.key ??
        landCatalog.maps.find((m) => m.kind === 'private')!.key;
      if (!current) selected = landCatalog.maps.find((m) => m.key === location.value)?.whole?.key;
      render();
      dialog.showModal();
    },
  };
}
