"""批量生成网页模型候选及对应哈希目录，不覆盖输入资源。"""
import argparse
import hashlib
import json
from pathlib import Path
from optimize_glb import optimize


def run(models, editor_file, basement_file, output, max_texture=512, quality=90):
    models, output = Path(models).resolve(), Path(output).resolve()
    if output == models or output.is_relative_to(models):
        raise ValueError('输出目录必须与源模型目录分开')
    if (output/'editor_catalog.json').resolve() == Path(editor_file).resolve() or (output/'basement_models.json').resolve() == Path(basement_file).resolve():
        raise ValueError('输出目录不能覆盖输入绑定目录')
    editor = json.loads(Path(editor_file).read_text(encoding='utf-8'))
    basement = json.loads(Path(basement_file).read_text(encoding='utf-8'))
    manifest = json.loads((models/'furniture/manifest.json').read_text(encoding='utf-8'))
    bindings = {r['representId']: r for r in editor['resources']}
    reports = []
    for folder, rows in [('furniture', manifest), ('basement', basement['resources'])]:
        (output/'models'/folder).mkdir(parents=True, exist_ok=True)
        for row in rows:
            file = row['file']
            source = (models/folder/file).resolve()
            if source.parent != models/folder: raise ValueError('模型路径越界')
            raw = source.read_bytes()
            optimized, report = optimize(raw, max_texture, quality)
            (output/'models'/folder/file).write_bytes(optimized)
            report['file'] = folder+'/'+file
            reports.append(report)
            target = bindings.get(row.get('resourceId')) if folder == 'furniture' else row
            sha = hashlib.sha256(optimized).hexdigest()
            if target is not None:
                aliases = set(target.get('modelSha256Aliases', [])) | {target['modelSha256']}
                target['modelSha256Aliases'] = sorted(aliases - {sha})
                target['modelSha256'] = sha
                if 'modelBytes' in target: target['modelBytes'] = len(optimized)
                if 'bytes' in target: target['bytes'] = len(optimized)
            if folder == 'furniture': row['sha256'] = sha
            print(f'{file}: {len(raw)} -> {len(optimized)} bytes', flush=True)
    summary = {'inputBytes': sum(r['inputBytes'] for r in reports),
               'outputBytes': sum(r['outputBytes'] for r in reports),
               'geometryUnchanged': all(r['geometryUnchanged'] for r in reports),
               'files': reports}
    for path, data in [('models/furniture/manifest.json', manifest), ('editor_catalog.json', editor),
                       ('basement_models.json', basement), ('compression-report.json', summary)]:
        (output/path).write_text(json.dumps(data, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    return summary


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', required=True); parser.add_argument('--editor', required=True)
    parser.add_argument('--basement', required=True); parser.add_argument('--output', required=True)
    parser.add_argument('--max-texture', type=int, default=512); parser.add_argument('--quality', type=int, default=90)
    args = parser.parse_args()
    result = run(args.models, args.editor, args.basement, args.output, args.max_texture, args.quality)
    print(json.dumps({k: v for k, v in result.items() if k != 'files'}))
