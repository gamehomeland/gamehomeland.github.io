"""按明确清单转换已支持的家具Mesh，保留失败原因；不扫描或修改游戏包。"""
import argparse
import hashlib
import json
from pathlib import Path
from inspect_mesh import inspect_mesh, geometry_glb


def convert(selection, assets, output):
    assets, output = Path(assets).resolve(), Path(output).resolve()
    rows = json.loads(Path(selection).read_text(encoding='utf-8-sig'))
    if not isinstance(rows, list) or not 1 <= len(rows) <= 100:
        raise ValueError('清单须包含1～100个指定模型')
    output.mkdir(parents=True, exist_ok=True)
    manifest, report, used = [], [], set()
    for row in rows:
        path = (assets / row['path'].replace('\\', '/')).resolve()
        resource = row['resource']
        if not path.is_relative_to(assets) or path.suffix.lower() != '.mesh' or not isinstance(resource, int) or resource <= 0 or resource in used:
            raise ValueError('模型路径、资源编号或重复项无效')
        used.add(resource)
        entry = {key: row[key] for key in ['name', 'resource', 'category', 'path']}
        try:
            raw = path.read_bytes()
            entry['meshSha256'] = hashlib.sha256(raw).hexdigest()
            metadata, _ = inspect_mesh(raw)
            data = geometry_glb(raw)
            file = f'furniture-{resource}.glb'
            (output/file).write_bytes(data)
            entry.update(supported=True, vertexCount=metadata['vertexCount'],
                         triangleCount=metadata['triangleCount'], glbFile=file,
                         glbSha256=hashlib.sha256(data).hexdigest())
            manifest.append({'file': file, 'name': row['name'], 'category': row['category'],
                             'note': '真实网格几何；未含原贴图、动画和游戏特效。'})
        except (ValueError, OSError) as error:
            entry.update(supported=False, reason=str(error))
        report.append(entry)
    for name, data in [('preview-manifest.json', manifest), ('conversion-report.json', report)]:
        (output/name).write_text(json.dumps(data, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    return {'selected': len(rows), 'converted': len(manifest), 'unsupported': len(rows)-len(manifest)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--selection', required=True)
    parser.add_argument('--assets', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    print(json.dumps(convert(args.selection, args.assets, args.output), ensure_ascii=False))
