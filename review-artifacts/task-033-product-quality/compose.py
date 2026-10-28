"""Labeled comparison sheets made only from actual, unretouched app captures."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
FONT = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 22)
SMALL = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 17)
BG = '#11151b'

def pair(name, width):
    images = []
    for phase in ('before', 'after'):
        shot = Image.open(HERE / phase / f'{name}.png').convert('RGB')
        shot = shot.resize((width, round(shot.height * width / shot.width)), Image.Resampling.LANCZOS)
        images.append(shot)
    sheet = Image.new('RGB', (width * 2 + 60, max(i.height for i in images) + 95), BG)
    draw = ImageDraw.Draw(sheet)
    draw.text((20, 12), f'{name.replace("-", " ").title()}  |  Actual local app · synthetic data', font=SMALL, fill='#b5c2d4')
    for index, (phase, shot) in enumerate(zip(('BEFORE · d7e01d0', 'AFTER · TASK-033'), images)):
        x = 20 + index * (width + 20)
        draw.text((x, 42), phase, font=FONT, fill='white')
        sheet.paste(shot, (x, 80))
    sheet.save(HERE / f'{name}-before-after.png')
    return sheet

for name, width in [('my-day-laptop', 1000), ('planner-laptop', 1000), ('my-day-mobile', 390), ('planner-mobile', 390), ('my-day-mobile-detail', 390)]:
    pair(name, width)

# One sharing sheet: the laptop and phone comparisons remain available separately at larger size.
rows = []
for title in ('my-day', 'planner'):
    row = Image.new('RGB', (1880, 650), BG)
    draw = ImageDraw.Draw(row)
    for index, (phase, device, width) in enumerate([('before','laptop',620), ('after','laptop',620), ('before','mobile',260), ('after','mobile',260)]):
        x = [20,660,1300,1580][index]
        draw.text((x,15), f'{title.title()} · {phase}', font=SMALL, fill='white')
        shot = Image.open(HERE / phase / f'{title}-{device}.png').convert('RGB')
        shot = shot.resize((width, round(shot.height * width / shot.width)), Image.Resampling.LANCZOS)
        row.paste(shot,(x,50))
    rows.append(row)
combined = Image.new('RGB',(1880,1325),BG)
combined.paste(rows[0],(0,0)); combined.paste(rows[1],(0,650))
ImageDraw.Draw(combined).text((20,1300),'Raw 1920px / 1366px / 390px captures are in before/ and after/. No generated mockups.',font=SMALL,fill='#b5c2d4')
combined.save(HERE/'review-contact-sheet.png')
