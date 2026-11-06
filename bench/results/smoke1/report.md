# Harness benchmark smoke1

Model deepseek-v4.1-flash (OpenCode Go), effort max; 4 tasks given in one session per run.
Runs: hy 1, dsh 1.

| Metric | hy mean [95% CI] | dsh mean [95% CI] | HY − DSH [95% CI] |
|---|---|---|---|
| Prompt tokens (cached + uncached) | 630,082 [–, –] | 965,330 [–, –] | – |
| Uncached prompt tokens | 28,610 [–, –] | 17,362 [–, –] | – |
| Output tokens | 19,170 [–, –] | 25,914 [–, –] | – |
| Cache hit rate (%) | 95.5 [–, –] | 98.2 [–, –] | – |
| Tool calls | 50 [–, –] | 52 [–, –] | – |
| Model requests | 34 [–, –] | 35 [–, –] | – |
| Time in turns (min) | 2.82 [–, –] | 3.42 [–, –] | – |
| Wall time (min) | 2.85 [–, –] | 3.60 [–, –] | – |
| Hidden checks passed (of 5) | 5.00 [–, –] | 5.00 [–, –] | – |

`*` = the 95% interval of the difference excludes 0.

## Hidden checks (success rate)

| Check | hy | dsh |
|---|---|---|
| implement | 1/1 | 1/1 |
| bugfix | 1/1 | 1/1 |
| cli | 1/1 | 1/1 |
| docs | 1/1 | 1/1 |
| suite | 1/1 | 1/1 |

## Runs

| Harness | # | Exit | Checks | Prompt | Uncached | Hit % | Tools | Requests | Turn min |
|---|---|---|---|---|---|---|---|---|---|
| hy | 1 | 0 | 5/5 | 630,082 | 28,610 | 95.46 | 50 | 34 | 2.8 |
| dsh | 1 | 0 | 5/5 | 965,330 | 17,362 | 98.2 | 52 | 35 | 3.4 |
