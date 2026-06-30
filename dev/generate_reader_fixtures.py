from __future__ import annotations

import base64
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "reader_fixtures" / "public"

PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADggGOSHzRgAAAAABJRU5ErkJggg=="
)
ZIP_TIMESTAMP = (2026, 6, 30, 15, 1, 56)


def write_zip_entry(archive: ZipFile, filename: str, data: str | bytes, *, compress_type: int) -> None:
    info = ZipInfo(filename, date_time=ZIP_TIMESTAMP)
    info.compress_type = compress_type
    archive.writestr(info, data)


def write_epub(path: Path, *, title: str, chapters: list[str], bad_markup: bool = False) -> None:
    with ZipFile(path, "w") as archive:
        write_zip_entry(archive, "mimetype", "application/epub+zip", compress_type=ZIP_STORED)
        write_zip_entry(
            archive,
            "META-INF/container.xml",
            """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
""",
            compress_type=ZIP_DEFLATED,
        )
        manifest_items = "\n".join(
            f'<item id="chapter{index}" href="chapter{index}.xhtml" media-type="application/xhtml+xml"/>'
            for index in range(1, len(chapters) + 1)
        )
        spine_items = "\n".join(f'<itemref idref="chapter{index}"/>' for index in range(1, len(chapters) + 1))
        nav_items = "\n".join(
            f'<li><a href="chapter{index}.xhtml">Section {index}</a></li>'
            for index in range(1, len(chapters) + 1)
        )
        write_zip_entry(
            archive,
            "OEBPS/content.opf",
            f"""<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:telegram-library-{path.stem}</dc:identifier>
    <dc:title>{title}</dc:title>
    <dc:creator>Reader Fixture Author</dc:creator>
    <dc:language>en</dc:language>
    <meta name="cover" content="cover-image"/>
    <meta property="dcterms:modified">2026-06-30T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/>
    {manifest_items}
  </manifest>
  <spine>{spine_items}</spine>
</package>
""",
            compress_type=ZIP_DEFLATED,
        )
        write_zip_entry(archive, "OEBPS/cover.png", PNG_1X1, compress_type=ZIP_DEFLATED)
        write_zip_entry(
            archive,
            "OEBPS/nav.xhtml",
            f"""<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>{title}</title></head>
  <body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol>{nav_items}</ol></nav></body>
</html>
""",
            compress_type=ZIP_DEFLATED,
        )
        for index, heading in enumerate(chapters, start=1):
            write_zip_entry(
                archive,
                f"OEBPS/chapter{index}.xhtml",
                chapter_html(title, heading, index, bad_markup=bad_markup),
                compress_type=ZIP_DEFLATED,
            )


def chapter_html(title: str, heading: str, index: int, *, bad_markup: bool) -> str:
    bad_bits = (
        """
    <style>body { transform: scale(10); }</style>
    <script>window.__bad_epub_script_ran = true</script>
    <h1>Очень длинный русский заголовок без нормальных переносов который не должен разорвать мобильный экран читателя</h1>
    <p onclick="alert('bad')"><span><b>Bad markup paragraph</b></span> still needs readable output.</p>
    <unknown-block><unknown-inline>Unknown nested markup text must remain readable as its own paragraph.</unknown-inline></unknown-block>
    <custom-section><custom-title>Custom title text survives sanitizer.</custom-title><custom-body><odd-tag>Deeply nested unknown tag text survives without raw book styles.</odd-tag></custom-body></custom-section>
    <p>ДлиннаяРусскаяСтрокаБезПробеловДолжнаПереноситьсяИДержатьсяВнутриЭкранаДлиннаяРусскаяСтрокаБезПробелов.</p>
    <iframe src="https://example.com"></iframe>
"""
        if bad_markup
        else ""
    )
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>{title}</title></head>
  <body>
    <h1>{heading}</h1>
    <h2>Clean Mode EPUB Section {index}</h2>
    <p>Visible text for reader e2e. Russian text: Привет, мир, «кавычки», ёлка.</p>
    <p>Long URL wraps: https://example.com/really/long/path/that/should/not/create/horizontal/overflow/in/mobile/webview</p>
    <p>Long word wraps: SupercalifragilisticexpialidociousSupercalifragilisticexpialidociousSupercalifragilistic.</p>
    <ul><li>First list item</li><li>Second list item</li></ul>
    <blockquote><p>Readable blockquote with calm spacing.</p></blockquote>
    <table><thead><tr><th>Column</th><th>Status</th></tr></thead><tbody><tr><td>Table</td><td>Horizontally safe</td></tr></tbody></table>
    <img alt="Fixture image placeholder" src="data:image/png;base64,{base64.b64encode(PNG_1X1).decode("ascii")}" />
    {bad_bits}
    {''.join(f'<p>Section {index} scrolling paragraph {paragraph}. This text makes the page long enough to scroll and restore.</p>' for paragraph in range(1, 70))}
  </body>
</html>
"""


def write_fb2(path: Path, *, title: str, encoding: str = "utf-8") -> None:
    xml = f"""<?xml version="1.0" encoding="{encoding}"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
  <description>
    <title-info>
      <author><first-name>Reader</first-name><last-name>Fixture</last-name></author>
      <book-title>{title}</book-title>
      <lang>ru</lang>
    </title-info>
  </description>
  <body>
    <section>
      <title><p>{title}</p></title>
      <p>Visible FB2 text for e2e. Русский текст: Привет, мир, ёлка, кавычки.</p>
      <p>LongWordsWithoutSpacesWrapCorrectlyLongWordsWithoutSpacesWrapCorrectlyLongWordsWithoutSpacesWrapCorrectly.</p>
      <cite><p>Readable quote in FB2.</p></cite>
      {''.join(f'<p>FB2 first section paragraph {index} for scrolling restore.</p>' for index in range(1, 80))}
    </section>
    <section>
      <title><p>{title} Second Section</p></title>
      {''.join(f'<p>FB2 second section paragraph {index} for next section restore.</p>' for index in range(1, 70))}
    </section>
  </body>
</FictionBook>
"""
    path.write_bytes(xml.encode("cp1251" if encoding.lower() in {"windows-1251", "cp1251"} else "utf-8"))


def write_txt(path: Path) -> None:
    path.write_text(
        "Reader E2E Long TXT\n\n"
        "Visible TXT text. Привет, мир, long URLs and long words must stay readable.\n"
        "https://example.com/really/long/path/that/should/not/create/horizontal/overflow/in/mobile/webview\n\n"
        + "\n\n".join(
            f"TXT paragraph {index}. This document is intentionally long enough to scroll and restore position."
            for index in range(1, 180)
        )
        + "\n",
        encoding="utf-8",
    )


def write_pdf(path: Path, *, scanned_like: bool = False, blank: bool = False, page_count: int = 2) -> None:
    pages = [
        f"BT /F1 20 Tf 40 150 Td (Reader E2E PDF Page {index}) Tj ET\n0.2 w 40 40 220 70 re S".encode("ascii")
        for index in range(1, page_count + 1)
    ]
    if blank:
        pages = [b"" for _ in range(page_count)]
    if scanned_like:
        pages = [
            b"0.88 g 25 25 250 150 re f\n0.4 g 42 130 210 8 re f\n0.5 g 42 110 180 8 re f\n0.5 g 42 90 220 8 re f",
            b"0.86 g 25 25 250 150 re f\n0.4 g 42 130 210 8 re f\n0.5 g 42 110 180 8 re f\n0.5 g 42 90 220 8 re f",
        ]
        page_count = len(pages)
    kids = " ".join(f"{object_number} 0 R" for object_number in range(3, 3 + page_count)).encode("ascii")
    objects = [
        b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        b"2 0 obj\n<< /Type /Pages /Kids [" + kids + b"] /Count " + str(page_count).encode("ascii") + b" >>\nendobj\n",
    ]
    font_object_number = 3 + page_count
    first_content_object_number = font_object_number + 1
    for index in range(page_count):
        page_object_number = 3 + index
        content_object_number = first_content_object_number + index
        objects.append(
            f"{page_object_number} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 220] "
            f"/Resources << /Font << /F1 {font_object_number} 0 R >> >> /Contents {content_object_number} 0 R >>\nendobj\n".encode(
                "ascii"
            )
        )
    objects.append(f"{font_object_number} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n".encode("ascii"))
    for index, page in enumerate(pages):
        object_number = first_content_object_number + index
        objects.append(
            f"{object_number} 0 obj\n<< /Length {len(page)} >>\nstream\n".encode("ascii")
            + page
            + b"\nendstream\nendobj\n"
        )
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
    path.write_bytes(bytes(output))


def main() -> None:
    PUBLIC.mkdir(parents=True, exist_ok=True)
    write_epub(PUBLIC / "simple.epub", title="Reader E2E Simple EPUB", chapters=["Simple EPUB"])
    write_epub(PUBLIC / "bad_markup.epub", title="Reader E2E Bad Markup EPUB", chapters=["Bad Markup EPUB"], bad_markup=True)
    write_epub(
        PUBLIC / "multi_section.epub",
        title="Reader E2E Multi Section EPUB",
        chapters=["Multi EPUB First", "Multi EPUB Second", "Multi EPUB Third"],
    )
    write_fb2(PUBLIC / "long_text.fb2", title="Reader E2E Long FB2")
    write_fb2(PUBLIC / "cp1251.fb2", title="Reader E2E CP1251 FB2", encoding="windows-1251")
    write_txt(PUBLIC / "long.txt")
    write_pdf(PUBLIC / "small.pdf")
    write_pdf(PUBLIC / "scanned_like.pdf", scanned_like=True)
    write_pdf(PUBLIC / "blank.pdf", blank=True)
    write_pdf(PUBLIC / "long_pdf.pdf", page_count=20)
    print(f"Wrote public reader fixtures to {PUBLIC}")


if __name__ == "__main__":
    main()
