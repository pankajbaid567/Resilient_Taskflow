# GitHub Actions Workflows

This directory contains GitHub Actions workflows for CI/CD, security scanning, and automated releases.

## Workflows

### 🔄 ci.yml - Continuous Integration

**Triggers:** Push and PR to `main` or `develop`

Runs comprehensive checks on every commit:
- **Lint**: ESLint and Prettier checks
- **Type Check**: TypeScript compilation
- **Test**: Unit and integration tests with PostgreSQL and Redis services
- **Build**: Build all applications (API, Worker, Dashboard)
- **Coverage**: Upload to Codecov

**Runtime:** ~8-12 minutes

### 🐳 docker.yml - Docker Build & Push

**Triggers:** Push to `main`, version tags (`v*`), PRs

Builds and publishes Docker images:
- Multi-platform builds (amd64, arm64)
- Push to GitHub Container Registry (GHCR)
- Generate SBOM (Software Bill of Materials)
- Security scanning with Trivy
- Docker Compose integration test

**Images:**
- `ghcr.io/YOUR_USERNAME/taskflow-api`
- `ghcr.io/YOUR_USERNAME/taskflow-worker`
- `ghcr.io/YOUR_USERNAME/taskflow-dashboard`

**Runtime:** ~15-20 minutes

### 🔒 security.yml - Security Scanning

**Triggers:** Push/PR to `main`/`develop`, weekly schedule (Mondays 9:00 UTC), manual

Comprehensive security scanning:
- **NPM Audit**: Package vulnerabilities
- **CodeQL**: Static code analysis
- **TruffleHog**: Secret scanning
- **Trivy + Grype**: Docker image vulnerabilities
- **Semgrep**: SAST (Static Application Security Testing)
- **License Check**: OSS license compliance

Results uploaded to GitHub Security tab.

**Runtime:** ~10-15 minutes

### 🚀 deploy.yml - Deployment

**Trigger:** Manual workflow dispatch

Environment-based deployment with rollback:
- Deploy to staging or production
- Update AWS ECS task definitions
- Deploy API and Worker services
- Update Dashboard (S3 + CloudFront)
- Run database migrations
- Health checks and smoke tests
- Automatic rollback on failure
- Slack notifications

**Runtime:** ~10-15 minutes

### 📦 release.yml - Release Management

**Triggers:** Version tags (`v*`), manual workflow dispatch

Automated release process:
- Version validation (semver)
- Build release artifacts with checksums
- Build and push versioned Docker images
- Generate changelog from PR labels
- Create GitHub release
- Notify via Slack
- Create deployment tracking issue

**Artifacts:**
- `taskflow-api-{version}.tar.gz`
- `taskflow-worker-{version}.tar.gz`
- `taskflow-dashboard-{version}.tar.gz`
- `checksums.txt`

**Runtime:** ~20-25 minutes

## Workflow Dependencies

```
ci.yml (always runs first)
  │
  ├─→ docker.yml (on main/tags)
  │     └─→ deploy.yml (manual)
  │
  ├─→ security.yml (parallel)
  │
  └─→ release.yml (on tags)
```

## Required Secrets

Configure in GitHub repository settings → Secrets and variables → Actions

### AWS Deployment
- `AWS_ROLE_ARN` - IAM role for ECS deployment
- `AWS_REGION` - AWS region (e.g., us-east-1)
- `API_URL` - API endpoint for health checks
- `API_KEY` - API key for smoke tests
- `SUBNET_IDS` - ECS subnet IDs
- `SECURITY_GROUP_ID` - ECS security group
- `CLOUDFRONT_DISTRIBUTION_ID` - CloudFront distribution

### Notifications
- `SLACK_WEBHOOK_URL` - Slack webhook for notifications

### Optional
- `CODECOV_TOKEN` - Codecov upload token

## Workflow Features

### Parallel Execution
Jobs run in parallel where possible to minimize total runtime.

### Caching
- pnpm store caching
- Docker layer caching
- Build artifact caching

### Matrix Builds
Build jobs use matrix strategy for multiple apps/platforms in parallel.

### Concurrency Control
Workflows cancel in-progress runs when new commits are pushed to the same branch.

### Artifact Retention
- Build artifacts: 7 days
- Release artifacts: 30 days
- SBOM: 90 days
- License reports: 90 days

## Usage Examples

### Running CI on a PR

CI runs automatically when you open a PR or push commits.

```bash
git checkout -b feature/new-feature
git commit -m "feat: add new feature"
git push origin feature/new-feature
# Open PR on GitHub
```

### Creating a Release

**Option 1: Git tag**
```bash
git tag v1.0.0
git push origin v1.0.0
```

**Option 2: Workflow dispatch**
1. Go to Actions → Release
2. Click "Run workflow"
3. Enter version: `1.0.0`
4. Click "Run workflow"

### Deploying to Staging

1. Go to Actions → Deploy
2. Click "Run workflow"
3. Select environment: `staging`
4. Enter version: `latest` or specific tag
5. Click "Run workflow"

### Deploying to Production

1. Create a release first (creates versioned Docker images)
2. Go to Actions → Deploy
3. Click "Run workflow"
4. Select environment: `production`
5. Enter version: `v1.0.0` (specific release tag)
6. Click "Run workflow"

### Running Security Scan Manually

1. Go to Actions → Security Scan
2. Click "Run workflow"
3. Select branch: `main` or your feature branch
4. Click "Run workflow"

## Monitoring Workflows

### View All Workflows
```
https://github.com/YOUR_USERNAME/Resilient_TaskFlow/actions
```

### View Specific Workflow
```
https://github.com/YOUR_USERNAME/Resilient_TaskFlow/actions/workflows/ci.yml
```

### Check Status
- ✅ Green: All checks passed
- ❌ Red: Some checks failed
- 🟡 Yellow: In progress
- ⚪ Gray: No runs yet

## Workflow Logs

Click on any workflow run to see:
- Summary of all jobs
- Detailed logs for each step
- Artifacts produced
- Runtime and cost

## Troubleshooting

### CI Failures

**Check the logs:**
1. Go to Actions tab
2. Click on failed workflow run
3. Click on failed job
4. Expand failed step to see error

**Common issues:**
- Test failures → Run tests locally
- Lint errors → Run `pnpm lint:fix`
- Type errors → Run `pnpm typecheck`
- Build failures → Run `pnpm build`

### Docker Build Failures

**Common issues:**
- Platform compatibility → Check Dockerfile
- Cache issues → Clear cache and rebuild
- Registry authentication → Check GITHUB_TOKEN

### Deployment Failures

**Common issues:**
- Health check timeout → Check ECS logs
- Migration failures → Check database connectivity
- Rollback triggered → Check deployment logs

### Security Scan Failures

**Common issues:**
- Vulnerabilities → Run `pnpm audit fix`
- False positives → Review and document
- License issues → Check dependency licenses

## Performance Optimization

### Reduce Runtime

- Use caching effectively
- Run jobs in parallel
- Skip unnecessary steps
- Optimize Docker builds

### Reduce Costs

- Skip Docker builds on PRs (already done)
- Clean up old artifacts
- Use self-hosted runners (advanced)

## Best Practices

1. **Keep workflows DRY** - Use composite actions
2. **Fail fast** - Run quick checks first
3. **Parallel execution** - Run independent jobs parallel
4. **Proper caching** - Cache dependencies
5. **Clear naming** - Use descriptive job/step names
6. **Error handling** - Graceful failures
7. **Security** - Never commit secrets
8. **Documentation** - Keep this README updated

## Workflow Badges

Add status badges to README.md:

```markdown
![CI](https://github.com/YOUR_USERNAME/Resilient_TaskFlow/workflows/CI/badge.svg)
![Docker](https://github.com/YOUR_USERNAME/Resilient_TaskFlow/workflows/Docker%20Build%20%26%20Push/badge.svg)
![Security](https://github.com/YOUR_USERNAME/Resilient_TaskFlow/workflows/Security%20Scan/badge.svg)
![Release](https://github.com/YOUR_USERNAME/Resilient_TaskFlow/workflows/Release/badge.svg)
```

## Resources

- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Workflow Syntax](https://docs.github.com/en/actions/reference/workflow-syntax-for-github-actions)
- [Reusable Workflows](https://docs.github.com/en/actions/learn-github-actions/reusing-workflows)
- [Security Hardening](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions)

## Support

For workflow issues:
1. Check workflow logs
2. Review this documentation
3. Check [CI/CD Documentation](../../docs/ci-cd.md)
4. Create an issue with workflow run URL
