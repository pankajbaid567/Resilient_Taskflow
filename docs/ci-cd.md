# CI/CD

The workflows in `.github/workflows/` have been parsed as YAML and the Docker smoke steps were run locally, but none of them has run on GitHub for this repository yet. Treat any behaviour below that depends on GitHub (caches, SARIF upload, GHCR pushes) as unverified.

| Workflow       | Trigger                              | Jobs                                                                                                                                     |
| -------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`       | push, pull request                   | lint, typecheck, unit tests (Postgres and Redis services), worker Docker-process integration, build, status                              |
| `docker.yml`   | push, pull request                   | build (amd64 + arm64) and push API/worker/dashboard images to GHCR, SBOM, Trivy scan (not on PRs), production-compose smoke test, status |
| `security.yml` | push, pull request, schedule, manual | dependency review (PRs), npm audit, CodeQL, TruffleHog, image scan (Trivy + Grype), Semgrep, license check                               |
| `release.yml`  | version tags, manual                 | validate, build artifacts, build and push images, changelog, GitHub release, Slack notification                                          |
| `deploy.yml`   | manual                               | **Placeholder.** Targets AWS ECS/ECR; nothing it references exists. Never run.                                                           |

## The compose smoke test

`docker.yml` job `docker-compose-test` builds the production-style stack from `docker-compose.prod.yml` with generated secrets, waits for health checks, creates an admin API key through the one-shot `migrate` image, submits a `process-data` job through the dashboard's nginx proxy and requires it to reach `SUCCEEDED` within about 60 seconds. It uses the project name `taskflow-ci` and always runs `down -v`. The same steps were run locally against the real stack.

## Secrets

Only needed for the parts that are not placeholders:

- `GITHUB_TOKEN` (automatic): GHCR push and releases.
- `SLACK_WEBHOOK_URL` (optional): release notification.
- AWS credentials, a deploy role and an `API_KEY` for health checks are referenced by `deploy.yml` only. Do not create them until the deployment exists.

## Run the same checks locally

```bash
pnpm install --frozen-lockfile
pnpm lint && pnpm format:check && pnpm typecheck && pnpm build && pnpm test
pnpm test:worker-integration     # Docker required
pnpm test:api-runtime
pnpm test:migrations
pnpm test:observability-integration
```

## Known limits

- Action versions are pinned to major tags (and `trivy-action` and `trufflehog` to release tags). Digest pinning is not done.
- The Semgrep job runs in the `semgrep/semgrep` container image without a pinned tag.
- There is no required-status-check or branch-protection configuration in the repository; set that in GitHub.
