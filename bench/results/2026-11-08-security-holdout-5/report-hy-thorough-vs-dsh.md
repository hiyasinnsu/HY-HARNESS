# Harness benchmark 2026-11-08-security-holdout-5

Model deepseek-v4.1-flash (OpenCode Go), effort max; suite security-holdout-windows (Windows adaptation of Terminal-Bench 2 fix-code-vulnerability; workspace-relative paths and local Python); 1 task(s) given in one session per run.
Runs: dsh 5, hy-fast 5, hy-thorough 5.

| Metric | dsh mean [95% CI] | hy-fast mean [95% CI] | hy-thorough mean [95% CI] | hy-thorough − dsh [95% CI] |
|---|---|---|---|---|
| Prompt tokens (cached + uncached) | 1,007,542 [342,451, 1,672,633] | 662,599 [93,657, 1,231,541] | 1,677,985 [131,194, 3,224,775] | 670,443 [-888,938, 2,229,823] |
| Uncached prompt tokens | 68,944 [38,785, 99,102] | 48,941 [13,204, 84,679] | 72,609 [43,671, 101,546] | 3,665 [-31,943, 39,273] |
| Output tokens | 9,265 [4,669, 13,861] | 10,464 [1,799, 19,129] | 18,049 [12,326, 23,773] | 8,784 [2,531, 15,038] * |
| Cache hit rate (%) | 92.5 [89.7, 95.2] | 92.0 [90.1, 94.0] | 94.7 [92.6, 96.8] | 2.2 [-0.7, 5.2] |
| Tool calls | 38 [25, 50] | 32 [22, 42] | 55 [33, 77] | 18 [-5, 40] |
| Model requests | 26 [17, 35] | 22 [15, 29] | 35 [22, 48] | 9 [-4, 23] |
| Time excl. model wait (min) | 0.99 [-0.07, 2.05] | 0.59 [-0.01, 1.19] | 1.65 [0.77, 2.52] | 0.66 [-0.51, 1.83] |
| Model wait (min) | 2.38 [1.12, 3.63] | 2.34 [0.13, 4.56] | 3.89 [2.52, 5.26] | 1.51 [-0.07, 3.10] |
| Time in turns (min) | 3.36 [2.05, 4.68] | 2.93 [0.37, 5.50] | 5.53 [3.86, 7.21] | 2.17 [0.36, 3.98] * |
| Wall time (min) | 3.39 [2.07, 4.71] | 2.94 [0.37, 5.50] | 5.54 [3.87, 7.21] | 2.15 [0.33, 3.96] * |
| Tool calls written as text (retried) | 0.00 [0.00, 0.00] | 0.20 [-0.36, 0.76] | 0.20 [-0.36, 0.76] | 0.20 [-0.36, 0.76] |
| Reads of missing paths | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| Solved (exit 0 and every hidden check passed) | 5/5 | 5/5 | 4/5 | – |
| Hidden checks passed | 7.00 [7.00, 7.00] | 7.00 [7.00, 7.00] | 6.40 [4.73, 8.07] | -0.60 [-2.27, 1.07] |

`*` = the 95% interval of the difference excludes 0.
Time and token intervals are exploratory approximations; success counts are shown without a t interval.
Cache totals and rates are unavailable when any step lacks provider-reported cache data.

## Hidden checks (success rate)

| Check | dsh | hy-fast | hy-thorough |
|---|---|---|---|
| original_repo_tests | 5/5 | 5/5 | 5/5 |
| report_file_exists_example | 5/5 | 5/5 | 4/5 |
| vul_file | 5/5 | 5/5 | 4/5 |
| cwe_id | 5/5 | 5/5 | 4/5 |
| hkey_basic_cases | 5/5 | 5/5 | 5/5 |
| hkey_error_cases | 5/5 | 5/5 | 5/5 |
| hkey_real_world_examples | 5/5 | 5/5 | 5/5 |
| reward | 5/5 | 5/5 | 4/5 |

## Runs

| Harness | # | Exit | Checks | Prompt | Uncached | Hit % | Tools | Requests | Turn min |
|---|---|---|---|---|---|---|---|---|---|
| dsh | 1 | 0 | 7/7 | 1,747,299 | 84,707 | 95.15 | 50 | 32 | 4.2 |
| hy-fast | 1 | 0 | 7/7 | 1,266,836 | 73,236 | 94.22 | 43 | 30 | 6.0 |
| hy-thorough | 1 | 0 | 7/7 | 760,395 | 53,067 | 93.02 | 40 | 27 | 7.7 |
| dsh | 2 | 0 | 7/7 | 1,395,301 | 99,301 | 92.88 | 47 | 35 | 4.3 |
| hy-thorough | 2 | 0 | 7/7 | 810,232 | 50,168 | 93.81 | 44 | 29 | 4.4 |
| hy-fast | 2 | 0 | 7/7 | 1,042,839 | 86,807 | 91.68 | 37 | 26 | 3.1 |
| hy-fast | 3 | 0 | 7/7 | 264,980 | 27,028 | 89.8 | 22 | 16 | 0.9 |
| dsh | 3 | 0 | 7/7 | 702,351 | 71,311 | 89.85 | 28 | 19 | 2.3 |
| hy-thorough | 3 | 0 | 7/7 | 1,974,862 | 83,406 | 95.78 | 55 | 36 | 4.3 |
| hy-fast | 4 | 0 | 7/7 | 361,865 | 28,297 | 92.18 | 32 | 21 | 3.4 |
| dsh | 4 | 0 | 7/7 | 694,313 | 42,537 | 93.87 | 33 | 24 | 3.9 |
| hy-thorough | 4 | 0 | 4/7 | 1,114,815 | 69,695 | 93.75 | 53 | 31 | 5.5 |
| dsh | 5 | 0 | 7/7 | 498,446 | 46,862 | 90.6 | 30 | 20 | 2.1 |
| hy-fast | 5 | 0 | 7/7 | 376,475 | 29,339 | 92.21 | 26 | 19 | 1.2 |
| hy-thorough | 5 | 0 | 7/7 | 3,729,619 | 106,707 | 97.14 | 85 | 53 | 5.8 |
