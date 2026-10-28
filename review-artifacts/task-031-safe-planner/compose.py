"""Labeled contact sheet made only from actual integrated app captures."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parent
font = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 26)
small = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 19)
sheet = Image.new('RGB', (1820, 990), '#eaf0f4')
draw = ImageDraw.Draw(sheet)
draw.text((24, 16), 'ChronaSense | Integrated planning modal', font=font, fill='#132735')
draw.text((24, 52), 'Actual local application | Synthetic data | TASK-031 safe combined candidate', font=small, fill='#455b69')
draw.text((24, 94), 'Laptop 1366 x 768', font=small, fill='#132735')
draw.text((1410, 94), 'Phone 390 x 844', font=small, fill='#132735')
sheet.paste(Image.open(root / 'screenshots/integrated-planner-laptop.png').convert('RGB'), (24, 128))
sheet.paste(Image.open(root / 'screenshots/integrated-planner-mobile.png').convert('RGB'), (1410, 128))
sheet.save(root / 'integrated-review.png')
print('Created integrated-review.png from actual application screenshots')
