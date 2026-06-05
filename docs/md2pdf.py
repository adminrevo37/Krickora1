#!/usr/bin/env python3
"""Minimal Markdown -> PDF renderer for the Krickora build docs.
Handles: # h1/h2/h3, paragraphs, **bold**, `code`, [text](url) links,
- / 1. lists, > blockquotes (rendered as callouts), ``` fenced code blocks,
and GitHub-style pipe tables. Usage: python3 md2pdf.py in.md out.pdf

Works around a broken system 'cryptography' (rust binding panics) that fpdf
imports eagerly, and the latin-1-only core fonts.
"""
import sys, re
from unittest import mock
from html import escape

class CryptoStub:
    def find_module(self, name, path=None):
        return self if name == "cryptography" or name.startswith("cryptography.") else None
    def load_module(self, name):
        if name in sys.modules: return sys.modules[name]
        m = mock.MagicMock(); m.__name__ = name; m.__path__ = []
        sys.modules[name] = m; return m
sys.meta_path.insert(0, CryptoStub())
from fpdf import FPDF

GREEN = "#0b3d2e"
UNI = {"—":"-","–":"-","→":"->","≥":">=","≤":"<=","×":"x","·":"-","…":"...",
       "“":'"',"”":'"',"‘":"'","’":"'","⭐":"*","⚠️":"[!]","🔒":"[lock]","🎉":"",
       " ":" "}
def ascii_clean(s):
    for k,v in UNI.items(): s = s.replace(k,v)
    return s.encode("latin-1","replace").decode("latin-1")

def inline(s, in_cell=False):
    """Markdown inline -> fpdf write_html inline. In table cells, fpdf forbids
    <font>/<a>, so render those as plain text there."""
    s = ascii_clean(s)
    s = escape(s)  # escape &,<,> first
    if in_cell:
        # fpdf forbids inline tags inside <td>; render plain text only
        s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)
        s = re.sub(r"`(.+?)`", r"\1", s)
        s = re.sub(r"\[(.+?)\]\((.+?)\)", r"\1", s)
    else:
        s = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", s)
        s = re.sub(r"`(.+?)`", r'<font face="courier" size="9">\1</font>', s)
        s = re.sub(r"\[(.+?)\]\((.+?)\)", r'<a href="\2">\1</a>', s)
    return s

def convert(md):
    out, lines, i = [], md.split("\n"), 0
    while i < len(lines):
        ln = lines[i]
        # fenced code
        if ln.strip().startswith("```"):
            i += 1; code = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                code.append(lines[i]); i += 1
            i += 1
            body = "<br>".join(escape(ascii_clean(c)) or "&nbsp;" for c in code)
            out.append(f'<p><font face="courier" size="8">{body}</font></p>')
            continue
        # table
        if ln.strip().startswith("|") and i+1 < len(lines) and re.match(r"^\s*\|[-:| ]+\|\s*$", lines[i+1]):
            header = [c.strip() for c in ln.strip().strip("|").split("|")]
            i += 2; rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")]); i += 1
            n = len(header); wd = max(8, 100//n)
            t = '<table border="1" width="100%"><thead><tr>'
            for h in header:
                t += f'<th width="{wd}%" bgcolor="#e7f0ec">{inline(h, True)}</th>'
            t += "</tr></thead><tbody>"
            for r in rows:
                r += [""]*(n-len(r))
                t += "<tr>" + "".join(f"<td>{inline(c, True)}</td>" for c in r[:n]) + "</tr>"
            t += "</tbody></table>"
            out.append(t); continue
        # headings
        m = re.match(r"^(#{1,3})\s+(.*)$", ln)
        if m:
            lvl = len(m.group(1)); txt = inline(m.group(2))
            out.append(f'<h{lvl}><font color="{GREEN}">{txt}</font></h{lvl}>'); i += 1; continue
        # blockquote -> callout
        if ln.strip().startswith(">"):
            quote = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                quote.append(lines[i].strip().lstrip(">").strip()); i += 1
            txt = inline(" ".join(quote))
            out.append(f'<p><font color="#c47f00">{txt}</font></p>'); continue
        # lists
        if re.match(r"^\s*[-*]\s+", ln):
            items = []
            while i < len(lines) and re.match(r"^\s*[-*]\s+", lines[i]):
                items.append(inline(re.sub(r"^\s*[-*]\s+","",lines[i]))); i += 1
            out.append("<ul>" + "".join(f"<li>{x}</li>" for x in items) + "</ul>"); continue
        if re.match(r"^\s*\d+\.\s+", ln):
            items = []
            while i < len(lines) and re.match(r"^\s*\d+\.\s+", lines[i]):
                items.append(inline(re.sub(r"^\s*\d+\.\s+","",lines[i]))); i += 1
            out.append("<ol>" + "".join(f"<li>{x}</li>" for x in items) + "</ol>"); continue
        # hr
        if ln.strip() in ("---","***","___"):
            out.append("<hr>"); i += 1; continue
        # blank
        if not ln.strip():
            i += 1; continue
        # paragraph (gather until blank)
        para = [ln]; i += 1
        while i < len(lines) and lines[i].strip() and not re.match(r"^(#|>|\||```|\s*[-*]\s|\s*\d+\.\s)", lines[i]):
            para.append(lines[i]); i += 1
        out.append(f"<p>{inline(' '.join(para))}</p>")
    return "".join(out)

def main():
    src, dst = sys.argv[1], sys.argv[2]
    md = open(src, encoding="utf-8").read()
    pdf = FPDF(format="A4")
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.set_margins(15, 15, 15); pdf.add_page()
    pdf.set_font("Helvetica", size=10)
    pdf.write_html(convert(md))
    pdf.output(dst); print("WROTE", dst)

if __name__ == "__main__":
    main()
