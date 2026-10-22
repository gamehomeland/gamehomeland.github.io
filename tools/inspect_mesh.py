"""核对已知布局的Mesh流；可导出无贴图的GLB几何实验，不改写游戏资源。"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import struct


def inspect_mesh(data):
    if not 276 <= len(data) <= 64*1024*1024:
        raise ValueError('Mesh文件长度超出范围')
    def u32(offset): return struct.unpack_from('<I', data, offset)[0]
    if data[0x54:0x58] != b'HSEM' or u32(0x58) != len(data):
        raise ValueError('Mesh标记或声明长度不符')
    flags = u32(0x5c)
    if flags not in (2, 0xe4000000, 0xe0000000):
        raise ValueError(f'暂不支持此Mesh布局标记0x{flags:08x}；不能套用未压缩流')
    vertices, triangles = u32(0x90), u32(0x94)
    if not 1 <= vertices <= 200000 or not 1 <= triangles <= 400000:
        raise ValueError('顶点或三角形数量超出检查范围')
    if u32(0x8c) != 1 or u32(0xac) or u32(0xb0):
        raise ValueError('包含尚未支持的层级或附加流')
    streams = {}
    for name, offset, count, fmt in [('position', u32(0x9c), vertices*3, 'f'),
                                     ('normal', u32(0xa0), vertices*3, 'f'),
                                     ('uvw', u32(0xa8), vertices*3, 'f'),
                                     ('indices', u32(0xb4), triangles*3, 'I')]:
        compressed = flags in (0xe4000000, 0xe0000000) and name != 'indices'
        size = (24+vertices*6 if name=='position' else 12+vertices*6 if name=='uvw' else vertices*3) if compressed else count*4
        if offset < 276 or offset+size > len(data):
            raise ValueError(name+'流越界')
        if compressed and name=='position':
            lo=struct.unpack_from('<3f',data,offset);hi=struct.unpack_from('<3f',data,offset+12)
            if any(not math.isfinite(v) for v in lo+hi) or any(a>b for a,b in zip(lo,hi)):
                raise ValueError('压缩位置范围无效')
            q=struct.unpack_from('<'+str(count)+'H',data,offset+24)
            values=tuple(lo[i%3]+(-v if v&1 else v)/65400*abs(hi[i%3]-lo[i%3]) for i,v in enumerate(q))
        elif compressed and name=='normal':
            q=data[offset:offset+size];decoded=[((v&127)/127)*(1 if v&128 else -1) for v in q];values=[]
            for i in range(vertices):
                n=decoded[i*3:i*3+3];length=math.sqrt(sum(v*v for v in n))
                values.extend(v/length if length else 0 for v in n)
            values=tuple(values)
        elif compressed and name=='uvw':
            maximum=struct.unpack_from('<3f',data,offset)
            if any(not math.isfinite(v) or v<0 for v in maximum): raise ValueError('压缩UV范围无效')
            q=struct.unpack_from('<'+str(count)+'H',data,offset+12)
            values=tuple((min(1,v/65400)-.5)*2*maximum[i%3] for i,v in enumerate(q))
        else:
            values = struct.unpack_from('<'+str(count)+fmt, data, offset)
        if fmt == 'f' and not all(math.isfinite(v) for v in values):
            raise ValueError(name+'流含非有限值')
        streams[name] = {'offset': offset, 'bytes': size, 'values': values}
    auxiliary = {}
    # 原生读取器分别从0xa4读取uint32顶点色、从0xd0读取Byte4切线。
    # 静态GLB按位置/法线/UV重建切线；附加流保留独立范围检查。
    if flags in (0xe4000000, 0xe0000000):
        for name, field in [('vertexColor',0xa4),('packedTangent',0xd0)]:
            start=u32(field)
            if start:
                size=vertices*4
                if start<276 or start+size>len(data):raise ValueError(name+'流越界')
                auxiliary[name]={'offset':start,'bytes':size}
    spans = sorted((v['offset'], v['offset']+v['bytes']) for v in [*streams.values(),*auxiliary.values()])
    if any(a[1] > b[0] for a, b in zip(spans, spans[1:])):
        raise ValueError('Mesh流相互重叠')
    indices = streams['indices']['values']
    if max(indices) >= vertices:
        raise ValueError('三角形索引超过顶点范围')
    positions = streams['position']['values']; normals = streams['normal']['values']
    used = sorted(set(indices))
    lengths = [math.sqrt(sum(v*v for v in normals[i*3:i*3+3])) for i in used]
    if min(lengths) < 0.5 or max(lengths) > 1.5:
        raise ValueError('使用中的顶点法线不符合当前布局')
    report = {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'layoutFlag': flags,
              'vertexCount': vertices, 'usedVertexCount': len(used), 'triangleCount': triangles,
              'headerValue98': u32(0x98), 'boundsMin': [min(positions[i::3]) for i in range(3)],
              'boundsMax': [max(positions[i::3]) for i in range(3)],
              'normalLengthRange': [min(lengths), max(lengths)],
              'streams': {k: {n: v[n] for n in ['offset', 'bytes']} for k, v in streams.items()},
              'auxiliaryStreams': auxiliary,
              'scope': '已知布局的几何流核对；不包含贴图、材质子集、骨骼、动画或完整Prefab转换。'}
    return report, streams


def geometry_glb(data, units_per_meter=100):
    if not math.isfinite(units_per_meter) or units_per_meter <= 0:
        raise ValueError('单位换算无效')
    report, streams = inspect_mesh(data)
    original = streams['indices']['values']; used = sorted(set(original)); remap = {v: i for i, v in enumerate(used)}
    positions = []; normals = []
    for i in used:
        positions.extend(v/units_per_meter for v in streams['position']['values'][i*3:i*3+3])
        normal = streams['normal']['values'][i*3:i*3+3]; length = math.sqrt(sum(v*v for v in normal))
        normals.extend(v/length for v in normal)
    indices = [remap[v] for v in original]
    chunks = [struct.pack('<'+str(len(positions))+'f', *positions),
              struct.pack('<'+str(len(normals))+'f', *normals),
              struct.pack('<'+str(len(indices))+'I', *indices)]
    # accessor边界以实际编码的float32为准。
    positions = struct.unpack('<'+str(len(positions))+'f', chunks[0])
    views = []; offset = 0
    for i, chunk in enumerate(chunks):
        views.append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(chunk), 'target': 34963 if i == 2 else 34962})
        offset += len(chunk)
    document = {'asset': {'version': '2.0', 'generator': 'Homeland geometry inspector'},
        'scene': 0, 'scenes': [{'nodes': [0]}], 'nodes': [{'mesh': 0, 'name': 'geometry-check'}],
        'meshes': [{'primitives': [{'attributes': {'POSITION': 0, 'NORMAL': 1}, 'indices': 2, 'material': 0, 'mode': 4}]}],
        'materials': [{'name': 'diagnostic-neutral', 'doubleSided': True,
                      'pbrMetallicRoughness': {'baseColorFactor': [0.72, 0.74, 0.78, 1], 'metallicFactor': 0, 'roughnessFactor': 1}}],
        'buffers': [{'byteLength': offset}], 'bufferViews': views,
        'accessors': [{'bufferView': 0, 'componentType': 5126, 'count': len(used), 'type': 'VEC3',
                       'min': [min(positions[i::3]) for i in range(3)], 'max': [max(positions[i::3]) for i in range(3)]},
                      {'bufferView': 1, 'componentType': 5126, 'count': len(used), 'type': 'VEC3'},
                      {'bufferView': 2, 'componentType': 5125, 'count': len(indices), 'type': 'SCALAR'}],
        'extras': {'scope': 'geometry-only; original materials and prefab placement are not reproduced',
                   'sourceSha256': report['sha256'], 'unitsPerMeterApplied': units_per_meter}}
    header = json.dumps(document, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    header += b' '*(-len(header) % 4); binary = b''.join(chunks)
    length = 12+8+len(header)+8+len(binary)
    return struct.pack('<III', 0x46546c67, 2, length)+struct.pack('<I4s', len(header), b'JSON')+header+struct.pack('<I4s', len(binary), b'BIN\0')+binary


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('mesh', type=Path); p.add_argument('--output', type=Path, required=True)
    p.add_argument('--glb', type=Path); p.add_argument('--units-per-meter', type=float, default=100)
    a = p.parse_args()
    if a.mesh.resolve() == a.output.resolve() or (a.glb and a.mesh.resolve() == a.glb.resolve()):
        raise SystemExit('输出不能覆盖原始资源')
    raw = a.mesh.read_bytes(); report, _ = inspect_mesh(raw)
    a.output.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', 'utf-8')
    if a.glb: a.glb.write_bytes(geometry_glb(raw, a.units_per_meter))
    print(json.dumps({k: report[k] for k in ['vertexCount', 'triangleCount', 'boundsMin', 'boundsMax']}))
