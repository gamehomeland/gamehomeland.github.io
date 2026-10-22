import io
import json
from pathlib import Path
import struct
import sys
import unittest
from PIL import Image
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from optimize_glb import optimize, unpack


def fixture(size=32):
    image = Image.new('RGBA', (size, size))
    image.putdata([((i * 17) % 256, (i * 11) % 256, (i * 29) % 256, (i * 7) % 256) for i in range(size * size)])
    png = io.BytesIO(); image.save(png, 'PNG')
    geometry = struct.pack('<9f', 0, 0, 0, 1, 0, 0, 0, 1, 0)
    binary = geometry + png.getvalue()
    doc = {'asset': {'version': '2.0'}, 'buffers': [{'byteLength': len(binary)}],
           'bufferViews': [{'buffer': 0, 'byteOffset': 0, 'byteLength': 36},
                           {'buffer': 0, 'byteOffset': 36, 'byteLength': len(png.getvalue())}],
           'accessors': [{'bufferView': 0, 'componentType': 5126, 'count': 3, 'type': 'VEC3', 'min': [0,0,0], 'max': [1,1,0]}],
           'meshes': [{'primitives': [{'attributes': {'POSITION': 0}, 'material': 0}]}],
           'nodes': [{'mesh': 0}], 'scenes': [{'nodes': [0]}], 'scene': 0,
           'images': [{'bufferView': 1, 'mimeType': 'image/png'}], 'textures': [{'source': 0}],
           'materials': [{'pbrMetallicRoughness': {'baseColorTexture': {'index': 0}}}]}
    return pack(doc, binary), image


def pack(doc, binary):
    j = json.dumps(doc).encode(); j += b' ' * (-len(j) % 4)
    binary += b'\0' * (-len(binary) % 4)
    return struct.pack('<III', 0x46546c67, 2, len(j) + len(binary) + 28) + struct.pack('<II', len(j), 0x4e4f534a) + j + struct.pack('<II', len(binary), 0x004e4942) + binary


class OptimizationTests(unittest.TestCase):
    def test_lossless_pixels_geometry_and_idempotence(self):
        source, image = fixture()
        output, report = optimize(source, 512, 90, True)
        old, old_data = unpack(source); new, data = unpack(output)
        for key in ['accessors','meshes','nodes','materials','scenes']:
            self.assertEqual(old[key], new[key])
        view = new['bufferViews'][new['images'][0]['bufferView']]
        decoded = Image.open(io.BytesIO(data[view['byteOffset']:view['byteOffset']+view['byteLength']])).convert('RGBA')
        self.assertEqual(decoded.tobytes(), image.tobytes())
        self.assertEqual(data[:36], old_data[:36])
        self.assertTrue(report['geometryUnchanged'])
        self.assertEqual(optimize(output, 512, 90, True)[0], output)
        with self.assertRaises(ValueError): optimize(output, 256, 90, True)

    def test_shared_data_texture_stays_lossless_and_resizes_alpha(self):
        source, image = fixture(512)
        doc, data = unpack(source)
        doc['materials'][0]['normalTexture'] = {'index': 0}
        output, report = optimize(pack(doc, data), 256, 90)
        new, data = unpack(output)
        self.assertEqual(report['images'][0]['encoding'], 'lossless')
        self.assertEqual(report['images'][0]['to'], [256,256])
        self.assertEqual(report['images'][0]['meanRGBErrorAfterResize'], 0)
        self.assertTrue(report['images'][0]['alphaUnchangedAfterResize'])

    def test_invalid_or_external_inputs_rejected(self):
        source, _ = fixture()
        with self.assertRaises(ValueError): optimize(source[:25])
        doc, data = unpack(source)
        doc['images'][0]['uri'] = 'https://example.test/private.png'
        with self.assertRaises(ValueError): optimize(pack(doc, data))


if __name__ == '__main__': unittest.main()
