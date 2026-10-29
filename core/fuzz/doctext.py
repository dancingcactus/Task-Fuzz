"""The text of an attached PDF, Word document or PowerPoint deck, for the executor.

A headless executor can't run anything, and its client's file tools can't open every format (Word and
PowerPoint files are zips of XML), so read_source hands it the text. Pages and slides are marked so it
can say where something came from. Images, charts and layout are lost: the path is still there for a
client that can look.
"""

import re
import zipfile
from xml.etree import ElementTree

MAX_CHARS = 60_000

PDF = "application/pdf"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
KINDS = {PDF: "pdf", DOCX: "docx", PPTX: "pptx"}

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"


def kind(path, mime=None):
    """pdf, docx or pptx when Fuzz can read the file, else None."""
    k = KINDS.get((mime or "").split(";")[0].strip())
    if k:
        return k
    ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    return ext if ext in ("pdf", "docx", "pptx") else None


def _pdf(path):
    from pypdf import PdfReader
    reader = PdfReader(path)
    if reader.is_encrypted:
        reader.decrypt("")   # opens files that are only locked against editing; raises when a password is needed
    return [f"[Page {n}]\n{(p.extract_text() or '').strip()}" for n, p in enumerate(reader.pages, 1)]


def _paragraphs(root, para, text, tab=None, brk=None):
    out = []
    for p in root.iter(para):
        bits = []
        for el in p.iter():
            if el.tag == text and el.text:
                bits.append(el.text)
            elif el.tag in (tab, brk):
                bits.append("\t" if el.tag == tab else "\n")
        line = "".join(bits).strip()
        if line:
            out.append(line)
    return out


def _docx(path):
    with zipfile.ZipFile(path) as z:
        names = ["word/document.xml"] + sorted(n for n in z.namelist() if re.fullmatch(r"word/(footnotes|endnotes)\.xml", n))
        out = []
        for n in names:
            if n in z.namelist():
                out += _paragraphs(ElementTree.fromstring(z.read(n)), f"{W}p", f"{W}t", f"{W}tab", f"{W}br")
    return ["\n".join(out)]   # no pages to mark: Word lays them out when it opens the file


def _pptx(path):
    def num(n):
        return int(re.search(r"(\d+)\.xml$", n).group(1))
    with zipfile.ZipFile(path) as z:
        all_ = z.namelist()
        slides = sorted((n for n in all_ if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)), key=num)
        out = []
        for n in slides:
            body = _paragraphs(ElementTree.fromstring(z.read(n)), f"{A}p", f"{A}t", f"{A}tab", f"{A}br")
            notes = f"ppt/notesSlides/notesSlide{num(n)}.xml"
            said = _paragraphs(ElementTree.fromstring(z.read(notes)), f"{A}p", f"{A}t") if notes in all_ else []
            said = [s for s in said if not s.isdigit()]   # the slide number placeholder
            out.append("\n".join([f"[Slide {num(n)}]", *body] + (["Notes:", *said] if said else [])))
    return out


def read(path, mime=None, max_chars=MAX_CHARS):
    """{format, text, truncated} for a file Fuzz can read, {format, error} when it can't, None for other files."""
    k = kind(path, mime)
    if k is None:
        return None
    try:
        parts = {"pdf": _pdf, "docx": _docx, "pptx": _pptx}[k](path)
    except Exception as e:   # a damaged or password-protected file: say so rather than fail the read
        return {"format": k, "error": f"Fuzz couldn't read this {k.upper()} ({type(e).__name__}: {e})"}
    text = "\n\n".join(parts).strip()
    out = {"format": k, "text": text[:max_chars], "truncated": len(text) > max_chars}
    if k == "pdf" and not re.sub(r"\[Page \d+\]", "", text).strip():
        out["note"] = "No text layer: it's probably scanned. Look at it with your own file tools if you can."
    return out
