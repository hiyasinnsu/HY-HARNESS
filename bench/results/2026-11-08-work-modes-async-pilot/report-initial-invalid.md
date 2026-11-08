# Harness benchmark 2026-11-08-work-modes-async-pilot

Model deepseek-v4.1-flash (OpenCode Go), effort max; suite async-cancel-windows (Windows adaptation of Terminal-Bench 2 cancel-async-tasks; asyncio cancellation replaces POSIX SIGINT); 1 task(s) given in one session per run.
Runs: hy-fast 3, dsh 3, hy-thorough 3.

| Metric | hy-fast mean [95% CI] | dsh mean [95% CI] | hy-thorough mean [95% CI] | hy-fast − dsh [95% CI] |
|---|---|---|---|---|
| Prompt tokens (cached + uncached) | 221,779 [-148,687, 592,244] | 976,526 [408,627, 1,544,424] | 2,151,144 [-312,399, 4,614,686] | -754,747 [-1,256,155, -253,339] * |
| Uncached prompt tokens | 26,792 [-2,216, 55,800] | 62,094 [43,450, 80,738] | 77,458 [-3,950, 158,866] | -35,302 [-60,801, -9,802] * |
| Output tokens | 16,424 [932, 31,916] | 33,340 [7,252, 59,427] | 58,144 [-11,987, 128,276] | -16,916 [-39,352, 5,521] |
| Cache hit rate (%) | 85.1 [69.8, 100.5] | 93.5 [91.3, 95.7] | 96.3 [95.2, 97.4] | -8.4 [-23.9, 7.2] |
| Tool calls | 16 [-7, 38] | 36 [13, 59] | 51 [27, 74] | -21 [-44, 3] |
| Model requests | 15 [-5, 35] | 35 [20, 50] | 44 [28, 61] | -20 [-38, -2] * |
| Time excl. model wait (min) | 0.11 [-0.00, 0.23] | 2.48 [1.46, 3.50] | 0.92 [-1.98, 3.83] | -2.37 [-3.40, -1.34] * |
| Model wait (min) | 4.30 [-3.30, 11.90] | 7.43 [4.79, 10.08] | 10.07 [-0.43, 20.56] | -3.13 [-11.17, 4.91] |
| Time in turns (min) | 4.42 [-3.24, 12.07] | 9.92 [6.39, 13.44] | 6.28 [-9.35, 21.91] | -5.50 [-13.93, 2.93] |
| Wall time (min) | 4.43 [-3.21, 12.07] | 9.94 [6.42, 13.47] | 11.29 [0.05, 22.53] | -5.52 [-13.93, 2.90] |
| Tool calls written as text (retried) | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| Reads of missing paths | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| Solved (every hidden check passed) | 0.67 [-0.77, 2.10] | 1.00 [1.00, 1.00] | 1.00 [1.00, 1.00] | -0.33 [-1.77, 1.10] |
| Hidden checks passed | 4.67 [3.23, 6.10] | 5.00 [5.00, 5.00] | 5.00 [5.00, 5.00] | -0.33 [-1.77, 1.10] |

`*` = the 95% interval of the difference excludes 0.

## Hidden checks (success rate)

| Check | hy-fast | dsh | hy-thorough |
|---|---|---|---|
| file_loads | 3/3 | 3/3 | 3/3 |
| concurrent | 3/3 | 3/3 | 3/3 |
| bounded | 3/3 | 3/3 | 3/3 |
| cancel_active | 3/3 | 3/3 | 3/3 |
| cancel_queued | 2/3 | 3/3 | 3/3 |

## Runs

| Harness | # | Exit | Checks | Prompt | Uncached | Hit % | Tools | Requests | Turn min |
|---|---|---|---|---|---|---|---|---|---|
| hy-fast | 1 | 0 | 5/5 | 246,547 | 33,811 | 86.29 | 15 | 15 | 3.6 |
| dsh | 1 | 0 | 5/5 | 1,106,515 | 65,363 | 94.09 | 47 | 42 | 8.3 |
| hy-thorough | 1 | 0 | 5/5 | 1,118,882 | 46,754 | 95.82 | 41 | 37 | 6.2 |
| hy-fast | 2 | 0 | 5/5 | 356,964 | 33,252 | 90.68 | 25 | 23 | 7.8 |
| dsh | 2 | 0 | 5/5 | 712,581 | 53,509 | 92.49 | 31 | 32 | 10.6 |
| dsh | 3 | 0 | 5/5 | 1,110,481 | 67,409 | 93.93 | 31 | 31 | 10.9 |
| hy-thorough | 2 | 0 | 5/5 | 2,238,141 | 73,661 | 96.71 | 51 | 50 | 12.6 |
| hy-fast | 3 | 0 | 4/5 | 61,825 | 13,313 | 78.47 | 7 | 7 | 1.8 |
| hy-thorough | 3 | null | 5/5 | 3,096,408 | 111,960 | 96.38 | 60 | 46 | 0.0 |
