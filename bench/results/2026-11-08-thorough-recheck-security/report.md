# Harness benchmark 2026-11-08-thorough-recheck-security

Model deepseek-v4.1-flash (OpenCode Go), effort max; suite security-holdout-windows (Windows adaptation of Terminal-Bench 2 fix-code-vulnerability; workspace-relative paths and local Python); 1 task(s) given in one session per run.
Runs: hy-thorough 10.

| Metric | hy-thorough mean [95% CI] |
|---|---|
| Prompt tokens (cached + uncached) | 1,864,622 [1,247,848, 2,481,396] |
| Uncached prompt tokens | 80,410 [63,489, 97,331] |
| Output tokens | 17,212 [12,475, 21,948] |
| Cache hit rate (%) | 94.8 [93.0, 96.6] |
| Tool calls | 54 [44, 64] |
| Model requests | 41 [32, 49] |
| Time excl. model wait (min) | 1.47 [0.65, 2.29] |
| Model wait (min) | 4.58 [3.08, 6.08] |
| Time in turns (min) | 6.05 [4.13, 7.97] |
| Wall time (min) | 6.06 [4.14, 7.99] |
| Tool calls written as text (retried) | 0.50 [0.12, 0.88] |
| Reads of missing paths | 0.00 [0.00, 0.00] |
| Solved (exit 0 and every hidden check passed) | 8/10 |
| Hidden checks passed | 6.20 [4.95, 7.45] |

`*` = the 95% interval of the difference excludes 0.
Time and token intervals are exploratory approximations; success counts are shown without a t interval.
Cache totals and rates are unavailable when any step lacks provider-reported cache data.

## Hidden checks (success rate)

| Check | hy-thorough |
|---|---|
| original_repo_tests | 9/10 |
| report_file_exists_example | 8/10 |
| vul_file | 8/10 |
| cwe_id | 8/10 |
| hkey_basic_cases | 10/10 |
| hkey_error_cases | 9/10 |
| hkey_real_world_examples | 10/10 |
| reward | 8/10 |

## Runs

| Harness | # | Exit | Checks | Prompt | Uncached | Hit % | Tools | Requests | Turn min |
|---|---|---|---|---|---|---|---|---|---|
| hy-thorough | 1 | 0 | 4/7 | 2,019,453 | 67,837 | 96.64 | 56 | 45 | 5.2 |
| hy-thorough | 2 | 0 | 7/7 | 2,738,208 | 107,296 | 96.08 | 64 | 50 | 6.5 |
| hy-thorough | 3 | 0 | 7/7 | 2,038,820 | 61,860 | 96.97 | 55 | 39 | 2.8 |
| hy-thorough | 4 | 0 | 2/7 | 319,955 | 36,691 | 88.53 | 23 | 17 | 1.8 |
| hy-thorough | 5 | 0 | 7/7 | 1,857,569 | 102,177 | 94.5 | 63 | 51 | 11.1 |
| hy-thorough | 6 | 0 | 7/7 | 2,419,751 | 89,049 | 96.32 | 62 | 48 | 6.6 |
| hy-thorough | 7 | 0 | 7/7 | 1,040,818 | 66,226 | 93.64 | 47 | 32 | 6.3 |
| hy-thorough | 8 | 0 | 7/7 | 1,068,760 | 72,152 | 93.25 | 40 | 29 | 4.7 |
| hy-thorough | 9 | 0 | 7/7 | 3,230,366 | 112,286 | 96.52 | 75 | 57 | 8.6 |
| hy-thorough | 10 | 0 | 7/7 | 1,912,524 | 88,524 | 95.37 | 55 | 39 | 7.0 |
