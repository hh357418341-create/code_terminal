# Skill Routing

Use the smallest skill set that fits the task. Read a skill's `SKILL.md` before acting when it triggers.

## Frontend

- Use `frontend-delivery` for page, component, responsive layout, interaction and UI bug work.
- Use `frontend-skill` or `frontend-uipromax` only for major visual redesigns, new app screens, landing pages, dashboards, or when explicitly requested.
- Use `playwright` for browser validation, mobile viewport checks, screenshots, UI flow debugging and regression checks.

## Verification

- Use `verification-pass` after multi-file changes, UI behavior changes, builds, commits, or deployment prep.
- Use `long-task-runner` for tasks that require several stages: inspect, implement, verify, package, commit, deploy.

## Security And Deployment

- Use `security-guardrails` whenever handling server credentials, env files, auth tokens, deployment, external network access or production paths.
- Do not create persistent credential files. Prefer interactive SSH/SCP input or existing server-side env files.

## Skill Authoring

- Use `skill-creator` only when creating or updating a real Codex skill under a skills directory.
- For this repository's local harness docs, update `docs/agent-harness/*` directly rather than creating a new global skill unless the user explicitly asks for one.

