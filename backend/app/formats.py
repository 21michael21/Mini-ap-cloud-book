from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from xml.etree import ElementTree
from zipfile import ZipFile


SUPPORTED_FORMATS = {"epub", "fb2", "txt", "pdf"}
EXPERIMENTAL_FORMATS = {"mobi", "azw3", "cbz"}


@dataclass(frozen=True)
class BookMetadata:
    title: str
    author: str | None = None
    cover_ref: str | None = None


def clean_title_from_filename(file_name: str) -> str:
    stem = Path(file_name).stem.replace("_", " ").replace("-", " ")
    cleaned = " ".join(stem.split())
    return cleaned or file_name


def detect_format(file_name: str, mime_type: str | None = None) -> str | None:
    suffix = Path(file_name).suffix.lower().lstrip(".")
    if suffix in SUPPORTED_FORMATS | EXPERIMENTAL_FORMATS:
        return suffix
    if mime_type == "application/pdf":
        return "pdf"
    if mime_type and "epub" in mime_type:
        return "epub"
    if mime_type and mime_type.startswith("text/"):
        return "txt"
    return None


def extract_metadata(file_path: Path, file_name: str, fmt: str) -> BookMetadata:
    if fmt == "epub":
        return _extract_epub_metadata(file_path, file_name)
    if fmt == "fb2":
        return _extract_fb2_metadata(file_path, file_name)
    return BookMetadata(title=clean_title_from_filename(file_name))


def _text_or_none(node: ElementTree.Element | None) -> str | None:
    if node is None or node.text is None:
        return None
    text = " ".join(node.text.split())
    return text or None


def _extract_epub_metadata(file_path: Path, file_name: str) -> BookMetadata:
    try:
        with ZipFile(file_path) as epub:
            container = ElementTree.fromstring(epub.read("META-INF/container.xml"))
            ns = {"c": "urn:oasis:names:tc:opendocument:xmlns:container"}
            rootfile = container.find(".//c:rootfile", ns)
            opf_path = rootfile.attrib["full-path"] if rootfile is not None else ""
            opf = ElementTree.fromstring(epub.read(opf_path))
            title = _text_or_none(opf.find(".//{http://purl.org/dc/elements/1.1/}title"))
            author = _text_or_none(opf.find(".//{http://purl.org/dc/elements/1.1/}creator"))
            return BookMetadata(title=title or clean_title_from_filename(file_name), author=author)
    except Exception:
        return BookMetadata(title=clean_title_from_filename(file_name))


def _extract_fb2_metadata(file_path: Path, file_name: str) -> BookMetadata:
    try:
        root = ElementTree.parse(file_path).getroot()
        title = _text_or_none(root.find(".//{*}book-title"))
        first = _text_or_none(root.find(".//{*}author/{*}first-name"))
        middle = _text_or_none(root.find(".//{*}author/{*}middle-name"))
        last = _text_or_none(root.find(".//{*}author/{*}last-name"))
        author = " ".join(part for part in [first, middle, last] if part) or None
        return BookMetadata(title=title or clean_title_from_filename(file_name), author=author)
    except Exception:
        return BookMetadata(title=clean_title_from_filename(file_name))
