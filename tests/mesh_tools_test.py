import importlib.util
import json
from pathlib import Path
import struct
import unittest

spec = importlib.util.spec_from_file_location('mesh_inspector', Path(__file__).resolve().parents[1]/'tools/inspect_mesh.py')
mesh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mesh)


def fixture():
    streams = [struct.pack('<9f', 0, 0, 0, 100, 0, 0, 0, 0, 100),
               struct.pack('<9f', 0, -1, 0, 0, -1, 0, 0, -1, 0),
               struct.pack('<9f', 0, 0, 0, 1, 0, 0, 0, 1, 0),
               struct.pack('<3I', 0, 1, 2)]
    body = bytearray(276)
    body[0x54:0x58] = b'HSEM'
    for offset, value in [(0x5c, 2), (0x8c, 1), (0x90, 3), (0x94, 1), (0x98, 1)]:
        struct.pack_into('<I', body, offset, value)
    for field, data in zip([0x9c, 0xa0, 0xa8, 0xb4], streams):
        struct.pack_into('<I', body, field, len(body)); body.extend(data)
    struct.pack_into('<I', body, 0x58, len(body))
    return body


class MeshTests(unittest.TestCase):
    def test_quantized_position_normal_uv_layout(self):
        raw=bytearray(276);raw[0x54:0x58]=b'HSEM'
        for off,val in [(0x5c,0xe4000000),(0x8c,1),(0x90,3),(0x94,1),(0x98,1)]:struct.pack_into('<I',raw,off,val)
        streams=[struct.pack('<6f9H',-200,-400,-200,200,0,200,0,65400,0,65400,65400,0,0,0,65400),bytes([128,255,128]*3),struct.pack('<3f9H',2,1,0,0,32700,32700,65400,65400,32700,32700,0,32700),struct.pack('<3I',0,2,1)]
        for off,stream in zip([0x9c,0xa0,0xa8,0xb4],streams):struct.pack_into('<I',raw,off,len(raw));raw.extend(stream)
        struct.pack_into('<I',raw,0x58,len(raw));report,data=mesh.inspect_mesh(raw)
        self.assertEqual(data['position']['values'],(-200,0,-200,200,0,-200,-200,-400,200))
        self.assertEqual(data['normal']['values'],(0,1,0)*3)
        self.assertEqual(data['uvw']['values'],(-2,0,0,2,1,0,0,-1,0))
        struct.pack_into('<I',raw,0x5c,0xe0000000)
        _,second=mesh.inspect_mesh(raw)
        self.assertEqual(second['position']['values'],data['position']['values'])
        self.assertEqual(second['normal']['values'],data['normal']['values'])
        struct.pack_into('<I',raw,0xd0,struct.unpack_from('<I',raw,0xa0)[0])
        with self.assertRaisesRegex(ValueError,'重叠'):mesh.inspect_mesh(raw)
    def test_glb_geometry_uses_real_indices_and_metre_scale(self):
        raw = fixture(); report, _ = mesh.inspect_mesh(raw)
        self.assertEqual(report['triangleCount'], 1)
        glb = mesh.geometry_glb(raw)
        magic, version, size = struct.unpack_from('<III', glb)
        self.assertEqual((magic, version, size), (0x46546c67, 2, len(glb)))
        length, kind = struct.unpack_from('<I4s', glb, 12)
        self.assertEqual(kind, b'JSON')
        doc = json.loads(glb[20:20+length])
        self.assertEqual(doc['accessors'][0]['max'], [1, 0, 1])
        self.assertEqual(doc['accessors'][2]['count'], 3)
        self.assertEqual(doc['extras']['unitsPerMeterApplied'], 100)

    def test_compression_unknown_layout_and_indices_fail(self):
        raw = fixture(); struct.pack_into('<I', raw, 0x5c, 0x80000000)
        with self.assertRaisesRegex(ValueError, '布局标记'): mesh.inspect_mesh(raw)
        raw = fixture(); struct.pack_into('<I', raw, len(raw)-4, 3)
        with self.assertRaisesRegex(ValueError, '索引'): mesh.inspect_mesh(raw)
        with self.assertRaises(ValueError): mesh.inspect_mesh(fixture()[:-1])

    def test_bad_streams_and_nonfinite_values_fail(self):
        raw = fixture(); struct.pack_into('<I', raw, 0xa0, 276)
        with self.assertRaisesRegex(ValueError, '重叠'): mesh.inspect_mesh(raw)
        raw = fixture(); struct.pack_into('<f', raw, 276, float('nan'))
        with self.assertRaisesRegex(ValueError, '非有限'): mesh.inspect_mesh(raw)
        with self.assertRaises(ValueError): mesh.geometry_glb(fixture(), 0)


if __name__ == '__main__': unittest.main()
