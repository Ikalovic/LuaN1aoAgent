"""Export reviewed AI artwork to deterministic, credential-free web assets."""

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageChops, ImageOps, ImageStat


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "output/imagegen/masters"
ART = ROOT / "web/public/art"
BRAND = ROOT / "web/public/brand"
EXPORTS = []
RESAMPLE = Image.Resampling.LANCZOS
MANIFEST = ROOT / "docs/assets/qingxuan-art-manifest.json"
PREVIOUS = {item["path"]: item["sha256"] for item in
            json.loads(MANIFEST.read_text())["exports"]} if MANIFEST.exists() else {}


def load(name):
    return Image.open(SOURCE / name).copy()


def save(image, destination, source, transformation, **options):
    if destination.exists():
        expected = PREVIOUS.get(str(destination.relative_to(ROOT)))
        if hashlib.sha256(destination.read_bytes()).hexdigest() != expected:
            raise FileExistsError(f"Refusing to replace an untracked or edited asset: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    image.save(destination, **options)
    data = destination.read_bytes()
    alpha = image.getchannel("A") if image.mode == "RGBA" else None
    EXPORTS.append({
        "path": str(destination.relative_to(ROOT)),
        "width": image.width,
        "height": image.height,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "has_transparency": alpha is not None and alpha.getextrema()[0] < 255,
        "source": source,
        "source_size": list(Image.open(SOURCE / source).size),
        "transformation": transformation,
    })


def visible_crop(image):
    alpha = image.getchannel("A")
    # The provider left almost invisible alpha speckles far outside the subject.
    alpha = alpha.point(lambda value: 0 if value <= 8 else value)
    image.putalpha(alpha)
    return image.crop(alpha.getbbox())


def centered(image, size, fraction):
    fitted = ImageOps.contain(
        image, (round(size[0] * fraction), round(size[1] * fraction)), RESAMPLE
    )
    canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    canvas.alpha_composite(fitted, ((size[0] - fitted.width) // 2,
                                  (size[1] - fitted.height) // 2))
    return canvas


def export_flat_wallboard():
    source = "qingxuan-background-flat-user-4k.png"
    surface = load(source).convert("RGB")
    if surface.size != (3840, 2160):
        raise ValueError("The flat wallboard source must be 3840x2160")
    manifest = json.loads(MANIFEST.read_text())
    start = len(EXPORTS)
    for size, suffix in [((1920, 1080), "1080"), ((3840, 2160), "4k")]:
        exported = surface if size == surface.size else surface.resize(size, RESAMPLE)
        description = "User-provided flat 3840x2160 background; " + (
            "same-resolution export, no upscaling" if suffix == "4k" else "Lanczos downsample"
        )
        save(exported, ART / f"wallboard-surface-v3-{suffix}.webp", source,
             description, format="WEBP", quality=85, method=6)
        save(exported, ART / f"wallboard-surface-v3-{suffix}.png", source,
             description + "; lossless PNG fallback", optimize=True)
    added = EXPORTS[start:]
    paths = {item["path"] for item in added}
    manifest["exports"] = [item for item in manifest["exports"] if item["path"] not in paths] + added
    manifest["current_wallboard"] = {
        "version": "v3", "source": source, "source_origin": "user_provided",
        "source_sha256": hashlib.sha256((SOURCE / source).read_bytes()).hexdigest(),
        "source_size": list(surface.size), "locally_upscaled": False,
        "generation_provenance_verified": False,
        "composition": "flat technical display background; no room or floor perspective",
    }
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Exported V3 flat wallboard:", [(item["path"], item["bytes"]) for item in added])


def export_homepage():
    manifest = json.loads(MANIFEST.read_text())
    start = len(EXPORTS)
    for name in ("workbench", "wallboard"):
        source = f"home-{name}-fixture.png"
        screenshot = load(source).convert("RGB")
        if screenshot.size != (1920, 1080):
            raise ValueError("Homepage product screenshots must be 1920x1080")
        save(screenshot, ART / f"home-{name}.webp", source,
             "Actual product screenshot with browser-only lab.example fixtures; same-resolution lossless export",
             format="WEBP", lossless=True, method=6)
        EXPORTS[-1].update({
            "source_origin": "browser_fixture_screenshot",
            "source_sha256": hashlib.sha256((SOURCE / source).read_bytes()).hexdigest(),
            "contains_live_runtime_data": False,
        })
    added = EXPORTS[start:]
    paths = {item["path"] for item in added}
    manifest["exports"] = [item for item in manifest["exports"] if item["path"] not in paths] + added
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Exported homepage screenshots:", [(item["path"], item["bytes"]) for item in added])


def main():
    user_surface_source = "qingxuan-background-user-4k.png"
    user_surface = load(user_surface_source).convert("RGB")
    if user_surface.size != (3840, 2160):
        raise ValueError("The user-provided wallboard source must be 3840x2160")
    symbol_source = "qingxuan-symbol.png"
    symbol = visible_crop(load(symbol_source).convert("RGBA"))
    variants = {}
    for variant, color in [("on-dark", "#53D6BD"), ("on-light", "#087F6B")]:
        flat = Image.new("RGBA", symbol.size, color)
        flat.putalpha(symbol.getchannel("A"))
        master = centered(flat, (1024, 1024), 0.70)
        variants[variant] = master
        for size in (128, 256):
            suffix = "" if size == 256 else "-128"
            save(master.resize((size, size), RESAMPLE),
                 BRAND / f"qingxuan-symbol-{variant}{suffix}.png", symbol_source,
                 "Shared alpha silhouette; solid theme color; 15% padding; downsample",
                 optimize=True)
        master.save(ROOT / f"output/imagegen/qingxuan-symbol-{variant}-1024.png")

    dark = variants["on-dark"]
    save(dark.resize((256, 256), RESAMPLE), BRAND / "qingxuan-symbol.png",
         symbol_source, "Same as on-dark 256px", optimize=True)
    for size, name in [(32, "favicon-32.png"), (48, "favicon-48.png"),
                       (192, "icon-192.png"), (512, "icon-512.png")]:
        save(dark.resize((size, size), RESAMPLE), BRAND / name, symbol_source,
             "Shared brand alpha; downsample", optimize=True)
    tile = Image.new("RGBA", (180, 180), "#141618")
    tile.alpha_composite(dark.resize((180, 180), RESAMPLE))
    save(tile.convert("RGB"), BRAND / "apple-touch-icon.png", symbol_source,
         "Shared brand on opaque graphite tile", optimize=True)
    save(dark.resize((48, 48), RESAMPLE), BRAND / "favicon.ico", symbol_source,
         "ICO with 16/32/48px frames", format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])

    surface_source = "wallboard-surface-sized.png"
    surface = load(surface_source).convert("RGB")
    for size, suffix in [((1920, 1080), "1080"), ((3840, 2160), "4k")]:
        exported = ImageOps.fit(surface, size, RESAMPLE)
        description = "Lanczos upscale from 1672x941; not native 4K"
        save(exported, ART / f"wallboard-surface-{suffix}.webp", surface_source,
             description, format="WEBP", quality=85, method=6)
        save(exported, ART / f"wallboard-surface-{suffix}.png", surface_source,
             description + "; PNG fallback", optimize=True)

    for size, suffix in [((1920, 1080), "1080"), ((3840, 2160), "4k")]:
        exported = user_surface if size == user_surface.size else user_surface.resize(size, RESAMPLE)
        description = "User-provided 3840x2160 source; " + (
            "same-resolution export, no upscaling" if suffix == "4k" else "Lanczos downsample"
        )
        save(exported, ART / f"wallboard-surface-v2-{suffix}.webp", user_surface_source,
             description, format="WEBP", quality=85, method=6)
        save(exported, ART / f"wallboard-surface-v2-{suffix}.png", user_surface_source,
             description + "; lossless PNG fallback", optimize=True)

    login_source = "login-surface-dark.png"
    login = ImageOps.fit(load(login_source).convert("RGB"), (1600, 1000), RESAMPLE,
                        centering=(1.0, 1.0))
    for extension in ("webp", "png"):
        options = {"format": "WEBP", "quality": 82, "method": 6} if extension == "webp" else {"optimize": True}
        save(login, ART / f"login-surface-dark.{extension}", login_source,
             "Crop to 16:10 anchored lower right; upscale from source crop", **options)

    empty_source = "empty-run.png"
    empty = centered(visible_crop(load(empty_source).convert("RGBA")), (1024, 768), 0.60)
    empty.save(ROOT / "output/imagegen/empty-run-1024.png")
    for extension in ("webp", "png"):
        options = {"format": "WEBP", "lossless": True, "method": 6} if extension == "webp" else {"optimize": True}
        save(empty.resize((384, 288), RESAMPLE), ART / f"empty-run.{extension}",
             empty_source, "Visible alpha crop; centered 4:3 canvas; downsample", **options)

    rail_source = "wallboard-header-rail-a.png"
    rail = load(rail_source).convert("RGBA")
    midpoint = rail.width // 2
    halves = [visible_crop(rail.crop((0, 0, midpoint, rail.height))),
              visible_crop(rail.crop((midpoint, 0, rail.width, rail.height)))]
    header = Image.new("RGBA", (1920, 160), (0, 0, 0, 0))
    for index, half in enumerate(halves):
        wing = ImageOps.contain(half, (480, 136), RESAMPLE)
        x = 96 if index == 0 else 1920 - 96 - wing.width
        header.alpha_composite(wing, (x, (160 - wing.height) // 2))
    assert header.getchannel("A").crop((576, 0, 1344, 160)).getextrema() == (0, 0)
    for extension in ("webp", "png"):
        options = {"format": "WEBP", "lossless": True, "method": 6} if extension == "webp" else {"optimize": True}
        save(header, ART / f"wallboard-header-rail.{extension}", rail_source,
             "Two original wings independently contained; center 40% fully transparent", **options)
    header.resize((3840, 320), RESAMPLE).save(ROOT / "output/imagegen/wallboard-header-rail-3840.png")

    deck_source = "wallboard-deck-albedo.png"
    # A mirrored 2x2 tile makes opposite border pixels match exactly.
    quarter = load(deck_source).convert("RGB").resize((512, 512), RESAMPLE)
    deck = Image.new("RGB", (1024, 1024))
    deck.paste(quarter, (0, 0))
    deck.paste(ImageOps.mirror(quarter), (512, 0))
    deck.paste(ImageOps.flip(quarter), (0, 512))
    deck.paste(ImageOps.flip(ImageOps.mirror(quarter)), (512, 512))
    for extension in ("webp", "png"):
        options = {"format": "WEBP", "quality": 88, "method": 6} if extension == "webp" else {"optimize": True}
        save(deck, ART / f"wallboard-deck-albedo.{extension}", deck_source,
             "Downsample to 512px; mirrored 2x2 tile for matching opposite edges", **options)
    seam_x = ImageStat.Stat(ImageChops.difference(deck.crop((0, 0, 1, 1024)),
                                                deck.crop((1023, 0, 1024, 1024)))).mean
    seam_y = ImageStat.Stat(ImageChops.difference(deck.crop((0, 0, 1024, 1)),
                                                deck.crop((0, 1023, 1024, 1024)))).mean
    manifest = {"initial_generation_model": "gpt-image-2.5-flare", "exports": EXPORTS,
                "deck_edge_mean_absolute_rgb_difference": {"x": seam_x, "y": seam_y},
                "current_wallboard": {
                    "version": "v2",
                    "source": user_surface_source,
                    "source_origin": "user_provided",
                    "source_sha256": hashlib.sha256((SOURCE / user_surface_source).read_bytes()).hexdigest(),
                    "source_size": list(user_surface.size),
                    "locally_upscaled": False,
                    "generation_provenance_verified": False,
                }}
    MANIFEST.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Exported {len(EXPORTS)} assets. Current wallboard: user-provided 3840x2160, no local upscaling.")
    print("Deck seam differences:", seam_x, seam_y)
    if (SOURCE / "qingxuan-background-flat-user-4k.png").exists():
        export_flat_wallboard()
    if all((SOURCE / f"home-{name}-fixture.png").exists() for name in ("workbench", "wallboard")):
        export_homepage()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--flat-wallboard-only", action="store_true",
                      help="Export only the reviewed V3 background, preserving other assets")
    mode.add_argument("--homepage-only", action="store_true",
                      help="Export only homepage product screenshots, preserving other assets")
    args = parser.parse_args()
    if args.homepage_only:
        export_homepage()
    elif args.flat_wallboard_only:
        export_flat_wallboard()
    else:
        main()
