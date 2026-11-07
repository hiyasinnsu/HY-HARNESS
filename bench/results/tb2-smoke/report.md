# Harness benchmark tb2-smoke

Model deepseek-v4.1-flash (OpenCode Go), effort max; suite tb2-financial (Terminal-Bench 2 financial-document-processor @ 2fd12b88aafd (OCR, classification, CSV), one task); 1 task(s) given in one session per run.
Runs: dsh 1, hy 1.

| Metric | dsh mean [95% CI] | hy mean [95% CI] | hy − dsh [95% CI] |
|---|---|---|---|
| Prompt tokens (cached + uncached) | 465,291 [–, –] | 3,585,971 [–, –] | – |
| Uncached prompt tokens | 29,323 [–, –] | 545,247 [–, –] | – |
| Output tokens | 9,571 [–, –] | 37,565 [–, –] | – |
| Cache hit rate (%) | 93.7 [–, –] | 84.8 [–, –] | – |
| Tool calls | 24 [–, –] | 98 [–, –] | – |
| Model requests | 25 [–, –] | 93 [–, –] | – |
| Time excl. model wait (min) | 0.18 [–, –] | 15.78 [–, –] | – |
| Model wait (min) | 2.39 [–, –] | 7.26 [–, –] | – |
| Time in turns (min) | 2.56 [–, –] | 23.04 [–, –] | – |
| Wall time (min) | 2.62 [–, –] | 23.05 [–, –] | – |
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
| dsh | 1 | 0 | 7/7 | 465,291 | 29,323 | 93.7 | 24 | 25 | 2.6 |
| hy | 1 | 0 | 7/7 | 3,585,971 | 545,247 | 84.79 | 98 | 93 | 23.0 |
