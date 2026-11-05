# Working with Office documents (WP-52)

You are about to create or change a document the user will open outside the
editor (`.docx`, `.xlsx`, `.pptx`, or a PDF). Follow this order.

## 1. Check what is available

```powershell
# A converter is optional; the harness previews Office files only when it exists.
Get-Command soffice -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
```

If LibreOffice is not installed, say so in the final answer instead of writing a
broken file: the GUI can still show the bytes, but it cannot render them.

## 2. Prefer a real library over hand-written XML

Use the workspace's own toolchain when Python is available:

```powershell
python -c "import docx, openpyxl, pptx; print('ok')"   # python-docx / openpyxl / python-pptx
```

- Word: `python-docx` (`Document()`, `add_heading`, `add_paragraph`, tables).
- Excel: `openpyxl` (`Workbook()`, `active.append([...])`, number formats).
- PowerPoint: `python-pptx` (`Presentation()`, `slide_layouts`, `shapes.add_textbox`).

When the library is missing, `pip install --user python-docx openpyxl python-pptx`
is acceptable **only** if the user asked for the document; otherwise ask.

## 3. Keep the source next to the artifact

Write a small script (`make_report.py`) and run it, so the document can be
rebuilt. Do not edit the `.docx` by hand.

## 4. Verify before presenting

```powershell
# The same conversion the GUI uses; it fails loudly when LibreOffice is missing.
python -c "import sys; print('preview:', sys.argv[1])" report.docx
```

- Re-open the file with the library that wrote it and assert the text you expect.
- Check size and page/sheet count rather than trusting the write.

## 5. Present the artifact

Call `present` with the file so the GUI shows a card with **Preview**
(PDFs and images render directly; Office files are converted when LibreOffice is
installed, cached by content hash, and the conversion error is shown otherwise).

## Failure handling

- Conversion failure: report the command, the exit code and the last stderr lines
  in the final answer. Do not claim the document is ready.
- A missing `soffice` is not a failure of your work: say that the file is valid
  but cannot be previewed on this machine, and offer the PDF route instead
  (`soffice --headless --convert-to pdf` once it is installed).
