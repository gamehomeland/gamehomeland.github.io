"""提取蓝图节点定长解析所需的资源编号和缩放布局，不复制模型或贴图。"""
from pathlib import Path
import argparse
import csv
import hashlib
import json

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--models', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.models.resolve() == args.output.resolve():
        raise SystemExit('输出不能覆盖资源表')
    raw = args.models.read_bytes()
    rows = [r for r in csv.DictReader(raw.decode('gb18030').splitlines(), delimiter='\t') if r.get('id', '').isdigit()]
    rules = {}
    for row in rows:
        key = int(row['id']); value = bool(int(row.get('bCanNonUniformScaling') or '0'))
        if key in rules and rules[key] != value:
            raise SystemExit('同一资源的缩放布局不一致')
        rules[key] = value
    ranges = []
    for key in sorted(rules):
        if ranges and key == ranges[-1][1] + 1:
            ranges[-1][1] = key
        else:
            ranges.append([key, key])
    result = {'schemaVersion': 1, 'sourceSha256': hashlib.sha256(raw).hexdigest(),
              'knownRanges': ranges, 'nonUniform': sorted(k for k, v in rules.items() if v)}
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n', encoding='utf8')
    print(json.dumps({'resources': len(rules), 'ranges': len(ranges), 'nonUniform': len(result['nonUniform'])}))
