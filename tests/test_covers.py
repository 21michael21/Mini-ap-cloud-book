from __future__ import annotations

import base64
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from backend.app.config import Settings
from backend.app.covers import extract_and_store_cover


PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADggGOSHzRgAAAAABJRU5ErkJggg=="
)


def test_extracts_epub_cover_from_manifest_property(tmp_path: Path) -> None:
    epub = tmp_path / "sample.epub"
    make_epub(epub, cover_href="images/cover.png", cover_properties="cover-image")
    settings = cover_settings(tmp_path)

    cover_ref = extract_and_store_cover(settings, epub, "sample.epub", "epub", title="Sample")

    assert cover_ref is not None
    assert cover_ref.endswith(".png")
    assert (settings.cover_cache_dir / cover_ref).read_bytes() == PNG_1X1


def test_extracts_epub_cover_from_meta_cover_id(tmp_path: Path) -> None:
    epub = tmp_path / "sample.epub"
    make_epub(epub, cover_href="images/cover.png", cover_id="cover-id", meta_cover_id="cover-id")
    settings = cover_settings(tmp_path)

    cover_ref = extract_and_store_cover(settings, epub, "sample.epub", "epub", title="Sample")

    assert cover_ref is not None
    assert (settings.cover_cache_dir / cover_ref).exists()


def test_epub_cover_rejects_path_traversal(tmp_path: Path) -> None:
    epub = tmp_path / "evil.epub"
    make_epub(epub, cover_href="../evil.png", cover_properties="cover-image")
    settings = cover_settings(tmp_path)

    cover_ref = extract_and_store_cover(settings, epub, "evil.epub", "epub", title="Evil")

    assert cover_ref is None
    assert not any(settings.cover_cache_dir.glob("*"))


def test_extracts_fb2_coverpage_binary(tmp_path: Path) -> None:
    fb2 = tmp_path / "sample.fb2"
    fb2.write_text(
        f"""<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:xlink="http://www.w3.org/1999/xlink">
          <description><title-info>
            <coverpage><image xlink:href="#cover.png" /></coverpage>
            <book-title>Covered FB2</book-title>
          </title-info></description>
          <binary id="cover.png" content-type="image/png">{base64.b64encode(PNG_1X1).decode("ascii")}</binary>
        </FictionBook>""",
        encoding="utf-8",
    )
    settings = cover_settings(tmp_path)

    cover_ref = extract_and_store_cover(settings, fb2, "sample.fb2", "fb2", title="Covered FB2")

    assert cover_ref is not None
    assert (settings.cover_cache_dir / cover_ref).read_bytes() == PNG_1X1


def test_txt_uses_frontend_placeholder_without_backend_cover(tmp_path: Path) -> None:
    txt = tmp_path / "plain.txt"
    txt.write_text("No image here", encoding="utf-8")
    settings = cover_settings(tmp_path)

    cover_ref = extract_and_store_cover(settings, txt, "plain.txt", "txt", title="Plain")

    assert cover_ref is None
    assert not any(settings.cover_cache_dir.glob("*"))


def make_epub(
    path: Path,
    *,
    cover_href: str,
    cover_id: str = "cover",
    cover_properties: str = "",
    meta_cover_id: str | None = None,
) -> None:
    meta = f'<meta name="cover" content="{meta_cover_id}"/>' if meta_cover_id else ""
    properties = f' properties="{cover_properties}"' if cover_properties else ""
    with ZipFile(path, "w", ZIP_DEFLATED) as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr(
            "META-INF/container.xml",
            """<?xml version="1.0"?>
            <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
              <rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles>
            </container>""",
        )
        archive.writestr(
            "OEBPS/content.opf",
            f"""<package xmlns:dc="http://purl.org/dc/elements/1.1/">
              <metadata><dc:title>Covered EPUB</dc:title>{meta}</metadata>
              <manifest>
                <item id="{cover_id}" href="{cover_href}" media-type="image/png"{properties}/>
              </manifest>
            </package>""",
        )
        if not cover_href.startswith("../"):
            archive.writestr(f"OEBPS/{cover_href}", PNG_1X1)


def cover_settings(tmp_path: Path) -> Settings:
    settings = Settings(
        database_url="sqlite+pysqlite:///:memory:",
        file_cache_dir=tmp_path / "file_cache",
        cover_cache_dir=tmp_path / "covers",
        cover_cache_max_bytes=1024 * 1024,
        cover_image_max_bytes=1024,
    )
    settings.cover_cache_dir.mkdir(parents=True, exist_ok=True)
    return settings
