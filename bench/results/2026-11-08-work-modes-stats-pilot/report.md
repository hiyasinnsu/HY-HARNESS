# Harness benchmark 2026-11-08-work-modes-stats-pilot

Model deepseek-v4.1-flash (OpenCode Go), effort max; suite stats (small stats library: 4 tasks in one session (implement, bugfix, CLI, docs)); 4 task(s) given in one session per run.
Runs: hy-fast 2, hy-thorough 2, dsh 2.

| Metric | hy-fast mean [95% CI] | hy-thorough mean [95% CI] | dsh mean [95% CI] | hy-fast − dsh [95% CI] |
|---|---|---|---|---|
| Prompt tokens (cached + uncached) | 300,284 [-824,369, 1,424,936] | 758,123 [556,015, 960,230] | 886,016 [-1,397,412, 3,169,443] | -585,732 [-3,131,097, 1,959,633] |
| Uncached prompt tokens | 25,852 [-111,596, 163,299] | 50,539 [18,449, 82,628] | 65,152 [40,750, 89,553] | -39,300 [-178,896, 100,296] |
| Output tokens | 7,486 [-6,605, 21,577] | 20,329 [-4,257, 44,915] | 24,336 [-1,406, 50,078] | -16,850 [-46,197, 12,497] |
| Cache hit rate (%) | 91.7 [76.9, 106.5] | 93.3 [87.3, 99.4] | 92.4 [75.5, 109.3] | -0.6 [-23.1, 21.8] |
| Tool calls | 29 [-35, 93] | 53 [-5, 110] | 50 [-46, 145] | -20 [-135, 94] |
| Model requests | 24 [24, 24] | 29 [22, 35] | 39 [1, 77] | -15 [-53, 23] |
| Time excl. model wait (min) | 0.18 [-0.04, 0.41] | 0.28 [-0.12, 0.67] | 0.47 [-0.49, 1.43] | -0.29 [-1.28, 0.70] |
| Model wait (min) | 1.42 [0.28, 2.57] | 5.17 [-28.61, 38.96] | 6.62 [-21.09, 34.33] | -5.20 [-32.93, 22.54] |
| Time in turns (min) | 1.61 [0.23, 2.98] | 5.45 [-27.94, 38.84] | 7.09 [-19.65, 33.84] | -5.49 [-32.27, 21.29] |
| Wall time (min) | 1.62 [0.16, 3.08] | 5.46 [-27.94, 38.85] | 7.22 [-19.54, 33.97] | -5.60 [-32.39, 21.20] |
| Tool calls written as text (retried) | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| Reads of missing paths | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| Solved (every hidden check passed) | 1.00 [1.00, 1.00] | 1.00 [1.00, 1.00] | 1.00 [1.00, 1.00] | 0.00 [0.00, 0.00] |
| Hidden checks passed | 5.00 [5.00, 5.00] | 5.00 [5.00, 5.00] | 5.00 [5.00, 5.00] | 0.00 [0.00, 0.00] |

`*` = the 95% interval of the difference excludes 0.

## Hidden checks (success rate)

| Check | hy-fast | hy-thorough | dsh |
|---|---|---|---|
| implement | 2/2 | 2/2 | 2/2 |
| bugfix | 2/2 | 2/2 | 2/2 |
| cli | 2/2 | 2/2 | 2/2 |
| docs | 2/2 | 2/2 | 2/2 |
| suite | 2/2 | 2/2 | 2/2 |

## Runs

| Harness | # | Exit | Checks | Prompt | Uncached | Hit % | Tools | Requests | Turn min |
|---|---|---|---|---|---|---|---|---|---|
| hy-fast | 1 | 0 | 5/5 | 388,797 | 36,669 | 90.57 | 34 | 24 | 1.7 |
| hy-thorough | 1 | 0 | 5/5 | 774,029 | 48,013 | 93.8 | 57 | 28 | 2.8 |
| dsh | 1 | 0 | 5/5 | 1,065,728 | 67,072 | 93.71 | 57 | 42 | 5.0 |
| hy-fast | 2 | 0 | 5/5 | 211,770 | 15,034 | 92.9 | 24 | 24 | 1.5 |
| dsh | 2 | 0 | 5/5 | 706,303 | 63,231 | 91.05 | 42 | 36 | 9.2 |
| hy-thorough | 2 | 0 | 5/5 | 742,216 | 53,064 | 92.85 | 48 | 29 | 8.1 |
