# SkyForge

SkyForge is a split-stack deployment platform:

- `client/`: React 19 + Vite single-page application.
- `server/`: Express API, Prisma/PostgreSQL persistence, Redis/BullMQ queues, and deployment workers.
- Web and API repositories build with Docker (or auto-generate multi-stage production Dockerfiles), push immutable ECR image digests, run on Amazon ECS Fargate behind an Application Load Balancer (ALB), and are health-checked directly.
- Teardown & One-Click Destroy cleanly removes all provisioned ECS clusters, services, tasks, ALBs, target groups, security groups, IAM roles, secrets, CloudWatch log streams, and ECR repositories.

A deployment is not marked `LIVE` until its build, cloud rollout, and endpoint health probe succeed. Failed or incomplete operations remain failed.

## Requirements

- Node.js `22.13+` and npm `10+`
- PostgreSQL `16+`
- Redis `7+`
- Docker Desktop/Engine with the CLI available to the worker
- An AWS account and either a verified IAM role connection or AWS access keys

The connected AWS identity must be able to manage the resources in the generated role policy. A worker never borrows another user’s AWS connection.

## First-time setup

1. Copy the environment examples.
2. Start PostgreSQL and Redis (or use the Compose stack below).
3. Install dependencies and apply the committed migrations.

```powershell
Copy-Item server/.env.example server/.env
Copy-Item client/.env.example client/.env
npm run install:all
npm run db:generate
npm run db:migrate
```

Set real values in `server/.env` before using authentication, AWS, or production Compose. Generate a 32-byte field-encryption key with a cryptographically secure generator:

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToBase64String($bytes)
```

Use a different `FIELD_ENCRYPTION_KEY` and `JWT_SECRET` for every environment. Keep them outside source control. Production startup rejects missing, short, or invalid values.

## Local development

With PostgreSQL and Redis running, use separate terminals:

```powershell
npm run dev:api
npm run dev:worker
npm run dev:client
```

The client uses same-origin `/api` by default. If the API is hosted separately, set `VITE_API_ORIGIN` to its public origin at build time and set the matching `CLIENT_URL` on the server.

GitHub OAuth requires this callback URL:

```text
https://<api-host>/api/github/callback
```

OAuth state is bound to an HttpOnly cookie. Do not put JWTs in OAuth URLs.

## Reproducible local deployment stack

Docker Compose starts PostgreSQL, Redis, a one-shot migration job, the API, the worker, and the Nginx-served client:

```powershell
Copy-Item server/.env.example server/.env
# Fill in real secrets, AWS account values, and GitHub OAuth values.
$env:POSTGRES_PASSWORD = "use-a-local-password"
docker compose up --build
```

- Client: `http://localhost:3000`
- API health: `http://localhost:5000/healthz`
- API readiness: `http://localhost:5000/readyz`

The worker uses the host Docker socket only for this local topology. Container build contexts are streamed to the Docker daemon, while frontend builds run in disposable containers with short-lived source/output volumes. Do not use an unrestricted Docker socket in a hostile multi-tenant environment; use a restricted BuildKit/build service for production.

## AWS onboarding

The Settings screen supports:

1. **IAM role (recommended for production):** set `SKYFORGE_AWS_ACCOUNT_ID` to the AWS account hosting the SkyForge API and worker, download the CloudFormation template, create the customer deployment role in the target account, and verify the role ARN. The SkyForge runtime must use an ECS task role or another workload identity with `sts:AssumeRole` permission; customer access keys are not required.
2. **AWS access keys (fallback only):** long-lived keys or temporary STS keys are verified with STS and encrypted before storage. Temporary credentials must include their session token. Secrets are never returned by the API after saving. Do not use this path for the public SaaS flow.

For the public SaaS deployment, run the API and worker on ECS/Fargate with a platform task role that grants only `sts:AssumeRole` on the customer deployment-role ARN pattern (for example, `arn:aws:iam::*:role/SkyForgeDeploymentRole-*`). Each customer role uses the SkyForge account as its trusted principal plus a unique External ID. SkyForge stores the role ARN, account ID, region, and External ID, then obtains short-lived credentials per job.

### Local role-flow testing without stored access keys

The local API and worker still need a bootstrap identity to call STS. Use AWS IAM Identity Center (SSO), not customer access keys:

1. Install AWS CLI v2 and run `aws configure sso --profile skyforge-platform`.
2. Sign in with `aws sso login --profile skyforge-platform`.
3. Verify the profile with `aws sts get-caller-identity --profile skyforge-platform`.
4. Copy `docker-compose.aws-profile.yml.example` to `docker-compose.aws-profile.yml`.
5. Set `AWS_PROFILE=skyforge-platform` and `AWS_CONFIG_DIR` to your local `.aws` directory.
6. Start Compose with both files: `docker compose -f docker-compose.yml -f docker-compose.aws-profile.yml up -d`.

The profile is mounted read-only into the API and worker containers. It is only the local SkyForge runtime identity; end users still connect their own accounts through the CloudFormation role flow.

Review the generated IAM policy before applying it in a production AWS account.

## Deployment lifecycle

1. The API validates ownership, repository identity, target, required environment variables, AWS connectivity, and Redis availability.
2. BullMQ stores deployment IDs and non-secret job metadata; credentials are resolved inside the worker.
3. The worker downloads a GitHub archive without shell interpolation, bounds archive resources, and rejects symlinks and secret-like files.
4. Web & dynamic builds run with Docker. Container images receive unique tags and are recorded by ECR digest before ECS rollout.
5. Automated multi-stage Dockerfile generation is provided for popular frameworks (Node/Express, Next.js, Python/FastAPI/Flask/Django, Go, Rust, Java/Spring Boot, Laravel, React/Vite/SPA).
6. ECS uses separate ALB and task security groups, a health-checked target group, and direct ALB ingress.
7. A real HTTP health probe on the ALB endpoint must pass before the deployment becomes `LIVE`.
8. Monitoring, rollback, and teardown use durable Redis jobs and recorded AWS resource manifests. Teardown verifies all provisioned cloud resources are absent.

Static Terraform files generated in the Infrastructure screen are **reference previews**. The live worker uses the AWS SDK path; generated files are not the production source of truth.

## Useful commands

```powershell
npm run check                  # client lint/build + all server syntax/tests + Prisma validation
npm --prefix server run check  # all server JavaScript syntax checks
npm run db:migrate             # apply committed migrations
npm run db:validate            # validate Prisma schema
npm --prefix server run aws:check  # verify every stored AWS connection through STS
npm --prefix server run secrets:encrypt  # encrypt legacy stored secrets (idempotent)
npm --prefix server test       # server unit tests
npm --prefix client audit --omit=dev --audit-level=high
npm --prefix server audit --omit=dev --audit-level=high
```

CI installs from both lockfiles, generates Prisma, applies migrations to an empty PostgreSQL database, runs tests and syntax checks, builds the client, and audits production dependencies.

## Security notes

- Never commit `.env`, AWS keys, GitHub tokens, database dumps, or generated build workspaces.
- The API uses strict ownership checks for projects, deployments, logs, AWS connections, and GitHub accounts.
- SSE log streams use authenticated fetch requests; the public EventSource route is not exposed.
- Authentication, AWS verification, and deployment mutation routes are rate-limited to reduce brute-force and runaway-job abuse.
- Production startup requires HTTPS for non-local client origins, valid JWT/encryption/database/Redis configuration, and rejects host/inline builds. Production health probes reject non-HTTPS, non-standard ports, private/local addresses, and untrusted redirect targets.
- The optional artifact preview is disabled by default, database-gated, and never serves source workspaces.
- Destroy recorded cloud resources before deleting a project. Teardown rejects malformed manifests, retries idempotently, and verifies recorded AWS resources are absent before reporting success.
- Rotate any credentials that have been copied into logs, tickets, backups, or source control.
