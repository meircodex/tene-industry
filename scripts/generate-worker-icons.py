"""Render IronBend's worker scanner icon. Requires Pillow for asset authoring only."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1] / 'public'

def render(size):
    scale = 4
    image = Image.new('RGB', (size * scale, size * scale), '#f56810')
    draw = ImageDraw.Draw(image)
    def box(bounds, fill, radius=0):
        coords = tuple(round(n * size * scale / 512) for n in bounds)
        draw.rounded_rectangle(coords, radius=round(radius * size * scale / 512), fill=fill)
    # All foreground geometry stays inside the central mask-safe circle.
    for x, y, dx, dy in [(112,112,1,1),(400,112,-1,1),(112,400,1,-1),(400,400,-1,-1)]:
        box(sorted_rect(x, y, x+dx*64, y+dy*18), 'white', 8)
        box(sorted_rect(x, y, x+dx*18, y+dy*64), 'white', 8)
    for x, y in [(164,164),(280,164),(164,280)]:
        box((x,y,x+68,y+68),'white',8)
        box((x+16,y+16,x+52,y+52),'#f56810',3)
        box((x+25,y+25,x+43,y+43),'white',2)
    for x,y,w,h in [(280,280,28,28),(320,280,28,68),(280,320,28,28)]:
        box((x,y,x+w,y+h),'white',3)
    return image.resize((size,size), Image.Resampling.LANCZOS)

def sorted_rect(x1,y1,x2,y2):
    return min(x1,x2),min(y1,y2),max(x1,x2),max(y1,y2)

if __name__ == '__main__':
    for size in (180,192,512):
        render(size).save(ROOT / f'worker-icon-{size}-v1.png', optimize=True)
