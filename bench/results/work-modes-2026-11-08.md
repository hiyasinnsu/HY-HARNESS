# Work mode investigation, 2026-11-08

The goal was to improve general behavior: Fast should complete the whole task promptly after essential, risk-appropriate checks; Thorough should investigate relevant details and failure paths and then deliver. Tool-specific syntax and recovery belong in tool descriptions or errors, not the system prompt. Every live trial used `opencode/deepseek-v4.1-flash` at max worker effort; the recorded HY step logs identify the actual model.

## Exploratory trials and failures

- `2026-11-08-work-modes-stats-pilot`: two runs per harness on a small statistics task; all passed the original five checks. A later, separately recorded edge check found that all six implementations returned infinity for the median of two maximum finite values. This post-hoc result was not substituted into the original score. DSH encountered F: hard-link failures and one restricted test-process launch.
- `2026-11-08-work-modes-async-pilot`: three runs per harness on a Windows adaptation of Terminal-Bench 2 `cancel-async-tasks`. Fast passed 5/5, 5/5, and 4/5: the last run did not adequately check queued work combined with asynchronous cleanup but described its result more broadly. DSH passed 5/5 three times. Thorough produced 5/5 each time, but its third run timed out at 900 seconds without a final response, and therefore was not complete. F: hard-link limitations and a missing initial empty Git commit affected this exploratory set. A browser test overlapped some trial time. The initial report incorrectly called the timeout solved; it remains as `report-initial-invalid.md` and was corrected in `report.md`.
- The adapted cancellation grader itself initially rejected the author's semaphore-based reference for a real queued-cancellation problem. That failed reference is documented in `2026-11-08-work-modes-stats-pilot/async-verifier-development.json`; a worker-pool reference passes, while absent and sequential implementations fail the appropriate checks. The Windows verifier cancels a parent asyncio task, rather than reproducing the official Linux SIGINT test, and is not an official Terminal-Bench score.
- `2026-11-08-work-modes-financial-ntfs`: six attempted runs failed before the agents could start because the restricted environment denied DSH profile writes and HY sandbox setup. The logs and report are retained; these are environmental failures, not model scores.
- The first browser test timed out under restricted permissions. Its next two attempts revealed that the test read the log before the turn ended. After correcting the wait, the browser test passed. The initial attempts are recorded in `project.md`.

## Changes and follow-up

The mode instructions now call for checking relevant failure paths, limiting investigation to the requirements and risk, and delivering once necessary checks are complete. They do not contain answers to either task. The patch tool explains unsupported patch syntax and missing hunk line numbers in its own descriptions or errors. The benchmark runner preserves existing workspaces, creates an initial commit even for an empty fixture, records setup failures, and does not count an unfinished timeout as solved.

| Follow-up task | Fast | DSH | Thorough |
| --- | --- | --- | --- |
| Windows async cancellation, 5 checks | 2/2 completed, 5/5 each; 199, 144 s | 2/2 completed, 5/5 each; 424, 261 s | 2/2 completed, 5/5 each; 407, 409 s |
| Windows document classification/extraction, 7 checks | 2/2 completed, 7/7 each; 183, 86 s | 2/2 completed, 7/7 each; 95, 134 s | 2/2 completed, 7/7 each; 167, 282 s |

These follow-ups used a hard-link-capable work area and an initial Git commit. The async task was used to diagnose the change; the document task was not used to tune this iteration, but had been used in prior project work. Both are Windows adaptations, not official benchmark scores. Two runs per condition cannot establish equivalence, absence of meaningful disadvantage, or a robust speed ranking. See `2026-11-08-work-modes-async-ntfs/` and `2026-11-08-work-modes-financial-authorized/` for the designs, logs, and separate comparison reports.

Some old HY streaming logs omit both explicitly reported zero hits and unreported cache data, so historical total hit rates cannot be recovered with certainty. The parser now retains an explicit zero, and the UI and reports show incomplete cache information as unavailable instead of presenting a calculated rate as fact. The unchanged conversation prefix across mode switches is tested; a provider cache hit after a switch has not been independently established.
