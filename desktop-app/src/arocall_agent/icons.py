"""Arocall brand icon (bundled from apps/web/public/icon.png) + per-status tray badges.

The tray keeps the product icon as its base so the agent is recognizable while
running; a small colored dot in the corner carries the live status:
gray = not configured, green = connected/idle, red = recording/error,
orange = uploading. Falls back to the legacy plain circle when Pillow or the
bundled PNG is unavailable.
"""
from pathlib import Path

STATUS_COLORS = {
    "unconfigured": "gray",
    "idle": "green",
    "recording": "red",
    "uploading": "orange",
    "error": "red",
}

DOT_RGB = {
    "gray": (148, 163, 184),
    "green": (22, 163, 74),
    "red": (220, 38, 38),
    "orange": (249, 115, 22),
}


def icon_path() -> Path:
    """Absolute path of the bundled brand PNG (works in source tree and venv installs)."""
    try:
        from importlib.resources import files
        p = files(__package__ or "arocall_agent").joinpath("assets/icon.png")
        if p.is_file():
            return Path(str(p))
    except Exception:
        pass
    return Path(__file__).resolve().parent / "assets" / "icon.png"


def load_base(size: int = 64):
    """Brand PNG resized to a square RGBA image. Raises when unavailable."""
    from PIL import Image

    img = Image.open(icon_path()).convert("RGBA")
    return img.resize((size, size), Image.LANCZOS)


def make_status_icon(status: str, size: int = 64):
    """Brand icon + status dot (bottom-right). Falls back to a plain circle."""
    from PIL import Image, ImageDraw

    color = STATUS_COLORS.get(status, "red")
    try:
        img = load_base(size)
    except Exception:
        img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        draw.ellipse([8, 8, size - 8, size - 8], fill=color)
        return img
    draw = ImageDraw.Draw(img)
    r = max(6, size // 6)
    cx, cy = size - r - 2, size - r - 2
    rgb = DOT_RGB.get(color, (220, 38, 38))
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=rgb, outline="white", width=max(2, size // 32))
    if status == "error":
        draw.line([cx - r // 2, cy - r // 2, cx + r // 2, cy + r // 2], fill="white", width=max(2, r // 3))
        draw.line([cx + r // 2, cy - r // 2, cx - r // 2, cy + r // 2], fill="white", width=max(2, r // 3))
    return img
