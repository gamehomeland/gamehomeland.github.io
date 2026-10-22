"""压缩自包含 GLB 的内嵌贴图，保持几何、节点、材质参数与样式映射。"""
import argparse
import copy
import hashlib
import io
import json
from pathlib import Path
import struct
from PIL import Image, ImageChops, ImageStat


def unpack(raw):
    if len(raw) < 28 or raw[:4] != b'glTF' or struct.unpack_from('<II', raw, 4) != (2, len(raw)):
        raise ValueError('不是完整的 GLB 2.0')
    length, kind = struct.unpack_from('<II', raw, 12)
    end = 20 + length
    if kind != 0x4e4f534a or length % 4 or end + 8 > len(raw):
        raise ValueError('JSON 块无效')
    doc = json.loads(raw[20:end])
    size, kind = struct.unpack_from('<II', raw, end)
    if kind != 0x004e4942 or end + 8 + size != len(raw):
        raise ValueError('BIN 块无效')
    if len(doc.get('buffers', [])) != 1 or 'uri' in doc['buffers'][0]:
        raise ValueError('仅支持自包含单缓冲区 GLB')
    data = raw[end + 8:]
    for view in doc.get('bufferViews', []):
        start = view.get('byteOffset', 0)
        if view.get('buffer') != 0 or start < 0 or view['byteLength'] < 0 or start + view['byteLength'] > len(data):
            raise ValueError('bufferView 越界')
    return doc, data


def image_source(texture):
    return texture.get('extensions', {}).get('EXT_texture_webp', {}).get('source', texture.get('source'))


def optimize(raw, max_texture=512, quality=90, lossless=False):
    if max_texture not in [256, 512, 1024, 2048] or not 70 <= quality <= 100:
        raise ValueError('贴图长边支持 256/512/1024/2048，颜色质量支持 70～100')
    doc, binary = unpack(raw)
    profile = {'maxTexture': max_texture, 'colorQuality': quality, 'lossless': lossless, 'version': 1}
    previous = doc.get('extras', {}).get('webOptimization')
    if previous:
        if previous['profile'] == profile:
            return raw, {'unchanged': True, 'inputBytes': len(raw), 'outputBytes': len(raw), 'geometryUnchanged': True}
        raise ValueError('请从原始转换结果重新压缩，避免对已压缩贴图反复编码')
    original = copy.deepcopy(doc)
    color_images, data_images = set(), set()
    def visit(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if key.endswith('Texture') and isinstance(item, dict) and 'index' in item:
                    source = image_source(doc['textures'][item['index']])
                    (color_images if key in ['baseColorTexture', 'emissiveTexture'] else data_images).add(source)
                visit(item)
        elif isinstance(value, list):
            for item in value: visit(item)
    visit(doc.get('materials', []))
    images_by_view = {}
    for i, image in enumerate(doc.get('images', [])):
        if 'uri' in image or image.get('mimeType') not in ['image/png', 'image/jpeg', 'image/webp']:
            raise ValueError('贴图必须内嵌为 PNG、JPEG 或 WebP')
        images_by_view.setdefault(image['bufferView'], []).append(i)
    if any(a.get('bufferView') in images_by_view for a in doc.get('accessors', [])):
        raise ValueError('贴图与几何不能共享同一 bufferView')
    replacements, image_reports = {}, []
    for view_id, image_ids in images_by_view.items():
        view = doc['bufferViews'][view_id]
        start = view.get('byteOffset', 0)
        source = binary[start:start + view['byteLength']]
        with Image.open(io.BytesIO(source)) as opened:
            if getattr(opened, 'n_frames', 1) != 1 or opened.width * opened.height > 16_777_216:
                raise ValueError('贴图动画或像素数超出支持范围')
            image = opened.convert('RGBA')
        original_size = list(image.size)
        if max(image.size) > max_texture:
            image.thumbnail((max_texture, max_texture), Image.Resampling.LANCZOS)
        lossless_file = io.BytesIO()
        image.save(lossless_file, 'WEBP', lossless=True, method=4, exact=True)
        encoded, mode = lossless_file.getvalue(), 'lossless'
        color_only = all(i in color_images and i not in data_images for i in image_ids)
        if color_only and not lossless:
            lossy_file = io.BytesIO()
            image.save(lossy_file, 'WEBP', quality=quality, method=4, exact=True)
            if len(lossy_file.getvalue()) < len(encoded) * 0.8:
                encoded, mode = lossy_file.getvalue(), 'color-q' + str(quality)
        decoded = Image.open(io.BytesIO(encoded)).convert('RGBA')
        if image.getchannel('A').tobytes() != decoded.getchannel('A').tobytes():
            raise ValueError('透明通道发生变化')
        error = sum(ImageStat.Stat(ImageChops.difference(image.convert('RGB'), decoded.convert('RGB'))).mean) / 3
        if mode == 'lossless' and image.tobytes() != decoded.tobytes():
            raise ValueError('无损编码像素不一致')
        # 小图本身更紧凑时保留原编码，避免为了格式转换反而增加体积。
        mime = 'image/webp'
        if original_size == list(image.size) and len(source) <= len(encoded):
            encoded, mime, mode, error = source, original['images'][image_ids[0]]['mimeType'], 'original', 0
        replacements[view_id] = encoded
        for i in image_ids: doc['images'][i]['mimeType'] = mime
        image_reports.append({'images': image_ids, 'from': original_size, 'to': list(image.size),
                              'encoding': mode, 'inputBytes': len(source), 'outputBytes': len(encoded),
                              'meanRGBErrorAfterResize': round(error, 4), 'alphaUnchangedAfterResize': True})
    result_binary = bytearray()
    for i, view in enumerate(doc['bufferViews']):
        old = original['bufferViews'][i]
        payload = replacements.get(i, binary[old.get('byteOffset', 0):old.get('byteOffset', 0) + old['byteLength']])
        result_binary.extend(b'\0' * (-len(result_binary) % 4))
        view['byteOffset'], view['byteLength'] = len(result_binary), len(payload)
        result_binary.extend(payload)
    doc['buffers'][0]['byteLength'] = len(result_binary)
    result_binary.extend(b'\0' * (-len(result_binary) % 4))
    uses_webp = False
    for texture in doc.get('textures', []):
        image_id = image_source(texture)
        if image_id is not None and doc['images'][image_id]['mimeType'] == 'image/webp':
            uses_webp = True
            texture.pop('source', None)
            texture.setdefault('extensions', {})['EXT_texture_webp'] = {'source': image_id}
    if uses_webp:
        for key in ['extensionsUsed', 'extensionsRequired']:
            doc[key] = sorted(set(doc.get(key, []) + ['EXT_texture_webp']))
    doc.setdefault('extras', {})['webOptimization'] = {
        'profile': profile, 'inputSha256': hashlib.sha256(raw).hexdigest(),
        'geometryUnchanged': True, 'textureCount': len(image_reports),
    }
    js = json.dumps(doc, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
    js += b' ' * (-len(js) % 4)
    output = struct.pack('<III', 0x46546c67, 2, 28 + len(js) + len(result_binary)) + struct.pack('<II', len(js), 0x4e4f534a) + js + struct.pack('<II', len(result_binary), 0x004e4942) + result_binary
    check, check_binary = unpack(output)
    for key in ['nodes', 'meshes', 'accessors', 'materials', 'scenes', 'scene', 'skins', 'animations']:
        if check.get(key) != original.get(key): raise ValueError('模型结构发生变化：' + key)
    for i, view in enumerate(original['bufferViews']):
        if i in replacements: continue
        new = check['bufferViews'][i]
        if binary[view.get('byteOffset', 0):view.get('byteOffset', 0) + view['byteLength']] != check_binary[new['byteOffset']:new['byteOffset'] + new['byteLength']]:
            raise ValueError('几何缓冲区发生变化')
    return output, {'inputBytes': len(raw), 'outputBytes': len(output), 'geometryUnchanged': True,
                    'inputSha256': hashlib.sha256(raw).hexdigest(), 'outputSha256': hashlib.sha256(output).hexdigest(),
                    'profile': profile, 'images': image_reports}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True); parser.add_argument('--output', required=True)
    parser.add_argument('--report', required=True); parser.add_argument('--max-texture', type=int, default=512)
    parser.add_argument('--quality', type=int, default=90); parser.add_argument('--lossless', action='store_true')
    args = parser.parse_args()
    source, target, report_file = map(lambda p: Path(p).resolve(), [args.input, args.output, args.report])
    if len({source, target, report_file}) != 3: raise SystemExit('输入、输出和报告必须使用不同路径')
    result, report = optimize(source.read_bytes(), args.max_texture, args.quality, args.lossless)
    target.parent.mkdir(parents=True, exist_ok=True); report_file.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(result); report_file.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: v for k, v in report.items() if k != 'images'}, ensure_ascii=False))
