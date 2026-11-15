"""Round the two icons the author supplied, then print base64 data URIs.

Both sources are already circular artwork on a white field, so each is masked
to a circle again: that turns the corners transparent, which matters because
the settings page sits on a dark surface.
"""

import base64
import io

from PIL import Image, ImageDraw

DOUYIN_SRC = (
    r"C:\Users\Lenovo\.dsh\attachments\v1\objects\51"
    r"\519cbb46584d818e0cdb474db9fbedf3dbd57c12574224cd3fa8e8e0e3fc6792"
)
IFDIAN_SRC = (
    r"C:\Users\Lenovo\.dsh\attachments\v1\objects\bb"
    r"\bb153f42bab0baf477a86f09bbaccdb1266ecbe3e5ecfa897231f3a1987b48e6"
)

SIZE = 128
SUPERSAMPLE = 4


def circular(path):
    """Mask a square icon to a circle and return a PNG data URI."""
    with Image.open(path) as raw:
        image = raw.convert("RGB")
    side = min(image.size)
    left = (image.width - side) // 2
    top = (image.height - side) // 2
    image = image.crop((left, top, left + side, top + side))

    big = image.resize((SIZE * SUPERSAMPLE, SIZE * SUPERSAMPLE), Image.LANCZOS)
    mask = Image.new("L", big.size, 0)
    ImageDraw.Draw(mask).ellipse((0, 0, big.size[0] - 1, big.size[1] - 1), fill=255)
    out = Image.new("RGBA", big.size, (0, 0, 0, 0))
    out.paste(big, (0, 0), mask)
    out = out.resize((SIZE, SIZE), Image.LANCZOS)

    buffer = io.BytesIO()
    out.save(buffer, format="PNG", optimize=True)
    data = buffer.getvalue()
    stem = path.rsplit("\\", 1)[-1][:8]
    out.save(rf"F:\DeepSeek作品\dsh消耗弹窗插件\_{stem}.png")
    print(f"{stem} -> {len(data)} bytes")
    return "data:image/png;base64," + base64.b64encode(data).decode("ascii")


douyin = circular(DOUYIN_SRC)
ifdian = circular(IFDIAN_SRC)

with open(r"F:\DeepSeek作品\dsh消耗弹窗插件\_icons.txt", "w", encoding="utf-8") as handle:
    handle.write("DOUYIN=" + douyin + "\n")
    handle.write("IFDIAN=" + ifdian + "\n")
print("written _icons.txt")
