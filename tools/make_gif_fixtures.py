"""Generate tiny, distinct animation frames for deterministic input regression."""
from pathlib import Path
import struct
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1] / 'tests/fixtures'
palette = [0, 0, 0, 232, 62, 65, 45, 150, 85, 55, 95, 225] + [0] * (768 - 12)
first = Image.new('P', (32, 24), 0)
first.putpalette(palette)
draw = ImageDraw.Draw(first)
draw.rectangle((3, 3, 13, 20), fill=1)
draw.rectangle((17, 8, 28, 20), fill=2)
second = Image.new('P', first.size, 3)
second.putpalette(palette)
first.save(root/'first-frame.gif', save_all=True, append_images=[second], duration=[80, 80], loop=0,
           transparency=0, disposal=2, optimize=False, interlace=True)
with Image.open(root/'first-frame.gif') as saved:
    saved.seek(0)
    saved.convert('RGBA').save(root/'first-frame.png')

# Keep the source LZW stream, but place it inside a larger logical screen with a local palette.
data = (root/'first-frame.gif').read_bytes()
table_size = 3 * 2 ** ((data[10] & 7) + 1)
head_end = 13 + table_size
p = head_end
gce = b''
while data[p] == 0x21:
    start, label = p, data[p + 1]
    p += 2
    while data[p]:
        p += 1 + data[p]
    p += 1
    if label == 0xf9:
        gce = data[start:p]
assert data[p] == 0x2c
descriptor = bytearray(data[p:p + 10])
descriptor[1:5] = struct.pack('<HH', 4, 3)
descriptor[9] = (descriptor[9] & 0x78) | 0x80 | (data[10] & 7)
end = p + 11
while data[end]:
    end += 1 + data[end]
end += 1
header = bytearray(data[:13])
header[6:10] = struct.pack('<HH', 40, 32)
header[10] &= 0x7f
local = bytes(header) + gce + bytes(descriptor) + data[13:head_end] + data[p + 10:end] + b'\x3b'
(root/'first-frame-local.gif').write_bytes(local)
with Image.open(root/'first-frame-local.gif') as picture:
    picture.convert('RGBA').save(root/'first-frame-local.png')
print('GIF first-frame, transparency, offset and local palette fixtures generated')
