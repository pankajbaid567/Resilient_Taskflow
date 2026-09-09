# CI/CD Pipeline Documentation

Resilient TaskFlow uses GitHub Actions for continuous integration, deployment, and security scanning.

## Workflows Overview

### 1. CI Workflow (`ci.yml`)

**Trigger:** Push/PR to `main` or `develop` branches

**Jobs:**
- **Lint**: ESLint and Prettier formatting checks
- **Type Check**: TypeScript compilation and type validation
- **Test**: Unit and integration tests with PostgreSQL and Redis
- **Build**: Build all applications (API, Worker, Dashboard)

**Features:**
- Parallel job execution for faster feedback
- pnpm caching for dependency installation
- Service containers for database/cache
- Coverage reporting to Codecov
- Build artifact uploads

**Status:** ![CI](https://github.com/YOUR_USERNAME/Resilient_TaskFlow/workflows/CI/badge.svg)

### 2. Docker Workflow (`docker.yml`)

**Trigger:** 
- Push to `main` branch
- Version tags (`v*`)
- Pull requests (build only)

**Jobs:**
- **Build and Push**: Multi-platform Docker images (amd64, arm64)
- **Scan**: Trivy vulnerability scanning
- **Docker Compose Test**: Integration testing

**Features:**
- GitHub Container Registry (ghcr.io) publishing
- Multi-architecture support (amd64/arm64)
- SBOM (Software Bill of Materials) generation
- Automated security scanning with Trivy
- Docker layer caching for faster builds
- Image tagging: latest, semver, branch, SHA

**Image Tags:**
- `ghcr.io/YOUR_USERNAME/taskflow-api:latest`
- `ghcr.io/YOUR_USERNAME/taskflow-worker:latest`
- `ghcr.io/YOUR_USERNAME/taskflow-dashboard:latest`

**Status:** ![Docker](https://github.com/YOUR_USERNAME/Resilient_TaskFlow/workflows/Docker%20Build%20%26%20Push/badge.svg)

### 3. Security Workflow (`security.yml`)

**Trigger:**
- Push/PR to `main` or `develop` branches
- Weekly schedule (Mondays at 9:00 UTC)
- Manual dispatch

**Scans:**
- **Dependency Review**: Checks for vulnerable dependencies in PRs
- **NPM Audit**: Identifies npm package vulnerabilities
- **CodeQL**: Static code analysis for security issues
- **Secret Scanning**: TruffleHog for exposed secrets
- **Docker Image Scan**: Trivy and Grype for container vulnerabilities
- **SAST**: Semgrep for security patterns
- **License Check**: Validates license compliance

**Features:**
- SARIF uploads to GitHub Security tab
- Automated PR comments with scan results
- Scheduled weekly scans
- License compliance enforcement
- Fail on critical/high severity issues

**Status:** ![Security](https://github.com/YOUR_USERNAME/Resilient_TaskFlow/workflows/Security%20Scan/badge.svg)

### 4. Deploy Workflow (`deploy.yml`)

**Trigger:** Manual workflow dispatch

**Parameters:**
- `environment`: staging or production
- `version`: Docker tag to deploy (default: latest)

**Jobs:**
- **Deploy**: AWS ECS deployment with health checks
- **Rollback**: Automatic rollback on failure

**Deployment Steps:**
1. Configure AWS credentials
2. Update ECS task definitions
3. Deploy API and Worker services
4. Update Dashboard (S3 + CloudFront)
5. Run database migrations
6. Health checks and smoke tests
7. Slack notifications

**Features:**
- Environment-specific deployments
- Automated rollback on failure
- Health check validation
- Smoke tests after deployment
- Slack notifications
- Database migration runner

### 5. Release Workflow (`release.yml`)

**Trigger:**
- Version tags (`v*`)
- Manual workflow dispatch

**Jobs:**
- **Validate**: Version format validation
- **Build**: Create release artifacts
- **Docker**: Build and push versioned images
- **Changelog**: Automated changelog generation
- **Release**: Create GitHub release
- **Notify**: Slack notifications

**Features:**
- Semantic versioning support
- Automated changelog from PR labels
- Release artifacts with checksums
- Multi-platform Docker images
- GitHub release creation
- Deployment tracking issues

**Release Artifacts:**
- `taskflow-api-{version}.tar.gz`
- `taskflow-worker-{version}.tar.gz`
- `taskflow-dashboard-{version}.tar.gz`
- `checksums.txt`

**Status:** ![Release](https://github.com/YOUR_USERNAME/Resilient_TaskFlow/workflows/Release/badge.svg)

## Required Secrets

Configure these secrets in GitHub repository settings:

### AWS Deployment
```
AWS_ROLE_ARN              # AWS IAM role for deployment
AWS_REGION                # AWS region (e.g., us-east-1)
API_URL                   # API endpoint URL for health checks
API_KEY                   # API key for smoke tests
SUBNET_IDS                # ECS subnet IDs
SECURITY_GROUP_ID         # ECS security group
CLOUDFRONT_DISTRIBUTION_ID # CloudFront distribution for dashboard
```

### Notifications
```
SLACK_WEBHOOK_URL         # Slack webhook for notifications
```

### Optional
```
CODECOV_TOKEN             # Codecov upload token
```

## Environment Variables

### Development
```bash
NODE_ENV=development
DATABASE_URL=postgresql://user:pass@localhost:5432/taskflow
REDIS_URL=redis://localhost:6379
KAFKA_BROKERS=localhost:19092
```

### Production
```bash
NODE_ENV=production
DATABASE_URL=postgresql://user:pass@prod-db:5432/taskflow
REDIS_URL=redis://prod-redis:6379
KAFKA_BROKERS=prod-kafka:9092
JWT_SECRET=<secure-random-secret>
API_KEY=<secure-api-key>
```

## Workflow Usage

### Running CI on Pull Requests

CI runs automatically on all PRs. Ensure:
- All tests pass
- Linting passes
- Type checking passes
- Security scans pass

### Creating a Release

1. **Tag the version:**
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

2. **Or use workflow dispatch:**
   - Go to Actions → Release
   - Click "Run workflow"
   - Enter version (e.g., `1.0.0`)

3. **Release artifacts will be:**
   - Published to GitHub Releases
   - Docker images pushed to GHCR
   - Changelog auto-generated
   - Deployment issue created

### Deploying to Staging

1. Go to Actions → Deploy
2. Click "Run workflow"
3. Select:
   - Environment: `staging`
   - Version: `latest` or specific tag
4. Click "Run workflow"

### Deploying to Production

1. **Create a release first** (see above)
2. Go to Actions → Deploy
3. Click "Run workflow"
4. Select:
   - Environment: `production`
   - Version: specific release tag (e.g., `v1.0.0`)
5. Click "Run workflow"
6. Monitor deployment progress
7. Verify health checks pass

### Manual Security Scan

1. Go to Actions → Security Scan
2. Click "Run workflow"
3. Select branch
4. Click "Run workflow"

## Workflow Best Practices

### Branch Strategy

- `main`: Production-ready code, protected branch
- `develop`: Integration branch for features
- Feature branches: `feature/description`
- Bugfix branches: `fix/description`

### Commit Messages

Use conventional commits for automated changelog:

- `feat: add new feature` → Features section
- `fix: resolve bug` → Bug Fixes section
- `docs: update documentation` → Documentation section
- `chore: update dependencies` → Maintenance section
- `security: patch vulnerability` → Security section

### Pull Request Labels

Add labels for changelog categorization:
- `feature`, `enhancement` → Features
- `bug`, `fix` → Bug Fixes
- `documentation`, `docs` → Documentation
- `chore`, `maintenance`, `dependencies` → Maintenance
- `security` → Security

### Testing Before Merge

```bash
# Run locally before pushing
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

### Docker Image Tags

The workflow creates multiple tags:
- `latest`: Latest build from main branch
- `v1.0.0`: Semantic version tag
- `v1.0`: Major.minor tag
- `v1`: Major tag
- `main-abc123`: Branch + commit SHA
- `pr-123`: Pull request number

## Monitoring Workflows

### GitHub Actions Dashboard

View workflow runs at:
```
https://github.com/YOUR_USERNAME/Resilient_TaskFlow/actions
```

### Workflow Status Badges

Add to README.md:

```markdown
![CI](https://github.com/YOUR_USERNAME/Resilient_TaskFlow/workflows/CI/badge.svg)
![Docker](https://github.com/YOUR_USERNAME/Resilient_TaskFlow/workflows/Docker%20Build%20%26%20Push/badge.svg)
![Security](https://github.com/YOUR_USERNAME/Resilient_TaskFlow/workflows/Security%20Scan/badge.svg)
```

### Slack Notifications

Configure Slack webhook for:
- Deployment success/failure
- Release notifications
- Security scan alerts

## Troubleshooting

### CI Failures

**Tests failing:**
```bash
# Run tests locally with same environment
docker-compose up -d postgres redis
pnpm test
```

**Build failing:**
```bash
# Clear cache and rebuild
pnpm clean
pnpm install
pnpm build
```

**Type errors:**
```bash
pnpm typecheck
```

### Docker Build Failures

**Image too large:**
- Review Dockerfile layers
- Use `.dockerignore` effectively
- Multi-stage builds already implemented

**Platform issues:**
- Check if building for correct platform
- ARM64 builds may be slower

### Deployment Failures

**Health check timeout:**
- Check ECS task logs
- Verify environment variables
- Check database connectivity

**Migration failures:**
- Review migration logs
- Check database permissions
- Verify migration files

**Rollback triggered:**
- Check deployment logs
- Review health check results
- Manual verification may be needed

### Security Scan Failures

**High/Critical vulnerabilities:**
```bash
# Run audit locally
pnpm audit
pnpm audit fix
```

**False positives:**
- Review vulnerability details
- Add exceptions if safe
- Document reasoning

## Performance Optimization

### Workflow Runtime

Current average runtimes:
- CI: ~8-12 minutes
- Docker: ~15-20 minutes
- Security: ~10-15 minutes
- Deploy: ~10-15 minutes
- Release: ~20-25 minutes

### Caching Strategy

The workflows use:
- pnpm store caching
- Docker layer caching (GitHub Actions cache)
- Build artifact caching

### Parallel Execution

Jobs run in parallel where possible:
- CI: All jobs parallel except status
- Security: All scans parallel
- Docker: Matrix builds parallel

## Cost Considerations

### GitHub Actions Minutes

- Public repos: Unlimited
- Private repos: 2,000 minutes/month free (Pro)

### Storage

- Artifacts: 500MB free (deleted after 7-90 days)
- Packages (GHCR): 500MB free

### AWS Costs

- ECS Fargate: Pay per task runtime
- ECR: Pay for storage
- CloudFront: Pay for requests
- Data transfer costs

## Security Considerations

### Secret Management

- Never commit secrets to repository
- Use GitHub Secrets for sensitive data
- Rotate secrets regularly
- Use least-privilege IAM roles

### Image Security

- Scan all images before deployment
- Use official base images
- Keep dependencies updated
- Monitor vulnerability reports

### Access Control

- Protect main branch
- Require PR reviews
- Require status checks
- Use CODEOWNERS file

## Future Enhancements

Potential improvements:
- [ ] Add E2E tests with Playwright
- [ ] Implement blue-green deployments
- [ ] Add canary deployment strategy
- [ ] Integrate with monitoring (Datadog, New Relic)
- [ ] Add performance testing to CI
- [ ] Implement GitOps with ArgoCD
- [ ] Add multi-region deployments
- [ ] Implement feature flags

## Resources

- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Docker Best Practices](https://docs.docker.com/develop/dev-best-practices/)
- [AWS ECS Documentation](https://docs.aws.amazon.com/ecs/)
- [Semantic Versioning](https://semver.org/)
- [Conventional Commits](https://www.conventionalcommits.org/)

## Support

For CI/CD issues:
1. Check workflow logs in GitHub Actions
2. Review this documentation
3. Check GitHub Discussions
4. Create an issue with workflow run URL
