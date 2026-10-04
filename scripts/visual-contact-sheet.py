"""Produce four labeled, inspectable sheets from actual browser screenshots."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import json

root = Path(__file__).resolve().parents[1]
source = root / 'artifacts' / 'visual'
font_path = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
font = ImageFont.truetype(font_path, 14)
small_font = ImageFont.truetype(font_path, 11)
columns, width, height = 6, 250, 242
for view in ('iso', 'top', 'front', 'right'):
    images = sorted(path for path in source.glob(f'*-{view}.png') if not path.name.startswith('contact-sheet'))
    if not images:
        continue
    sheet = Image.new('RGB', (columns * width, ((len(images) + columns - 1) // columns) * height + 66), '#e8edf3')
    draw = ImageDraw.Draw(sheet)
    title = 'isometric' if view == 'iso' else view
    draw.text((18, 15), f'build123d-fiber · {len(images)} native OpenCascade fixtures · {title}', font=ImageFont.truetype(font_path, 22), fill='#253c53')
    draw.text((18, 44), 'Actual Chromium WebGL captures. Every case has four exact screenshot regression baselines.', font=small_font, fill='#65768a')
    for index, path in enumerate(images):
        x, y = index % columns * width, index // columns * height + 66
        image = Image.open(path).convert('RGB')
        image.thumbnail((width - 12, height - 39), Image.Resampling.LANCZOS)
        sheet.paste(image, (x + (width - image.width) // 2, y + 4))
        name = path.stem[:-(len(view) + 1)]
        draw.text((x + 8, y + height - 30), name, font=font, fill='#253c53')
        data_path = source / f'{name}.geometry.json'
        if data_path.exists():
            geometry = json.loads(data_path.read_text())
            volume = sum(mesh['volume'] for mesh in geometry['meshes'])
            draw.text((x + 8, y + height - 12), f"{len(geometry['meshes'])} shape(s)  ·  {volume:.1f} mm³", font=small_font, fill='#65768a')
    sheet.save(source / f'contact-sheet-{view}.png')
    if view == 'iso':
        sheet.save(source / 'contact-sheet.png')
        (root / 'docs').mkdir(exist_ok=True)
        sheet.save(root / 'docs' / 'visual-baseline.png')
    print(f'Visual contact sheet: {source / f"contact-sheet-{view}.png"}')
