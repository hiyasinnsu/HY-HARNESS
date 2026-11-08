# Harness benchmark 2026-11-08-vision-smoke

Model deepseek-v4.1-flash (OpenCode Go), effort max; suite tb2-financial (Terminal-Bench 2 financial-document-processor @ 2fd12b88aafd (OCR, classification, CSV), one task); 1 task(s) given in one session per run.
Runs: dsh 1, hy 1.

| Metric | dsh mean [95% CI] | hy mean [95% CI] | hy − dsh [95% CI] |
|---|---|---|---|
| Prompt tokens (cached + uncached) | 625,660 [–, –] | 264,771 [–, –] | – |
| Uncached prompt tokens | 28,540 [–, –] | 26,435 [–, –] | – |
| Output tokens | 9,345 [–, –] | 6,825 [–, –] | – |
| Cache hit rate (%) | 95.4 [–, –] | 90.0 [–, –] | – |
| Tool calls | 35 [–, –] | 33 [–, –] | – |
| Model requests | 25 [–, –] | 20 [–, –] | – |
| Time excl. model wait (min) | 0.30 [–, –] | 0.17 [–, –] | – |
| Model wait (min) | 2.01 [–, –] | 3.52 [–, –] | – |
| Time in turns (min) | 2.31 [–, –] | 3.69 [–, –] | – |
| Wall time (min) | 2.35 [–, –] | 3.71 [–, –] | – |
| Tool calls written as text (retried) | 0.00 [–, –] | 0.00 [–, –] | – |
| Reads of missing paths | 0.00 [–, –] | 0.00 [–, –] | – |
| Solved (every hidden check passed) | 1.00 [–, –] | 1.00 [–, –] | – |
| Hidden checks passed | 7.00 [–, –] | 7.00 [–, –] | – |

`*` = the 95% interval of the difference excludes 0.

## Hidden checks (success rate)

| Check | dsh | hy |
|---|---|---|
| directories_created | 1/1 | 1/1 |
| invoices_moved_correctly | 1/1 | 1/1 |
| other_documents_moved_correctly | 1/1 | 1/1 |
| summary_csv_exists | 1/1 | 1/1 |
| summary_csv_structure | 1/1 | 1/1 |
| summary_csv_content | 1/1 | 1/1 |
| original_documents_dir_empty | 1/1 | 1/1 |
| reward | 1/1 | 1/1 |

## Runs

| Harness | # | Exit | Checks | Prompt | Uncached | Hit % | Tools | Requests | Turn min |
|---|---|---|---|---|---|---|---|---|---|
| dsh | 1 | 0 | 7/7 | 625,660 | 28,540 | 95.44 | 35 | 25 | 2.3 |
| hy | 1 | 0 | 7/7 | 264,771 | 26,435 | 90.02 | 33 | 20 | 3.7 |
