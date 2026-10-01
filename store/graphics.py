"""Google Play graphics from the app's own icon (assets/): the 512 × 512
store icon and the 1024 × 500 feature graphic. Needs Pillow:
    python3 -m pip install pillow && python3 store/graphics.py
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).parent
ASSETS = HERE.parent / "assets"
NAVY = (20, 24, 31)
ORANGE = (255, 106, 19)
FONTS = "/usr/share/fonts/truetype"


def font(size, bold=True):
    for name in (["liberation/LiberationSans-Bold.ttf", "dejavu/DejaVuSans-Bold.ttf"] if bold else ["liberation/LiberationSans-Regular.ttf", "dejavu/DejaVuSans.ttf"]):
        try:
            return ImageFont.truetype(f"{FONTS}/{name}", size)
        except OSError:
            pass
    return ImageFont.load_default()


# The store icon: 32-bit PNG, 512 × 512.
Image.open(ASSETS / "icon-only.png").convert("RGBA").resize((512, 512), Image.LANCZOS).save(HERE / "icon-512.png")

# The feature graphic: the winding road on the right, the name and what it's for on the left.
W, H = 1024, 500
g = Image.new("RGB", (W, H), NAVY)
road = Image.open(ASSETS / "icon-foreground.png").convert("RGBA").resize((620, 620), Image.LANCZOS)
g.paste(road, (W - 560, (H - 620) // 2), road)
d = ImageDraw.Draw(g)
d.text((64, 150), "Ride Forge", font=font(92), fill=(244, 246, 248))
d.text((68, 262), "Motorcycle routes that find", font=font(36, bold=False), fill=(200, 206, 214))
d.text((68, 306), "the twisty way.", font=font(36), fill=ORANGE)
g.save(HERE / "feature-graphic.png")
print("store/icon-512.png, store/feature-graphic.png")
