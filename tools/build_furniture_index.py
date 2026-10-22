"""只读家具表和表现资源表，保留空值、重复编号及测试标记，不提取模型。"""
import argparse
import csv
import hashlib
import io
import json
from collections import Counter
from pathlib import Path

TABLES = {
    'furniture': 'UI/Scheme/Case/Homeland/Homeland_FurnitureInfo.tab',
    'categories': 'UI/Scheme/Case/Homeland/Homeland_FurnitureCatg.tab',
    'resources': 'Represent/homeland/ID_Model.txt',
    'brushes': 'Represent/homeland/ID_Brush.txt',
    'customBrushes': 'Represent/homeland/ID_CustomBrush.txt',
}


def build(assets):
    assets = Path(assets).resolve()
    tables, sources = {}, {}
    for kind, name in TABLES.items():
        file = (assets/name).resolve()
        if not file.is_relative_to(assets):
            raise ValueError('资料路径越界')
        raw = file.read_bytes()
        tables[kind] = list(csv.DictReader(io.StringIO(raw.decode('gb18030')), delimiter='\t'))
        sources[kind] = {'path': name, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}

    def integer(value):
        return int(value) if value and value.lstrip('-').isdigit() else None

    furniture = []
    for row in tables['furniture']:
        furniture.append({
            'tableId': integer(row['dwTableID']), 'type': integer(row['nFurnitureType']),
            'furnitureId': integer(row['dwFurnitureID']), 'representId': integer(row['nRepresentID']),
            'name': row['szName'], 'category': [integer(row[f'nCatag{i}Index']) for i in (1, 2, 3)],
            'scaleRangeRaw': row['szScaleRange'], 'axisScaleRaw': row['szXYZScale'],
            'heightLimitRaw': row['szHeightLimit'], 'freeRotationRaw': row['bFreelyRotate'],
            'interactionRaw': row['bInteract'], 'testFlagRaw': row['bForTest'],
            'brushModeCountRaw': row['nBrushModeCnt'],
        })
    resources = []
    for row in tables['resources']:
        resources.append({
            'id': integer(row['id']), 'modelPath': row['model'].replace('\\', '/'),
            'defaultDetailRaw': row['defualtDetail'], 'detailsRaw': row['details'],
            'animationRaw': row['animation'], 'attachmentTagsRaw': row['szTag'],
            'representTagsRaw': row['RepresentTags'], 'nonUniformScalingRaw': row['bCanNonUniformScaling'],
            'checkScaleRaw': row['bCheckScale'], 'minLocalYRaw': row['MinLocalPosY'],
            'maxLocalYRaw': row['MaxLocalPosY'], 'furnitureTypeRaw': row['FurnitureType'],
            'furnitureIdRaw': row['FurnitureID'],
        })
    categories = [{
        'tableId': integer(r['dwTableID']), 'indices': [integer(r[f'nCatag{i}Index']) for i in (1, 2, 3)],
        'name': r['szName'],
    } for r in tables['categories']]
    # 每张资源表自成编号空间，保留来源表、反向家具身份和未解释原值。
    special = {}
    for kind in ['brushes', 'customBrushes']:
        special[kind] = [{
            'id': integer(r['id']), 'path': r['path'].replace('\\', '/'),
            'furnitureTypeRaw': r['FurnitureType'], 'furnitureIdRaw': r['FurnitureID'],
            'raw': dict(r),
        } for r in tables[kind]]
    catalogs = {'resources': resources, **special}
    lookup = {kind: {} for kind in catalogs}
    for kind, rows in catalogs.items():
        for row in rows:
            lookup[kind].setdefault(row['id'], []).append(row)
    associations, unresolved, identity_differences = [], [], []
    for row in furniture:
        if not row['representId'] or row['representId'] < 0:
            continue
        kind = ('customBrushes' if row['type'] in (3, 4) else
                'brushes' if row['brushModeCountRaw'] == '2' else 'resources')
        candidates = lookup[kind].get(row['representId'], [])
        exact = [r for r in candidates if integer(r['furnitureTypeRaw']) == row['type']
                 and integer(r['furnitureIdRaw']) == row['furnitureId']]
        association = {'furnitureTableId': row['tableId'], 'resourceTable': kind,
                       'resourceId': row['representId'], 'resourceFound': bool(candidates),
                       'identityMatched': bool(exact), 'candidateCount': len(candidates)}
        associations.append(association)
        if not candidates:
            unresolved.append(row['tableId'])
        elif not exact:
            identity_differences.append({**association, 'furnitureType': row['type'],
                                        'furnitureId': row['furnitureId'],
                                        'resourceIdentities': [[r['furnitureTypeRaw'], r['furnitureIdRaw']] for r in candidates]})
    ids = Counter(r['id'] for r in resources if r['id'] is not None)
    positive = [r for r in furniture if r['representId'] is not None and r['representId'] > 0]
    missing = [r['tableId'] for r in positive if r['representId'] not in ids]
    duplicates = [key for key, count in ids.items() if count > 1]
    coverage = {
        'schema_version': 2, 'sources': sources,
        'furnitureRows': len(furniture), 'categoryRows': len(categories), 'resourceRows': len(resources),
        'positiveRepresentRows': len(positive), 'matchedRepresentRows': len(positive)-len(missing),
        'notInModelTableFurnitureTableIds': missing, 'duplicateRepresentIds': duplicates,
        'notInModelTableByFurnitureType': dict(sorted(Counter(r['type'] for r in positive if r['tableId'] in set(missing)).items())),
        'notInModelTableBrushModeCounts': dict(Counter(r['brushModeCountRaw'] for r in positive if r['tableId'] in set(missing))),
        'brushResourceRows': len(special['brushes']), 'customBrushResourceRows': len(special['customBrushes']),
        'resourceAssociationsByTable': dict(Counter(a['resourceTable'] for a in associations if a['resourceFound'])),
        'resolvedResourceRows': sum(a['resourceFound'] for a in associations),
        'identityMatchedRows': sum(a['identityMatched'] for a in associations),
        'unresolvedFurnitureTableIds': unresolved,
        'resourceIdentityDifferences': identity_differences,
        'modelPathKinds': dict(sorted(Counter(Path(r['modelPath']).suffix.lower() or '(empty)' for r in resources).items())),
        'scope': '索引元数据，不代表全部条目可购买、可摆放或具备网页模型。空字段保留原值，不能当作关闭、零或无限。',
        'webModelFiles': 0, 'allModelGeometryConverted': False, 'gameImportVerified': False,
    }
    return {'schema_version': 2, 'sources': sources, 'furniture': furniture, 'categories': categories,
            'resources': resources, **special, 'associations': associations}, coverage


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--assets', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    index, coverage = build(a.assets)
    a.output.mkdir(parents=True, exist_ok=True)
    for name, value in [('furniture-index.json', index), ('furniture-coverage.json', coverage)]:
        (a.output/name).write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({key: coverage[key] for key in ['furnitureRows', 'categoryRows', 'resourceRows', 'positiveRepresentRows', 'matchedRepresentRows', 'modelPathKinds', 'webModelFiles']}, ensure_ascii=False))
