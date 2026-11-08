# Harness benchmark 2026-11-09-lean4-vs-lean-financial

Model deepseek-v4.1-flash (OpenCode Go), effort max; suite tb2-financial (Terminal-Bench 2 financial-document-processor @ 2fd12b88aafd (OCR, classification, CSV), one task); 1 task(s) given in one session per run.
Runs: hy 10, hy-lean4 10.

| Metric | hy mean [95% CI] | hy-lean4 mean [95% CI] | hy-lean4 − hy [95% CI] |
|---|---|---|---|
| Prompt tokens (cached + uncached) | 273,147 [207,891, 338,402] | 282,972 [205,868, 360,077] | 9,826 [-84,398, 104,050] |
| Uncached prompt tokens | 33,838 [20,730, 46,946] | 31,068 [25,447, 36,690] | -2,769 [-16,509, 10,970] |
| Output tokens | 5,698 [4,575, 6,820] | 6,625 [5,697, 7,553] | 927 [-431, 2,286] |
| Cache hit rate (%) | 86.4 [79.7, 93.0] | 88.4 [86.4, 90.3] | 2.0 [-4.9, 8.8] |
| Tool calls | 25 [21, 28] | 24 [21, 27] | -1 [-5, 4] |
| Model requests | 17 [14, 19] | 16 [13, 18] | -1 [-5, 2] |
| Time excl. model wait (min) | 0.08 [0.06, 0.10] | 0.07 [0.06, 0.09] | -0.01 [-0.03, 0.02] |
| Model wait (min) | 1.66 [1.36, 1.96] | 1.63 [1.30, 1.96] | -0.03 [-0.45, 0.39] |
| Time in turns (min) | 1.74 [1.44, 2.04] | 1.70 [1.36, 2.04] | -0.04 [-0.47, 0.39] |
| Wall time (min) | 1.75 [1.45, 2.05] | 1.71 [1.37, 2.06] | -0.04 [-0.47, 0.39] |
| Tool calls written as text (retried) | 0.00 [0.00, 0.00] | 0.20 [-0.10, 0.50] | 0.20 [-0.10, 0.50] |
| Reads of missing paths | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| Solved (exit 0 and every hidden check passed) | 10/10 | 10/10 | – |
| Hidden checks passed | 7.00 [7.00, 7.00] | 7.00 [7.00, 7.00] | 0.00 [0.00, 0.00] |

`*` = the 95% interval of the difference excludes 0.
Time and token intervals are exploratory approximations; success counts are shown without a t interval.
Cache totals and rates are unavailable when any step lacks provider-reported cache data.

## Hidden checks (success rate)

| Check | hy | hy-lean4 |
|---|---|---|
| directories_created | 10/10 | 10/10 |
| invoices_moved_correctly | 10/10 | 10/10 |
| other_documents_moved_correctly | 10/10 | 10/10 |
| summary_csv_exists | 10/10 | 10/10 |
| summary_csv_structure | 10/10 | 10/10 |
| summary_csv_content | 10/10 | 10/10 |
| original_documents_dir_empty | 10/10 | 10/10 |
| reward | 10/10 | 10/10 |

## Runs

| Harness | # | Exit | Checks | Prompt | Uncached | Hit % | Tools | Requests | Turn min |
|---|---|---|---|---|---|---|---|---|---|
| hy | 1 | 0 | 7/7 | 295,244 | 29,004 | 90.18 | 26 | 19 | 1.3 |
| hy-lean4 | 1 | 0 | 7/7 | 427,209 | 36,809 | 91.38 | 26 | 17 | 2.2 |
| hy-lean4 | 2 | 0 | 7/7 | 235,757 | 26,349 | 88.82 | 22 | 15 | 1.6 |
| hy | 2 | 0 | 7/7 | 274,679 | 26,231 | 90.45 | 26 | 17 | 2.0 |
| hy-lean4 | 3 | 0 | 7/7 | 215,526 | 25,958 | 87.96 | 23 | 14 | 1.5 |
| hy | 3 | 0 | 7/7 | 289,446 | 31,398 | 89.15 | 24 | 16 | 1.9 |
| hy-lean4 | 4 | 0 | 7/7 | 206,119 | 25,767 | 87.5 | 19 | 13 | 1.4 |
| hy | 4 | 0 | 7/7 | 366,025 | 30,409 | 91.69 | 24 | 22 | 1.9 |
| hy-lean4 | 5 | 0 | 7/7 | 306,408 | 28,648 | 90.65 | 27 | 19 | 1.7 |
| hy | 5 | 0 | 7/7 | 418,996 | 34,868 | 91.68 | 35 | 20 | 2.2 |
| hy-lean4 | 6 | 0 | 7/7 | 185,307 | 26,587 | 85.65 | 20 | 12 | 1.1 |
| hy | 6 | 0 | 7/7 | 145,739 | 20,811 | 85.72 | 19 | 11 | 1.3 |
| hy | 7 | 0 | 7/7 | 169,040 | 23,504 | 86.1 | 19 | 13 | 1.1 |
| hy-lean4 | 7 | 0 | 7/7 | 316,915 | 50,163 | 84.17 | 25 | 18 | 2.1 |
| hy-lean4 | 8 | 0 | 7/7 | 191,035 | 25,659 | 86.57 | 20 | 12 | 1.2 |
| hy | 8 | 0 | 7/7 | 214,462 | 84,414 | 60.64 | 22 | 16 | 2.1 |
| hy | 9 | 0 | 7/7 | 196,258 | 24,482 | 87.53 | 20 | 14 | 1.4 |
| hy-lean4 | 9 | 0 | 7/7 | 505,540 | 35,780 | 92.92 | 33 | 23 | 2.7 |
| hy-lean4 | 10 | 0 | 7/7 | 239,908 | 28,964 | 87.93 | 22 | 14 | 1.6 |
| hy | 10 | 0 | 7/7 | 361,576 | 33,256 | 90.8 | 30 | 21 | 2.2 |
