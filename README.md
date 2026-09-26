# SkyForge

SkyForge is a split-stack deployment platform:

- `client/`: React 19 + Vite single-page application.
- `server/`: Express API, Prisma/PostgreSQL persistence, Redis/BullMQ queues, and deployment workers.
- Static repositories deploy to private S3 origins behind CloudFront Origin Access Control.
- Container repositories build in Docker, push an immutable ECR image digest, run on ECS Fargate behind an HTTPS CloudFront edge, and are health-checked over HTTPS.

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

For local static previews only, set `SERVE_DEPLOYMENT_ARTIFACTS=true` to expose `/live/:projectId`. The route is disabled by default, serves only a database-verified `LIVE`/`ROLLED_BACK` static build from that deployment’s isolated `generated/<project>/deployments/<deployment>/dist` directory, rejects symlinks, and never falls back to repository source files. The included server image does not contain the client bundle; use the separate Compose client or provide a combined image before enabling `SERVE_CLIENT`.

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

1. **IAM role (recommended):** set `SKYFORGE_AWS_ACCOUNT_ID` on the SkyForge server, download the CloudFormation template, create the role in the target account, and verify the role ARN. The SkyForge runtime also needs a workload identity or other base credentials capable of assuming that role.
2. **AWS access keys:** long-lived keys or temporary STS keys are verified with STS and encrypted before storage. Temporary credentials must include their session token. Secrets are never returned by the API after saving. Prefer the role flow.

Review the generated IAM policy before applying it in a production AWS account.

## Deployment lifecycle

1. The API validates ownership, repository identity, target, required environment variables, AWS connectivity, and Redis availability.
2. BullMQ stores deployment IDs and non-secret job metadata; credentials are resolved inside the worker.
3. The worker downloads a GitHub archive without shell interpolation, bounds archive resources, and rejects symlinks and secret-like files.
4. Static builds run in a disposable Node container. Output is validated, uploaded to a private S3 bucket, and served through CloudFront OAC. CloudFront invalidations complete before the deployment is health-checked.
5. Container builds run with Docker. Images receive unique tags and are recorded by ECR digest before ECS rollout.
6. ECS uses separate ALB and task security groups, a health-checked target group, and a CloudFront HTTPS edge.
7. A real HTTPS HTTP probe must pass before the deployment becomes `LIVE`.
8. Monitoring, rollback, and teardown use durable Redis jobs and recorded AWS resource manifests. Rollback is health-checked; teardown remains failed if AWS resources cannot be removed or verified.

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
