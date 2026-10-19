#!/usr/bin/env python3
"""Compose HD listing images from real screenshots. Requires Pillow 12+.

Run from any directory. Optional: LISTING_FONT and LISTING_FONT_BOLD font paths.
Screenshots are cropped and scaled down only. UI pixels are never redrawn.
"""
import json
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
WIDTH, HEIGHT = 1920, 1080


def font(size, bold=False):
    custom = os.environ.get('LISTING_FONT_BOLD' if bold else 'LISTING_FONT')
    candidates = [
        (custom, 0),
        ('/System/Library/Fonts/Supplemental/Galvji.ttc', int(bold)),
        ('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' if bold else
         '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 0),
    ]
    for path, index in candidates:
        if path and Path(path).is_file():
            return ImageFont.truetype(path, size, index=index)
    raise RuntimeError('Set LISTING_FONT and LISTING_FONT_BOLD to installed TrueType fonts')


def text(canvas, value, xy, size, color, bold=False, spacing=12, max_width=680):
    # Supersample typography only, leaving screenshot pixels on their own layer.
    layer = Image.new('RGBA', (WIDTH * 2, HEIGHT * 2))
    draw = ImageDraw.Draw(layer)
    face = font(size * 2, bold)
    for line in value.splitlines():
        assert draw.textlength(line, font=face) <= max_width * 2, line
    for row, line in enumerate(value.splitlines()):
        draw.text((xy[0] * 2, (xy[1] + row * (size + spacing)) * 2),
                  line, font=face, fill=color, anchor='lt')
    canvas.alpha_composite(layer.resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS))


def screenshot(canvas, page, box):
    source = Image.open(ROOT / 'assets' / page['source']).convert('RGBA')
    crop = page['crop']
    assert 0 <= crop[0] < crop[2] <= source.width
    assert 0 <= crop[1] < crop[3] <= source.height
    source = source.crop(crop)
    original = source.size
    source.thumbnail((box[2], box[3]), Image.Resampling.LANCZOS)
    assert source.width <= original[0] and source.height <= original[1]
    x = box[0] + (box[2] - source.width) // 2
    y = box[1] + (box[3] - source.height) // 2
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle((x - 2, y - 2, x + source.width + 2, y + source.height + 2),
                           radius=3, fill='#cbd3d0')
    canvas.alpha_composite(source, (x, y))
    print(f"{page['output']}: source crop {original}, placed {source.size} at {(x, y)}")


def main():
    config = json.loads((ROOT / 'assets/listing/layout.json').read_text())
    for page in config['pages']:
        canvas = Image.new('RGBA', (WIDTH, HEIGHT), config['background'])
        wide = page.get('wide', False)
        if wide:
            text(canvas, config['name'] + ' for Paseo', (80, 46), 25, config['accent'])
            text(canvas, page['title'], (80, 112), 54, config['ink'], True, max_width=1760)
            screenshot(canvas, page, (80, 214, 1760, 800))
        else:
            text(canvas, config['name'], (80, 82), 28, config['accent'], True)
            text(canvas, 'A plugin for Paseo', (80, 127), 23, config['muted'])
            text(canvas, page['title'], (80, 225), page.get('titleSize', 70), config['ink'], True, 16)
            text(canvas, page['body'], (80, 585), 27, config['muted'], spacing=16)
            if page.get('detail'):
                text(canvas, page['detail'], (80, 828), 23, config['accent'], spacing=14)
            screenshot(canvas, page, (820, 76, 1020, 910))
        text(canvas, page['caption'], (80, 1022), 20, config['muted'], max_width=1760)
        target = ROOT / 'assets/listing' / page['output']
        canvas.convert('RGB').save(target, optimize=True, dpi=(144, 144))
        with Image.open(target) as check:
            assert check.size == (WIDTH, HEIGHT) and check.format == 'PNG'


if __name__ == '__main__':
    main()
