from __future__ import annotations

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from backend.app.formats import clean_title_from_filename, detect_format, extract_metadata


def test_detect_format_from_extension_and_mime() -> None:
    assert detect_format("book.epub", None) == "epub"
    assert detect_format("scan.bin", "application/pdf") == "pdf"
    assert detect_format("notes.unknown", "text/plain") == "txt"
    assert detect_format("archive.zip", "application/zip") is None


def test_clean_title_from_filename() -> None:
    assert clean_title_from_filename("new_book-final.epub") == "new book final"


def test_extract_epub_metadata(tmp_path: Path) -> None:
    epub = tmp_path / "sample.epub"
    with ZipFile(epub, "w", ZIP_DEFLATED) as archive:
        archive.writestr(
            "META-INF/container.xml",
            """<?xml version="1.0"?>
            <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
              <rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles>
            </container>""",
        )
        archive.writestr(
            "OEBPS/content.opf",
            """<package xmlns:dc="http://purl.org/dc/elements/1.1/">
              <metadata>
                <dc:title>Clean Architecture</dc:title>
                <dc:creator>Robert Martin</dc:creator>
              </metadata>
            </package>""",
        )

    metadata = extract_metadata(epub, "fallback.epub", "epub")

    assert metadata.title == "Clean Architecture"
    assert metadata.author == "Robert Martin"


def test_extract_fb2_metadata(tmp_path: Path) -> None:
    fb2 = tmp_path / "sample.fb2"
    fb2.write_text(
        """<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
          <description><title-info>
            <author><first-name>Arkady</first-name><last-name>Strugatsky</last-name></author>
            <book-title>Roadside Picnic</book-title>
          </title-info></description>
        </FictionBook>""",
        encoding="utf-8",
    )

    metadata = extract_metadata(fb2, "fallback.fb2", "fb2")

    assert metadata.title == "Roadside Picnic"
    assert metadata.author == "Arkady Strugatsky"
