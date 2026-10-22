"""从家具资源索引和已验证GLB清单生成编辑器资源绑定。"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import struct


def pair(raw):
    values = [float(v) for v in raw.split(';') if v.strip()]
    if len(values) != 2 or not all(math.isfinite(v) for v in values) or values[0] > values[1]:
        raise ValueError('范围字段无效：'+raw)
    return values


def build(index_file, manifest_file, previous_file=None):
    index_path, manifest_path = Path(index_file), Path(manifest_file)
    index = json.loads(index_path.read_text(encoding='utf-8-sig'))
    manifest = json.loads(manifest_path.read_text(encoding='utf-8-sig'))
    resources = {r['id']: r for r in index['resources']}
    result = []
    previous={r['representId']:r for r in json.loads(Path(previous_file).read_text(encoding='utf-8-sig'))['resources']} if previous_file else {}
    for sample in manifest:
        resource_id = sample.get('resourceId')
        if resource_id is None:
            continue  # 未完成装配的Prefab等样本仅用于预览。
        resource = resources[resource_id]
        matches = [f for f in index['furniture'] if f['representId'] == resource_id
                   and f['type'] == int(resource['furnitureTypeRaw'])
                   and f['furnitureId'] == int(resource['furnitureIdRaw'])]
        if len(matches) != 1 or not resource['modelPath'].lower().endswith('.mesh'):
            raise ValueError('编辑资源必须唯一关联到普通Mesh家具')
        furniture = matches[0]
        file = (manifest_path.parent/sample['file']).resolve()
        if not file.is_relative_to(manifest_path.parent.resolve()):
            raise ValueError('模型文件越界')
        raw = file.read_bytes()
        if raw[:4] != b'glTF' or struct.unpack_from('<I',raw,8)[0] != len(raw):
            raise ValueError('GLB无效')
        document = json.loads(raw[20:20+struct.unpack_from('<I',raw,12)[0]])
        if document['extras'].get('unitsPerMeterApplied') != 100:
            raise ValueError('编辑器资源要求明确的米制换算')
        accessor = document['accessors'][0]
        nonuniform = resource['nonUniformScalingRaw'] == '1'
        if nonuniform:
            ranges = [pair(value) for value in furniture['axisScaleRaw'].split('|')]
            if len(ranges) != 3: raise ValueError('非等比范围不完整')
        else:
            one = pair(furniture['scaleRangeRaw']) if furniture['scaleRangeRaw'] else [1,1]
            ranges = [one,one,one]
        default = int(resource['defaultDetailRaw'] or 0)
        details = [int(v) for v in resource['detailsRaw'].split(';') if v] or [default]
        if default not in details or any(not 0 <= v <= 255 for v in details):
            raise ValueError('资源样式编号无效')
        aliases=[];old=previous.get(resource_id)
        sha=hashlib.sha256(raw).hexdigest()
        if old and old['sourceMeshSha256']==document['extras']['sourceSha256']:
            aliases=sorted(set([old['modelSha256']]+old.get('modelSha256Aliases',[]))-{sha})
        variants=document.get('extensions',{}).get('KHR_materials_variants',{}).get('variants',[])
        triangles=sum(document['accessors'][p['indices']]['count']//3 for mesh in document['meshes'] for p in mesh['primitives'])
        result.append({
            'key': f'model-{resource_id}', 'name': furniture['name'], 'category': sample['category'],
            'representId': resource_id, 'furnitureType': furniture['type'], 'furnitureId': furniture['furnitureId'],
            'defaultDetail': default, 'details': details, 'nonUniform': nonuniform,
            'scaleRanges': ranges, 'freeRotation': furniture['freeRotationRaw']=='1',
            'heightRangeM': [v/100 for v in pair(furniture['heightLimitRaw'])] if furniture['heightLimitRaw'] else None,
            'modelSha256': sha, 'modelSha256Aliases':aliases, 'sourceMeshSha256': document['extras']['sourceSha256'],
            'detailNames':[v.get('name',f'样式 {i}') for i,v in enumerate(variants)],
            'boundsMin': accessor['min'], 'boundsMax': accessor['max'],
            'triangles': triangles,
            'resourcePath': resource['modelPath'],
        })
    return {'schemaVersion':1,'unitsPerMeter':100,'sourceIndexSha256':hashlib.sha256(index_path.read_bytes()).hexdigest(),
            'scope':'普通Mesh家具的局部布置。空缩放范围按游戏操作层禁用缩放；不推定任意旋转。Prefab、笔刷和不明资源不进入此编辑目录。',
            'resources':result}


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--index',required=True);parser.add_argument('--manifest',required=True);parser.add_argument('--output',required=True)
    parser.add_argument('--previous')
    args=parser.parse_args();data=build(args.index,args.manifest,args.previous)
    Path(args.output).write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    print(f'可编辑家具资源：{len(data["resources"])}')
