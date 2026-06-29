from __future__ import annotations

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from backend.app.formats import clean_title_from_filename, detect_format, extract_metadata, sniff_format


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


def test_broken_epub_falls_back_to_filename_metadata(tmp_path: Path) -> None:
    epub = tmp_path / "broken.epub"
    with ZipFile(epub, "w", ZIP_DEFLATED) as archive:
        archive.writestr("mimetype", "application/epub+zip")

    metadata = extract_metadata(epub, "broken-upload.epub", "epub")

    assert metadata.title == "broken upload"
    assert metadata.author is None


def test_extract_fb2_metadata_from_windows_1251(tmp_path: Path) -> None:
    fb2 = tmp_path / "sample.fb2"
    fb2.write_bytes(
        """<?xml version="1.0" encoding="windows-1251"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
  <description><title-info>
    <author><first-name>Аркадий</first-name><last-name>Стругацкий</last-name></author>
    <book-title>Пикник на обочине</book-title>
  </title-info></description>
</FictionBook>""".encode("cp1251")
    )

    metadata = extract_metadata(fb2, "fallback.fb2", "fb2")

    assert metadata.title == "Пикник на обочине"
    assert metadata.author == "Аркадий Стругацкий"


def test_detect_format_from_valid_content_with_wrong_or_empty_extension(tmp_path: Path) -> None:
    pdf = tmp_path / "upload"
    pdf.write_bytes(make_image_only_pdf())
    fb2 = tmp_path / "book.bin"
    fb2.write_text("<FictionBook><body><section><p>Text</p></section></body></FictionBook>", encoding="utf-8")
    epub = tmp_path / "book.data"
    with ZipFile(epub, "w", ZIP_DEFLATED) as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr("META-INF/container.xml", "<container />")

    assert detect_format(pdf.name, None, pdf) == "pdf"
    assert detect_format(fb2.name, None, fb2) == "fb2"
    assert detect_format(epub.name, None, epub) == "epub"


def test_zero_byte_file_has_no_sniffed_format(tmp_path: Path) -> None:
    empty = tmp_path / "empty"
    empty.write_bytes(b"")

    assert sniff_format(empty) is None
    assert detect_format(empty.name, None, empty) is None


def test_scanned_pdf_like_file_sniffs_as_pdf_without_text_layer(tmp_path: Path) -> None:
    scanned = tmp_path / "scan.unknown"
    scanned.write_bytes(make_image_only_pdf())

    assert sniff_format(scanned) == "pdf"


def make_image_only_pdf() -> bytes:
    objects = [
        b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
        b"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>\nendobj\n",
    ]
    stream = b"0.9 g 20 20 160 160 re f"
    objects.append(b"4 0 obj\n<< /Length " + str(len(stream)).encode("ascii") + b" >>\nstream\n" + stream + b"\nendstream\nendobj\n")
    output = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for obj in objects:
        offsets.append(len(output))
        output.extend(obj)
    xref = len(output)
    output.extend(f"xref\n0 {len(offsets)}\n".encode("ascii"))
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.extend(f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode("ascii"))
    return bytes(output)
