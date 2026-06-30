from __future__ import annotations

import base64
import hashlib
import logging
import posixpath
import time
from pathlib import Path
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile

from backend.app.config import Settings
logger = logging.getLogger(__name__)

IMAGE_EXTENSIONS_BY_MIME = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}


def extract_and_store_cover(
    settings: Settings,
    file_path: Path,
    file_name: str,
    fmt: str,
    *,
    title: str | None = None,
    author: str | None = None,
) -> str | None:
    try:
        if fmt == "epub":
            image = extract_epub_cover(file_path, settings.cover_image_max_bytes)
        elif fmt == "fb2":
            image = extract_fb2_cover(file_path, settings.cover_image_max_bytes)
        elif fmt in {"txt", "pdf"}:
            # TODO: PDF first-page thumbnail needs image/PDF tooling that is not in
            # the lightweight backend stack. The Mini App keeps its generated
            # fallback cover for PDF/TXT until that spike is done.
            return None
        else:
            return None
        if image is None:
            return None
        return store_cover_bytes(settings, image.data, image.mime_type)
    except Exception:
        logger.exception("Cover extraction failed for %s", file_name)
        return None


class CoverImage:
    def __init__(self, data: bytes, mime_type: str) -> None:
        self.data = data
        self.mime_type = mime_type


def cover_cache_path(settings: Settings, cover_ref: str) -> Path | None:
    if not cover_ref or Path(cover_ref).name != cover_ref:
        return None
    cover_dir = resolved_cover_dir(settings)
    path = cover_dir / cover_ref
    try:
        path.resolve().relative_to(cover_dir.resolve())
    except ValueError:
        return None
    return path


def store_cover_bytes(settings: Settings, data: bytes, mime_type: str) -> str | None:
    ext = IMAGE_EXTENSIONS_BY_MIME.get(mime_type.lower())
    if not ext:
        return None
    if not data or len(data) > settings.cover_image_max_bytes:
        return None
    actual_mime = sniff_image_mime(data)
    if actual_mime != mime_type.lower():
        return None

    cover_dir = resolved_cover_dir(settings)
    cover_dir.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(data).hexdigest()
    cover_ref = f"{digest}{ext}"
    path = cover_dir / cover_ref
    if not path.exists():
        tmp_path = path.with_suffix(f"{path.suffix}.tmp")
        tmp_path.write_bytes(data)
        tmp_path.replace(path)
    path.touch()
    cleanup_cover_cache(settings)
    return cover_ref


def extract_epub_cover(file_path: Path, max_bytes: int) -> CoverImage | None:
    try:
        with ZipFile(file_path) as archive:
            opf_path = epub_opf_path(archive)
            if not opf_path:
                return None
            opf_xml = archive.read(opf_path)
            opf = ElementTree.fromstring(opf_xml)
            manifest = list(opf.findall(".//{*}manifest/{*}item"))
            candidate_hrefs = epub_cover_candidates(opf, manifest)
            opf_dir = posixpath.dirname(opf_path)
            for href, media_type in candidate_hrefs:
                member = safe_epub_member_path(opf_dir, href)
                if member is None or member not in archive.namelist():
                    continue
                if media_type not in IMAGE_EXTENSIONS_BY_MIME:
                    continue
                info = archive.getinfo(member)
                if info.file_size <= 0 or info.file_size > max_bytes:
                    continue
                data = archive.read(member)
                if sniff_image_mime(data) == media_type:
                    return CoverImage(data, media_type)
    except (BadZipFile, KeyError, ElementTree.ParseError, OSError):
        logger.info("Could not extract EPUB cover from %s", file_path)
    return None


def epub_opf_path(archive: ZipFile) -> str | None:
    try:
        container = ElementTree.fromstring(archive.read("META-INF/container.xml"))
    except (KeyError, ElementTree.ParseError):
        return None
    rootfile = container.find(".//{*}rootfile")
    path = rootfile.attrib.get("full-path", "") if rootfile is not None else ""
    return safe_archive_member(path) if path else None


def epub_cover_candidates(
    opf: ElementTree.Element,
    manifest: list[ElementTree.Element],
) -> list[tuple[str, str]]:
    by_id = {item.attrib.get("id"): item for item in manifest if item.attrib.get("id")}
    candidates: list[ElementTree.Element] = []

    for meta in opf.findall(".//{*}metadata/{*}meta"):
        if meta.attrib.get("name") == "cover":
            cover_id = meta.attrib.get("content")
            item = by_id.get(cover_id)
            if item is not None:
                candidates.append(item)

    candidates.extend(
        item for item in manifest if "cover-image" in item.attrib.get("properties", "").split()
    )
    candidates.extend(
        item for item in manifest if item.attrib.get("media-type", "").lower() in IMAGE_EXTENSIONS_BY_MIME
    )

    seen: set[str] = set()
    result: list[tuple[str, str]] = []
    for item in candidates:
        href = item.attrib.get("href", "")
        media_type = item.attrib.get("media-type", "").lower()
        key = f"{href}\0{media_type}"
        if href and key not in seen:
            seen.add(key)
            result.append((href, media_type))
    return result


def safe_epub_member_path(opf_dir: str, href: str) -> str | None:
    href = href.split("#", 1)[0].strip()
    if not href:
        return None
    href_parts = href.replace("\\", "/").split("/")
    if href.startswith("/") or any(part == ".." for part in href_parts):
        return None
    joined = posixpath.normpath(posixpath.join(opf_dir, href))
    return safe_archive_member(joined)


def safe_archive_member(path: str) -> str | None:
    raw = path.replace("\\", "/")
    if raw.startswith("/") or any(part == ".." for part in raw.split("/")):
        return None
    normalized = posixpath.normpath(raw).lstrip("/")
    if normalized in {"", "."}:
        return None
    return normalized


def extract_fb2_cover(file_path: Path, max_bytes: int) -> CoverImage | None:
    try:
        root = ElementTree.fromstring(file_path.read_bytes())
    except ElementTree.ParseError:
        from backend.app.formats import _decode_text_bytes

        text = _decode_text_bytes(file_path.read_bytes())
        if text is None:
            return None
        root = ElementTree.fromstring(text)

    image_id = fb2_cover_image_id(root)
    if not image_id:
        return None

    for binary in root.findall(".//{*}binary"):
        if binary.attrib.get("id") != image_id:
            continue
        mime_type = binary.attrib.get("content-type", "").lower()
        if mime_type not in IMAGE_EXTENSIONS_BY_MIME:
            return None
        encoded = "".join((binary.text or "").split())
        if not encoded:
            return None
        data = base64.b64decode(encoded, validate=True)
        if len(data) > max_bytes:
            return None
        if sniff_image_mime(data) == mime_type:
            return CoverImage(data, mime_type)
    return None


def fb2_cover_image_id(root: ElementTree.Element) -> str | None:
    image = root.find(".//{*}coverpage/{*}image")
    if image is None:
        return None
    href = image.attrib.get("{http://www.w3.org/1999/xlink}href") or image.attrib.get("href")
    if not href:
        return None
    return href.lstrip("#")


def sniff_image_mime(data: bytes) -> str | None:
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def cleanup_cover_cache(settings: Settings) -> None:
    cover_dir = resolved_cover_dir(settings)
    if not cover_dir.exists():
        return
    files: list[tuple[float, int, Path]] = []
    for path in cover_dir.iterdir():
        if not path.is_file() or path.name.endswith(".tmp"):
            continue
        try:
            stat = path.stat()
        except OSError:
            logger.exception("Could not stat cover file %s", path)
            continue
        files.append((stat.st_mtime, stat.st_size, path))

    max_bytes = settings.cover_cache_max_bytes
    if max_bytes <= 0:
        return
    total = sum(size for _, size, _ in files)
    for _, size, path in sorted(files):
        if total <= max_bytes:
            break
        try:
            path.unlink()
            total -= size
        except OSError:
            logger.exception("Could not remove cover file %s during LRU cleanup", path)


def resolved_cover_dir(settings: Settings) -> Path:
    return settings.cover_cache_dir or settings.file_cache_dir / "covers"
