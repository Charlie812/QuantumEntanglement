#!/usr/bin/env python3
"""產生量子糾纏 PWA icons (192/512/180 sizes)。"""

from PIL import Image, ImageDraw, ImageFilter
import os

OUT_DIR = os.path.dirname(os.path.abspath(__file__))

BG_TOP    = (10, 10, 22)        # #0a0a16
BG_BOT    = (28, 18, 48)        # #1c1230
C_CHARLIE = (0, 229, 255)       # cyan
C_WEIXIAN = (255, 94, 196)      # pink

def vert_gradient(size, top, bot):
    img = Image.new("RGB", (size, size), top)
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / (size - 1)
        r = int(top[0] + (bot[0] - top[0]) * t)
        g = int(top[1] + (bot[1] - top[1]) * t)
        b = int(top[2] + (bot[2] - top[2]) * t)
        d.line([(0, y), (size, y)], fill=(r, g, b))
    return img

def glow_circle(size, center, radius, color, glow_radius_multiplier=2.2):
    """Returns an RGBA layer with a glowing circle."""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # Outer glow halo (semi transparent, larger)
    glow_r = int(radius * glow_radius_multiplier)
    halo = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    hd = ImageDraw.Draw(halo)
    hd.ellipse(
        (center[0] - glow_r, center[1] - glow_r,
         center[0] + glow_r, center[1] + glow_r),
        fill=color + (110,),
    )
    halo = halo.filter(ImageFilter.GaussianBlur(radius=glow_r * 0.4))
    layer = Image.alpha_composite(layer, halo)
    # Bright core
    cd = ImageDraw.Draw(layer)
    cd.ellipse(
        (center[0] - radius, center[1] - radius,
         center[0] + radius, center[1] + radius),
        fill=color + (255,),
    )
    # Inner highlight
    hi_r = int(radius * 0.55)
    hi_off = int(radius * 0.25)
    cd.ellipse(
        (center[0] - hi_r - hi_off, center[1] - hi_r - hi_off,
         center[0] + hi_r - hi_off, center[1] + hi_r - hi_off),
        fill=(255, 255, 255, 90),
    )
    return layer

def connection_line(size, p1, p2, c1, c2, thickness):
    """Faint glowing line gradient between two points."""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    steps = 80
    for i in range(steps):
        t = i / (steps - 1)
        x = int(p1[0] + (p2[0] - p1[0]) * t)
        y = int(p1[1] + (p2[1] - p1[1]) * t)
        r = int(c1[0] + (c2[0] - c1[0]) * t)
        g = int(c1[1] + (c2[1] - c1[1]) * t)
        b = int(c1[2] + (c2[2] - c1[2]) * t)
        alpha = 70 if (i % 6 < 4) else 0   # dashed feel
        d = ImageDraw.Draw(layer)
        d.ellipse((x - thickness, y - thickness, x + thickness, y + thickness),
                  fill=(r, g, b, alpha))
    layer = layer.filter(ImageFilter.GaussianBlur(radius=thickness * 0.5))
    return layer

def make_icon(size, maskable_safezone=0.82):
    # 1. background gradient
    img = vert_gradient(size, BG_TOP, BG_BOT).convert("RGBA")

    # 2. dim background swirl (large blurred gradient circles for atmosphere)
    atmo = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ad = ImageDraw.Draw(atmo)
    big = int(size * 0.55)
    ad.ellipse(
        (-big//3, -big//3, big, big),
        fill=C_CHARLIE + (40,),
    )
    ad.ellipse(
        (size - big, size - big, size + big//3, size + big//3),
        fill=C_WEIXIAN + (40,),
    )
    atmo = atmo.filter(ImageFilter.GaussianBlur(radius=size * 0.12))
    img = Image.alpha_composite(img, atmo)

    # 3. two entangled particles
    # Place them along a diagonal, within the safe zone for maskable icons
    s = size * maskable_safezone
    margin = (size - s) / 2
    # particle radius (smallish so glow is visible)
    pr = int(size * 0.13)
    p1 = (int(margin + s * 0.28), int(margin + s * 0.32))
    p2 = (int(margin + s * 0.72), int(margin + s * 0.68))

    # connection line first (under particles)
    line = connection_line(size, p1, p2, C_CHARLIE, C_WEIXIAN, thickness=int(size * 0.012))
    img = Image.alpha_composite(img, line)

    # particles
    img = Image.alpha_composite(img, glow_circle(size, p1, pr, C_CHARLIE))
    img = Image.alpha_composite(img, glow_circle(size, p2, pr, C_WEIXIAN))

    return img.convert("RGB")

def main():
    targets = [
        ("icon-512.png", 512),
        ("icon-192.png", 192),
        ("apple-touch-icon.png", 180),
    ]
    for fname, sz in targets:
        path = os.path.join(OUT_DIR, fname)
        img = make_icon(sz)
        img.save(path, "PNG", optimize=True)
        print(f"  wrote {fname} ({sz}x{sz})")

if __name__ == "__main__":
    main()
