# SkyForge

SkyForge deploys web applications from a GitHub repository to **your own AWS account**. You choose the target for each project: ECS Fargate, ECS Fargate behind CloudFront, or S3 + CloudFront for static sites. It also scans and protects them, and deletes everything cleanly when you are done.

You connect GitHub and AWS, pick a repository, choose a deployment target, and press **Deploy**. SkyForge then:

1. downloads the source;
2. works out what kind of app it is (language, framework, version, entry point, port);
3. checks the environment variables and services the app needs;
4. builds a production container image and pushes it to Amazon ECR;
5. runs it on the chosen target: ECS Fargate behind an Application Load Balancer (optionally with CloudFront in front), or S3 + CloudFront for static sites;
6. waits for a real HTTP health check before calling it **LIVE**;
7. scans the live site for security problems and, if you choose, puts an AWS WAF firewall in front of it.

**One-Click Destroy** removes every AWS resource the project created. SkyForge then asks AWS whether anything is left, and only reports success when nothing is, so a destroyed project stops costing money.

---

## Contents

- [Feature overview](#feature-overview)
- [Deployment targets](#deployment-targets)
- [Architecture](#architecture)
- [Supported stacks](#supported-stacks)
- [How a deployment works](#how-a-deployment-works)
- [Build planner](#build-planner)
- [Environment variables and services](#environment-variables-and-services)
- [Security](#security)
- [Taking a site offline](#taking-a-site-offline)
- [Destroy and verified teardown](#destroy-and-verified-teardown)
- [Monitoring](#monitoring)
- [Requirements](#requirements)
- [Setup and local development](#setup-and-local-development)
- [AWS onboarding](#aws-onboarding)
- [Configuration reference](#configuration-reference)
- [API reference](#api-reference)
- [Project structure](#project-structure)
- [Testing and useful commands](#testing-and-useful-commands)
- [Limitations](#limitations)
- [Security notes for operators](#security-notes-for-operators)

---

## Feature overview

| Area | What SkyForge does |
|---|---|
| **Repository analysis** | Reads the GitHub repository, detects the framework and language, and suggests CPU and memory with an AI planner (Gemini, optional). |
| **Build planner** | Re-detects the app from the checked-out code at build time and generates a production Dockerfile for 15+ stacks. It falls back to the repository's own Dockerfile if the generated build fails. |
| **Deployment targets** | Three explicit choices, none preselected: ECS Fargate, ECS Fargate + CloudFront, and S3 + CloudFront (static sites). Deployment is blocked until you pick one. |
| **Deployment** | Builds with Docker, pushes to ECR by immutable digest, and runs on ECS Fargate behind an ALB with a rolling update, or builds static files and uploads them to S3. |
| **Environment checks** | Scans the whole source tree for the environment variables the app reads and the databases or caches it needs. Deployment is blocked until required values are set. |
| **Security scanning** | Static code scan, a safe self-pentest of the live site, and a container image CVE scan, combined into a score from 0 to 100 and a grade from A to F. |
| **AI fix pull requests** | One click turns a finding (such as `DEBUG = True` or a hard-coded secret) into a commit and pull request on GitHub. |
| **Canary secrets** | Plants a credential with no permissions in the container; any use of it means the container's secrets have leaked. |
| **Protected tier (WAF)** | OWASP, SQL-injection, known-exploit and IP-reputation rules, rate limiting, code-aware login limits, honeypot auto-ban, Under Attack mode, and an attack dashboard. |
| **Site availability** | Take a site offline (maintenance page, container stopped) and bring it back without redeploying. |
| **Verified teardown** | Deletes every project resource, then sweeps AWS by name and only succeeds once nothing remains. |
| **Monitoring** | Health checks every minute, ban-list sync, canary checks, and automatic recovery after worker restarts. |

---

## Deployment targets

A new project has **no target**. Open **Infrastructure** and pick one of these. Deploy stays disabled until you do.

| Target | Runs | HTTPS | Suits |
|---|---|---|---|
| **ECS Fargate** | Container on Fargate behind an ALB | No (HTTP on the ALB address) | Any app |
| **ECS Fargate + CloudFront** | Same, with a CloudFront distribution in front of the ALB | Yes, on the `cloudfront.net` address | Any app |
| **S3 + CloudFront** | Static build output in a private S3 bucket served by CloudFront (Origin Access Control, AWS security headers policy) | Yes | Static sites and SPAs only |

- You can switch between the two ECS targets at any time. Switching between the ECS and S3 families requires destroying the live deployment first.
- **S3 + CloudFront** builds the app with the generated Dockerfile and copies the files out of the image, so the same detection works (React, Vue, Angular, Vite, plain HTML and similar). Server apps are rejected for this target.
- **CloudFront not enabled on your account?** New AWS accounts can be refused with "Your account must be verified before you can add new CloudFront resources". SkyForge then falls back automatically and tells you so: ECS + CloudFront serves the ALB address over HTTP, and S3 + CloudFront uses S3 static website hosting over HTTP. Once AWS enables CloudFront, redeploy to get HTTPS.
- Behind CloudFront, the WAF reads the visitor IP from `X-Forwarded-For`, so bans and rate limits apply to the real client rather than CloudFront's edge.
- Take-offline works on every target. For S3 sites it switches CloudFront to a maintenance page (or swaps the bucket root in website mode).
- Destroy removes the bucket, distribution and Origin Access Control as well, and the verification sweep checks for them.

---

## Architecture

```text
 Browser ──► client/ (React 19 + Vite)
                │  /api
                ▼
          server/ API (Express 5) ──► PostgreSQL (Prisma)  projects, deployments, encrypted secrets
                │
                ▼ BullMQ queues on Redis
          server/ workers
            ├─ deployment worker  download → env check → build → ECR → ECS → health → security
            ├─ monitor worker     health checks, resume-from-offline, WAF ban sync, canary checks
            ├─ rollback worker    restore a previous task definition
            └─ destroy worker     delete recorded resources → verified sweep
                │
                ▼ your AWS account (assumed role or access keys)
          ECR · ECS Fargate · ALB · Security Groups · IAM · CloudWatch Logs · Secrets Manager · WAF · S3 · CloudFront
```

- **client/**: React 19 single-page app (Vite, Tailwind CSS 4).
- **server/**: Express API, Prisma ORM over PostgreSQL, Redis and BullMQ queues, and the worker processes.
- The API never runs builds. Credentials are resolved inside the worker for each job, and a worker never borrows another user's AWS connection.

---

## Supported stacks

The build planner detects these from the source and generates a production Dockerfile automatically.

| Stack | Detection | How it runs |
|---|---|---|
| **Node.js servers**: Express, Fastify, Koa, Hapi, NestJS, plain Node | `package.json` with server dependencies | `npm start`, `start:prod`, `main`, or a common entry file (`server.js`, `src/index.ts`, ...) |
| **Next.js** | `next` dependency | `next start`; static export (`output: "export"`) is served by nginx |
| **Nuxt, Remix, SvelteKit, Astro (SSR)** | framework dependency and adapter | the framework's Node server output |
| **Frontend SPAs**: React (Vite/CRA), Vue, Angular, Svelte, Preact, Gatsby, Docusaurus, ... | build script plus a frontend toolchain | built with Node, served by nginx with SPA routing and security headers |
| **Static HTML** | `index.html` (root, `public/`, `docs/`, `site/`, ...) | nginx |
| **Python**: Django, Flask, FastAPI, Streamlit, Gradio, scripts | `manage.py`, `requirements*.txt`, `pyproject.toml`, `Pipfile` | gunicorn or uvicorn on the detected module and app object |
| **Go** | `go.mod` or `*.go` | `go build` (main package found automatically, `GOTOOLCHAIN=auto`) |
| **Rust** (Actix, Axum, Rocket, ...) | `Cargo.toml` | release binary on Debian (glibc) |
| **Java**: Spring Boot, Quarkus, Micronaut | `pom.xml`, `build.gradle(.kts)` | Maven or Gradle (wrapper preferred), runnable jar on Temurin |
| **PHP**: Laravel, Symfony, plain PHP | `composer.json` or `*.php` | Apache with `public/` or the repo root as document root |
| **Ruby**: Rails, Sinatra, Rack | `Gemfile` | `rails server`, `ruby app.rb`, or `rackup` |
| **Jekyll** | `_config.yml` plus the Jekyll gem or layouts | built to static HTML, served by nginx |
| **.NET**: ASP.NET Core, minimal APIs | `*.csproj` | `dotnet publish` with the SDK matching `TargetFramework` |
| **Anything with a Dockerfile** | repository `Dockerfile` | built as-is, using the port from `EXPOSE` |

Runtime versions come from `.nvmrc`, `.node-version`, `package.json` `engines`, `.python-version`, `runtime.txt`, `.ruby-version`, `.tool-versions` (asdf/mise), `pom.xml`/Gradle, and `TargetFramework`. If no version is declared, SkyForge chooses one based on the app's tooling. For example, Gatsby 3 runs on Node 16, and `node-sass` 4 runs on Node 14.

Multi-service repositories (several apps under `services/`) are combined into one container behind a small reverse-proxy gateway.

---

## How a deployment works

1. **Preflight (API).** Checks project ownership, the repository identity, that the AWS connection works, that Redis is available, and that **all required environment variables are set**. Any failure blocks the deployment and lists the exact reasons.
2. **Queue.** BullMQ stores only IDs and non-secret metadata. Credentials are resolved inside the worker.
3. **Download.** The worker downloads the GitHub tarball and checks its size limits. It skips symlinks and credential files such as `.env` and private keys, and logs what was skipped. GitHub-hosted **git submodules** are fetched at their pinned commits.
4. **Branch fallback.** If the configured branch does not exist, SkyForge tries `main`, then `master`, then the repository's default branch, logging a warning each time.
5. **Environment check.** The source is re-scanned. A missing required variable stops the deployment within seconds, naming the variable and the file and line that uses it. Backing services and `localhost` connection strings are flagged.
6. **Build.** The build planner chooses the app root, runtime, and start command, then generates the Dockerfile and builds it with Docker. Public build-time variables (`VITE_`, `NEXT_PUBLIC_`, `REACT_APP_`, ...) are passed in as build arguments.
7. **Push.** The image is pushed to a SkyForge-managed ECR repository and recorded by digest.
8. **Provision.** SkyForge creates or reconciles:
   - the ECS cluster;
   - the task definition, with `PORT`/`HOST` environment variables and Secrets Manager secrets;
   - the IAM execution and task roles;
   - the CloudWatch log group;
   - separate security groups for the ALB and the tasks;
   - the ALB with header hardening;
   - the target group, accepting any HTTP response from 200 to 499 as healthy with a 30-second drain;
   - the listener and the ECS service, with a 180-second health-check grace period.
9. **Rollout.** SkyForge waits for the new tasks to run and pass load-balancer health checks, reporting progress as it goes. If the container keeps crashing, it fails early with the exit reason and the app's last log lines.
10. **Health check.** SkyForge waits for the new load balancer's DNS name to resolve, then probes the site over HTTP. If this machine cannot reach the site but AWS reports the target healthy, the deployment still goes live, with a warning.
11. **LIVE.** The deployment is marked live, and the post-launch security steps run. These never fail an otherwise successful deployment:
    - the firewall is applied for Protected projects;
    - the security report is built (code scan, self-pentest, image CVEs, canary check).

Rollback restores a previous task definition. Retrying a deployment re-runs the whole pipeline as a new, immutable attempt.

> The Terraform shown on the Infrastructure page is a **reference preview**. The worker provisions everything with the AWS SDK, and deployment records are the source of truth.

---

## Build planner

`server/services/buildPlanner.js` makes every build-time decision from the checked-out code rather than from metadata captured at import time.

- **App root.** Uses the repository root if it holds a manifest. Otherwise it uses the nearest folder that does, preferring `app/`, `server/`, `backend/`, `api/`, `web/`, ...
- **Entry point and port.**
  - Django: the package that contains `wsgi.py`.
  - Flask and FastAPI: the module and variable that create the app.
  - Node: `start` script → `main` → common entry files → `tsx` for TypeScript entries.
  - The port comes from a hard-coded `listen(...)`, `PORT || 4000`, `server.port=`, `ListenAndServe(":8080")`, and similar patterns, otherwise from framework defaults.
- **Forgiving installs.**
  - Frozen lockfile installs fall back to a normal install.
  - The pnpm version follows the lockfile (or the `packageManager` field).
  - Python installs from prebuilt wheels first and only adds compilers if a package must be built from source.
  - uv and Poetry projects are supported.
- **Forgiving builds.**
  - Old webpack and react-scripts builds are retried with the legacy OpenSSL provider.
  - SPAs whose build script chains a type-check (`tsc && vite build`) are retried with the bundler alone.
  - Angular's nested `dist/<app>/browser` output is found automatically.
- **Dockerfile fallback.** If the generated build fails and the repository has a Dockerfile, it is used instead, and the reverse also applies.
- **Port bridge.** Some apps listen only on `localhost` (Fastify's default, Flask's `app.run()`, `vite preview`). A small static binary (`server/templates/shim/main.go`) starts the app. If the app is reachable only on loopback, the bridge forwards the container's external address to it. If the app already listens on all interfaces, the bridge does nothing.

**Docker strategies** on the Docker page:

- **Generate** (default): SkyForge's template, regenerated from the source on every build.
- **Existing**: the repository's Dockerfile.
- **Custom**: a Dockerfile you edited and saved in SkyForge. **Revert to SkyForge Template** returns to Generate.

---

## Environment variables and services

`server/services/envScanner.js` reads the whole source tree in a single GitHub archive download, so it takes about two seconds per repository.

**What it detects**

| Source | Examples |
|---|---|
| JavaScript/TypeScript | `process.env.X`, `process.env["X"]`, destructuring from `process.env`, `import.meta.env.X` |
| Python | `os.environ["X"]`, `os.getenv("X", default)`, python-decouple `config("X")`, django-environ `env("X")`, **pydantic `BaseSettings` fields** |
| Go, Ruby, PHP, Java, C#, Rust | `os.Getenv`, `ENV.fetch`/`ENV[...]`, Laravel `env()`/`getenv`, `System.getenv`, `Environment.GetEnvironmentVariable`, `env::var(...).unwrap()` |
| Config files | Spring `${X}` / `${X:default}`, Prisma `env("X")`, `.env.example` / `.env.sample` / `.env.template` |

**Required or optional**

- **Required.** A value with no fallback: `os.environ["X"]`, a pydantic field without a default, `${X}`, `.unwrap()`, `ENV.fetch("X")`, or a placeholder value in `.env.example`. A secret- or connection-like name (`*_SECRET`, `*_KEY`, `DATABASE_URL`, `*_URI`, ...) read without a default also counts as required.
- **Optional.** Anything with a default (`process.env.X || "info"`, `getenv("X", "dev")`, `${X:10}`), plus frontend build-time variables.
- Variables the platform sets itself (`PORT`, `HOST`, `NODE_ENV`, ...) and reads inside tests, tooling configs, and type declarations are ignored.

**Backing services** (PostgreSQL, MySQL/MariaDB, MongoDB, Redis, SQLite) are detected from dependency manifests: npm, pip/Poetry/Pipfile, Go modules, Cargo features, Gemfile, Composer, Maven/Gradle, NuGet, and the Prisma provider. SkyForge **does not create databases**. It warns you to supply a hosted instance reachable from AWS (Neon, Supabase, MongoDB Atlas, Upstash, RDS, ...). It also warns when a configured value points at `localhost`, which on AWS is the container itself.

**On the Environment page** (Plan screen), each variable shows:

- whether it is required, along with the file and line where it is used;
- a **Not needed** checkbox for false positives, which stops the variable from blocking deployment;
- for optional variables, their defaults or example values;
- service warnings, and a **Re-scan** button.

Values are encrypted at rest (AES-GCM with `FIELD_ENCRYPTION_KEY`) and injected into the container as Secrets Manager secrets.

---

## Security

Each project has a security tier, chosen on the **Security & Uptime** page (`/project/:id/security`).

| | **Free** ($0) | **Protected** (about $14/month) |
|---|:---:|:---:|
| Security score: code scan + safe self-pentest after every deployment | ✅ | ✅ |
| Detection of debug mode, hard-coded secrets, committed `.env` files, and insecure configuration | ✅ | ✅ |
| One-click AI fix pull requests | ✅ | ✅ |
| Container image vulnerability (CVE) scan | ✅ | ✅ |
| Canary secret | ✅ | ✅ |
| Security headers on static sites, ALB header hardening, AWS Shield Standard | ✅ | ✅ |
| AWS WAF: OWASP core rules, SQL injection, known bad inputs, IP reputation | | ✅ |
| Rate limiting (2,000 requests per 5 minutes per IP) | | ✅ |
| Code-aware login rate limit (100 per 5 minutes on login and auth routes found in the source) | | ✅ |
| Honeypot tripwires with a 24-hour auto-ban, and an Unban button | | ✅ |
| Under Attack mode and a blocked-attack dashboard | | ✅ |

Protected tier pricing is AWS WAF's: $5 per web ACL plus $1 per rule (9 rules), plus $0.60 per million requests. Switching tiers on a live site applies or removes the firewall immediately.

### Security score

`server/services/securityScanner.js` combines three sources into one score. Each finding deducts points by severity (critical 30, high 15, medium 7, low 2), and the result is graded A (90+), B (75+), C (60+), D (40+), or F.

**1. Code scan**

| Finding | Severity |
|---|---|
| Committed `.env` files | high |
| AWS, Stripe live, GitHub, and Slack keys; private keys | critical |
| Google API keys | high |
| Django `DEBUG = True` | high |
| Hard-coded Django `SECRET_KEY` | high |
| `ALLOWED_HOSTS = ['*']` | low |
| Flask `debug=True` | medium |
| Wildcard CORS with credentials | medium |
| Spring actuator exposing everything | high |
| Express without helmet | low |
| Generic hard-coded credentials in config modules | medium |

**2. Self-pentest of the live site.** About 25 safe GET requests, sent only to the project's own URL. It checks for:

- exposed `/.git/`, `/.env`, `/db.sqlite3`, `/.DS_Store`, `server-status`, and actuator `/env`;
- debug error pages (Django, Werkzeug, Laravel, Node, Spring stack traces);
- a public Django admin;
- directory listing;
- missing security headers;
- server version banners;
- insecure session cookies;
- CORS reflection;
- reflected (unescaped) input;
- open redirects;
- HTTP without TLS.

**3. Image scan.** ECR basic scanning (free) of the image that actually runs (`linux/amd64`, even when Docker pushes a multi-platform index). Critical and high CVE counts become findings.

The scan runs automatically after every deployment and on demand with **Run security scan**.

### AI fix pull requests

**Create fix PR** on a fixable finding (`server/services/fixPullRequest.js`):

- **Well-known issues get deterministic fixes.** Django `DEBUG` becomes `os.environ.get("DJANGO_DEBUG", "False")`. `SECRET_KEY` becomes `os.environ["DJANGO_SECRET_KEY"]`. Flask `debug=True` becomes `FLASK_DEBUG`. Before editing, SkyForge confirms the target line still contains the problem.
- **Other findings are fixed by Gemini.** It may only replace lines within ±6 of the finding and must never write out the secret value.
- **Where the change goes.** On repositories you can push to, SkyForge creates a branch and opens a **pull request**. On someone else's repository, it commits to a branch in **your fork** and returns a compare link. SkyForge never opens pull requests on third-party repositories by itself.
- **Follow-up.** The pull request description lists any environment variables to set before redeploying.

### Canary secret

On the first deployment, SkyForge creates an IAM user named `<app>-canary` with **no permissions** and plants its access key in the container as `AWS_BACKUP_ACCESS_KEY_ID` / `AWS_BACKUP_SECRET_ACCESS_KEY`. Nothing legitimate ever uses it. The monitor checks `GetAccessKeyLastUsed` about every 10 minutes. Any use produces a **critical** finding: the container's environment has leaked, so rotate your secrets. IAM users are free, and the canary is deleted on destroy.

### Protected tier: AWS WAF on the load balancer

`server/services/wafService.js` creates a regional web ACL attached to the project's ALB. It does not need CloudFront. Its rules run in this order:

1. **SkyForge scanner allow.** Requests carrying the project's secret `x-skyforge-scan` header pass, so the self-pentest checks the app itself and never trips its own honeypots.
2. **Banned IPs.** An IP set filled by the tripwire.
3. **Tripwire.** Requests for paths that scanners probe, such as `/.env`, `/.git/`, `/.aws/`, `/wp-login.php`, `/xmlrpc.php`, `/phpmyadmin`, `/cgi-bin/`, `/vendor/phpunit`, `/server-status`, and `/actuator/`, are blocked. The list is **code-aware**: it leaves out any path the app itself serves, such as WordPress paths for PHP apps, `/actuator/` for Spring, and routes found in the source. The monitor bans the offending IPs for 24 hours.
4. **Login rate limit.** 100 requests per 5 minutes per IP on login, auth, token, and admin routes, including routes extracted from Express, Django, Flask, FastAPI, Spring, Rails, Laravel, and Next.js file routes.
5. **Global rate limit.** 2,000 requests per 5 minutes per IP.
6. **AWS managed rule groups.**
   - IP reputation, known bad inputs, and SQL injection.
   - The OWASP core rule set, with its 8 KB request-body limit switched to count-only so uploads keep working.

**Under Attack mode** tightens the limits to 300 per 5 minutes globally and 20 on login routes; turning it off restores the normal limits. The **attack dashboard** summarizes blocked requests sampled over the last 3 hours, broken down by rule, attacker IP, country, and targeted path.

### Always on

- **Security headers.** nginx-served sites send `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, and `Permissions-Policy`, and hide the nginx version.
- **ALB hardening.** `drop_invalid_header_fields` guards against request smuggling.
- **AWS Shield Standard.** Network-level DDoS protection on every ALB.
- **Network isolation.** Tasks accept traffic only from the ALB security group.
- **Secrets handling.** Secrets are stored in Secrets Manager. Credential files are stripped from images.

---

## Taking a site offline

**Take site offline** on the Security page, without destroying anything:

- The ALB listener switches to a built-in **maintenance page** (HTTP 503), which takes effect within about 15 seconds.
- The ECS service scales to **0 tasks**, so container charges stop.
- The load balancer keeps billing (about $0.55/day). To stop all charges, destroy the project.

**Bring site online:**

1. The service scales back to 1 task.
2. A hidden warm-up listener rule keeps the target group in use, so AWS health-checks the restarting container.
3. The monitor switches traffic back as soon as the container is healthy, usually within 1–2 minutes. Visitors see the maintenance page until then, not errors.

---

## Destroy and verified teardown

**One-Click Destroy** on the Deployment Console:

1. **Snapshot.** Records every resource manifest for the project's deployments.
2. **Delete, in dependency order.**
   - WAF web ACL (detached from the ALB first) and its ban list; the canary IAM user and keys.
   - ECS service: SkyForge waits until the tasks have fully stopped. Then the cluster.
   - Listeners, the ALB, and the target group.
   - Security groups: retried for up to 10 minutes while AWS releases network interfaces.
   - Log group, Secrets Manager secret, IAM roles, and task definitions.
   - The ECR repository and all its images.
3. **Verified sweep.** SkyForge searches AWS for **anything named for the project**, including resources a crashed or interrupted operation never recorded:
   - ECS cluster, service, and task definitions;
   - ALB and target group;
   - security groups and IAM roles;
   - log group and secret;
   - WAF ACL and IP set;
   - canary user;
   - ECR repository.

   It deletes whatever it finds and checks again.
4. **Success only when AWS confirms nothing remains:** *"Verified with AWS: no resources for this project remain, so it no longer incurs charges."* If something survives, teardown fails and lists exactly what is left. **Retry Teardown** is idempotent.

The local build workspace is removed, and the project's security state is reset.

---

## Monitoring

The monitor worker runs every minute for each live deployment. It:

- probes the site's health path and records the latency and health status;
- skips the probe while the site is offline;
- completes **Bring online** once the container is healthy;
- about every 10 minutes, syncs WAF tripwire bans (with unbanned IPs exempt for 24 hours) and checks the canary.

Each check schedules the next, keyed by minute so that duplicate chains merge. When a worker starts, it **re-seeds monitoring for every live site**, so restarts never leave a site unwatched.

---

## Requirements

- Node.js `22.13+` and npm `10+`
- PostgreSQL `16+`
- Redis `7+`
- Docker Engine or Docker Desktop, with the CLI available to the worker (BuildKit)
- An AWS account connected through an IAM role or access keys
- A GitHub OAuth app (for repository access and fix pull requests)
- Optional: a Gemini API key (AI deployment plans and AI fixes)

---

## Setup and local development

```powershell
Copy-Item server/.env.example server/.env
Copy-Item client/.env.example client/.env
npm run install:all
npm run db:generate
npm run db:migrate
```

Set real values in `server/.env`. Generate a 32-byte field-encryption key:

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToBase64String($bytes)
```

Use a different `FIELD_ENCRYPTION_KEY` and `JWT_SECRET` (32+ characters) for every environment. If `DATABASE_URL` contains special characters such as `@`, URL-encode them (`%40`).

With PostgreSQL and Redis running, start each process in its own terminal:

```powershell
npm run dev:api      # http://localhost:5000
npm run dev:worker
npm run dev:client   # http://localhost:5173 (proxies /api to the API)
```

No local Redis? Run `docker run -d --name skyforge-redis -p 6379:6379 redis:7-alpine`.

GitHub OAuth callback URL: `https://<api-host>/api/github/callback`. OAuth state is bound to an HttpOnly cookie.

### Docker Compose stack

```powershell
$env:POSTGRES_PASSWORD = "use-a-local-password"
docker compose up --build
```

- Client: `http://localhost:3000`
- API health and readiness: `http://localhost:5000/healthz` and `http://localhost:5000/readyz`

The worker uses the host Docker socket in this local topology only. In a hostile multi-tenant environment, use a restricted BuildKit or build service instead.

---

## AWS onboarding

The Settings screen offers two ways to connect:

1. **IAM role (recommended for production).**
   1. Set `SKYFORGE_AWS_ACCOUNT_ID` to the account that runs the SkyForge API and worker.
   2. Download the CloudFormation template and create the deployment role in the target account.
   3. Verify the role ARN.

   The SkyForge runtime needs its own workload identity with `sts:AssumeRole`. Each customer role trusts the SkyForge account and requires a unique External ID.
2. **Access keys (fallback).** Verified with STS and encrypted before storage. Temporary keys must include their session token.

**After upgrading:** the role template now includes the permissions for security features:

- `wafv2:*` web ACL and IP set actions;
- `elasticloadbalancing:SetWebAcl`, `ModifyLoadBalancerAttributes`, and `CreateRule`/`DeleteRule`/`DescribeRules`;
- IAM user and access-key actions for the canary;
- ECR image scanning actions;
- `logs:GetLogEvents`.

Re-create existing roles from the updated template to use these features. Without them, the related features are skipped with a clear log message, and deployments still work.

**Local role-flow testing.** Use AWS IAM Identity Center (`aws configure sso --profile skyforge-platform`). Then copy `docker-compose.aws-profile.yml.example` to `docker-compose.aws-profile.yml`, set `AWS_PROFILE` and `AWS_CONFIG_DIR`, and start Compose with both files. The local copy is git-ignored.

---

## Configuration reference

All server settings live in `server/.env`, which is loaded by `server/config/env.js` regardless of the working directory.

| Variable | Purpose |
|---|---|
| `DATABASE_URL`, `REDIS_URL` (or `REDIS_HOST`/`REDIS_PORT`) | Storage and queues |
| `JWT_SECRET`, `FIELD_ENCRYPTION_KEY` | Auth tokens and at-rest encryption (required in production) |
| `CLIENT_URL` | Allowed browser origin(s); must use HTTPS in production (except localhost) |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub OAuth |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Optional AI planner and AI fixes |
| `SKYFORGE_AWS_ACCOUNT_ID`, `AWS_REGION` | Role onboarding and default region |
| `AWS_VPC_ID` + `AWS_SUBNET_IDS` | Reuse a specific network (otherwise the default VPC is used) |
| `ALLOW_PLATFORM_AWS` + `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` | Single-account platform credentials (off by default) |
| `ALLOW_INLINE_JOBS` | Run jobs in the API when Redis is down (development only; rejected in production) |
| `ALLOW_CUSTOM_HEALTH_HOSTS` | Allow health probes to non-AWS hosts (development) |
| `BUILD_TIMEOUT_MS`, `PUSH_TIMEOUT_MS` | Docker build and push time limits |
| `ECS_WAIT_SECONDS` | Maximum time to wait for a rollout (default 900) |
| `DESTROY_VERIFY_ATTEMPTS`, `CLOUDFRONT_WAIT_SECONDS` | Teardown verification and how long to wait for CloudFront distributions to disable |
| `DEPLOYMENT_WORKER_CONCURRENCY` | Parallel deployments per worker |
| `TRUST_PROXY`, `SERVE_CLIENT`, `LOG_REDIS_ERRORS` | Reverse-proxy trust, serving `client/dist` from the API, Redis error logging |

The client reads `VITE_API_ORIGIN`. Leave it empty when the client and API share an origin.

---

## API reference

All routes are under `/api`, and all except auth and the OAuth callback require `Authorization: Bearer <token>`.

| Area | Routes |
|---|---|
| Auth | `POST /auth/signup`, `POST /auth/login`, `GET /auth/me`, `PATCH /auth/profile` |
| GitHub | `GET /github/login`, `GET /github/callback`, `GET /github/repos`, `POST /github/analyze`, `POST /github/disconnect` |
| AWS | `GET /aws/status`, `POST /aws/setup`, `POST /aws/connect`, `POST /aws/credentials`, `POST /aws/disconnect` |
| Projects | `POST /projects`, `GET /projects`, `GET /projects/:id`, `DELETE /projects/:id` |
| Plan and environment | `GET\|POST /projects/:id/plan`, `POST /projects/:id/env` (values + `ignoredEnv`), `POST /projects/:id/env/scan` |
| Docker | `GET /projects/:id/docker`, `POST /projects/:id/docker/strategy`, `POST /projects/:id/docker/validate`, `POST /projects/:id/docker/save` |
| Infrastructure | `GET /projects/:id/infrastructure` |
| Security | `GET /projects/:id/security`, `POST /projects/:id/security/tier`, `POST /projects/:id/security/scan`, `POST /projects/:id/security/under-attack`, `POST /projects/:id/security/unban`, `POST /projects/:id/security/fix` |
| Site availability | `POST /projects/:id/site/offline`, `POST /projects/:id/site/online` |
| Deployments | `POST /deployments/project/:projectId`, `GET /deployments/project/:projectId`, `GET /deployments/:id`, `GET /deployments/:id/logs/stream` (SSE), `GET /deployments/:id/queue-position`, `POST /deployments/:id/retry`, `POST /deployments/:id/rollback`, `POST /deployments/project/:projectId/destroy` |
| Health | `GET /healthz`, `GET /readyz` |

---

## Project structure

```text
client/src/
  pages/            Dashboard, Projects, DeploymentPlan (environment), DockerPreview,
                    InfrastructurePreview, DeploymentConsole, Security, Settings, ...
  components/       EnvironmentWizard, RepositoryIntelligence*, Card, Button, ...
  services/api.js   API client
server/
  config/           env loader, Prisma client
  controllers/      auth, github, aws, project, planning, docker, infrastructure,
                    deployment, security
  services/
    buildPlanner.js     source → app root, runtime, entry point, port
    templateEngine.js   Dockerfile generation (templates/docker/*)
    sourceService.js    download, submodules, build attempts, port bridge
    envScanner.js       environment variables and backing services
    ecsService.js       ECS/ALB provisioning, offline/online, discovery sweep
    ecrService.js       ECR push and image scanning
    securityScanner.js  code scan, self-pentest, scoring, route extraction
    securityService.js  tiers, canary, firewall orchestration, reports
    wafService.js       AWS WAF rules, bans, attack summary
    canaryService.js    canary IAM credentials
    fixPullRequest.js   deterministic and AI fixes as GitHub branches and pull requests
    destroyService.js   teardown and verified sweep
    healthService.js    SSRF-safe HTTP probes and DNS wait
  workers/          deployment, monitor, rollback, destroy, reconciler
  templates/        docker/* generators, shim/main.go (port bridge), terraform previews
  prisma/           schema and migrations
  test/             node:test suites
```

---

## Testing and useful commands

```powershell
npm run check                      # client lint + build, server syntax + tests, Prisma validation
npm --prefix server test           # server unit tests (node:test)
npm --prefix server run check      # syntax-check every server JavaScript file
npm run db:migrate                 # apply committed migrations
npm run db:validate                # validate the Prisma schema
npm --prefix server run aws:check  # verify every connected AWS account through STS
npm --prefix server run secrets:encrypt  # encrypt legacy stored secrets (idempotent)
```

The test suites cover:

- build planning across stacks;
- environment-variable classification;
- Dockerfile templates;
- WAF rule generation;
- the code scan and deterministic fixes;
- route extraction;
- a self-pentest against a deliberately vulnerable local server;
- secret handling, serialization, rate limiting, and teardown manifests.

CI installs from both lockfiles, applies migrations to an empty PostgreSQL database, runs tests and syntax checks, builds the client, and audits production dependencies.

---

## Limitations

- **HTTPS.** The plain ECS Fargate target serves HTTP on the ALB address. The CloudFront targets give free HTTPS, but some new AWS accounts must ask AWS Support to enable CloudFront; until then they fall back to HTTP. The security report flags HTTP-only sites.
- **WAF on S3 sites.** The Protected tier attaches a regional WAF to the ALB, so it does not yet cover S3 + CloudFront sites (a CloudFront-scope WAF is planned).
- **SPA deep links in S3 website mode** return status 404 while still serving the app, because S3 website hosting uses the error document. With CloudFront enabled they return 200.
- **Databases are not provisioned.** SkyForge detects them and tells you what to set; you supply a hosted instance.
- **Pattern-based detection.** Unusual setups can be missed, such as variables built at runtime or custom config loaders. The deploy-time check, the **Not needed** option, and Custom Dockerfiles cover the gaps.
- **Not every repository can deploy.** Repositories with broken code, that need services at build time (for example `sqlx` compile-time queries), or that are not web servers will fail with a clear reason.
- **Offline mode still bills for the ALB.** Destroy to stop all charges.
- **Builds run on the worker host.** Slow networks lengthen builds; tune `BUILD_TIMEOUT_MS` if needed.

---

## Security notes for operators

- Never commit `.env` files, AWS keys, GitHub tokens, database dumps, or `server/generated/`.
- Every project, deployment, log, AWS connection, and GitHub account is ownership-checked.
- SSE log streams require authenticated fetch requests.
- Authentication, AWS verification, planning, deployment mutation, and security routes are rate-limited.
- Production startup requires HTTPS client origins, valid JWT, encryption, database, and Redis settings, and rejects inline jobs. Health probes block private addresses, credentials in URLs, and untrusted redirects; plain HTTP is allowed only for AWS load-balancer endpoints.
- Unexpected errors return a generic message; client errors (bad JSON, CORS) return safe, specific messages.
- Rotate any credentials that have been copied into logs, tickets, backups, or source control.
