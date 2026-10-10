# Worktree admission benchmark

This is a reproducible code benchmark for worktree garbage collection and new-worktree admission. It grades candidate source checkouts at runtime with local Git fixtures. It does not use source grep as a performance check, the model's own tests, network services, credentials, or paid APIs.

## Run the benchmark

From the repository root, with Node.js 22 or later and local Git installed:

```sh
node --test benchmarks/worktree-admission/grader.test.mjs
node benchmarks/worktree-admission/grade.mjs --candidate /path/to/candidate-checkout
```

To materialize the agent input from a checkout that contains the pinned commit, use a new destination outside that checkout; its parent directory must already exist:

```sh
node benchmarks/worktree-admission/materialize-task.mjs --repo . --destination /absolute/path/to/agent-input
```

The materializer verifies the pinned tree, exports it without `.git`, copies only `TASK.md` as `BENCHMARK_TASK.md`, and prints archive and prompt hashes for the run record.

The grader prints one JSON result and exits nonzero only for a grader/setup error. A candidate can receive any score from 0 to 100. Each criterion is all-or-nothing and the weights sum to 100. Every behavioral check runs in a child process with a fixed deadline; timed-out process groups are stopped. Git fixtures are local and use a private temporary HOME with no credential variables.

## What is measured

| Criterion | Weight | Dynamic evidence |
| --- | ---: | --- |
| Admission preemption | 25 | A new enabled plan completes before the second GC candidate in a 225-record backlog. |
| Bounded GC batch | 15 | One prune pass visits and snapshots exactly four candidates. |
| Stalled Git timeout | 15 | `prepare` returns `worktree_git_timeout` within 1.5 seconds against a Git stand-in that never exits after it starts. |
| Git process cleanup | 15 | The timed-out stand-in and its child process are gone before the operation settles. |
| Abort settling | 20 | Aborting preparation settles as cancelled, cleans the Git process tree, and allows the next serialized operation to complete afterward. |
| Direct-plan bypass | 10 | Disabled planning returns a direct workspace while the manager serializer is deliberately held. |

The backlog test uses 225 ready records and a controlled first-GC gate. It observes call ordering and actual attempted work. The other checks create temporary repositories and run the candidate manager against controlled Git processes. These are behavior checks, not throughput claims about production storage or operating-system scheduling. Per-check wall times are diagnostic; the direct-plan criterion checks ordering before the local guard releases the serializer, not a hard real-time latency guarantee.

## Calibration

`calibration.local.json` records the observed frozen-buggy-baseline and historical-reference scores from this checkout. It is implementation calibration, not a model run. `run-template.json` is intentionally blank for model-run evidence.

The GitHub Actions workflow runs grader self-tests, then grades the public frozen source and reference commits. It checks that the baseline fails the targeted criteria and the reference passes all criteria. It has no repository secrets and does not run the full project suite.

## Source isolation and leakage limits

The task is anchored to the immutable pre-fix source commit in `manifest.json`. To prepare an agent input, export that commit as a source archive, extract it without `.git`, then provide only `TASK.md` as the task prompt. Do not mount this benchmark directory, the reference checkout, or the grader during the agent run. `git archive` leaves out commit history and preserves the committed source tree without adding the later fixes.

This is a public repository, so the historical reference and this grader are discoverable after publication. A network-enabled agent or an agent that already knows the change can be contaminated. The manifest records that limitation; source-only packaging cannot make a public historical task secret. For an uncontaminated model run, disable network access and record prior exposure honestly.

The grader imports and executes the candidate's `worktree-manager.mjs`. Run it in a disposable, credential-free environment. The grader itself makes no network calls; the GitHub workflow uses public source checkouts to obtain the two calibration commits.
