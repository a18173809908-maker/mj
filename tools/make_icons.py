# -*- coding: utf-8 -*-
"""
生成应用图标（纯标准库，不依赖 Pillow）。
图形：墨绿圆角方块 + 白色「¥」符号，4x 超采样抗锯齿。
输出：assets/icon-192.png、icon-512.png、icon-maskable-512.png
"""
import math
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets')


# ---------------------------------------------------------------- PNG 编码

def write_png(path, w, h, rows):
    """rows: list of bytearray，每行长度 w*4（RGBA）"""
    raw = b''.join(b'\x00' + bytes(r) for r in rows)

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data +
                struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))

    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    blob = (b'\x89PNG\r\n\x1a\n' +
            chunk(b'IHDR', ihdr) +
            chunk(b'IDAT', zlib.compress(raw, 9)) +
            chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(blob)


# ---------------------------------------------------------------- 几何工具

def seg_dist(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    l2 = dx * dx + dy * dy
    if l2 == 0:
        return math.hypot(px - x1, py - y1)
    t = ((px - x1) * dx + (py - y1) * dy) / l2
    t = 0.0 if t < 0 else (1.0 if t > 1 else t)
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


def in_round_rect(x, y, size, radius):
    if radius <= 0:
        return 0 <= x <= size and 0 <= y <= size
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    return math.hypot(x - cx, y - cy) <= radius


def lerp(a, b, t):
    return a + (b - a) * t


# ---------------------------------------------------------------- 图标绘制

def render(size, radius_ratio, glyph_scale, ss=4):
    """
    size        : 输出边长
    radius_ratio: 圆角占边长比例（maskable 传 0）
    glyph_scale : ¥ 符号缩放（安全区用 0.74）
    ss          : 超采样倍数
    """
    S = size * ss
    r = S * radius_ratio

    # 配色：左上偏亮 → 右下深，营造质感
    top = (0x1B, 0x6E, 0x52)
    bot = (0x07, 0x2A, 0x1E)
    white = (0xFF, 0xFF, 0xFF)

    # ¥ 符号几何（以 S 为边长的归一化坐标，再按 glyph_scale 缩放居中）
    def glyph_pts():
        g = glyph_scale
        cx, cy = S / 2.0, S / 2.0
        # 基准字形（在 0..512 空间设计），再映射到 S
        base = 512.0
        k = S * g / base

        def P(x, y):
            return (cx + (x - 256.0) * k, cy + (y - 256.0) * k)

        strokes = []
        # V 的两撇
        strokes.append((P(150, 108), P(256, 226)))
        strokes.append((P(362, 108), P(256, 226)))
        # 竖笔
        strokes.append((P(256, 226), P(256, 402)))
        # 两道横杠
        strokes.append((P(160, 246), P(352, 246)))
        strokes.append((P(160, 300), P(352, 300)))
        half_w = 25.0 * k          # 笔画半宽
        return strokes, half_w

    strokes, half_w = glyph_pts()

    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            acc_r = acc_g = acc_b = acc_a = 0.0
            for sy in range(ss):
                for sx in range(ss):
                    # 子像素中心
                    x = px * ss + sx + 0.5
                    y = py * ss + sy + 0.5
                    # 归一化到超采样画布
                    X = x * (S / (size * ss))
                    Y = y * (S / (size * ss))

                    if not in_round_rect(X, Y, S, r):
                        continue
                    t = (X / S + Y / S) / 2.0
                    col = (
                        lerp(top[0], bot[0], t),
                        lerp(top[1], bot[1], t),
                        lerp(top[2], bot[2], t),
                    )
                    # ¥ 覆盖
                    for (x1, y1), (x2, y2) in strokes:
                        if seg_dist(X, Y, x1, y1, x2, y2) <= half_w:
                            col = white
                            break
                    acc_r += col[0]
                    acc_g += col[1]
                    acc_b += col[2]
                    acc_a += 255.0

            n = float(ss * ss)
            if acc_a <= 0:
                row += bytes((0, 0, 0, 0))
            else:
                # 颜色按已覆盖子像素平均（避免边缘发灰），alpha 按比例
                cov = acc_a / 255.0
                row += bytes((
                    int(round(acc_r / cov)),
                    int(round(acc_g / cov)),
                    int(round(acc_b / cov)),
                    int(round(acc_a / n)),
                ))
        rows.append(row)
    return rows


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    jobs = [
        ('icon-192.png', 192, 0.22, 1.0, 4),
        ('icon-512.png', 512, 0.22, 1.0, 3),
        ('icon-maskable-512.png', 512, 0.0, 0.72, 3),
        ('apple-touch-icon.png', 180, 0.0, 0.94, 4),
    ]
    for name, size, rr, gs, ss in jobs:
        rows = render(size, rr, gs, ss)
        path = os.path.join(OUT_DIR, name)
        write_png(path, size, size, rows)
        print('generated %-26s %d x %d  (%d bytes)' % (name, size, size, os.path.getsize(path)))


if __name__ == '__main__':
    main()
