# MT-LOCAL-STACK runs on head a7e7d30b66 (review fix 1)
- push run (no path filter, fires on the lane branch): https://github.com/exafyltd/vitana-platform/actions/runs/42479873134 : success (first attempt was cancelled by the manual dispatch below through the concurrency group; re-run, success)
- workflow_dispatch run on the branch: https://github.com/exafyltd/vitana-platform/actions/runs/42479877884 : success
- Earlier head 2edbba58b7: the push run 42478164894 existed only because that head's push touched a filtered path; the update-branch merge commit does not, which is why the path filter was dropped.
Note: dispatching while a push run is in flight cancels the push run (same concurrency group). Dispatch before or after, not during.
