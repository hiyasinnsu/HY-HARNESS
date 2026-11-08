# Harness benchmark 2026-11-08-thorough-recheck2-security

Model deepseek-v4.1-flash (OpenCode Go), effort max; suite security-holdout-windows (Windows adaptation of Terminal-Bench 2 fix-code-vulnerability; workspace-relative paths and local Python); 1 task(s) given in one session per run.
Runs: hy-thorough 10.

| Metric | hy-thorough mean [95% CI] |
|---|---|
| Prompt tokens (cached + uncached) | 1,922,675 [1,336,866, 2,508,483] |
| Uncached prompt tokens | 69,235 [57,024, 81,446] |
| Output tokens | 22,230 [16,621, 27,839] |
| Cache hit rate (%) | 96.0 [95.0, 96.9] |
| Tool calls | 62 [51, 74] |
| Model requests | 43 [34, 52] |
| Time excl. model wait (min) | 1.17 [0.68, 1.67] |
| Model wait (min) | 4.15 [2.96, 5.33] |
| Time in turns (min) | 5.32 [4.01, 6.63] |
| Wall time (min) | 5.33 [4.01, 6.64] |
| Tool calls written as text (retried) | 0.20 [-0.10, 0.50] |
| Reads of missing paths | 0.00 [0.00, 0.00] |
| Solved (exit 0 and every hidden check passed) | 10/10 |
| Hidden checks passed | 7.00 [7.00, 7.00] |

`*` = the 95% interval of the difference excludes 0.
Time and token intervals are exploratory approximations; success counts are shown without a t interval.
Cache totals and rates are unavailable when any step lacks provider-reported cache data.

## Hidden checks (success rate)

| Check | hy-thorough |
|---|---|
| original_repo_tests | 10/10 |
| report_file_exists_example | 10/10 |
| vul_file | 10/10 |
| cwe_id | 10/10 |
| hkey_basic_cases | 10/10 |
| hkey_error_cases | 10/10 |
| hkey_real_world_examples | 10/10 |
| reward | 10/10 |

## Runs

| Harness | # | Exit | Checks | Prompt | Uncached | Hit % | Tools | Requests | Turn min |
|---|---|---|---|---|---|---|---|---|---|
| hy-thorough | 1 | 0 | 7/7 | 1,349,036 | 61,100 | 95.47 | 60 | 38 | 4.3 |
| hy-thorough | 2 | 0 | 7/7 | 2,364,463 | 79,791 | 96.63 | 73 | 53 | 6.0 |
| hy-thorough | 3 | 0 | 7/7 | 2,060,515 | 80,355 | 96.1 | 57 | 40 | 4.7 |
| hy-thorough | 4 | 0 | 7/7 | 643,338 | 45,962 | 92.86 | 38 | 24 | 2.8 |
| hy-thorough | 5 | 0 | 7/7 | 1,296,376 | 68,344 | 94.73 | 43 | 29 | 2.9 |
| hy-thorough | 6 | 0 | 7/7 | 3,258,236 | 88,060 | 97.3 | 67 | 55 | 6.2 |
| hy-thorough | 7 | 0 | 7/7 | 2,451,185 | 85,617 | 96.51 | 73 | 50 | 7.6 |
| hy-thorough | 8 | 0 | 7/7 | 2,621,128 | 84,552 | 96.77 | 91 | 61 | 8.4 |
| hy-thorough | 9 | 0 | 7/7 | 2,180,086 | 57,206 | 97.38 | 72 | 47 | 5.8 |
| hy-thorough | 10 | 0 | 7/7 | 1,002,384 | 41,360 | 95.87 | 49 | 31 | 4.4 |
