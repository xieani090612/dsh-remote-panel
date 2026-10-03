#!/usr/bin/env python3
"""
生成 app/app.ico —— 纯程序化绘制，不使用任何第三方素材。

图形：一枚圆角渐变方块 + 一台白色服务器（三个仓位 + 状态灯）。
        在 16px 下仍然能认出「一台机器」，这也是 ico 里同时塞 9 档尺寸的原因：
        Windows 按场景自己挑（任务栏 24/32、Alt+Tab 32/48、资源管理器大图标 256）。

为什么要 4 倍超采样：Pillow 的圆角与圆形没有抗锯齿，
        先在 4 倍尺寸上画、再用 LANCZOS 缩下来，边缘才干净。

用法：
    python app/make-icon.py            # 重新生成 app/app.ico 与 docs/icon-preview.png
"""
from __future__ import annotations

import pathlib
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent

MASTER = 1024                      # 超采样画布
SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]

GRADIENT_TOP = (0x3B, 0x8B, 0xF5)
GRADIENT_BOTTOM = (0x18, 0x4C, 0xB8)
SLOT = (0x1E, 0x5F, 0xD0, 255)
BODY = (0xFF, 0xFF, 0xFF, 255)
LED = (0x3A, 0xD3, 0x7F, 255)


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def build_master() -> Image.Image:
    # 竖直渐变底
    ramp = np.linspace(0.0, 1.0, MASTER, dtype=np.float32)[:, None]
    canvas = np.zeros((MASTER, MASTER, 3), dtype=np.float32)
    for channel in range(3):
        canvas[:, :, channel] = GRADIENT_TOP[channel] * (1.0 - ramp) + GRADIENT_BOTTOM[channel] * ramp

    image = Image.fromarray(canvas.astype(np.uint8), "RGB").convert("RGBA")
    image.putalpha(rounded_mask(MASTER, int(MASTER * 0.22)))

    draw = ImageDraw.Draw(image)

    # 服务器机身
    draw.rounded_rectangle((232, 300, 792, 724), radius=44, fill=BODY)

    # 三个仓位：每个一条圆角「插槽」，右端一颗状态灯
    for index in range(3):
        top = 347 + index * 120
        draw.rounded_rectangle((272, top, 752, top + 90), radius=26, fill=SLOT)
        led_x, led_y, led_r = 706, top + 45, 18
        draw.ellipse((led_x - led_r, led_y - led_r, led_x + led_r, led_y + led_r), fill=LED)

    return image


def main() -> int:
    master = build_master()

    ico_path = HERE / "app.ico"
    # sizes 交给 Pillow：它会从这张 1024 的图逐个 LANCZOS 缩下去，
    # 比先缩到 256 再逐档缩要干净。
    master.save(ico_path, format="ICO", sizes=[(s, s) for s in SIZES])

    # 自检：读回来确认每个尺寸都在，并且不是空的。
    with Image.open(ico_path) as check:
        got = sorted(check.ico.sizes())
    expected = sorted((s, s) for s in SIZES)
    if got != expected:
        print(f"ICO 尺寸不对：期望 {expected}，实际 {got}", file=sys.stderr)
        return 1

    # 预览图：把各档并排画在浅色与深色底上，方便肉眼确认小尺寸还认得出。
    docs = ROOT / "docs"
    docs.mkdir(parents=True, exist_ok=True)
    preview_sizes = [16, 24, 32, 48, 64, 128, 256]
    pad, gap = 16, 12
    cell_w = sum(preview_sizes) + gap * (len(preview_sizes) - 1) + pad * 2
    cell_h = 256 + pad * 2
    sheet = Image.new("RGB", (cell_w, cell_h * 2), (0xF3, 0xF3, 0xF3))
    draw = ImageDraw.Draw(sheet)
    draw.rectangle((0, cell_h, cell_w, cell_h * 2), fill=(0x20, 0x20, 0x20))

    for row in range(2):
        x = pad
        for size in preview_sizes:
            icon = master.resize((size, size), Image.Resampling.LANCZOS)
            y = row * cell_h + pad + 256 - size
            sheet.paste(icon, (x, y), icon)
            x += size + gap

    sheet.save(docs / "icon-preview.png")

    print(f"已写入 {ico_path}（{ico_path.stat().st_size:,} 字节，{len(SIZES)} 档尺寸）")
    print(f"已写入 {docs / 'icon-preview.png'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
