# Subagent Protocol

Use subagents only when the user asks for subagents, delegation, or parallel agent work, or when an explicitly approved task benefits from independent workers.

## Roles

- `explorer`: answer specific codebase questions, inspect ownership boundaries, find relevant files, or check whether a suspected issue is real.
- `worker`: implement a bounded change in a disjoint write set. Assign file ownership up front.
- `verifier`: run independent checks, review screenshots, inspect diffs, or validate a deployment plan without modifying production.

## Guardrails

- Tell every subagent that it is not alone in the codebase and must not revert unrelated changes.
- Give each worker a disjoint write scope; avoid two workers editing the same file unless the task is read-only.
- Do not delegate live production deployment, credential handling, destructive file operations, or git history changes unless the user explicitly approves that scope.
- Pass raw artifacts and paths, not hidden conclusions. The goal is independent validation.
- Require subagents to report changed files, commands run, results, and residual risks.

## Prompt Template

```text
You are working in D:\freelife\opencode-workbench.
Read AGENTS.md and docs/agent-harness/README.md first, then follow the harness load order: rules.md, memory.yaml, skills.md, subagents.md as needed.
Task: <specific task>.
Ownership: <files/directories this agent may edit or read>.
Do not revert unrelated changes. Other agents or the user may have active edits.
Do not store or print secrets.
Return: changed files, commands run, results, risks.
```

## Integration Checklist

- Review the subagent's diff before accepting it.
- Run the parent-level verification commands after integrating worker output.
- Keep the parent agent responsible for final git status, commit, push and deployment summary.
