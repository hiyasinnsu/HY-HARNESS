# Harness benchmark 2026-11-09-lean4-vs-lean-security

Model deepseek-v4.1-flash (OpenCode Go), effort max; suite security-holdout-windows (Windows adaptation of Terminal-Bench 2 fix-code-vulnerability; workspace-relative paths and local Python); 1 task(s) given in one session per run.
Runs: hy 10, hy-lean4 10.

| Metric | hy mean [95% CI] | hy-lean4 mean [95% CI] | hy-lean4 − hy [95% CI] |
|---|---|---|---|
| Prompt tokens (cached + uncached) | 450,180 [334,331, 566,029] | 482,091 [279,732, 684,450] | 31,911 [-189,202, 253,024] |
| Uncached prompt tokens | 37,009 [24,779, 49,239] | 30,840 [24,877, 36,802] | -6,169 [-19,162, 6,824] |
| Output tokens | 7,049 [5,520, 8,578] | 9,539 [6,307, 12,770] | 2,490 [-954, 5,934] |
| Cache hit rate (%) | 91.7 [90.4, 92.9] | 92.5 [90.9, 94.2] | 0.9 [-1.1, 2.8] |
| Tool calls | 29 [24, 34] | 33 [28, 38] | 4 [-3, 10] |
| Model requests | 20 [17, 23] | 22 [18, 26] | 2 [-3, 7] |
| Time excl. model wait (min) | 0.52 [0.15, 0.90] | 0.67 [0.31, 1.04] | 0.15 [-0.34, 0.64] |
| Model wait (min) | 1.47 [1.07, 1.87] | 1.93 [1.11, 2.75] | 0.46 [-0.42, 1.34] |
| Time in turns (min) | 2.00 [1.30, 2.69] | 2.60 [1.66, 3.55] | 0.61 [-0.49, 1.71] |
| Wall time (min) | 2.00 [1.31, 2.69] | 2.61 [1.66, 3.56] | 0.61 [-0.49, 1.71] |
| Tool calls written as text (retried) | 0.20 [-0.10, 0.50] | 0.10 [-0.13, 0.33] | -0.10 [-0.45, 0.25] |
| Reads of missing paths | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| Solved (exit 0 and every hidden check passed) | 10/10 | 10/10 | – |
| Hidden checks passed | 7.00 [7.00, 7.00] | 7.00 [7.00, 7.00] | 0.00 [0.00, 0.00] |

`*` = the 95% interval of the difference excludes 0.
Time and token intervals are exploratory approximations; success counts are shown without a t interval.
Cache totals and rates are unavailable when any step lacks provider-reported cache data.

## Hidden checks (success rate)

| Check | hy | hy-lean4 |
|---|---|---|
| original_repo_tests | 10/10 | 10/10 |
| report_file_exists_example | 10/10 | 10/10 |
| vul_file | 10/10 | 10/10 |
| cwe_id | 10/10 | 10/10 |
| hkey_basic_cases | 10/10 | 10/10 |
| hkey_error_cases | 10/10 | 10/10 |
| hkey_real_world_examples | 10/10 | 10/10 |
| reward | 10/10 | 10/10 |

## Runs

| Harness | # | Exit | Checks | Prompt | Uncached | Hit % | Tools | Requests | Turn min |
|---|---|---|---|---|---|---|---|---|---|
| hy | 1 | 0 | 7/7 | 512,603 | 44,123 | 91.39 | 26 | 17 | 1.8 |
| hy-lean4 | 1 | 0 | 7/7 | 556,970 | 40,106 | 92.8 | 36 | 25 | 3.0 |
| hy | 2 | 0 | 7/7 | 281,850 | 26,106 | 90.74 | 26 | 17 | 1.2 |
| hy-lean4 | 2 | 0 | 7/7 | 258,728 | 25,512 | 90.14 | 27 | 17 | 1.9 |
| hy | 3 | 0 | 7/7 | 421,908 | 28,180 | 93.32 | 32 | 23 | 1.5 |
| hy-lean4 | 3 | 0 | 7/7 | 487,320 | 29,208 | 94.01 | 33 | 24 | 3.1 |
| hy-lean4 | 4 | 0 | 7/7 | 253,283 | 22,243 | 91.22 | 23 | 17 | 1.1 |
| hy | 4 | 0 | 7/7 | 612,331 | 41,963 | 93.15 | 43 | 28 | 2.2 |
| hy | 5 | 0 | 7/7 | 287,214 | 25,838 | 91 | 22 | 16 | 1.5 |
| hy-lean4 | 5 | 0 | 7/7 | 280,228 | 27,940 | 90.03 | 28 | 17 | 2.0 |
| hy | 6 | 0 | 7/7 | 517,200 | 32,592 | 93.7 | 31 | 21 | 3.8 |
| hy-lean4 | 6 | 0 | 7/7 | 1,108,633 | 46,105 | 95.84 | 42 | 30 | 5.7 |
| hy-lean4 | 7 | 0 | 7/7 | 197,528 | 21,912 | 88.91 | 25 | 15 | 1.0 |
| hy | 7 | 0 | 7/7 | 713,724 | 80,892 | 88.67 | 30 | 24 | 2.6 |
| hy | 8 | 0 | 7/7 | 362,884 | 35,588 | 90.19 | 20 | 15 | 1.2 |
| hy-lean4 | 8 | 0 | 7/7 | 418,042 | 27,386 | 93.45 | 37 | 25 | 2.6 |
| hy-lean4 | 9 | 0 | 7/7 | 788,540 | 40,380 | 94.88 | 42 | 27 | 3.0 |
| hy | 9 | 0 | 7/7 | 573,186 | 34,562 | 93.97 | 38 | 25 | 3.3 |
| hy | 10 | 0 | 7/7 | 218,901 | 20,245 | 90.75 | 23 | 16 | 0.9 |
| hy-lean4 | 10 | 0 | 7/7 | 471,638 | 27,606 | 94.15 | 35 | 25 | 2.5 |
