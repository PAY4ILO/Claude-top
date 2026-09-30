#!/usr/bin/env python3
"""
Готовит картинки для сайта из оригиналов Figma (design/figma/originals).

  pip install pillow vtracer
  python3 tools/prepare-assets.py

* Растровые картинки обрезаются ровно по кадру, который видно в Figma
  (у слоёв стоит заливка "Fill"/"Crop" со смещением), и сохраняются в WebP
  в 2x от размера на макете — для ретины.
* Логотипы и иконка Telegram в Figma лежат как PNG, поэтому SVG получается
  векторизацией: окружности иконки Telegram построены точными примитивами,
  остальное — трассировкой контуров. Отличие от оригинала проверено
  попиксельно (средняя разница ~2/255).
* После генерации SVG стоит прогнать через svgo (см. README).
"""
import re
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "design/figma/originals"
OUT = ROOT / "assets/img"

# Слой в Figma: размер рамки и положение картинки внутри неё (проценты от рамки),
# значения взяты из get_design_context.
CROPS = {
    # file                          source                   box (w, h)            left     top     width   height
    "about-freedom.webp":        ("about-new-project.png", (308, 391),          -123.70,  -0.04, 322.73, 107.25),
    "about-build.webp":          ("about-payuy.png",       (323, 415),          -107.91,   0.00, 325.10, 106.75),
    "about-rewards.webp":        ("about-commuinini.png",  (500, 363),           -55.26, -18.47, 223.86, 130.04),
    "lk-progress.webp":          ("lk-2ct.png",            (255.223, 223.028),   -87.37, -43.57, 297.20, 143.57),
    "lk-support.webp":           ("lk-supp.png",           (281, 224),          -117.78, -43.97, 350.49, 185.80),
}


def crop_like_figma(src, box, left, top, width, height, scale=2):
    im = Image.open(SRC / src).convert("RGBA")
    bw, bh = box
    shown_w, shown_h = width / 100 * bw, height / 100 * bh
    sx, sy = im.width / shown_w, im.height / shown_h
    x0, y0 = -left / 100 * bw * sx, -top / 100 * bh * sy
    region = im.crop((round(x0), round(y0), round(x0 + bw * sx), round(y0 + bh * sy)))
    return region.resize((round(bw * scale), round(bh * scale)), Image.LANCZOS)


def build_rasters():
    for name, (src, box, *geom) in CROPS.items():
        img = crop_like_figma(src, box, *geom)
        img.save(OUT / name, "WEBP", quality=90, method=6)
        print(f"  {name:22} {img.size}")

    hero = Image.open(SRC / "hero-2025-06-22_21.31.12.png").convert("RGB")
    hero.save(OUT / "hero.webp", "WEBP", quality=86, method=6)
    hero.resize((960, 540), Image.LANCZOS).save(OUT / "hero-960.webp", "WEBP", quality=86, method=6)
    print(f"  hero.webp              {hero.size} (+ hero-960.webp)")


def trace(png_path, size, out_svg, **params):
    import vtracer

    im = Image.open(png_path).convert("RGBA").resize((size, size), Image.LANCZOS)
    tmp = OUT / "_trace.png"
    im.save(tmp)
    vtracer.convert_image_to_svg_py(str(tmp), str(out_svg), colormode="color", hierarchical="stacked", **params)
    tmp.unlink()
    # vtracer не пишет viewBox, а без него SVG не везде масштабируется.
    svg = Path(out_svg).read_text()
    Path(out_svg).write_text(svg.replace("<svg ", f'<svg viewBox="0 0 {size} {size}" ', 1))


def build_logos():
    hq = dict(mode="polygon", filter_speckle=2, color_precision=8, layer_difference=3, path_precision=1)
    # Холст SVG = весь квадрат исходного PNG, как у слоя в Figma (картинка на всю рамку).
    trace(SRC / "lwl-2d.png", 1024, OUT / "logo.svg", **hq)
    trace(SRC / "lwl-3d.png", 1024, OUT / "logo-3d.svg", **hq)
    print("  logo.svg, logo-3d.svg")


def build_telegram():
    import vtracer

    src = Image.open(SRC / "telegram-pngwing.png").convert("RGBA")
    px = src.load()
    scale = 4
    plane = Image.new("RGBA", src.size, (0, 0, 0, 0))
    pp = plane.load()
    cx, cy, r_disc = 258, 253, 212
    for y in range(src.height):
        for x in range(src.width):
            if (x - cx) ** 2 + (y - cy) ** 2 < (r_disc - 4) ** 2 and px[x, y][0] > 140:
                pp[x, y] = px[x, y][:3] + (255,)
    big = plane.resize((src.width * scale, src.height * scale), Image.LANCZOS)
    bp = big.load()
    for y in range(big.height):
        for x in range(big.width):
            r, g, b, a = bp[x, y]
            bp[x, y] = (r, g, b, 255 if a >= 128 else 0)
    tmp_png, tmp_svg = OUT / "_plane.png", OUT / "_plane.svg"
    big.save(tmp_png)
    vtracer.convert_image_to_svg_py(
        str(tmp_png), str(tmp_svg), colormode="color", hierarchical="stacked", mode="spline",
        filter_speckle=8, color_precision=6, layer_difference=24, corner_threshold=60,
        length_threshold=4.0, splice_threshold=45, path_precision=1,
    )
    paths = "\n".join(re.findall(r"<path[^>]*/>", tmp_svg.read_text()))
    tmp_png.unlink()
    tmp_svg.unlink()
    (OUT / "telegram.svg").write_text(
        f"""<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<defs>
<linearGradient id="tg-ring" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fdfeff"/><stop offset="1" stop-color="#f7fafc"/></linearGradient>
<linearGradient id="tg-disc" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#33b3ea"/><stop offset="1" stop-color="#158ccc"/></linearGradient>
</defs>
<circle cx="{cx}" cy="{cy}" r="237" fill="url(#tg-ring)"/>
<circle cx="{cx}" cy="{cy}" r="{r_disc}" fill="url(#tg-disc)"/>
<g transform="scale({1 / scale})">
{paths}
</g>
</svg>
"""
    )
    print("  telegram.svg")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    print("Растровые:")
    build_rasters()
    print("Векторные:")
    build_logos()
    build_telegram()
