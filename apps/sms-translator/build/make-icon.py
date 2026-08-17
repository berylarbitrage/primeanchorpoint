#!/usr/bin/env python3
"""
Generate build/icon.ico (and icon.png) for the Windows build.

Written in pure Python — no Pillow — so the icon can be regenerated anywhere
the repo is checked out, including CI images without imaging libraries. Shapes
are rendered 4x oversampled and box-downsampled for antialiasing.

Usage:  python3 build/make-icon.py
"""
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
SIZES = [256, 128, 64, 48, 32, 16]
SS = 4  # supersampling factor

BG_TOP = (0x63, 0xAA, 0xFF)
BG_BOTTOM = (0x2B, 0x63, 0xC4)
BUBBLE = (0xFF, 0xFF, 0xFF)
BAR = (0x2F, 0x6F, 0xD0)


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def rounded_rect(x, y, x0, y0, x1, y1, r):
    """True when (x, y) is inside the rounded rectangle."""
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def in_triangle(px, py, a, b, c):
    def sign(p1, p2, p3):
        return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])

    d1 = sign((px, py), a, b)
    d2 = sign((px, py), b, c)
    d3 = sign((px, py), c, a)
    has_neg = d1 < 0 or d2 < 0 or d3 < 0
    has_pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (has_neg and has_pos)


def sample(x, y, n):
    """Return (r, g, b, a) for a point in an n x n canvas, or None for empty."""
    u, v = x / n, y / n

    # App tile: rounded square filling the canvas with a small margin.
    m = 0.045
    if not rounded_rect(u, v, m, m, 1 - m, 1 - m, 0.22):
        return None

    base = lerp(BG_TOP, BG_BOTTOM, v)

    # Speech bubble body.
    bx0, by0, bx1, by1 = 0.20, 0.235, 0.80, 0.645
    tail = ((0.335, by1 - 0.005), (0.50, by1 - 0.005), (0.355, 0.815))
    if rounded_rect(u, v, bx0, by0, bx1, by1, 0.115) or in_triangle(u, v, *tail):
        # Two text bars inside the bubble.
        if rounded_rect(u, v, 0.295, 0.345, 0.705, 0.415, 0.035):
            return BAR + (255,)
        if rounded_rect(u, v, 0.295, 0.465, 0.565, 0.535, 0.035):
            return BAR + (255,)
        return BUBBLE + (255,)

    return base + (255,)


def render(size):
    n = size * SS
    out = bytearray(size * size * 4)
    for py in range(size):
        for px in range(size):
            r = g = b = a = 0
            for sy in range(SS):
                for sx in range(SS):
                    got = sample(px * SS + sx + 0.5, py * SS + sy + 0.5, n)
                    if got:
                        r += got[0]
                        g += got[1]
                        b += got[2]
                        a += got[3]
            total = SS * SS
            idx = (py * size + px) * 4
            covered = a // 255  # samples that landed inside the shape
            if covered:
                # Average colour over covered samples only, so edge pixels keep
                # their hue instead of being darkened toward transparent black.
                out[idx] = r // covered
                out[idx + 1] = g // covered
                out[idx + 2] = b // covered
                out[idx + 3] = a // total
            else:
                out[idx : idx + 4] = b"\0\0\0\0"
    return bytes(out)


def png_chunk(tag, data):
    body = tag + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def to_png(rgba, size):
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)  # filter type: none
        raw += rgba[y * stride : (y + 1) * stride]
    return (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + png_chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + png_chunk(b"IEND", b"")
    )


def to_ico(pngs):
    """ICO with PNG-compressed entries (supported by Windows Vista and later)."""
    count = len(pngs)
    header = struct.pack("<HHH", 0, 1, count)
    offset = 6 + 16 * count
    entries, blobs = b"", b""
    for size, blob in pngs:
        entries += struct.pack(
            "<BBBBHHII",
            0 if size >= 256 else size,
            0 if size >= 256 else size,
            0,
            0,
            1,
            32,
            len(blob),
            offset,
        )
        blobs += blob
        offset += len(blob)
    return header + entries + blobs


def main():
    pngs = []
    for size in SIZES:
        rgba = render(size)
        blob = to_png(rgba, size)
        pngs.append((size, blob))
        if size == 256:
            with open(os.path.join(HERE, "icon.png"), "wb") as f:
                f.write(blob)
        print(f"rendered {size}x{size} ({len(blob)} bytes)")

    with open(os.path.join(HERE, "icon.ico"), "wb") as f:
        f.write(to_ico(pngs))
    print("wrote icon.ico and icon.png")


if __name__ == "__main__":
    main()
