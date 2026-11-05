"""Mechanically check that every quoted extract appears at its cited line.

Usage: python -I verify.py <verification_dir> [--report <out.md>]

A quote matches when, after whitespace normalization, its fragments
(split on "…") appear in order within lines [line-2, line+span+2].
On a mismatch the script prints where the first fragment actually is,
so the citation can be corrected instead of the quote being loosened.
"""
import json
import sys
from pathlib import Path

WINDOW = 2


def norm(text):
    return " ".join(text.split())


def check(base, ev):
    path = (base / ev["source"]).resolve()
    if not path.exists():
        return False, f"missing file {ev['source']}"
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    line, span = ev["line"], ev.get("span", 0)
    lo, hi = max(line - 1 - WINDOW, 0), min(line + span + WINDOW, len(lines))
    window = norm(" ".join(lines[lo:hi]))
    pos = 0
    for frag in (norm(f) for f in ev["quote"].split("…")):
        idx = window.find(frag, pos)
        if idx < 0:
            first = norm(ev["quote"].split("…")[0])
            hits = [i + 1 for i, l in enumerate(lines) if first[:60] in norm(l)]
            return False, f"fragment not at line {line}: {frag[:70]!r}; first fragment found at {hits[:5]}"
        pos = idx + len(frag)
    return True, ""


def main():
    # -I ignores PYTHONIOENCODING, and the Windows console defaults to cp932.
    sys.stdout.reconfigure(encoding="utf-8")
    base = Path(sys.argv[1])
    data = json.loads((base / "extracts.json").read_text(encoding="utf-8"))
    total = failed = 0
    rows = []
    for item in data["items"]:
        for ev in item["evidence"]:
            total += 1
            ok, msg = check(base, ev)
            if not ok:
                failed += 1
                print(f"NG {item['id']} {ev['source']}:{ev['line']} — {msg}")
        rows.append(item)
    print(f"照合 {'OK' if failed == 0 else 'NG'}: 抜き書き {total} 件中 {total - failed} 件が原文のとおり")
    if "--report" in sys.argv and failed == 0:
        write_report(base, data, Path(sys.argv[sys.argv.index("--report") + 1]))
    return 1 if failed else 0


def write_report(base, data, out):
    counts = {}
    for item in data["items"]:
        counts[item["verdict"]] = counts.get(item["verdict"], 0) + 1
    md = [f"# {data['title']}", "", f"- 照合日: {data['verified_on']}",
          "- 生成: `python -I tools/verify.py . --report verification_report.md`（すべての抜き書きが引用行で原文と一致した場合だけ生成される）",
          "- 判定の内訳: " + "、".join(f"{k} {v} 件" for k, v in counts.items()), "",
          "| 判定 | 意味 |", "| :--- | :--- |"]
    md += [f"| {k} | {v} |" for k, v in data["legend"].items()]
    md.append("")
    for item in data["items"]:
        md += [f"## {item['id']}【{item['verdict']}】", "", item["claim"], ""]
        if not item["evidence"]:
            md += ["- 直接の一次ソースなし（推論。検証フェーズで実測する）", ""]
            continue
        for ev in item["evidence"]:
            md.append(f"- `{ev['source']}:{ev['line']}` — “{ev['quote']}”")
        md.append("")
    out.write_text("\n".join(md) + "\n", encoding="utf-8")
    print(f"report written: {out}")


if __name__ == "__main__":
    sys.exit(main())
