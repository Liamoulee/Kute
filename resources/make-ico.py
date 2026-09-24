#!/usr/bin/env python3
# builds resources/kute.ico, run from the repo root: python resources/make-ico.py (needs Pillow)
# small sizes from lowres.png, big ones from icon.png (the detailed logo is mush below 40 px)

import struct
from io import BytesIO
from PIL import Image

LOW_RES = "resources/lowres.png"
DETAILED = "resources/icon.png"
OUT = "resources/kute.ico"

# simplified art up to and including this size
LOW_RES_MAX = 32
SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]


def square(path):
    image = Image.open(path).convert("RGBA")
    box = image.getchannel("A").point(lambda alpha: 255 if alpha > 8 else 0).getbbox()
    image = image.crop(box)
    side = max(image.size)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.alpha_composite(image, ((side - image.width) // 2, (side - image.height) // 2))
    return canvas


def dib(image):
    """32 bit icon bitmap: header with doubled height, bottom-up BGRA rows, unused 1 bit mask."""
    size = image.width
    header = struct.pack("<IiiHHIIiiII", 40, size, size * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    blue, green, red, alpha = image.split()[2], image.split()[1], image.split()[0], image.split()[3]
    rows = Image.merge("RGBA", (blue, green, red, alpha)).transpose(Image.FLIP_TOP_BOTTOM).tobytes()
    mask_row = ((size + 31) // 32) * 4
    return header + rows + bytes(mask_row * size)


def png(image):
    buffer = BytesIO()
    image.save(buffer, "PNG", optimize=True)
    return buffer.getvalue()


def main():
    low, detailed = square(LOW_RES), square(DETAILED)
    images = []
    for size in SIZES:
        source = low if size <= LOW_RES_MAX else detailed
        scaled = source.resize((size, size), Image.LANCZOS)
        # windows expects PNG for 256, bitmaps for the rest
        images.append((size, png(scaled) if size == 256 else dib(scaled)))

    offset = 6 + 16 * len(images)
    directory = b""
    for size, data in images:
        directory += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    with open(OUT, "wb") as file:
        file.write(struct.pack("<HHH", 0, 1, len(images)) + directory + b"".join(data for _, data in images))
    print(OUT, offset, "bytes:", ", ".join(f"{size} ({'low res' if size <= LOW_RES_MAX else 'detailed'})" for size, _ in images))


main()
