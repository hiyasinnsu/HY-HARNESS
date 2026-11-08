# Harness benchmark 2026-11-08-thorough-recheck-financial

Model deepseek-v4.1-flash (OpenCode Go), effort max; suite tb2-financial (Terminal-Bench 2 financial-document-processor @ 2fd12b88aafd (OCR, classification, CSV), one task); 1 task(s) given in one session per run.
Runs: hy-thorough 10.

| Metric | hy-thorough mean [95% CI] |
|---|---|
| Prompt tokens (cached + uncached) | 632,421 [426,708, 838,135] |
| Uncached prompt tokens | 48,196 [34,800, 61,591] |
| Output tokens | 12,838 [10,504, 15,171] |
| Cache hit rate (%) | 91.7 [90.2, 93.3] |
| Tool calls | 43 [35, 50] |
| Model requests | 26 [21, 32] |
| Time excl. model wait (min) | 0.13 [0.10, 0.16] |
| Model wait (min) | 3.59 [2.57, 4.60] |
| Time in turns (min) | 3.71 [2.68, 4.74] |
| Wall time (min) | 3.72 [2.69, 4.75] |
| Tool calls written as text (retried) | 0.10 [-0.13, 0.33] |
| Reads of missing paths | 0.00 [0.00, 0.00] |
| Solved (exit 0 and every hidden check passed) | 10/10 |
| Hidden checks passed | 7.00 [7.00, 7.00] |

`*` = the 95% interval of the difference excludes 0.
Time and token intervals are exploratory approximations; success counts are shown without a t interval.
Cache totals and rates are unavailable when any step lacks provider-reported cache data.

## Hidden checks (success rate)

| Check | hy-thorough |
|---|---|
| directories_created | 10/10 |
| invoices_moved_correctly | 10/10 |
| other_documents_moved_correctly | 10/10 |
| summary_csv_exists | 10/10 |
| summary_csv_structure | 10/10 |
| summary_csv_content | 10/10 |
| original_documents_dir_empty | 10/10 |
| reward | 10/10 |

## Runs

| Harness | # | Exit | Checks | Prompt | Uncached | Hit % | Tools | Requests | Turn min |
|---|---|---|---|---|---|---|---|---|---|
| hy-thorough | 1 | 0 | 7/7 | 694,536 | 51,336 | 92.61 | 47 | 26 | 4.1 |
| hy-thorough | 2 | 0 | 7/7 | 1,124,511 | 93,343 | 91.7 | 54 | 38 | 7.2 |
| hy-thorough | 3 | 0 | 7/7 | 908,271 | 59,759 | 93.42 | 49 | 37 | 4.0 |
| hy-thorough | 4 | 0 | 7/7 | 625,217 | 40,001 | 93.6 | 46 | 26 | 3.6 |
| hy-thorough | 5 | 0 | 7/7 | 696,806 | 47,974 | 93.12 | 51 | 25 | 3.9 |
| hy-thorough | 6 | 0 | 7/7 | 327,794 | 31,218 | 90.48 | 32 | 19 | 1.8 |
| hy-thorough | 7 | 0 | 7/7 | 589,935 | 46,879 | 92.05 | 41 | 28 | 3.4 |
| hy-thorough | 8 | 0 | 7/7 | 266,071 | 30,423 | 88.57 | 27 | 16 | 2.4 |
| hy-thorough | 9 | 0 | 7/7 | 250,455 | 30,935 | 87.65 | 28 | 16 | 2.7 |
| hy-thorough | 10 | 0 | 7/7 | 840,617 | 50,089 | 94.04 | 51 | 30 | 4.1 |
