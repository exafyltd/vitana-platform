/**
 * The log of a real failed GitLab job, as the runner printed it, for the tests of the failure fingerprint and of the repair instructions.
 *
 * Captured 2026-11-19 (read-only GitLab API, `GET /jobs/:id/trace`, the last 6 KB) from job 3941 of pipeline 559 in vitana/rehearsal: a
 * node test that fails an assertion (`total of 1,2,3 should be 6`, 7 !== 6). Only the identifiers of the runner fleet are masked (instance
 * id, host name, runner token prefix, runner and correlation ids); every line, prefix, escape code and carriage return is as GitLab sent it.
 *
 * What it shows, and the tests depend on:
 *   - every line is `<ISO time>Z <step id><O|E><space or +>text`; the script's own output is the `01` stream, the runner's the `00` one;
 *   - the script's output sits between `section_start:…:step_script` and `section_end:…:step_script`; the runner's preparation comes before
 *     it, and its cleanup and the final `ERROR: Job failed: exit code 1` after it;
 *   - node prints an assertion failure on stderr (`01E`): the class and message, the two values, the stack, then `actual`/`expected`.
 *
 * A .ts module because *.log is git-ignored in this package.
 */
export const REAL_SCRIPT_FAILURE_LOG: string = [
  "2026-11-19T11:15:55.851085Z 00O \u001b[0KRunning with gitlab-runner 19.5.2 (66ad5002)\u001b[0;m",
  "2026-11-19T11:15:55.851114Z 00O \u001b[0K  on fleet-runner xxxxxxxxx, system ID: s_000000000000\u001b[0;m",
  "2026-11-19T11:15:55.851117Z 00O \u001b[0K  UUID: 00000000-0000-7000-8000-000000000000\u001b[0;m",
  "2026-11-19T11:15:55.851194Z 00O section_start:1795086955:prepare_executor\r\u001b[0K",
  "2026-11-19T11:15:55.851199Z 00O+\u001b[0K\u001b[36;1mPreparing the \"docker-autoscaler\" executor\u001b[0;m\u001b[0;m",
  "2026-11-19T11:15:55.851479Z 00O \u001b[0KDialing instance i-0123456789abcdef0...\u001b[0;m",
  "2026-11-19T11:15:57.366507Z 00O \u001b[0KInstance i-0123456789abcdef0 connected\u001b[0;m",
  "2026-11-19T11:15:59.000792Z 00O \u001b[0KUsing Docker executor with image public.ecr.aws/docker/library/node:20-bookworm ...\u001b[0;m",
  "2026-11-19T11:16:01.685784Z 00O \u001b[0KUsing effective pull policy of [if-not-present] for container public.ecr.aws/docker/library/node:20-bookworm\u001b[0;m",
  "2026-11-19T11:16:01.721242Z 00O \u001b[0KUsing locally found image version due to \"if-not-present\" pull policy\u001b[0;m",
  "2026-11-19T11:16:01.721258Z 00O \u001b[0KUsing docker image sha256:8f693eaa7e0a8e71560c9a82b55fd54c2ae920a2ba5d2cde28bac7d1c01c9ba5 for public.ecr.aws/docker/library/node:20-bookworm with digest public.ecr.aws/docker/library/node@sha256:8f693eaa7e0a8e71560c9a82b55fd54c2ae920a2ba5d2cde28bac7d1c01c9ba5 ...\u001b[0;m",
  "2026-11-19T11:16:01.721305Z 00O section_end:1795086961:prepare_executor\r\u001b[0K",
  "2026-11-19T11:16:01.721959Z 00O+section_start:1795086961:prepare_script\r\u001b[0K",
  "2026-11-19T11:16:01.721965Z 00O+\u001b[0K\u001b[36;1mPreparing environment\u001b[0;m\u001b[0;m",
  "2026-11-19T11:16:01.740395Z 00O \u001b[0KUsing effective pull policy of [if-not-present] for container sha256:072376a64c654169ef9de96b4b40740c10f1ef1a69f913644f56b25d1d894401\u001b[0;m",
  "2026-11-19T11:16:02.080091Z 01O Running on runner-xxxxxxxxx-project-4-concurrent-0 via ip-10-0-0-1...",
  "2026-11-19T11:16:02.083510Z 01O Running on CPU: Intel(R) Xeon(R) Platinum 8175M CPU @ 2.50GHz (avx, avx2, avx512f)",
  "2026-11-19T11:16:02.370669Z 00O section_end:1795086962:prepare_script\r\u001b[0K",
  "2026-11-19T11:16:02.379280Z 00O+section_start:1795086962:get_sources\r\u001b[0K",
  "2026-11-19T11:16:02.379701Z 00O+\u001b[0K\u001b[36;1mGetting source from Git repository\u001b[0;m\u001b[0;m",
  "2026-11-19T11:16:02.778406Z 01O \u001b[32;1mGitaly correlation ID: 01AAAAAAAAAAAAAAAAAAAAAAAA\u001b[0;m",
  "2026-11-19T11:16:02.778875Z 01O \u001b[32;1mFetching changes with git depth set to 20...\u001b[0;m",
  "2026-11-19T11:16:02.785876Z 01O Initialized empty Git repository in /builds/vitana/rehearsal/.git/",
  "2026-11-19T11:16:02.789444Z 01O \u001b[32;1mCreated fresh repository.\u001b[0;m",
  "2026-11-19T11:16:03.322055Z 01O \u001b[32;1mChecking out a4b7fb38 as detached HEAD (ref is refs/merge-requests/6/head)...\u001b[0;m",
  "2026-11-19T11:16:03.858108Z 01O ",
  "2026-11-19T11:16:03.858116Z 01O \u001b[32;1mSkipping Git submodules setup\u001b[0;m",
  "2026-11-19T11:16:03.956331Z 00O section_end:1795086963:get_sources\r\u001b[0K",
  "2026-11-19T11:16:03.959937Z 00O+section_start:1795086963:step_script\r\u001b[0K",
  "2026-11-19T11:16:03.960042Z 00O+\u001b[0K\u001b[36;1mExecuting \"step_script\" stage of the job script\u001b[0;m\u001b[0;m",
  "2026-11-19T11:16:03.960079Z 00O \u001b[0KUsing effective pull policy of [if-not-present] for container public.ecr.aws/docker/library/node:20-bookworm\u001b[0;m",
  "2026-11-19T11:16:03.993267Z 00O \u001b[0KUsing docker image sha256:8f693eaa7e0a8e71560c9a82b55fd54c2ae920a2ba5d2cde28bac7d1c01c9ba5 for public.ecr.aws/docker/library/node:20-bookworm with digest public.ecr.aws/docker/library/node@sha256:8f693eaa7e0a8e71560c9a82b55fd54c2ae920a2ba5d2cde28bac7d1c01c9ba5 ...\u001b[0;m",
  "2026-11-19T11:16:04.943663Z 01O \u001b[32;1m$ node --version\u001b[0;m",
  "2026-11-19T11:16:05.970777Z 01O v20.20.2",
  "2026-11-19T11:16:05.975242Z 01O \u001b[32;1m$ npm test\u001b[0;m",
  "2026-11-19T11:16:07.678312Z 01O ",
  "2026-11-19T11:16:07.678327Z 01O > loop-rehearsal-fixture@1.0.0 test",
  "2026-11-19T11:16:07.678328Z 01O > node test.mjs",
  "2026-11-19T11:16:07.678329Z 01O ",
  "2026-11-19T11:16:07.730203Z 01E node:internal/modules/run_main:123",
  "2026-11-19T11:16:07.730212Z 01E     triggerUncaughtException(",
  "2026-11-19T11:16:07.730213Z 01E     ^",
  "2026-11-19T11:16:07.730213Z 01E ",
  "2026-11-19T11:16:07.730214Z 01E AssertionError [ERR_ASSERTION]: total of 1,2,3 should be 6",
  "2026-11-19T11:16:07.730214Z 01E ",
  "2026-11-19T11:16:07.730215Z 01E 7 !== 6",
  "2026-11-19T11:16:07.730215Z 01E ",
  "2026-11-19T11:16:07.730216Z 01E     at file:///builds/vitana/rehearsal/test.mjs:4:8",
  "2026-11-19T11:16:07.730216Z 01E     at ModuleJob.run (node:internal/modules/esm/module_job:325:25)",
  "2026-11-19T11:16:07.730218Z 01E     at async ModuleLoader.import (node:internal/modules/esm/loader:606:24)",
  "2026-11-19T11:16:07.730218Z 01E     at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5) {",
  "2026-11-19T11:16:07.730219Z 01E   generatedMessage: false,",
  "2026-11-19T11:16:07.730219Z 01E   code: 'ERR_ASSERTION',",
  "2026-11-19T11:16:07.730281Z 01E   actual: 7,",
  "2026-11-19T11:16:07.730282Z 01E   expected: 6,",
  "2026-11-19T11:16:07.730283Z 01E   operator: 'strictEqual'",
  "2026-11-19T11:16:07.730283Z 01E }",
  "2026-11-19T11:16:07.730284Z 01E ",
  "2026-11-19T11:16:07.730285Z 01E Node.js v20.20.2",
  "2026-11-19T11:16:07.838506Z 00O section_end:1795086967:step_script\r\u001b[0K",
  "2026-11-19T11:16:07.839918Z 00O+section_start:1795086967:cleanup_file_variables\r\u001b[0K",
  "2026-11-19T11:16:07.839927Z 00O+\u001b[0K\u001b[36;1mCleaning up project directory and file based variables\u001b[0;m\u001b[0;m",
  "2026-11-19T11:16:08.145528Z 00O section_end:1795086968:cleanup_file_variables\r\u001b[0K",
  "2026-11-19T11:16:08.179750Z 00O \u001b[31;1mERROR: Job failed: exit code 1\u001b[0;m",
  "",
].join('\n');
