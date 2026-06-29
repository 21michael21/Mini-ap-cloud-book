from __future__ import annotations

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile


ROOT = Path(__file__).resolve().parent
FIXTURES = ROOT / "fixtures"


def write_txt() -> None:
    (FIXTURES / "sample.txt").write_text(
        "Harness TXT\n\n"
        + "\n\n".join(
            f"Paragraph {index}. This plain text document proves the TXT reader restores scroll position."
            for index in range(1, 80)
        )
        + "\n",
        encoding="utf-8",
    )


def write_fb2() -> None:
    (FIXTURES / "sample.fb2").write_text(
        f"""<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
  <description>
    <title-info>
      <author><first-name>Harness</first-name><last-name>Author</last-name></author>
      <book-title>Harness FB2</book-title>
      <lang>en</lang>
    </title-info>
  </description>
  <body>
    <section>
      <title><p>Harness FB2</p></title>
      <p>This FB2 document proves the FictionBook reader renders visible text.</p>
      {''.join(f'<p>First section paragraph {index} for scroll restoration.</p>' for index in range(1, 40))}
    </section>
    <section>
      <title><p>Harness FB2 Second Section</p></title>
      {''.join(f'<p>Second section paragraph {index} for section restoration.</p>' for index in range(1, 40))}
    </section>
  </body>
</FictionBook>
""",
        encoding="utf-8",
    )


def write_epub() -> None:
    path = FIXTURES / "sample.epub"
    with ZipFile(path, "w") as archive:
        archive.writestr("mimetype", "application/epub+zip", compress_type=ZIP_STORED)
        archive.writestr(
            "META-INF/container.xml",
            f"""<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
""",
            compress_type=ZIP_DEFLATED,
        )
        archive.writestr(
            "OEBPS/content.opf",
            """<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:telegram-library-harness-epub</dc:identifier>
    <dc:title>Harness EPUB</dc:title>
    <dc:creator>Harness Author</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-06-29T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="style" href="style.css" media-type="text/css"/>
  </manifest>
  <spine>
    <itemref idref="chapter"/>
    <itemref idref="chapter2"/>
  </spine>
</package>
""",
            compress_type=ZIP_DEFLATED,
        )
        archive.writestr(
            "OEBPS/nav.xhtml",
            """<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Harness EPUB</title></head>
  <body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol><li><a href="chapter.xhtml">Start</a></li></ol></nav></body>
</html>
""",
            compress_type=ZIP_DEFLATED,
        )
        archive.writestr(
            "OEBPS/chapter.xhtml",
            """<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <title>Harness EPUB</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <h1>Harness EPUB</h1>
    <p>This EPUB document proves the EPUB reader renders visible text.</p>
    {''.join(f'<p>First section paragraph {index} for scroll restoration.</p>' for index in range(1, 45))}
  </body>
</html>
""",
            compress_type=ZIP_DEFLATED,
        )
        archive.writestr(
            "OEBPS/chapter2.xhtml",
            f"""<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <title>Harness EPUB Second Section</title>
  </head>
  <body>
    <h1>Harness EPUB Second Section</h1>
    {''.join(f'<p>Second section paragraph {index} for section restoration.</p>' for index in range(1, 45))}
  </body>
</html>
""",
            compress_type=ZIP_DEFLATED,
        )
        archive.writestr(
            "OEBPS/style.css",
            "body { font-family: serif; }",
            compress_type=ZIP_DEFLATED,
        )


def pdf_object(data: str) -> bytes:
    return data.encode("latin-1")


def write_pdf() -> None:
    objects = [
        pdf_object("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
        pdf_object("2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n"),
        pdf_object(
            "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] "
            "/Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>\nendobj\n"
        ),
        pdf_object(
            "4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] "
            "/Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>\nendobj\n"
        ),
        pdf_object("5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n"),
    ]
    stream1 = b"BT /F1 18 Tf 40 110 Td (Harness PDF Page 1) Tj ET"
    stream2 = b"BT /F1 18 Tf 40 110 Td (Harness PDF Page 2) Tj ET"
    objects.append(pdf_object(f"6 0 obj\n<< /Length {len(stream1)} >>\nstream\n") + stream1 + b"\nendstream\nendobj\n")
    objects.append(pdf_object(f"7 0 obj\n<< /Length {len(stream2)} >>\nstream\n") + stream2 + b"\nendstream\nendobj\n")

    output = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for obj in objects:
        offsets.append(len(output))
        output.extend(obj)
    xref = len(output)
    output.extend(f"xref\n0 {len(offsets)}\n".encode("latin-1"))
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode("latin-1"))
    output.extend(
        f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode(
            "latin-1"
        )
    )
    (FIXTURES / "sample.pdf").write_bytes(bytes(output))


def main() -> None:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    write_txt()
    write_fb2()
    write_epub()
    write_pdf()
    print(f"Wrote reader fixtures to {FIXTURES}")


if __name__ == "__main__":
    main()
