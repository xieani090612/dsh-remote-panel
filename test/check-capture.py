#!/usr/bin/env python3
"""
对截图做**像素级**内容边界断言 —— 用来回答「文字是不是贴边/被裁」。

用法：
    python test/check-capture.py <png> [--margin 8] [--client-px 457] [--expect-width-dip 365.6]

判据（全部是数出来的，不靠眼睛）：
  * 内容包围盒的左边界 >= margin 像素（左侧要有留白，不能贴边）；
  * 内容包围盒的右边界 <= 图像宽度 - margin 像素（不能贴右边框，更不能被裁）；
  * 如果给了 --client-px，则再断言内容右边界 <= client_px - margin（卡片必须落在客户区内）。

「内容」= 与图像四周背景色不同的像素。深色主题下背景是 #202020 一类，
所以先取左上角 (2,2) 与右上角附近的窗口背景作为基准色，容差内视为背景。
"""
from __future__ import annotations

import argparse
import sys

import numpy as np
from PIL import Image


def content_bbox(path: str, tolerance: int = 24, inset: int = 9):
    """
    inset：截图通常包含窗口边框（本机 125% 缩放下每边约 9 物理像素）。
    边框本身的颜色和窗口背景不同，如果把它算成「内容」，包围盒就会等于整张图，
    留白检查永远是 0 —— 假失败。所以只在**客户区**（inset 之内）里找内容。
    """
    image = Image.open(path).convert("RGB")
    arr = np.asarray(image).astype(np.int16)
    height, width, _ = arr.shape

    x0, y0 = inset, inset
    x1, y1 = width - inset, height - inset
    region = arr[y0:y1, x0:x1, :]

    # 窗口背景 = 客户区四条边中位色（客户区边缘一定是窗口背景/卡片外的留白）
    edge = np.concatenate([
        region[0:3, :, :].reshape(-1, 3),
        region[-3:, :, :].reshape(-1, 3),
        region[:, 0:3, :].reshape(-1, 3),
        region[:, -3:, :].reshape(-1, 3),
    ])
    background = np.median(edge, axis=0)

    diff = np.abs(region - background).max(axis=2)
    mask = diff > tolerance
    ys, xs = np.nonzero(mask)
    if xs.size == 0:
        return x0, y0, x0, y0, tuple(int(v) for v in background), width, height, inset
    return (x0 + int(xs.min()), y0 + int(ys.min()),
            x0 + int(xs.max()), y0 + int(ys.max()),
            tuple(int(v) for v in background), width, height, inset)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("png")
    parser.add_argument("--margin", type=int, default=8, help="要求的最小留白（像素），相对客户区边缘")
    parser.add_argument("--frame-inset", type=int, default=9, help="窗口边框宽度（像素），分析时排除")
    parser.add_argument("--client-px", type=int, default=0, help="客户区宽度（像素）；>0 时额外断言内容不超出")
    parser.add_argument("--label", default="")
    args = parser.parse_args()

    left, top, right, bottom, background, width, height, inset = content_bbox(args.png, inset=args.frame_inset)
    client_left, client_right = inset, width - 1 - inset
    print(f"截图 {args.png}")
    print(f"  图像      ：{width}x{height}px   客户区 x {client_left}..{client_right}   背景基准 RGB{background}")
    print(f"  内容包围盒：x {left}..{right}   y {top}..{bottom}")
    print(f"  左右留白  ：左 {left - client_left}px   右 {client_right - right}px")

    failures = []
    if left - client_left < args.margin:
        failures.append(f"左留白不足：{left - client_left}px < {args.margin}px（内容贴左边）")
    if client_right - right < args.margin:
        failures.append(f"右留白不足：{client_right - right}px < {args.margin}px（内容贴右边或被裁）")
    if args.client_px > 0 and right > args.client_px - args.margin:
        failures.append(f"内容超出客户区：右边界 {right}px > 客户区 {args.client_px}px − {args.margin}px")

    tag = f"[{args.label}] " if args.label else ""
    if failures:
        for failure in failures:
            print(f"  {tag}FAIL {failure}")
        return 1
    print(f"  {tag}OK 留白达标（左右均 >= {args.margin}px，且无内容越界）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
