"""Generate neutral input-format fixtures without changing the page examples."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1] / 'tests/fixtures'
root.mkdir(exist_ok=True)
picture = Image.new('RGB', (32, 32), '#faf4e3')
draw = ImageDraw.Draw(picture)
draw.rectangle((15, 12, 17, 27), fill='#527854')
draw.polygon([(16, 22), (9, 18), (9, 23), (16, 26)], fill='#7b995e')
draw.polygon([(17, 17), (23, 14), (23, 19), (17, 22)], fill='#7b995e')
for box in [(12, 3, 20, 7), (8, 7, 13, 14), (19, 7, 24, 14), (12, 13, 20, 17)]:
    draw.rectangle(box, fill='#ce7183')
draw.rectangle((12, 7, 20, 13), fill='#e5a38f')
draw.rectangle((14, 8, 18, 12), fill='#e7b756')
draw.rectangle((10, 27, 22, 29), fill='#8ba7a1')
picture.save(root / 'rgb.jpg')
picture.convert('RGBA').save(root / 'alpha.webp', lossless=True)
exif = Image.Exif()
exif[274] = 6
picture.crop((0, 0, 32, 16)).save(root / 'rotated.jpg', exif=exif)
print('Generated JPG, WebP and rotated input fixtures')
