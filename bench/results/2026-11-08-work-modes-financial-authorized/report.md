# Harness benchmark 2026-11-08-work-modes-financial-authorized

Model deepseek-v4.1-flash (OpenCode Go), effort max; suite tb2-financial (Terminal-Bench 2 financial-document-processor @ 2fd12b88aafd (OCR, classification, CSV), one task); 1 task(s) given in one session per run.
Runs: dsh 2, hy-fast 2, hy-thorough 2.

| Metric | dsh mean [95% CI] | hy-fast mean [95% CI] | hy-thorough mean [95% CI] | hy-thorough − dsh [95% CI] |
|---|---|---|---|---|
| Prompt tokens (cached + uncached) | 443,829 [-2,436,653, 3,324,310] | 235,594 [-723,627, 1,194,814] | 656,256 [-1,978,734, 3,291,245] | 212,427 [-3,691,461, 4,116,315] |
| Uncached prompt tokens | 29,365 [3,527, 55,202] | – [–, –] | – [–, –] | – [–, –] |
| Output tokens | 7,876 [-6,228, 21,980] | 6,524 [-15,845, 28,892] | 14,150 [-49,463, 77,762] | 6,274 [-58,884, 71,431] |
| Cache hit rate (%) | 90.7 [24.8, 156.7] | – [–, –] | – [–, –] | – [–, –] |
| Tool calls | 24 [-40, 88] | 24 [-8, 55] | 38 [-71, 146] | 14 [-112, 139] |
| Model requests | 21 [-93, 135] | 15 [-36, 66] | 26 [-19, 70] | 5 [-118, 127] |
| Time excl. model wait (min) | 0.23 [-0.41, 0.86] | 0.16 [-0.33, 0.64] | 0.26 [-0.82, 1.34] | 0.03 [-1.22, 1.29] |
| Model wait (min) | 1.66 [-1.86, 5.17] | 2.08 [-7.68, 11.84] | 3.48 [-7.55, 14.50] | 1.82 [-9.75, 13.39] |
| Time in turns (min) | 1.89 [-2.27, 6.04] | 2.24 [-8.01, 12.48] | 3.74 [-8.37, 15.84] | 1.85 [-10.95, 14.65] |
| Wall time (min) | 1.91 [-2.21, 6.04] | 2.24 [-8.01, 12.49] | 3.74 [-8.37, 15.85] | 1.83 [-10.96, 14.62] |
| Tool calls written as text (retried) | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| Reads of missing paths | 0.50 [-5.85, 6.85] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | -0.50 [-6.85, 5.85] |
| Solved (exit 0 and every hidden check passed) | 2/2 | 2/2 | 2/2 | – |
| Hidden checks passed | 7.00 [7.00, 7.00] | 7.00 [7.00, 7.00] | 7.00 [7.00, 7.00] | 0.00 [0.00, 0.00] |

`*` = the 95% interval of the difference excludes 0.
Time and token intervals are exploratory approximations; success counts are shown without a t interval.
Cache totals and rates are unavailable when any step lacks provider-reported cache data.

## Hidden checks (success rate)

| Check | dsh | hy-fast | hy-thorough |
|---|---|---|---|
| directories_created | 2/2 | 2/2 | 2/2 |
| invoices_moved_correctly | 2/2 | 2/2 | 2/2 |
| other_documents_moved_correctly | 2/2 | 2/2 | 2/2 |
| summary_csv_exists | 2/2 | 2/2 | 2/2 |
| summary_csv_structure | 2/2 | 2/2 | 2/2 |
| summary_csv_content | 2/2 | 2/2 | 2/2 |
| original_documents_dir_empty | 2/2 | 2/2 | 2/2 |
| reward | 2/2 | 2/2 | 2/2 |

## Runs

| Harness | # | Exit | Checks | Prompt | Uncached | Hit % | Tools | Requests | Turn min |
|---|---|---|---|---|---|---|---|---|---|
| dsh | 1 | 0 | 7/7 | 217,126 | 31,398 | 85.54 | 19 | 12 | 1.6 |
| hy-fast | 1 | 0 | 7/7 | 311,087 | – | – (8/19 steps) | 26 | 19 | 3.0 |
| hy-thorough | 1 | 0 | 7/7 | 448,874 | – | – (21/22 steps) | 29 | 22 | 2.8 |
| dsh | 2 | 0 | 7/7 | 670,531 | 27,331 | 95.92 | 29 | 30 | 2.2 |
| hy-fast | 2 | 0 | 7/7 | 160,100 | – | – (10/11 steps) | 21 | 11 | 1.4 |
| hy-thorough | 2 | 0 | 7/7 | 863,637 | – | – (28/29 steps) | 46 | 29 | 4.7 |
