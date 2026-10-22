import struct
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'tools'))
from inspect_terrain_hole import inspect


def fixture():
    data=bytearray(400)
    data[0x54:0x58]=b'HSEM'
    for off,value in [(0x58,len(data)),(0x5c,0xe4000000),(0x90,3),(0x94,1),(0x9c,0x114),(0xa0,0x114+42),(0xb4,380)]:
        struct.pack_into('<I',data,off,value)
    struct.pack_into('<6f',data,0x114,-200,-30,-200,200,0,200)
    struct.pack_into('<9H',data,0x12c,0,65400,0,65400,65400,0,0,65400,65400)
    struct.pack_into('<3I',data,380,0,1,2)
    return data


class TerrainHoleTests(unittest.TestCase):
    def test_position_quantization_and_triangle_indices(self):
        r=inspect(fixture())
        self.assertEqual(r['vertices'],[[-200,0,-200],[200,0,-200],[-200,0,200]])
        self.assertEqual(r['triangles'],[[0,1,2]])

    def test_bad_counts_offsets_and_indices(self):
        for offset,value in [(0x90,0),(0xa0,317),(0xb4,399),(380,4)]:
            d=fixture();struct.pack_into('<I',d,offset,value)
            with self.assertRaises(ValueError): inspect(d)

    def test_other_mesh_layout_is_not_silently_accepted(self):
        d=fixture();struct.pack_into('<I',d,0x5c,2)
        with self.assertRaises(ValueError): inspect(d)


if __name__=='__main__': unittest.main()
