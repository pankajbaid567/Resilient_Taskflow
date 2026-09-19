# Contributing to Resilient TaskFlow

Thank you for your interest in contributing to Resilient TaskFlow! This document provides guidelines and instructions for contributing.

## Code of Conduct

Please be respectful and constructive in all interactions. We aim to foster an inclusive and welcoming environment.

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm 8+
- Docker and Docker Compose
- Git

### Setup Development Environment

1. **Fork and clone the repository:**

   ```bash
   git clone https://github.com/YOUR_USERNAME/Resilient_TaskFlow.git
   cd Resilient_TaskFlow
   ```

2. **Install dependencies:**

   ```bash
   pnpm install
   ```

3. **Start development services:**

   ```bash
   docker-compose up -d
   ```

4. **Run database migrations:**

   ```bash
   pnpm db:migrate
   ```

5. **Start development servers:**
   ```bash
   pnpm dev
   ```

## Development Workflow

### Branch Strategy

- `main`: Production-ready code
- `develop`: Integration branch
- `feature/description`: New features
- `fix/description`: Bug fixes
- `docs/description`: Documentation updates
- `chore/description`: Maintenance tasks

### Making Changes

1. **Create a feature branch:**

   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** following our coding standards

3. **Write tests** for new functionality

4. **Run tests locally:**

   ```bash
   pnpm lint
   pnpm typecheck
   pnpm test
   pnpm build
   ```

5. **Commit your changes** using conventional commits:
   ```bash
   git commit -m "feat: add new feature description"
   ```

### Commit Message Format

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat: description` - New feature
- `fix: description` - Bug fix
- `docs: description` - Documentation changes
- `style: description` - Code style changes (formatting)
- `refactor: description` - Code refactoring
- `test: description` - Test additions or changes
- `chore: description` - Maintenance tasks
- `perf: description` - Performance improvements
- `security: description` - Security fixes

**Examples:**

```bash
feat: add job priority scheduling
fix: resolve memory leak in worker pool
docs: update API documentation
test: add integration tests for retry logic
```

### Pull Request Process

1. **Push your branch:**

   ```bash
   git push origin feature/your-feature-name
   ```

2. **Create a Pull Request** on GitHub

3. **Fill out the PR template** with:
   - Description of changes
   - Related issue numbers
   - Testing performed
   - Screenshots (if UI changes)

4. **Add appropriate labels:**
   - `feature`, `bug`, `documentation`, `enhancement`, etc.

5. **Wait for CI checks** to pass:
   - Linting
   - Type checking
   - Tests
   - Build
   - Security scans

6. **Address review comments**

7. **Squash and merge** after approval

## Coding Standards

### TypeScript

- Use strict TypeScript mode
- Define explicit types (avoid `any`)
- Use interfaces for object shapes
- Document complex logic with comments

**Example:**

```typescript
interface JobPayload {
  type: string;
  data: Record<string, unknown>;
  priority?: number;
}

async function submitJob(payload: JobPayload): Promise<Job> {
  // Implementation
}
```

### File Naming

- Use kebab-case for files: `job-processor.ts`
- Use PascalCase for classes: `JobProcessor`
- Use camelCase for functions: `processJob`

### Code Organization

```
packages/
  package-name/
    src/
      index.ts           # Public API
      types.ts           # Type definitions
      utils.ts           # Utility functions
      __tests__/         # Tests
    package.json
    tsconfig.json
```

### Testing

- **Unit tests** for individual functions/classes
- **Integration tests** for API endpoints
- **E2E tests** for critical workflows

**Test file naming:**

```
src/job-processor.ts
src/__tests__/job-processor.test.ts
```

**Test structure:**

```typescript
describe('JobProcessor', () => {
  describe('processJob', () => {
    it('should process job successfully', async () => {
      // Arrange
      const job = createMockJob();

      // Act
      const result = await processJob(job);

      // Assert
      expect(result.status).toBe('completed');
    });

    it('should retry on failure', async () => {
      // Test implementation
    });
  });
});
```

### Documentation

- Add JSDoc comments for public APIs
- Update relevant documentation files
- Include code examples when helpful

**Example:**

````typescript
/**
 * Submits a job to the queue for asynchronous processing.
 *
 * @param payload - Job payload including type and data
 * @param options - Optional job configuration
 * @returns Promise resolving to created job
 *
 * @example
 * ```typescript
 * const job = await submitJob({
 *   type: 'send_email',
 *   data: { to: 'user@example.com' }
 * });
 * ```
 */
async function submitJob(
  payload: JobPayload,
  options?: JobOptions
): Promise<Job> {
  // Implementation
}
````

## Project Structure

```
Resilient_TaskFlow/
├── .github/
│   ├── workflows/         # GitHub Actions CI/CD
│   └── CONTRIBUTING.md
├── apps/
│   ├── api/              # REST API service
│   ├── worker/           # Worker service
│   └── dashboard/        # React dashboard
├── packages/
│   ├── config/           # Shared configuration
│   ├── types/            # Shared TypeScript types
│   ├── queue/            # Queue implementation
│   ├── database/         # Database layer
│   ├── logger/           # Logging utilities
│   ├── cache/            # Caching layer
│   └── performance/      # Performance tools
├── tests/
│   ├── integration/      # Integration tests
│   ├── load/             # Load tests (k6)
│   └── chaos/            # Chaos tests
├── docs/                 # Documentation
├── infrastructure/       # Docker, Prometheus, Grafana
└── docker-compose.yml
```

## Testing Guidelines

### Running Tests

```bash
# All tests
pnpm test

# Watch mode
pnpm test:watch

# Specific package
pnpm --filter @taskflow/queue test

# Integration tests
pnpm test:integration

# Load tests
pnpm load:sustained
```

### Test Coverage

- Aim for >80% coverage
- Focus on critical paths
- Test edge cases and error handling

### Mocking

Use proper mocking for external dependencies:

```typescript
import { vi } from 'vitest';

vi.mock('@taskflow/database', () => ({
  query: vi.fn(),
}));
```

## Performance Considerations

- **Profile before optimizing**
- **Use indexes** for database queries
- **Cache frequently accessed data**
- **Batch operations** where possible
- **Monitor memory usage** in workers

## Security Guidelines

- **Never commit secrets** or API keys
- **Validate all input** from external sources
- **Use parameterized queries** to prevent SQL injection
- **Implement rate limiting** on public endpoints
- **Hash passwords** with bcrypt (never store plaintext)
- **Use JWT** for authentication
- **Sanitize error messages** (don't expose internal details)

## Documentation

### Types of Documentation

1. **Code comments** - Complex logic
2. **JSDoc** - Public APIs
3. **README files** - Package-level docs
4. **docs/** - Architecture and guides
5. **API documentation** - OpenAPI/Swagger

### Documentation Updates

When adding features:

- Update relevant README files
- Add API documentation
- Update architecture diagrams if needed
- Include migration guides for breaking changes

## Review Process

### For Reviewers

- **Be constructive** and respectful
- **Focus on** logic, architecture, and maintainability
- **Check for** test coverage
- **Verify** documentation updates
- **Test locally** if significant changes

### Review Checklist

- [ ] Code follows project conventions
- [ ] Tests are included and passing
- [ ] Documentation is updated
- [ ] No security vulnerabilities introduced
- [ ] Performance impact considered
- [ ] Breaking changes documented
- [ ] CI checks passing

## Release Process

1. **Version bump** following semver
2. **Update changelog**
3. **Create release tag**
4. **GitHub release** auto-created
5. **Docker images** built and pushed
6. **Deployment** to staging then production

See [CI/CD Documentation](../docs/ci-cd.md) for details.

## Getting Help

- **Documentation:** Check `docs/` directory
- **Issues:** Search existing issues or create new one
- **Discussions:** Use GitHub Discussions for questions
- **Slack:** Join our Slack channel (if available)

## Recognition

Contributors will be:

- Listed in CONTRIBUTORS.md
- Acknowledged in release notes
- Thanked in the community

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

## Questions?

Feel free to open an issue or discussion if you have questions about contributing!

---

Thank you for contributing to Resilient TaskFlow! 🚀
