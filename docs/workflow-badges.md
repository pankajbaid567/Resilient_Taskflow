# GitHub Actions Workflow Badges

Add these badges to your README.md file to show CI/CD status.

## Badge Code

Replace `YOUR_USERNAME` with your GitHub username or organization name.

```markdown
## CI/CD Status

![CI](https://github.com/YOUR_USERNAME/Resilient_TaskFlow/workflows/CI/badge.svg)
![Docker Build & Push](https://github.com/YOUR_USERNAME/Resilient_TaskFlow/workflows/Docker%20Build%20%26%20Push/badge.svg)
![Security Scan](https://github.com/YOUR_USERNAME/Resilient_TaskFlow/workflows/Security%20Scan/badge.svg)
![Release](https://github.com/YOUR_USERNAME/Resilient_TaskFlow/workflows/Release/badge.svg)
```

## Individual Badges

### CI Workflow
```markdown
![CI](https://github.com/YOUR_USERNAME/Resilient_TaskFlow/workflows/CI/badge.svg)
```

Shows status of:
- Linting
- Type checking
- Tests
- Builds

### Docker Workflow
```markdown
![Docker Build & Push](https://github.com/YOUR_USERNAME/Resilient_TaskFlow/workflows/Docker%20Build%20%26%20Push/badge.svg)
```

Shows status of:
- Docker image builds
- Multi-platform builds
- GHCR pushes
- Security scans

### Security Workflow
```markdown
![Security Scan](https://github.com/YOUR_USERNAME/Resilient_TaskFlow/workflows/Security%20Scan/badge.svg)
```

Shows status of:
- Dependency audits
- CodeQL analysis
- Secret scanning
- Docker vulnerability scans
- SAST (Semgrep)
- License compliance

### Release Workflow
```markdown
![Release](https://github.com/YOUR_USERNAME/Resilient_TaskFlow/workflows/Release/badge.svg)
```

Shows status of:
- Release builds
- Docker image tagging
- GitHub release creation
- Changelog generation

## Shields.io Alternative Badges

For more customization options, use shields.io:

### Version Badge
```markdown
![Version](https://img.shields.io/github/v/release/YOUR_USERNAME/Resilient_TaskFlow?label=version)
```

### License Badge
```markdown
![License](https://img.shields.io/badge/license-MIT-blue.svg)
```

### Language Badge
```markdown
![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)
![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)
```

### Coverage Badge (with Codecov)
```markdown
![Coverage](https://codecov.io/gh/YOUR_USERNAME/Resilient_TaskFlow/branch/main/graph/badge.svg)
```

### Docker Pulls
```markdown
![Docker Pulls](https://img.shields.io/docker/pulls/YOUR_USERNAME/taskflow-api)
```

### Contributors
```markdown
![Contributors](https://img.shields.io/github/contributors/YOUR_USERNAME/Resilient_TaskFlow)
```

### Last Commit
```markdown
![Last Commit](https://img.shields.io/github/last-commit/YOUR_USERNAME/Resilient_TaskFlow)
```

### Issues
```markdown
![Issues](https://img.shields.io/github/issues/YOUR_USERNAME/Resilient_TaskFlow)
```

### Pull Requests
```markdown
![Pull Requests](https://img.shields.io/github/issues-pr/YOUR_USERNAME/Resilient_TaskFlow)
```

## Complete Badge Section Example

```markdown
# 🚀 Resilient TaskFlow

> Production-grade distributed task queue and asynchronous job-processing platform

## Badges

![CI](https://github.com/YOUR_USERNAME/Resilient_TaskFlow/workflows/CI/badge.svg)
![Docker Build & Push](https://github.com/YOUR_USERNAME/Resilient_TaskFlow/workflows/Docker%20Build%20%26%20Push/badge.svg)
![Security Scan](https://github.com/YOUR_USERNAME/Resilient_TaskFlow/workflows/Security%20Scan/badge.svg)
![Release](https://github.com/YOUR_USERNAME/Resilient_TaskFlow/workflows/Release/badge.svg)

[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![codecov](https://codecov.io/gh/YOUR_USERNAME/Resilient_TaskFlow/branch/main/graph/badge.svg)](https://codecov.io/gh/YOUR_USERNAME/Resilient_TaskFlow)
```

## Badge Colors

GitHub Actions workflow badges:
- 🟢 Green: All checks passed
- 🔴 Red: Some checks failed
- 🟡 Yellow: In progress
- ⚪ Gray: No runs yet

## Linking Badges

Make badges clickable:

```markdown
[![CI](https://github.com/YOUR_USERNAME/Resilient_TaskFlow/workflows/CI/badge.svg)](https://github.com/YOUR_USERNAME/Resilient_TaskFlow/actions/workflows/ci.yml)
```

## Custom Styling

Add query parameters for custom styling:

```markdown
![CI](https://github.com/YOUR_USERNAME/Resilient_TaskFlow/workflows/CI/badge.svg?style=flat-square)
```

Styles:
- `flat` (default)
- `flat-square`
- `plastic`
- `for-the-badge`

## Branch-Specific Badges

Show status for specific branch:

```markdown
![CI](https://github.com/YOUR_USERNAME/Resilient_TaskFlow/workflows/CI/badge.svg?branch=develop)
```

## Event-Specific Badges

Show status for specific event:

```markdown
![CI](https://github.com/YOUR_USERNAME/Resilient_TaskFlow/workflows/CI/badge.svg?event=push)
```

## Updating Your README

1. Open `README.md`
2. Add badge section after the title
3. Replace `YOUR_USERNAME` with your GitHub username
4. Commit and push changes
5. Badges will automatically update with workflow status
