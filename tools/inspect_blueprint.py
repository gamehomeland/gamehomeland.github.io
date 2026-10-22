"""只读 V7 字段解读，不执行文件内容，不改写输入。"""
import argparse
import csv
import hashlib
import json
import math
import lzma
from pathlib import Path
import struct

SEMANTICS = json.loads((Path(__file__).resolve().parents[1]/'docs/blueprint-semantics.json').read_text('utf-8'))


def light_parameters(block):
    """只解释已对应到兼容转换与参数读取的字段，路径指针永不解引用。"""
    if len(block) != 184:
        raise ValueError('灯光参数块必须为184字节')
    kind = struct.unpack_from('<I', block)[0]
    descriptors = SEMANTICS['light']['fields'] + SEMANTICS['light']['variantFields'].get(str(kind), [])
    result = []
    formats = {'u32': '<I', 'f32': '<f', 'vec3': '<3f', 'vec4': '<4f', 'address64': '<Q'}
    for entry in descriptors:
        fmt = formats[entry['type']]
        values = struct.unpack_from(fmt, block, entry['offset'])
        if entry['type'] == 'address64':
            value = f'0x{values[0]:016x}'
        else:
            values = [v if not isinstance(v, float) or math.isfinite(v) else str(v) for v in values]
            value = values[0] if len(values) == 1 else values
        result.append({**entry, 'bytes': struct.calcsize(fmt), 'value': value})
    unknown = [{'offset': r['offset'], 'bytes': r['bytes'],
                'hex': block[r['offset']:r['offset']+r['bytes']].hex()}
               for r in SEMANTICS['light']['unresolvedCommonRanges']]
    if str(kind) not in SEMANTICS['light']['variantFields']:
        unknown.append({'offset': 24, 'bytes': 8, 'hex': block[24:32].hex()})
    return {'fields': result, 'unresolved': unknown, 'pointerPolicy': SEMANTICS['light']['pointerPolicy']}


def decode_ground_grid(properties, compressed, expected):
    if not 0 < expected < 1_048_576 or len(properties) != 5:
        raise ValueError('地表解码尺寸或属性超出检查范围')
    value = properties[0]
    if value >= 9*5*5:
        raise ValueError('无效LZMA属性')
    lc = value % 9; value //= 9
    lp = value % 5; pb = value // 5
    dictionary = int.from_bytes(properties[1:], 'little')
    if not 4096 <= dictionary <= 64*1024*1024 or lc+lp > 4:
        raise ValueError('LZMA字典或编码参数超出检查范围')
    decoder = lzma.LZMADecompressor(format=lzma.FORMAT_RAW, filters=[{
        'id': lzma.FILTER_LZMA1, 'dict_size': dictionary, 'lc': lc, 'lp': lp, 'pb': pb}])
    decoded = decoder.decompress(compressed, max_length=expected+1)
    if len(decoded) != expected or decoder.unused_data:
        raise ValueError('地表解码长度不符或包含多余数据')
    return decoded


def checksum(body):
    digest = hashlib.md5(body).digest()
    return bytes(digest[(i+1) % 16] ^ 0x33 for i in range(16))


def known_scales(models=None):
    root = Path(__file__).resolve().parents[1]
    palette = json.loads((root/'data/furniture_palette.json').read_text('utf-8'))
    support = json.loads((root/'data/support_geometry.json').read_text('utf-8'))['runtime']
    result = {v['representId']: False for c in palette['colors'] for v in c['variants']}
    result.update({support['representId']: False, support['meshRepresentId']: False, 0xffffffff: False})
    if models:
        for row in csv.DictReader(Path(models).read_text('gb18030').splitlines(), delimiter='\t'):
            if row.get('id', '').isdigit():
                result[int(row['id'])] = bool(int(row.get('bCanNonUniformScaling') or '0'))
    return result


def inspect(data, scales, max_nodes=50000, decode_grids=False):
    if not 26 <= len(data) <= 32_000_000:
        raise ValueError('文件长度超出检查范围')
    payload, suffix = data[:-16], data[-16:]
    if checksum(payload) != suffix:
        raise ValueError('文件校验不符')
    fields = []
    position = 0
    nodes = 0

    def raw(name, size, kind='bytes'):
        nonlocal position
        if size < 0 or position + size > len(payload):
            raise ValueError(f'{name} 截断，偏移 {position}')
        p = position
        value = payload[p:p+size]
        position += size
        fields.append({'path': name, 'offset': p, 'bytes': size, 'type': kind,
                       'value': value.hex() if size <= 320 else {'sha256': hashlib.sha256(value).hexdigest()}})
        return value

    def number(name, fmt):
        types = {'B': 'u8', 'H': 'u16', 'I': 'u32', 'f': 'f32'}
        value = struct.unpack('<'+fmt, raw(name, struct.calcsize('<'+fmt), types[fmt]))[0]
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError(name+' 含非有限浮点数')
        fields[-1]['value'] = value
        return value

    def vector(name, names):
        return [number(name+'.'+part, 'f') for part in names]

    def transform(name, nonuniform=False):
        scale = vector(name, ['sx', 'sy', 'sz'] if nonuniform else ['scale'])
        if min(scale) <= 0:
            raise ValueError(name+' 缩放必须为正')
        vector(name, ['qx', 'qy', 'qz', 'qw', 'px', 'py', 'pz'])

    def string(name):
        end = payload.find(b'\0', position, min(position+260, len(payload)))
        if end == -1:
            raise ValueError(name+' 缺少限长字符串终止符')
        value = raw(name, end-position+1, 'cstring')[:-1]
        fields[-1]['value'] = {'text': value.decode('gb18030', errors='replace'), 'hex': value.hex()}

    global_ = number('file.global', 'B')
    if global_ not in (0, 1) or number('file.version', 'I') != 7:
        raise ValueError('仅支持 V7 局部或全局格式')
    if global_:
        vector('scene.extent', ['axis0', 'axis1'])
        vector('scene.localBounds', ['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ'])
        number('scene.nextInstanceId', 'I'); number('scene.withVersion', 'B'); number('scene.saveVersion', 'I')
        version = number('ground.version', 'I')
        count = number('ground.layerCount', 'I')
        if version not in (1, 2) or count > 3:
            raise ValueError('不支持的地表块')
        width = number('ground.width', 'I'); height = number('ground.height', 'I')
        vector('ground.scale', ['x', 'y', 'z'])
        vector('ground.rotation', ['x', 'y', 'z', 'w']); vector('ground.position', ['x', 'y', 'z'])
        for i in range(count):
            name = f'ground.layers[{i}]'
            first = number(name+'.resourceId', 'I'); number(name+'.instanceId', 'I'); number(name+'.order', 'I')
            if version == 2:
                length = number(name+'.compressedBytes', 'I')
                properties = raw(name+'.compressionProperties', 5)
                compressed = raw(name+'.compressedData', length)
                if decode_grids and length:
                    grid = decode_ground_grid(properties, compressed, width*height)
                    fields[-1]['decodedGrid'] = {'bytes': len(grid), 'sha256': hashlib.sha256(grid).hexdigest(),
                        'minimum': min(grid), 'maximum': max(grid), 'nonzeroCells': sum(bool(v) for v in grid),
                        'sample': list(grid[:64]), 'renderWeight': 'byte/255.0'}
            elif first:
                raw(name+'.grid', width*height)
        if number('foliage.version', 'I') != 1:
            raise ValueError('不支持的植被块')
        width = number('foliage.width', 'I'); height = number('foliage.height', 'I')
        count = number('foliage.typeCount', 'B')
        if count > 64:
            raise ValueError('植被类型超过64')
        number('foliage.instanceId', 'I')
        vector('foliage.scale', ['x', 'y', 'z'])
        vector('foliage.rotation', ['x', 'y', 'z', 'w']); vector('foliage.position', ['x', 'y', 'z'])
        if count:
            for i in range(64): number(f'foliage.resources[{i}]', 'I')
            raw('foliage.typeMapping', 64)
            raw('foliage.gridTwoBytesPerCell', width*height*2)

    root_offset = position

    def node(name, depth):
        nonlocal nodes
        nodes += 1
        if nodes > max_nodes or depth > 128:
            raise ValueError('节点数量或深度超过检查范围')
        start = position
        kind = number(name+'.type', 'B')
        if kind in (0, 2, 3, 8):
            flags = number(name+'.flags', 'I')
            if kind == 0:
                fields[-1]['semantic'] = {'reverseTransmitPoint': bool(flags & 1),
                    'otherBitsRaw': flags & 0xfffffffe, 'scope': '传送家具方向反转，不代表隐藏或锁定'}
            number(name+'.instanceId', 'I')
            resource = number(name+'.resourceId', 'I')
            number(name+'.builtin', 'B'); number(name+'.detail', 'B')
            if kind == 2:
                number(name+'.subgroupHasMultiPlaneContainer', 'B')
                tags = number(name+'.subgroupTagMask', 'I')
                fields[-1]['semantic'] = {'unclassified': tags == 0xffffffff,
                    'tags': [] if tags == 0xffffffff else [v for k, v in SEMANTICS['subgroup']['bits'].items() if tags & int(k)],
                    'otherBitsRaw': 0 if tags == 0xffffffff else tags & 0xffffffe0}
            children = number(name+'.childCount', 'H')
            if resource not in scales:
                raise ValueError(f'资源 {resource} 的缩放规则未知，请提供 --models')
            transform(name+'.transform', scales[resource])
        elif kind in (1, 9):
            number(name+'.instanceId', 'I'); number(name+'.brushResource', 'H'); number(name+'.mask', 'H')
            if kind == 9:
                number(name+'.cascadeField', 'B')
                fields[-1]['loadBehavior'] = SEMANTICS['cascade']['extraByte']
            children = number(name+'.childCount', 'H')
            transform(name+'.transform')
        elif kind in (5, 6, 7):
            number(name+'.index', 'H'); children = number(name+'.childCount', 'H')
            if children: transform(name+'.transform')
        elif kind == 4:
            length = number(name+'.nodeBytes', 'H')
            if not 231 <= length <= 749 or start+length > len(payload):
                raise ValueError('灯光节点长度无效')
            number(name+'.flags', 'I'); number(name+'.instanceId', 'I')
            block = raw(name+'.lightSDKParameters', 184, 'opaque-sdk-block')
            fields[-1]['decoded'] = light_parameters(block)
            fields[-1]['interpretationsNotSemanticNames'] = {
                'u32': list(struct.unpack('<46I', block)),
                'f32': [v if math.isfinite(v) else str(v) for v in struct.unpack('<46f', block)],
            }
            string(name+'.materialPath'); string(name+'.maskPath')
            children = number(name+'.childCount', 'H'); transform(name+'.transform')
            if position-start != length:
                raise ValueError('灯光节点实际长度与声明不符')
        else:
            raise ValueError(f'未知节点类型 {kind}，偏移 {start}')
        for i in range(children): node(f'{name}.children[{i}]', depth+1)

    node('root', 0)
    if position != len(payload):
        raise ValueError(f'存在未读取尾部：{len(payload)-position} 字节')
    fields.append({'path': 'file.checksum', 'offset': position, 'bytes': 16, 'type': 'md5-rotate-xor', 'value': suffix.hex()})
    return {'reportVersion': 2, 'formatVersion': 7, 'global': bool(global_), 'rootOffset': root_offset,
            'nodeCount': nodes, 'checksumVerified': True, 'gameImportVerified': False, 'fields': fields}


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('file', type=Path); p.add_argument('--models', type=Path)
    p.add_argument('--decode-grids', action='store_true', help='在尺寸与内存限制内解码地表LZMA绘制网格')
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    if a.file.resolve() == a.output.resolve():
        raise SystemExit('输出文件不能覆盖输入蓝图')
    report = inspect(a.file.read_bytes(), known_scales(a.models), decode_grids=a.decode_grids)
    a.output.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False)+'\n', 'utf-8')
    print(json.dumps({'nodes': report['nodeCount'], 'fields': len(report['fields']), 'rootOffset': report['rootOffset']}))
