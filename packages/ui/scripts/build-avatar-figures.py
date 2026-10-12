#!/usr/bin/env python3
"""Build the full-body avatar figures from source art.

Reads <src>/<kind>-full.png and <src>/<kind>-ink.png (1024x1536 cut-outs
on a transparent background), cleans the alpha (faint residue to 0,
near-opaque to 255), shrinks each to 768x1152 and writes the colour and ink
variants to packages/ui/assets/avatar-figures/<kind>.webp and <kind>-ink.webp.

The figures are shipped as separate files, not inlined like the portraits,
so they only load on the pages that show them.

Run it after changing the art:
  python3 packages/ui/scripts/build-avatar-figures.py <src-dir>
Needs Python 3 and Pillow built with WebP support.
"""
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'assets' / 'avatar-figures'
KINDS = ['robot', 'cat', 'dog', 'boy', 'girl']

OUT_SIZE = (768, 1152)
QUALITY = 82
MAX_BYTES = 150 * 1024
ALPHA_FLOOR, ALPHA_CEIL = 8, 250   # below: transparent; at or above: opaque


def build(src: Path) -> Image.Image:
    im = Image.open(src).convert('RGBA')
    alpha = im.getchannel('A').point(lambda v: 0 if v < ALPHA_FLOOR else 255 if v >= ALPHA_CEIL else v)
    im.putalpha(alpha)
    return im.resize(OUT_SIZE, Image.LANCZOS)


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit('usage: build-avatar-figures.py <src-dir>')
    src_dir = Path(sys.argv[1])
    OUT.mkdir(parents=True, exist_ok=True)
    for kind in KINDS:
        for source_suffix, output_suffix in [('full', ''), ('ink', '-ink')]:
            out = OUT / f'{kind}{output_suffix}.webp'
            image = build(src_dir / f'{kind}-{source_suffix}.png')
            # Keep both variants small enough for the onboarding stage. Ink
            # artwork compresses readily; detailed colour art can need a
            # slightly lower quality while retaining its original dimensions.
            for quality in range(QUALITY, 49, -4):
                image.save(out, 'WEBP', quality=quality, alpha_quality=90, method=6)
                if out.stat().st_size <= MAX_BYTES:
                    break
            else:
                sys.exit(f'{out.relative_to(ROOT)} exceeds {MAX_BYTES // 1024} KB')
            print(f'{out.relative_to(ROOT)}  {out.stat().st_size / 1024:.1f} KB (quality {quality})')


if __name__ == '__main__':
    main()
