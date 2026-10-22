import importlib.util
from pathlib import Path
import struct
import lzma
import unittest

spec = importlib.util.spec_from_file_location('blueprint_inspector', Path(__file__).resolve().parents[1]/'tools/inspect_blueprint.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
I = lambda value: struct.pack('<I', value)
H = lambda value: struct.pack('<H', value)
TRANSFORM = struct.pack('<8f', 1, 0, 0, 0, 1, 0, 0, 0)


def object_(kind=0, resource=123, children=(), nonuniform=False):
    header = bytes([kind])+I(0)+I(1)+I(resource)+bytes([0, 0])
    if kind == 2: header += bytes([1])+I(17)
    t = struct.pack('<10f', 1, 2, 3, 0, 0, 0, 1, 0, 0, 0) if nonuniform else TRANSFORM
    return header+H(len(children))+t+b''.join(children)


def file_(root, prefix=b'\0'+I(7)):
    body = prefix+root
    return body+module.checksum(body)


class InspectorTests(unittest.TestCase):
    def test_subgroup_tag_bits_and_unclassified_sentinel(self):
        for mask, labels in [(9, ['01', 'wall']), (16, ['roof']), (0xffffffff, [])]:
            raw = bytearray(object_(2))
            struct.pack_into('<I', raw, 16, mask)
            report = module.inspect(file_(bytes(raw)), {123: False})
            field = next(f for f in report['fields'] if f['path'] == 'root.subgroupTagMask')
            self.assertEqual(field['value'], mask)
            self.assertEqual(field['semantic']['tags'], labels)
            self.assertEqual(field['semantic']['unclassified'], mask == 0xffffffff)

    def test_model_flag_is_bit_not_whole_integer(self):
        for flags, expected in [(0, False), (1, True), (2, False), (3, True)]:
            body = bytearray(object_())
            struct.pack_into('<I', body, 1, flags)
            report = module.inspect(file_(bytes(body)), {123: False})
            field = next(f for f in report['fields'] if f['path'] == 'root.flags')
            self.assertEqual(field['value'], flags)
            self.assertEqual(field['semantic']['reverseTransmitPoint'], expected)

    def test_light_typed_fields_and_runtime_addresses(self):
        block = bytearray(184)
        struct.pack_into('<I', block, 0, 0)
        struct.pack_into('<2f', block, 24, 350, 120)
        struct.pack_into('<I', block, 92, 256)
        struct.pack_into('<Q', block, 108, 0x7ff812345678)
        decoded = module.light_parameters(bytes(block))
        values = {f['name']: f['value'] for f in decoded['fields']}
        self.assertEqual(values['radius'], 350)
        self.assertEqual(values['innerRadius'], 120)
        self.assertEqual(values['shadowTextureSize'], 256)
        self.assertEqual(values['materialAddress'], '0x00007ff812345678')
        self.assertTrue(any(r['offset'] == 32 and r['bytes'] == 48 for r in decoded['unresolved']))
        with self.assertRaises(ValueError): module.light_parameters(bytes(183))

    def test_bounded_ground_lzma_decode(self):
        grid = bytes([0, 64, 128, 255])
        filters = [{'id': lzma.FILTER_LZMA1, 'dict_size': 4096, 'lc': 3, 'lp': 0, 'pb': 2}]
        packed = lzma.compress(grid, format=lzma.FORMAT_RAW, filters=filters)
        properties = bytes([93])+I(4096)
        self.assertEqual(module.decode_ground_grid(properties, packed, 4), grid)
        with self.assertRaises(ValueError): module.decode_ground_grid(properties, packed, 3)
        with self.assertRaises(ValueError): module.decode_ground_grid(properties, packed, 5)
        with self.assertRaises(ValueError): module.decode_ground_grid(bytes([255])+I(4096), packed, 4)
        with self.assertRaises(ValueError): module.decode_ground_grid(bytes([93])+I(2**31), packed, 4)
        with self.assertRaises(ValueError): module.decode_ground_grid(properties, packed, 1_048_576)

    def test_all_node_types_and_contiguous_offsets(self):
        light = bytes([4])+H(231)+I(0)+I(9)+bytes(184)+b'\0\0'+H(0)+TRANSFORM
        children = [object_(kind) for kind in (0, 2, 3)]
        children += [bytes([1])+I(3)+H(8)+H(11)+H(0)+TRANSFORM,
                     bytes([9])+I(4)+H(8)+H(11)+bytes([2])+H(0)+TRANSFORM, light]
        children += [bytes([kind])+H(0)+H(0) for kind in (5, 6, 7)]
        raw = file_(object_(8, children=children))
        result = module.inspect(raw, {123: False})
        self.assertEqual(result['nodeCount'], 10)
        offset = 0
        for field in result['fields']:
            self.assertEqual(field['offset'], offset)
            offset += field['bytes']
        self.assertEqual(offset, len(raw))
        self.assertEqual(next(f['bytes'] for f in result['fields'] if f['type']=='opaque-sdk-block'), 184)

    def test_nonuniform_requires_resource_rule(self):
        data = file_(object_(nonuniform=True))
        with self.assertRaises(ValueError): module.inspect(data, {})
        result = module.inspect(data, {123: True})
        self.assertEqual(next(f['value'] for f in result['fields'] if f['path']=='root.transform.sy'), 2)
        with self.assertRaises(ValueError): module.inspect(data, {123: False})

    def test_global_nonempty_blocks_do_not_use_fixed_offset(self):
        prefix = bytes([1])+I(7)+struct.pack('<8f', *([1]*8))+I(9)+bytes([1])+I(8)
        ground = I(2)+I(3)+I(1)+I(1)+struct.pack('<10f', *([0]*10))
        for i in range(3): ground += I(1)+I(4)+I(i)+I(2)+bytes(5)+b'ab'
        foliage = I(1)+I(1)+I(1)+bytes([1])+I(2)+struct.pack('<10f', *([0]*10))+bytes(320)+bytes([0, 15])
        raw = file_(bytes([5])+H(0)+H(1)+TRANSFORM+object_(), prefix+ground+foliage)
        result = module.inspect(raw, {123: False})
        self.assertEqual(result['rootOffset'], 550)
        self.assertEqual(result['nodeCount'], 2)

    def test_malformed_lengths_and_checksums(self):
        good = file_(object_())
        with self.assertRaises(ValueError): module.inspect(good[:-1], {123: False})
        with self.assertRaises(ValueError): module.inspect(file_(object_()+b'extra'), {123: False})
        light = bytes([4])+H(232)+I(0)+I(9)+bytes(184)+b'\0\0'+H(0)+TRANSFORM
        with self.assertRaises(ValueError): module.inspect(file_(light), {123: False})

    def test_unknown_and_nonfinite_fields(self):
        with self.assertRaises(ValueError): module.inspect(file_(b'\x0a'), {})
        bad = object_()[:17]+struct.pack('<f', float('nan'))+object_()[21:]
        with self.assertRaises(ValueError): module.inspect(file_(bad), {123: False})


if __name__ == '__main__': unittest.main()
