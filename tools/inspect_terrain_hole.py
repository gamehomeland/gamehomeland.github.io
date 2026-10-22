"""Read positions and triangles of the audited e4000000 TerrainHole subset.

This is not a general compressed Mesh decoder. It does not export materials.
"""
import argparse
import hashlib
import json
import math
import struct
from pathlib import Path


def inspect(data: bytes):
    if len(data) < 0x114 or data[0x54:0x58] != b'HSEM':
        raise ValueError('不是支持的洞口Mesh')
    u32 = lambda offset: struct.unpack_from('<I', data, offset)[0]
    if u32(0x58) != len(data) or u32(0x5c) != 0xe4000000:
        raise ValueError('未支持的Mesh布局')
    count, triangles = u32(0x90), u32(0x94)
    position, normal, index = u32(0x9c), u32(0xa0), u32(0xb4)
    if not 3 <= count <= 100000 or not 1 <= triangles <= 100000:
        raise ValueError('洞口Mesh计数无效')
    if not 0x114 <= position < normal <= len(data) or normal-position != 24+count*6:
        raise ValueError('位置流长度不匹配')
    if not normal <= index <= len(data)-triangles*12:
        raise ValueError('三角形索引越界')
    lo, hi = struct.unpack_from('<3f', data, position), struct.unpack_from('<3f', data, position+12)
    if not all(math.isfinite(v) for v in lo+hi) or any(a>b for a,b in zip(lo,hi)):
        raise ValueError('位置范围无效')
    vertices = []
    for i in range(count):
        q = struct.unpack_from('<3H', data, position+24+i*6)
        # 原生解码用最低位决定符号，除数65400；不能替换为无符号/65535。
        p = [lo[j] + ((-v if v & 1 else v)/65400)*abs(hi[j]-lo[j]) for j,v in enumerate(q)]
        if any(v<lo[j]-.01 or v>hi[j]+.01 for j,v in enumerate(p)):
            raise ValueError('顶点不在声明范围内')
        vertices.append(p)
    faces = [list(struct.unpack_from('<3I', data, index+i*12)) for i in range(triangles)]
    if any(i>=count for face in faces for i in face):
        raise ValueError('三角形引用无效顶点')
    return {'sha256':hashlib.sha256(data).hexdigest(), 'vertices':vertices, 'triangles':faces,
            'boundsM':[[min(p[j] for p in vertices)/100 for j in range(3)], [max(p[j] for p in vertices)/100 for j in range(3)]],
            'scope':'position-and-triangle-only; not a general compressed Mesh decoder'}


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file',type=Path);parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    if args.file.resolve()==args.output.resolve(): raise SystemExit('输出不能覆盖原始Mesh')
    result=inspect(args.file.read_bytes())
    args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    print(json.dumps({'vertices':len(result['vertices']),'triangles':len(result['triangles']),'boundsM':result['boundsM']}))
