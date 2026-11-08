# Harness benchmark 2026-11-08-work-modes-async-ntfs

Model deepseek-v4.1-flash (OpenCode Go), effort max; suite async-cancel-windows (Windows adaptation of Terminal-Bench 2 cancel-async-tasks; asyncio cancellation replaces POSIX SIGINT); 1 task(s) given in one session per run.
Runs: hy-fast 2, dsh 2, hy-thorough 2.

| Metric | hy-fast mean [95% CI] | dsh mean [95% CI] | hy-thorough mean [95% CI] | hy-fast − dsh [95% CI] |
|---|---|---|---|---|
| Prompt tokens (cached + uncached) | 382,813 [-18,722, 784,348] | 1,118,269 [-4,365,043, 6,601,581] | 2,150,650 [-15,654, 4,316,953] | -735,456 [-6,233,451, 4,762,539] |
| Uncached prompt tokens | – [–, –] | 31,229 [-111,879, 174,337] | – [–, –] | – [–, –] |
| Output tokens | 18,456 [-20,571, 57,482] | 36,340 [-121,583, 194,263] | 54,538 [50,726, 58,350] | -17,884 [-180,558, 144,789] |
| Cache hit rate (%) | – [–, –] | 96.3 [65.1, 127.4] | – [–, –] | – [–, –] |
| Tool calls | 23 [16, 29] | 32 [-57, 121] | 63 [-20, 145] | -9 [-99, 80] |
| Model requests | 22 [2, 41] | 33 [-56, 122] | 53 [15, 91] | -11 [-102, 79] |
| Time excl. model wait (min) | 0.13 [-0.15, 0.40] | 0.50 [-1.24, 2.25] | 0.73 [-1.42, 2.88] | -0.38 [-2.14, 1.39] |
| Model wait (min) | 2.73 [-3.28, 8.73] | 5.17 [-10.19, 20.53] | 6.07 [4.16, 7.98] | -2.45 [-18.94, 14.05] |
| Time in turns (min) | 2.85 [-2.88, 8.58] | 5.67 [-11.43, 22.78] | 6.80 [6.56, 7.04] | -2.82 [-20.86, 15.22] |
| Wall time (min) | 2.86 [-2.90, 8.62] | 5.71 [-11.52, 22.94] | 6.81 [6.56, 7.05] | -2.85 [-21.02, 15.32] |
| Tool calls written as text (retried) | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.50 [-5.85, 6.85] | 0.00 [0.00, 0.00] |
| Reads of missing paths | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| Solved (exit 0 and every hidden check passed) | 2/2 | 2/2 | 2/2 | – |
| Hidden checks passed | 5.00 [5.00, 5.00] | 5.00 [5.00, 5.00] | 5.00 [5.00, 5.00] | 0.00 [0.00, 0.00] |

`*` = the 95% interval of the difference excludes 0.
Time and token intervals are exploratory approximations; success counts are shown without a t interval.
Cache totals and rates are unavailable when any step lacks provider-reported cache data.

## Hidden checks (success rate)

| Check | hy-fast | dsh | hy-thorough |
|---|---|---|---|
| file_loads | 2/2 | 2/2 | 2/2 |
| concurrent | 2/2 | 2/2 | 2/2 |
| bounded | 2/2 | 2/2 | 2/2 |
| cancel_active | 2/2 | 2/2 | 2/2 |
| cancel_queued | 2/2 | 2/2 | 2/2 |

## Runs

| Harness | # | Exit | Checks | Prompt | Uncached | Hit % | Tools | Requests | Turn min |
|---|---|---|---|---|---|---|---|---|---|
| hy-fast | 1 | 0 | 5/5 | 414,415 | – | – (22/23 steps) | 23 | 23 | 3.3 |
| dsh | 1 | 0 | 5/5 | 1,549,822 | 19,966 | 98.71 | 39 | 40 | 7.0 |
| hy-thorough | 1 | 0 | 5/5 | 2,321,144 | – | – (55/56 steps) | 69 | 56 | 6.8 |
| dsh | 2 | 0 | 5/5 | 686,716 | 42,492 | 93.81 | 25 | 26 | 4.3 |
| hy-fast | 2 | 0 | 5/5 | 351,211 | – | – (19/20 steps) | 22 | 20 | 2.4 |
| hy-thorough | 2 | 0 | 5/5 | 1,980,155 | – | – (49/50 steps) | 56 | 50 | 6.8 |
