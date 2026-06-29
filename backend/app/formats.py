from __future__ import annotations

from dataclasses import dataclass
import logging
from pathlib import Path
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile


logger = logging.getLogger(__name__)


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


def detect_format(file_name: str, mime_type: str | None = None, file_path: Path | None = None) -> str | None:
    suffix = Path(file_name).suffix.lower().lstrip(".")
    if suffix in SUPPORTED_FORMATS | EXPERIMENTAL_FORMATS:
        return suffix
    if mime_type == "application/pdf":
        return "pdf"
    if mime_type and "epub" in mime_type:
        return "epub"
    if mime_type and mime_type.startswith("text/"):
        return "txt"
    if file_path is not None:
        return sniff_format(file_path)
    return None


def extract_metadata(file_path: Path, file_name: str, fmt: str) -> BookMetadata:
    if fmt == "epub":
        return _extract_epub_metadata(file_path, file_name)
    if fmt == "fb2":
        return _extract_fb2_metadata(file_path, file_name)
    return BookMetadata(title=clean_title_from_filename(file_name))


def sniff_format(file_path: Path) -> str | None:
    try:
        head = file_path.read_bytes()[:4096]
    except OSError:
        logger.exception("Could not read file for format sniffing: %s", file_path)
        return None

    if not head:
        return None
    if head.startswith(b"%PDF-"):
        return "pdf"
    if head.startswith(b"PK"):
        try:
            with ZipFile(file_path) as archive:
                names = set(archive.namelist())
                mimetype = archive.read("mimetype").decode("ascii", "ignore").strip() if "mimetype" in names else ""
                if mimetype == "application/epub+zip" or "META-INF/container.xml" in names:
                    return "epub"
        except (BadZipFile, KeyError, OSError):
            logger.info("Zip-like upload was not a readable EPUB: %s", file_path)
            return None

    sample = _decode_text_bytes(head)
    if sample and "<FictionBook" in sample:
        return "fb2"
    if sample and sample.strip():
        return "txt"
    return None


def _decode_text_bytes(data: bytes) -> str | None:
    for encoding in ("utf-8-sig", "utf-8", "windows-1251", "cp1251"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return None


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
        logger.exception("Falling back to filename metadata for EPUB %s", file_name)
        return BookMetadata(title=clean_title_from_filename(file_name))


def _extract_fb2_metadata(file_path: Path, file_name: str) -> BookMetadata:
    try:
        root = _parse_text_xml(file_path)
        title = _text_or_none(root.find(".//{*}book-title"))
        first = _text_or_none(root.find(".//{*}author/{*}first-name"))
        middle = _text_or_none(root.find(".//{*}author/{*}middle-name"))
        last = _text_or_none(root.find(".//{*}author/{*}last-name"))
        author = " ".join(part for part in [first, middle, last] if part) or None
        return BookMetadata(title=title or clean_title_from_filename(file_name), author=author)
    except Exception:
        logger.exception("Falling back to filename metadata for FB2 %s", file_name)
        return BookMetadata(title=clean_title_from_filename(file_name))


def _parse_text_xml(file_path: Path) -> ElementTree.Element:
    data = file_path.read_bytes()
    try:
        return ElementTree.fromstring(data)
    except ElementTree.ParseError:
        pass
    text = _decode_text_bytes(data)
    if text is None:
        raise UnicodeDecodeError("utf-8", data, 0, min(len(data), 1), "unsupported text encoding")
    return ElementTree.fromstring(text)
