"""Fetch primary sources as line-stable plain text for citation.

Usage: python -I fetch.py <sources_dir> <name> <url> [<name> <url> ...]

HTML is reduced to text with one block element per line so that
`sources/<name>.txt:<line>` citations stay stable. Non-HTML responses
(raw source files) are saved verbatim.
"""
import sys
import urllib.request
from datetime import date
from html.parser import HTMLParser
from pathlib import Path

BLOCK_TAGS = {
    "p", "div", "li", "tr", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6",
    "pre", "br", "section", "article", "table", "dt", "dd", "blockquote", "code",
}
SKIP_TAGS = {"script", "style", "nav", "header", "footer", "svg", "noscript"}
MIN_CHARS = 500


class TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.lines = [""]
        self.skip_depth = 0
        self.in_pre = 0

    def handle_starttag(self, tag, attrs):
        if tag in SKIP_TAGS:
            self.skip_depth += 1
        if tag == "pre":
            self.in_pre += 1
        if tag in BLOCK_TAGS and tag != "code":
            self.lines.append("")

    def handle_endtag(self, tag):
        if tag in SKIP_TAGS and self.skip_depth:
            self.skip_depth -= 1
        if tag == "pre" and self.in_pre:
            self.in_pre -= 1
        if tag in BLOCK_TAGS and tag != "code":
            self.lines.append("")

    def handle_data(self, data):
        if self.skip_depth:
            return
        if self.in_pre:
            parts = data.split("\n")
            self.lines[-1] += parts[0]
            self.lines.extend(parts[1:])
        else:
            self.lines[-1] += " ".join(data.split()) + (" " if data.endswith((" ", "\n")) else "")

    def text(self):
        out = [" ".join(line.split()) if not line.startswith(" ") else line.rstrip() for line in self.lines]
        return "\n".join(line for line in out if line.strip())


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (hy-harness verification)"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        ctype = resp.headers.get("Content-Type", "")
        body = resp.read().decode("utf-8", errors="replace")
    if "html" in ctype or body.lstrip().lower().startswith(("<!doctype html", "<html")):
        parser = TextExtractor()
        parser.feed(body)
        return parser.text()
    return body


def main():
    out_dir = Path(sys.argv[1])
    args = sys.argv[2:]
    for name, url in zip(args[0::2], args[1::2]):
        try:
            text = fetch(url)
        except Exception as exc:  # report and continue with the remaining sources
            print(f"FAIL {name}: {exc}")
            continue
        if len(text) < MIN_CHARS:
            print(f"SHORT {name}: {len(text)} chars")
        header = f"Source: {url}\nFetched: {date.today().isoformat()}\n\n"
        (out_dir / f"{name}.txt").write_text(header + text + "\n", encoding="utf-8")
        print(f"OK {name}: {len(text)} chars")


if __name__ == "__main__":
    main()
