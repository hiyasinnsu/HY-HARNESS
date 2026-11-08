# Harness benchmark 2026-11-08-work-modes-financial-confirm-10

Model deepseek-v4.1-flash (OpenCode Go), effort max; suite tb2-financial (Terminal-Bench 2 financial-document-processor @ 2fd12b88aafd (OCR, classification, CSV), one task); 1 task(s) given in one session per run.
Runs: hy-fast 10, dsh 10, hy-thorough 10.

| Metric | hy-fast mean [95% CI] | dsh mean [95% CI] | hy-thorough mean [95% CI] | hy-fast − dsh [95% CI] |
|---|---|---|---|---|
| Prompt tokens (cached + uncached) | 238,578 [143,042, 334,114] | 522,670 [303,429, 741,912] | 644,941 [499,435, 790,447] | -284,092 [-514,469, -53,715] * |
| Uncached prompt tokens | 36,133 [22,174, 50,092] | 46,229 [29,180, 63,278] | 70,874 [34,152, 107,596] | -10,095 [-30,650, 10,459] |
| Output tokens | 6,210 [5,143, 7,277] | 9,389 [7,573, 11,204] | 18,496 [5,733, 31,259] | -3,178 [-5,175, -1,181] * |
| Cache hit rate (%) | 82.5 [73.6, 91.3] | 90.6 [88.2, 93.0] | 88.1 [80.8, 95.5] | -8.1 [-17.1, 0.9] |
| Tool calls | 23 [20, 27] | 29 [23, 36] | 40 [34, 46] | -6 [-13, 1] |
| Model requests | 15 [11, 18] | 22 [17, 27] | 25 [21, 29] | -7 [-13, -1] * |
| Time excl. model wait (min) | 0.13 [0.11, 0.16] | 0.26 [0.21, 0.31] | – [–, –] | -0.13 [-0.18, -0.07] * |
| Model wait (min) | 1.62 [1.25, 2.00] | 2.39 [1.64, 3.15] | 4.41 [2.37, 6.44] | -0.77 [-1.57, 0.03] |
| Time in turns (min) | 1.76 [1.36, 2.16] | 2.65 [1.86, 3.45] | – [–, –] | -0.90 [-1.74, -0.05] * |
| Wall time (min) | 1.76 [1.36, 2.16] | 2.68 [1.89, 3.47] | 5.61 [1.39, 9.83] | -0.92 [-1.76, -0.07] * |
| Tool calls written as text (retried) | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.10 [-0.13, 0.33] | 0.00 [0.00, 0.00] |
| Reads of missing paths | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.10 [-0.13, 0.33] | 0.00 [0.00, 0.00] |
| Solved (exit 0 and every hidden check passed) | 10/10 | 10/10 | 9/10 | – |
| Hidden checks passed | 7.00 [7.00, 7.00] | 7.00 [7.00, 7.00] | 6.30 [4.72, 7.88] | 0.00 [0.00, 0.00] |

`*` = the 95% interval of the difference excludes 0.
Time and token intervals are exploratory approximations; success counts are shown without a t interval.
Cache totals and rates are unavailable when any step lacks provider-reported cache data.

## Hidden checks (success rate)

| Check | hy-fast | dsh | hy-thorough |
|---|---|---|---|
| directories_created | 10/10 | 10/10 | 9/10 |
| invoices_moved_correctly | 10/10 | 10/10 | 9/10 |
| other_documents_moved_correctly | 10/10 | 10/10 | 9/10 |
| summary_csv_exists | 10/10 | 10/10 | 9/10 |
| summary_csv_structure | 10/10 | 10/10 | 9/10 |
| summary_csv_content | 10/10 | 10/10 | 9/10 |
| original_documents_dir_empty | 10/10 | 10/10 | 9/10 |
| reward | 10/10 | 10/10 | 9/10 |

## Runs

| Harness | # | Exit | Checks | Prompt | Uncached | Hit % | Tools | Requests | Turn min |
|---|---|---|---|---|---|---|---|---|---|
| hy-fast | 1 | 0 | 7/7 | 152,295 | 74,087 | 51.35 | 19 | 11 | 1.7 |
| dsh | 1 | 0 | 7/7 | 547,865 | 35,993 | 93.43 | 25 | 26 | 2.4 |
| hy-thorough | 1 | 0 | 7/7 | 698,644 | 85,140 | 87.81 | 52 | 28 | 3.7 |
| hy-fast | 2 | 0 | 7/7 | 213,297 | 27,953 | 86.89 | 24 | 13 | 1.7 |
| dsh | 2 | 0 | 7/7 | 336,469 | 20,309 | 93.96 | 26 | 18 | 1.7 |
| hy-thorough | 2 | 0 | 7/7 | 1,018,396 | 45,724 | 95.51 | 51 | 37 | 4.1 |
| dsh | 3 | 0 | 7/7 | 568,752 | 93,616 | 83.54 | 27 | 26 | 3.5 |
| hy-thorough | 3 | 0 | 7/7 | 606,709 | 39,925 | 93.42 | 40 | 28 | 3.8 |
| hy-fast | 3 | 0 | 7/7 | 177,934 | 21,006 | 88.19 | 19 | 13 | 1.0 |
| hy-fast | 4 | 0 | 7/7 | 173,290 | 23,530 | 86.42 | 23 | 13 | 1.4 |
| dsh | 4 | 0 | 7/7 | 336,283 | 34,459 | 89.75 | 30 | 17 | 2.1 |
| hy-thorough | 4 | 0 | 7/7 | 422,255 | 37,487 | 91.12 | 30 | 20 | 2.9 |
| hy-fast | 5 | 0 | 7/7 | 241,290 | 70,282 | 70.87 | 26 | 15 | 2.6 |
| dsh | 5 | 0 | 7/7 | 404,658 | 46,514 | 88.51 | 29 | 15 | 2.0 |
| hy-thorough | 5 | 0 | 7/7 | 689,818 | 94,874 | 86.25 | 42 | 25 | 5.9 |
| hy-thorough | 6 | 0 | 7/7 | 741,495 | 77,815 | 89.51 | 35 | 20 | 2.9 |
| dsh | 6 | 0 | 7/7 | 800,581 | 74,181 | 90.73 | 34 | 32 | 4.4 |
| hy-fast | 6 | 0 | 7/7 | 218,978 | 28,258 | 87.1 | 23 | 13 | 2.0 |
| hy-fast | 7 | 0 | 7/7 | 181,046 | 25,526 | 85.9 | 21 | 13 | 1.4 |
| dsh | 7 | 0 | 7/7 | 283,844 | 32,708 | 88.48 | 21 | 15 | 2.0 |
| hy-thorough | 7 | 0 | 7/7 | 843,686 | 49,574 | 94.12 | 48 | 30 | 5.1 |
| hy-fast | 8 | 0 | 7/7 | 236,824 | 28,440 | 87.99 | 22 | 16 | 2.0 |
| hy-thorough | 8 | 0 | 7/7 | 604,361 | 47,945 | 92.07 | 43 | 22 | 3.4 |
| dsh | 8 | 0 | 7/7 | 1,268,574 | 66,270 | 94.78 | 53 | 33 | 4.6 |
| dsh | 9 | 0 | 7/7 | 370,505 | 28,489 | 92.31 | 26 | 18 | 1.7 |
| hy-thorough | 9 | 0 | 7/7 | 317,099 | 27,691 | 91.27 | 28 | 17 | 2.1 |
| hy-fast | 9 | 0 | 7/7 | 181,381 | 24,709 | 86.38 | 19 | 13 | 1.1 |
| dsh | 10 | 0 | 7/7 | 309,172 | 29,748 | 90.38 | 22 | 16 | 2.0 |
| hy-fast | 10 | 0 | 7/7 | 609,445 | 37,541 | 93.84 | 36 | 28 | 2.6 |
| hy-thorough | 10 | 1 | 0/7 | 506,950 | 202,566 | 60.04 | 30 | 26 | – (incomplete) |
