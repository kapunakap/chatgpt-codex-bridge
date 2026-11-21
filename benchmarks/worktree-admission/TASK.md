# Agent task

You are working from a frozen repository source snapshot. Improve the worktree manager so a large backlog of background cleanup does not make a new repository-backed session wait behind every cleanup candidate.

Preserve safe snapshot behavior and active-worktree protection. Keep each cleanup pass bounded so it can yield to newly arriving work. Ensure stalled Git commands are bounded, and make cancellation during worktree preparation settle cleanly before later manager operations proceed. Direct execution for disabled or non-Git workspaces should remain responsive.

Add focused automated tests for the behavior you change. Use local fixtures only. Keep the change scoped to the worktree manager and its tests. Report the commands you ran, their results, and any limits in your implementation.

Do not assume production-scale speed from a fixture result. Explain what your tests prove about ordering, bounds, and cleanup.
