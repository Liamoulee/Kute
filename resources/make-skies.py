# Builds the custom sky presets in resources/skies (compiled into the exe by src/modules/skybox.rs).
# Krunker's dome is an equirectangular sphere: top row = zenith, middle = horizon, bottom half below the ground.
# Everything tiles horizontally, and small shapes get wider towards the zenith so the pole does not smear them.
#   python resources/make-skies.py
import math
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

W, H = 2048, 1024
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "skies")
rng = np.random.default_rng(1337)


def hex_rgb(value):
    value = value.lstrip("#")
    return np.array([int(value[i:i + 2], 16) for i in (0, 2, 4)], dtype=np.float32)


def gradient(stops):
    """stops: (0..1 from zenith to horizon, color). below the horizon repeats the horizon color, darker"""
    img = np.zeros((H, W, 3), np.float32)
    ys = np.clip(np.arange(H) / (H / 2), 0, 1)
    positions = [s[0] for s in stops]
    colors = np.array([hex_rgb(s[1]) for s in stops])
    for c in range(3):
        img[:, :, c] = np.interp(ys, positions, colors[:, c])[:, None]
    img[H // 2:] *= 0.55
    return img


def periodic_noise(beta, seed, largest=300, stretch=1.0):
    """fbm-like noise, periodic in both directions, 0..1. largest: biggest feature in px, stretch > 1 widens"""
    local = np.random.default_rng(seed)
    white = local.standard_normal((H, W))
    fy = np.fft.fftfreq(H)[:, None]
    fx = np.fft.fftfreq(W)[None, :] * stretch
    freq = np.sqrt(fx * fx + fy * fy)
    freq[0, 0] = 1
    # without the cut the few lowest frequencies make screen sized blobs
    cut = 1 - np.exp(-((freq * largest) ** 2))
    noise = np.real(np.fft.ifft2(np.fft.fft2(white) * cut / freq ** beta))
    noise -= noise.min()
    return noise / noise.max()


def sky_mask(fade_top=0.08):
    """1 in the sky, fading out at the zenith (pole smear) and below the horizon"""
    y = np.arange(H)[:, None] / (H / 2)
    top = np.clip(y / fade_top, 0, 1) if fade_top > 0 else np.ones_like(y)
    bottom = np.clip((1.02 - y) / 0.06, 0, 1)
    return (top * bottom).astype(np.float32)


def stars(img, count, max_radius, colored=False, top_bias=1.5):
    layer = Image.new("L", (W, H), 0)
    tint = Image.new("RGB", (W, H), (0, 0, 0))
    draw = ImageDraw.Draw(layer)
    tdraw = ImageDraw.Draw(tint)
    for _ in range(count):
        # more stars high up
        y = int((rng.random() ** top_bias) * H * 0.49) + int(H * 0.02)
        x = int(rng.random() * W)
        theta = math.pi * y / H
        stretch = 1 / max(math.sin(theta), 0.08)
        r = max(0.6, rng.random() ** 3 * max_radius)
        bright = int(120 + rng.random() * 135)
        for dx in (-W, 0, W):
            box = [x + dx - r * stretch, y - r, x + dx + r * stretch, y + r]
            draw.ellipse(box, fill=bright)
            if colored:
                tone = [(255, 220, 190), (190, 210, 255), (255, 255, 255), (255, 190, 230)][int(rng.random() * 4)]
                tdraw.ellipse(box, fill=tone)
    glow = layer.filter(ImageFilter.GaussianBlur(2.2))
    core = np.asarray(layer, np.float32) / 255
    halo = np.asarray(glow, np.float32) / 255
    color = np.asarray(tint, np.float32) if colored else np.full((H, W, 3), 255, np.float32)
    amount = np.clip(core + halo * 0.8, 0, 1)[:, :, None] * sky_mask(0.0)[:, :, None]
    return img * (1 - amount) + color * amount


def blend(img, color, amount):
    amount = np.clip(amount, 0, 1)[:, :, None]
    return img * (1 - amount) + hex_rgb(color) * amount


def glow(cx, cy, radius_x, radius_y):
    y, x = np.mgrid[0:H, 0:W]
    dx = np.minimum(np.abs(x - cx), W - np.abs(x - cx))
    return np.exp(-((dx / radius_x) ** 2 + ((y - cy) / radius_y) ** 2))


def save(img, name):
    os.makedirs(OUT, exist_ok=True)
    Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save(os.path.join(OUT, f"{name}.jpg"), quality=88, optimize=True)
    print(name, os.path.getsize(os.path.join(OUT, f"{name}.jpg")) // 1024, "KB")


def starfield():
    img = gradient([(0, "#01020a"), (0.6, "#0a1233"), (1, "#23346b")])
    # milky way: a soft band across the sky
    y, x = np.mgrid[0:H, 0:W]
    band_y = H * 0.24 + np.sin(x / W * 2 * math.pi) * H * 0.12
    band = np.exp(-((y - band_y) / (H * 0.07)) ** 2) * periodic_noise(1.6, 3) ** 1.5 * sky_mask(0.1)
    img = blend(img, "#8a7fc2", band * 0.55)
    img = stars(img, 5000, 1.3, colored=True)
    img = stars(img, 250, 2.6, colored=True)
    save(img, "starfield")


def sunset():
    img = gradient([(0, "#1d1446"), (0.45, "#6a2c70"), (0.75, "#e2566e"), (0.92, "#ff9a5a"), (1, "#ffd27a")])
    img = blend(img, "#fff1b8", glow(W * 0.5, H * 0.49, W * 0.05, H * 0.035) * 1.0)
    img = blend(img, "#ffb46b", glow(W * 0.5, H * 0.47, W * 0.22, H * 0.12) * 0.6)
    clouds = periodic_noise(1.7, 7, largest=160, stretch=5)
    y = np.arange(H)[:, None] / (H / 2)
    streaks = np.clip((clouds - 0.52) * 4, 0, 1) * np.exp(-((y - 0.78) / 0.12) ** 2) * sky_mask()
    img = blend(img, "#4a2150", streaks * 0.7)
    img = blend(img, "#ffb070", np.clip((clouds - 0.6) * 5, 0, 1) * np.exp(-((y - 0.86) / 0.06) ** 2) * sky_mask() * 0.5)
    img = stars(img, 600, 1.0, top_bias=0.6)
    save(img, "sunset")


def aurora():
    img = gradient([(0, "#010308"), (0.7, "#04101f"), (1, "#0b2233")])
    img = stars(img, 2500, 1.2)
    y, x = np.mgrid[0:H, 0:W]
    phase = x / W * 2 * math.pi
    wobble = periodic_noise(1.8, 5, largest=500, stretch=3)
    for i, (edge, top, base, amp, strength) in enumerate([("#3dffb0", "#7a4dff", 0.72, 0.07, 0.9), ("#35e0e8", "#b05cff", 0.6, 0.06, 0.55)]):
        line = (base + amp * np.sin(phase * (2 + i) + i * 2.1) + 0.05 * (wobble - 0.5)) * (H / 2)
        d = y - line
        # bright lower edge, rays rising from it and fading
        lower = np.exp(-np.clip(d, 0, None) / (H * 0.008)) * (d > -1)
        rise = np.exp(-np.clip(-d, 0, None) / (H * 0.14)) * (d <= 0)
        rays = 0.15 + 0.85 * periodic_noise(1.1, 30 + i, largest=30, stretch=0.05) ** 1.8
        shape = (lower + rise * rays) * sky_mask()
        mix = np.clip(-d / (H * 0.12), 0, 1)[:, :, None]
        color = hex_rgb(edge) * (1 - mix) + hex_rgb(top) * mix
        amount = np.clip(shape * strength, 0, 1)[:, :, None]
        img = img * (1 - amount) + color * amount
    save(img, "aurora")


def synthwave():
    img = gradient([(0, "#0d0221"), (0.5, "#2a0a4a"), (0.85, "#b0247d"), (1, "#ff4f9a")])
    y, x = np.mgrid[0:H, 0:W]
    cx, cy, r = W * 0.5, H * 0.5, H * 0.16
    dx = np.minimum(np.abs(x - cx), W - np.abs(x - cx)) * (H / W) * 2
    inside = (dx ** 2 + (y - cy) ** 2) < r ** 2
    t = np.clip((y - (cy - r)) / r, 0, 1)
    sun = np.zeros((H, W, 3), np.float32)
    top, bottom = hex_rgb("#ffe066"), hex_rgb("#ff3d8b")
    for c in range(3):
        sun[:, :, c] = top[c] * (1 - t) + bottom[c] * t
    # the classic cuts, wider towards the horizon
    rel = (y - (cy - r)) / r
    cuts = (rel > 0.35) & (np.mod(y - (cy - r * 0.65), r * 0.12) < (rel - 0.3) * r * 0.1)
    mask = (inside & ~cuts & (y < cy)).astype(np.float32)
    mask = np.asarray(Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2)), np.float32) / 255
    img = img * (1 - mask[:, :, None]) + sun * mask[:, :, None]
    img = blend(img, "#ff4f9a", glow(cx, cy, W * 0.12, H * 0.1) * 0.35 * (1 - mask))
    img = stars(img, 1500, 1.1, top_bias=1.2)
    save(img, "synthwave")


def nebula():
    img = gradient([(0, "#03020a"), (1, "#0b0a1f")])
    mask = sky_mask(0.12)
    for color, seed, strength in [("#6b2cff", 11, 0.8), ("#ff3fa4", 12, 0.6), ("#35e0e8", 13, 0.55)]:
        cloud = np.clip((periodic_noise(2.0, seed, largest=480) - 0.5) * 2.8, 0, 1) ** 1.4
        img = blend(img, color, cloud * mask * strength)
    img = stars(img, 4000, 1.2, colored=True)
    img = stars(img, 150, 2.4, colored=True)
    save(img, "nebula")


def candy():
    img = gradient([(0, "#7fb2ff"), (0.6, "#c7b7ff"), (1, "#ffc6e5")])
    clouds = periodic_noise(1.9, 21, largest=220, stretch=2.5)
    y = np.arange(H)[:, None] / (H / 2)
    puff = np.clip((clouds - 0.5) * 3.5, 0, 1) * np.clip(1.4 - y, 0, 1) * sky_mask()
    shade = np.clip((clouds - 0.64) * 5, 0, 1) * sky_mask()
    img = blend(img, "#ffffff", puff * 0.9)
    img = blend(img, "#ffd9ef", shade * 0.5)
    save(img, "candy")


for preset in (starfield, sunset, aurora, synthwave, nebula, candy):
    preset()
