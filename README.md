# SkyForge

SkyForge deploys web applications from a GitHub repository to **your own AWS account**. You choose the target for each project: ECS Fargate, ECS Fargate behind CloudFront, or S3 + CloudFront for static sites. It also scans and protects them, and deletes everything cleanly when you are done.

You connect GitHub and AWS, pick a repository, choose a deployment target, and press **Deploy**. SkyForge then:

1. downloads the source;
2. works out what kind of app it is (language, framework, version, entry point, port);
3. checks the environment variables and services the app needs;
4. builds a production container image and pushes it to Amazon ECR;
5. runs it on the chosen target: ECS Fargate behind an Application Load Balancer (optionally with CloudFront in front), or S3 + CloudFront for static sites;
6. waits for a real HTTP health check before calling it **LIVE**;
7. scans the live site for security problems and, if you choose, puts an AWS WAF firewall in front of it;
8. keeps watching: 21 attack-prevention features run for as long as the site is live, including decoys, honey credentials, automatic incident response with Email/Slack/Discord/Telegram alerts, leak and CVE watch, and an AI red team.

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
- [Databases](#databases)
- [Where images are built](#where-images-are-built)
- [AWS guide and readiness check](#aws-guide-and-readiness-check)
- [Security](#security)
- [Taking a site offline](#taking-a-site-offline)
- [Destroy and verified teardown](#destroy-and-verified-teardown)
- [After deploy](#after-deploy): auto-deploy, previews, custom domains, costs, logs and metrics, restore, status page
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
| **Protected tier (WAF)** | OWASP, SQL-injection, known-exploit and IP-reputation rules, self-tuning rate limits, code-aware login limits, honeypot auto-ban, Under Attack mode, and an attack dashboard. Works on the ALB and on CloudFront. |
| **21 attack-prevention features** | Deception (decoy `.env` + honey credentials + `robots.txt` bait), security gate, outbound firewall, admin lockdown + rotating door, bot challenge, herd immunity, read-only containers, code-derived IAM, leak watch, OSV CVE alerts, push-time secret detection, blast radius, attack replay, surface diff, denial-of-wallet guard, AI red team. |
| **Alerts and incident response** | Email, Slack, Discord, Telegram and signed webhooks. Every incident records what SkyForge did automatically (Under Attack mode, bans, restart, offline) and what you should do. |
| **Site availability** | Take a site offline (maintenance page, container stopped) and bring it back without redeploying. |
| **Verified teardown** | Deletes every project resource, then sweeps AWS by name and only succeeds once nothing remains. |
| **Cloud builds** | Optionally build images in AWS CodeBuild inside your account (only the source is uploaded); falls back to a local build if AWS refuses or the build fails. |
| **AWS guide and readiness check** | An in-app guide to AWS sign-up, verification, security, limits and costs, plus a live read-only check of the connected account. |
| **Auto-deploy and previews** | Every push to the branch deploys automatically; every open pull request gets its own temporary preview, removed when the PR closes. |
| **Custom domains** | Your own domain with a free AWS certificate, attached to CloudFront or the load balancer. |
| **Costs and budget** | Account spend by day and service, per-site costs, a forecast, and a monthly budget that alerts (or takes sites offline). |
| **App logs and metrics** | Live app output from CloudWatch plus CPU, memory, traffic, latency and error charts. |
| **Restore any version** | Put any earlier working version back live without rebuilding. |
| **Plain-English failures** | Failed deploys are explained with one-click fixes (port, memory, build location, settings). |
| **Public status page** | A shareable uptime page with 90 days of history. |
| **Monitoring** | Health checks every minute, scheduled security automation (bans, honey and canary keys, attack spikes, pushes, cost, rate-limit tuning, leaks, CVEs, door rotation), and automatic recovery after worker restarts. |

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

- **Full-stack repositories.** A browser frontend and a Node API in sibling folders (`client/` + `server/`, `frontend/` + `backend/`, `web/` + `api/`, ...) are built into **one container** (`server/services/fullStackBuilder.js`):
  - the frontend is built (Vite, Create React App, Vue, Angular, Svelte, ...) and served as static files on port 80, with client-side routes falling back to `index.html`;
  - the API runs on its own port inside the container, started with the command from its own Dockerfile (so steps like "run migrations, then start" are kept), its `start` script, or its entry file;
  - `/api`, `/socket.io`, `/graphql`, `/health`, `/metrics`, WebSockets, and anything that is not a page or a file go to the API, so the browser talks to one address, just like behind the dev-server proxy;
  - an unset socket URL variable (`VITE_SOCKET_URL`, `REACT_APP_WS_URL`, ...) defaults to `/` (this site), and the log warns about other `http://localhost` fallbacks in the frontend code;
  - if the API process stops, the container stops, so AWS restarts it.

  SSR frontends (Next.js, Nuxt, SvelteKit, Remix, Astro) and non-Node APIs are not combined this way.
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

**Backing services** (PostgreSQL, MySQL/MariaDB, MongoDB, Redis, SQLite) are detected from dependency manifests: npm, pip/Poetry/Pipfile, Go modules, Cargo features, Gemfile, Composer, Maven/Gradle, NuGet, and the Prisma provider. SkyForge warns when a configured value points at `localhost`, which on AWS is the container itself. For SQL databases you can choose how the app gets one (see [Databases](#databases)); for MongoDB and Redis, supply a hosted instance (MongoDB Atlas, Upstash, ...).

**On the Environment page** (Plan screen), each variable shows:

- whether it is required, along with the file and line where it is used;
- a **Not needed** checkbox for false positives, which stops the variable from blocking deployment;
- for optional variables, their defaults or example values;
- service warnings, and a **Re-scan** button.

Values are encrypted at rest (AES-GCM with `FIELD_ENCRYPTION_KEY`) and injected into the container as Secrets Manager secrets.

### Databases

The **Database** card on the Environment page offers two ways to give the app a PostgreSQL or MySQL database:

| Option | What happens | Cost |
|---|---|---|
| **Use my own database URL** | You paste a connection string (Neon, Supabase, PlanetScale, your own RDS, ...) as `DATABASE_URL`. | Your provider's |
| **Create one for me on AWS (RDS)** | On the next deploy SkyForge creates a database in your AWS account and gives the app its address. | About $13–16/month (`db.t4g.micro` + 20 GB), free for 12 months on free-tier accounts |

The managed database (`server/services/rdsService.js`):

- is **PostgreSQL 16** or **MySQL 8.0**, `db.t4g.micro`, 20 GB gp3, encrypted, single-AZ, with 1 day of automatic backups;
- is **private**: no public address, and its security group only accepts connections from the app's containers (the private VPC range is allowed only until the app's security group exists on the first deploy);
- gets a generated password, stored encrypted and passed to the app through Secrets Manager;
- sets `DATABASE_URL` plus the usual variants, so most frameworks need no changes: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME`, `DB_DATABASE`, and `PG*` / `POSTGRES_*` (PostgreSQL) or `MYSQL_*` (MySQL). These variables count as set, so they never block deployment, and they override a `localhost` value;
- takes 5–10 minutes the first time; later deploys reuse it, and its data survives redeploys;
- allows plain connections for PostgreSQL (`rds.force_ssl=0` in a project parameter group), because many app drivers cannot verify the RDS certificate out of the box. Traffic never leaves the VPC.

**One-Click Destroy deletes the database and its data** (no final snapshot, so nothing keeps billing), then its subnet group, parameter group and security group, and the verified sweep checks for all four. Taking a site offline does not stop the database.

---

## Where images are built

The **Where to build** card on the Infrastructure page chooses, per project:

| Option | What happens | Cost |
|---|---|---|
| **On this computer** (default) | Docker builds the image here and uploads it to ECR. | Free |
| **In AWS (CodeBuild)** | Only the source archive (usually a few MB) is uploaded; AWS CodeBuild builds the image and pushes it to ECR inside AWS's network. Docker is not needed here. | About $0.01 per build minute; the first 100 minutes a month are free |

Cloud builds (`server/services/cloudBuildService.js`):

- create a shared builder in your account once: a private S3 bucket (`skyforge-builds-<account>-<region>`, archives expire after a day), an IAM role (`skyforge-codebuild`) that can only read that bucket, push to `skyforge-*` repositories and write its logs, and the CodeBuild project `skyforge-builder` (Linux, 4 vCPU / 7 GB). None of these cost anything while idle;
- pull official base images (`node`, `python`, `nginx`, ...) from the Amazon ECR Public mirror of Docker Hub, avoiding Docker Hub's pull limits on shared build hosts;
- stream the CodeBuild log into the deployment console.

**AWS first, this computer second.** If AWS refuses a cloud build (new accounts often start with a CodeBuild limit of 0 concurrent builds) or the cloud build fails for any other reason, SkyForge logs why and builds locally instead. Only a cancelled deployment stops. To enable cloud builds on a new account, request a higher **Concurrently running builds** quota for CodeBuild in Service Quotas.

**Slow or unstable connections.**

- Local builds retry network failures (dropped registry connections, timeouts, DNS errors) up to 3 times, reusing finished steps. Errors in the app's own build are not retried.
- Uploads to ECR retry up to 5 times. Layers that already reached AWS are skipped on each attempt.
- An upload where no layer finishes for 4 minutes is restarted. The limit grows on each retry (10 minutes, then none), so a slow but working upload of a large layer is never cut off. The whole push may take up to 30 minutes (`PUSH_TIMEOUT_MS`, `PUSH_STALL_MS`).

---

## AWS guide and readiness check

**AWS Guide** in the sidebar (`/dashboard/aws-guide`) explains everything an AWS account needs before deploying:

- **Account:** sign-up and verification (email, card, phone, identity), and securing the account (root MFA, no root keys, IAM role or user).
- **Setup:** connecting it to SkyForge, and choosing a region.
- **Limits:** account verifications that unlock features (CloudFront, the CodeBuild quota, the Fargate vCPU quota, RDS).
- **Money:** budgets and the free tier, and what each target costs.
- **Deploying:** a pre-deployment checklist, and fixes for common error messages.
- **Clean-up:** how to stop all charges.

**Check my AWS account** runs read-only checks (`GET /api/aws/readiness`, `server/services/awsReadiness.js`); nothing is created or billed:

| Check | Fails or warns when |
|---|---|
| Docker running, GitHub connected | Docker Desktop is stopped; no GitHub login |
| AWS credentials work | Keys or role are invalid; **warns when connected with root user keys** |
| This computer can reach the region | STS, ECR, ECS or S3 endpoints of the region do not answer |
| Network | No VPC with two subnets in different zones |
| Permissions | Read probes of ECR, ECS, load balancers, Secrets Manager, CloudWatch Logs, CloudFront, RDS and WAF are denied |
| Fargate capacity | The Fargate On-Demand vCPU quota is below 2 (via Service Quotas) |
| CloudFront, CodeBuild, RDS limits | AWS refused them in an earlier deployment (from the deployment history) |

Each item says what was found and how to fix it.

## Global search

The search box in the top bar finds projects (name, repository, framework, status), a project's pages ("lexa security" opens Lexa's Security page), app pages, and AWS guide topics. Use the arrow keys and Enter, press **Ctrl+K** (or **/**) anywhere to focus it, and Esc to close it. On phones it opens from the search icon.

---

## Security

Each project has a security tier and a set of protection switches, all on the **Security & Uptime** page (`/project/:id/security`). Alert channels are set once per account under **Settings → Security alerts**.

| | **Free** ($0) | **Protected** (about $14–20/month) |
|---|:---:|:---:|
| Security score: code scan + safe self-pentest after every deployment | ✅ | ✅ |
| Container image CVE scan, canary secret, one-click AI fix pull requests | ✅ | ✅ |
| Security gate before traffic switches (#2) | ✅ | ✅ |
| Alerts on Email, Slack, Discord, Telegram and webhooks, plus automatic incident response (#6) | ✅ | ✅ |
| New-CVE alerts from OSV (#8), push-time secret detection (#9), leak watch (#11) | ✅ | ✅ |
| Outbound firewall (#3), tamper-proof read-only containers (#10), AWS permissions generated from the code (#14) | ✅ (ECS) | ✅ (ECS) |
| Blast-radius map (#13), attack-surface diff per deploy (#18), denial-of-wallet guard (#19), AI red-team rehearsal (#20) | ✅ | ✅ |
| Decoy secrets with honey credentials and `robots.txt` bait (#1, #15, #16) | ✅ static sites | ✅ all targets |
| AWS WAF: OWASP core, SQL injection, known bad inputs, IP reputation | | ✅ |
| Tripwire auto-bans and herd immunity across projects (#12) | | ✅ |
| Self-tuning rate limits (#7) and code-aware login limits | | ✅ |
| Admin lockdown (#4), rotating admin door (#21), bot challenge (#5) | | ✅ |
| Under Attack mode (manual or automatic), attack dashboard, attack replay (#17) | | ✅ |

Protected-tier pricing is AWS WAF's: $5 per web ACL, $1 per rule per month (9 to 15 rules depending on which features are on), and $0.60 per million requests. Switching tiers or toggling a feature on a live site takes effect immediately, except the read-only filesystem, which applies on the next deployment.

The numbers (#1–#21) refer to the 21 attack-prevention features listed in [The 21 attack-prevention features](#the-21-attack-prevention-features).

### Security score

`server/services/securityScanner.js` combines four sources into one score. Each finding deducts points by severity (critical 30, high 15, medium 7, low 2), and the result is graded A (90+), B (75+), C (60+), D (40+), or F.

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

SkyForge's own decoy files are recognised by their honey key and never reported as leaks.

**3. Leak watch.** The site's pages and same-origin JavaScript bundles are searched for the project's real secret values (see [#11](#11-secret-aware-response-firewall-leak-watch)).

**4. Image scan.** ECR basic scanning (free) of the image that actually runs (`linux/amd64`, even when Docker pushes a multi-platform index). Critical and high CVE counts become findings.

The scan runs automatically after every deployment and on demand with **Run security scan**.

### AI fix pull requests

**Create fix PR** on a fixable finding (`server/services/fixPullRequest.js`):

- **Well-known issues get deterministic fixes.** Django `DEBUG` becomes `os.environ.get("DJANGO_DEBUG", "False")`. `SECRET_KEY` becomes `os.environ["DJANGO_SECRET_KEY"]`. Flask `debug=True` becomes `FLASK_DEBUG`. Before editing, SkyForge confirms the target line still contains the problem.
- **Other findings are fixed by Gemini.** It may only replace lines within ±6 of the finding and must never write out the secret value.
- **Where the change goes.** On repositories you can push to, SkyForge creates a branch and opens a **pull request**. On someone else's repository, it commits to a branch in **your fork** and returns a compare link. SkyForge never opens pull requests on third-party repositories by itself.
- **Follow-up.** The pull request description lists any environment variables to set before redeploying.

### Canary secret

On the first deployment, SkyForge creates an IAM user named `<app>-canary` with **no permissions** and plants its access key in the container as `AWS_BACKUP_ACCESS_KEY_ID` / `AWS_BACKUP_SECRET_ACCESS_KEY`. Nothing legitimate ever uses it. The monitor checks `GetAccessKeyLastUsed` about every 10 minutes. Any use raises a **critical** incident: the container's environment has leaked, so rotate your secrets. On the Protected tier the automatic response switches Under Attack mode on for 2 hours. IAM users are free, and the canary is deleted on destroy.

### The firewall (Protected tier)

`server/services/wafService.js` creates one web ACL per project:

- **ECS targets:** REGIONAL scope, attached to the project's ALB. It does not need CloudFront. Behind CloudFront (ECS + CloudFront target), every IP-based rule reads the visitor's address from `X-Forwarded-For`, so bans and limits hit the real client, not CloudFront's edge.
- **S3 + CloudFront:** CLOUDFRONT scope (created in us-east-1, as AWS requires) and attached to the distribution. S3 website hosting, which SkyForge falls back to while CloudFront is unavailable on the account, cannot have a firewall; the Security page says so, and decoys, leak watch, and scanning still apply.

Rules run in this order. Each one appears only when its feature is on.

| # | Rule | What it does |
|---|---|---|
| 1 | `skyforge-scanner` | Allows requests with the project's secret `x-skyforge-scan` header, so SkyForge's own scans test the app itself and never trip its traps. |
| 2 | `admin-door` | The secret door link: answers `302` to the admin area and sets an `sf_door` cookie for 24 hours. |
| 3 | `banned-ips` | Blocks this project's bans plus the shared attacker list (herd immunity). |
| 4 | `decoys-env`, `decoys-aws` | Serves fake `.env` and AWS credential files (HTTP 200) holding a honey key. |
| 5 | `robots` | Serves a `robots.txt` whose `Disallow:` lines are traps (only when the app has no `robots.txt`). |
| 6 | `tripwire` | Paths only scanners request, plus the robots.txt trap folders. Answers `404`; the monitor bans the IP. |
| 7 | `admin-lockdown` | Admin routes answer `404` unless the visitor's IP is allow-listed or carries the door cookie. |
| 8 | `bot-challenge` | AWS WAF Challenge (silent JavaScript proof-of-work) on HTML page loads: login pages or all pages. |
| 9 | `login-rate-limit` | Per-IP limit on login, auth, token, and admin routes found in the source (100 per 5 minutes by default, self-tuned). |
| 10 | `global-rate-limit` | Per-IP limit on everything (2,000 per 5 minutes by default, self-tuned). |
| 11–14 | AWS managed groups | IP reputation, known bad inputs, OWASP core (its 8 KB body limit is count-only so uploads work), SQL injection. |

The tripwire list is **code-aware**: it leaves out any path the app itself serves, such as WordPress paths for PHP apps, `/actuator/` for Spring, and routes found in the source. Decoys never shadow a path the app serves either.

**Under Attack mode** tightens limits to 300 per 5 minutes globally and 20 on login routes, and challenges every HTML page load. Switch it on by hand, or let automatic incident response do it during an attack spike; it switches itself off after an hour of calm. The **attack dashboard** summarizes blocked and challenged requests sampled over the last 3 hours by rule, attacker IP, country, and targeted path.

### The 21 attack-prevention features

#### 1. Deception honeypots: fake `.env` with a canary key

Scanners hunt for `/.env`, `/.env.production`, `/.aws/credentials` and similar. SkyForge serves them a believable fake file with a fake database URL, JWT secret, SMTP password, and a **real AWS key with no permissions** (the honey credential, see #15).

- **ECS (Protected):** firewall custom responses (`decoys-env`, `decoys-aws`). The request also counts as a tripwire hit, so the IP is banned within about 10 minutes.
- **S3 sites (any tier):** the decoy files are uploaded next to the site.
- Paths the app serves itself are never replaced with a decoy.

#### 2. Security gate before traffic switches

Before anything is built, the code scan runs; after the image is pushed to ECR, SkyForge waits up to 90 seconds for the vulnerability scan. Only then does the new version receive traffic.

| Gate setting | Critical code findings (keys, private keys) or critical image CVEs |
|---|---|
| Off | ignored |
| **Warn** (default) | logged in the deployment console, deployment continues |
| Block | deployment stops before the new version gets traffic; a `gate.blocked` incident is raised |

#### 3. Code-aware outbound firewall

The app's ECS security group normally lets the container connect anywhere. With the outbound firewall on, it may only connect out on the TCP ports the code needs, plus DNS (53) and NTP (123):

- always 80 and 443 (APIs, AWS, package CDNs);
- ports from connection strings in environment values (`postgres://` → 5432, `rediss://host:6390` → 6390, and so on);
- ports for libraries found in the code (nodemailer/smtplib → 587/465/25, ioredis → 6379, mongoose → 27017, mysql2 → 3306, amqplib → 5672, kafkajs → 9092).

A compromised container then cannot open reverse shells on arbitrary ports or reach crypto-mining pools. Security-group changes apply to running tasks immediately, so turning it on or off needs no redeploy.

#### 4. Admin lockdown

List IP addresses or CIDR ranges. Admin routes (`/admin` plus admin-looking routes found in the source, such as `/backoffice` or `/staff`) answer `404` to everyone else. The allowlist is a separate WAF IP set (`<app>-admin-allow`), removed as soon as the list is empty.

#### 5. Bot challenge

AWS WAF's **Challenge** action: a silent JavaScript proof-of-work that browsers pass automatically and headless scripts fail. Only requests whose `Accept` header includes `text/html` are challenged, so APIs, mobile apps, health checks, and assets keep working. A solved challenge is remembered for an hour. Options: off, login pages, or all pages (Under Attack mode always uses all pages).

#### 6. Automatic incident response with alerts

Every signal becomes an **incident** (`server/services/incidentService.js`):

1. It is de-duplicated, so the same signal is not reported twice within its window.
2. An **automatic response** runs when the project allows it (on by default).
3. A plain-language summary is written by Gemini when `GEMINI_API_KEY` is set, otherwise by a built-in playbook.
4. The incident is sent to every alert channel at or above the minimum severity.
5. It appears on the Security page with what SkyForge did, and can be marked resolved.

| Incident | Severity | Automatic response |
|---|---|---|
| Canary key used (`canary.used`) | critical | Under Attack mode for 2 hours (Protected) |
| Honey key used (`honey.used`) | high | none needed: the key has no permissions |
| Decoy taken / tripwire ban (`decoy.taken`, `ip.banned`) | medium / low | IPs banned for 24 hours and shared with your other projects |
| Attack spike: 300+ blocked requests in an hour, counted by CloudWatch (`attack.spike`) | high | Under Attack mode; switches off automatically after an hour of calm (`attack.calm`) |
| Site down: 3 failed health checks (`site.down`) | high | Restarts the containers once; `site.recovered` when it is back |
| Secret visible on the site (`leak.detected`) | critical | Optional: take the site offline |
| Secret pushed to the repository (`secret.pushed`) | critical | alert |
| New vulnerability in a dependency (`cve.new`) | per CVE | alert |
| Attack surface grew (`surface.changed`) | medium / low | alert |
| Over budget (`wallet.budget`) | high | Under Attack mode; optional hard stop (offline) at 150% |
| Deployment blocked by the gate (`gate.blocked`) | high | the deployment never received traffic |
| New admin door link (`door.rotated`) | info | always delivered, regardless of minimum severity |
| Red-team findings (`redteam.findings`) | high / medium | alert |

**Alert channels.** Enter only what each channel needs:

| Channel | You provide |
|---|---|
| Email | SMTP host, port, username, password (an app password for Gmail), recipients |
| Slack | an Incoming Webhook URL (`https://hooks.slack.com/services/...`) |
| Discord | a channel webhook URL (`https://discord.com/api/webhooks/...`) |
| Telegram | a bot token from @BotFather and a chat ID |
| Custom webhook | an HTTPS URL; optional signing secret (`x-skyforge-signature: sha256=<HMAC of the body>`) |

All secret fields are encrypted at rest and shown masked. Webhook URLs must be HTTPS and resolve to public addresses. **Send test** checks each channel.

#### 7. Self-tuning rate limits

Every 6 hours SkyForge samples the requests the firewall allowed and reads CloudWatch's `AllowedRequests` for the last 3 days. It estimates the busiest legitimate visitor's peak 5-minute rate and sets the per-IP limits to **3×** that:

- the global limit stays between 500 and 20,000;
- the login limit stays between 30 and 500.

It needs at least 20 sampled requests; until then the defaults stay (shown as "learning"). The firewall is only updated when a limit moves by more than 20%. Under Attack mode always overrides the tuned limits.

#### 8. New-CVE alerts via OSV

At each deployment SkyForge reads the exact package versions from lockfiles and manifests:

- `package-lock.json` (or `package.json`);
- `requirements*.txt`, `poetry.lock`, `Pipfile.lock`;
- `go.mod`, `Gemfile.lock`, `composer.lock`, `Cargo.lock`.

Once a day it queries [OSV.dev](https://osv.dev) (`/v1/querybatch`, free, no key). The first check reports what is already known; later checks alert only on **newly published** vulnerabilities, with the package, version, advisory ID and severity.

#### 9. Push-time secret detection

Every 10 minutes SkyForge lists new commits on the deployed branch through the GitHub API (no public URL or webhook needed). It scans the **added lines** of each diff for AWS, Stripe, GitHub, Slack, Google keys and private keys, and flags newly committed `.env`, `.pem`, `.p12`, `id_rsa` and service-account files (`.env.example` and similar templates are allowed). Bots scrape public pushes within minutes, so the alert tells you to revoke the key, not just delete the commit.

#### 10. Tamper-proof (read-only) containers

With this on, the ECS task runs with `readonlyRootFilesystem: true`. Writable scratch space is mounted at `/tmp`, `/var/tmp`, `/run`, and `/var/cache/nginx`. The task also drops `NET_RAW` and runs an init process. Attackers cannot drop web shells or modify the app's code at runtime.

This is opt-in. If the app fails to start read-only, SkyForge redeploys it with a writable filesystem in the same deployment and logs why. An app that starts fine but writes inside its own folder at runtime (for example a SQLite database file) will have those writes fail, so leave this off for such apps.

#### 11. Secret-aware response firewall (leak watch)

Every 6 hours, and after every deployment, SkyForge fetches the site's home page, common config and debug paths (`/config.js`, `/env.js`, `/api/config`, `/debug`, …) and up to 15 same-origin JavaScript bundles. It looks for:

- the **actual values** of the project's secrets (environment variables named like `*SECRET*`, `*PASSWORD*`, `*TOKEN*`, `*_KEY`, `DATABASE_URL`, …);
- provider key formats (AWS, Stripe, GitHub, Slack, Google, private keys);
- the canary key.

Values are compared in memory and never logged; findings name the variable and the URL. The most common cause is a frontend build that inlined a server-side variable. With **Take the site offline when a secret leaks** on, the automatic response switches to the maintenance page until you rotate the secret.

This is a scheduled scanner, not an inline proxy: responses are not rewritten in flight.

#### 12. Herd immunity: shared ban list across projects

Every IP banned on any project (tripwire or decoy) is recorded in the `ThreatIntel` table. Each Protected project's ban list also contains attacker IPs seen by **other** projects in the last 7 days (up to 3,000), so a scanner that hits one site is already blocked on the next. Unbanning an IP also removes it from the shared list.

#### 13. Blast-radius map

**Blast-radius map** answers "if an attacker fully controlled this container, what could they reach?":

- the secrets in its environment;
- data stores named in its configuration;
- the AWS actions its task role allows (inline and attached policies, read from IAM);
- whether its outbound network is restricted;
- whether the canary would reveal the theft.

It produces a score, a level (low, medium, high), and concrete advice, such as replacing wildcard permissions with the code-derived policy (#14).

#### 14. AWS permissions generated from the code

At each deployment SkyForge reads the AWS SDK calls in the source: JavaScript v3 command imports, the v2 `new AWS.S3()` style, and Python `boto3`. It turns them into a least-privilege IAM policy:

- `PutObjectCommand` becomes `s3:PutObject`;
- `ListObjectsV2` becomes `s3:ListBucket`;
- `send_email` becomes `ses:SendEmail`;
- S3 actions are scoped to bucket names found in `*BUCKET*` environment variables.

With **AWS permissions generated from the code** on, this policy is attached to the task role as the inline policy `SkyForgeCodePermissions`, so the container can do exactly what the code does and nothing more. If no SDK calls are found, the role keeps no permissions at all. The policy is removed when the switch is off, and deleted with the role on destroy.

#### 15. Honey credentials

A second IAM user, `<app>-honey`, with **no permissions**. Its key appears only inside decoy files (#1). Nobody legitimate has ever seen it, so any use of it proves an attacker downloaded a decoy and tried it. AWS records when, where (region) and against which service, which the incident includes. Checked every 10 minutes; deleted on destroy. Your real secrets were never in the decoy.

#### 16. `robots.txt` bait

When the app has no `robots.txt` of its own, SkyForge serves one that "hides" `/admin-backup/`, `/internal/export/`, `/db-dumps/`, `/old-site/` and `/private-api/`. Well-behaved crawlers obey it and never visit; scanners read it to find hidden areas, and those folders are tripwires, so visiting them gets the IP banned. On S3 sites the file is uploaded with the site.

#### 17. Attack replay

**Replay blocked attacks** takes the paths of the requests the firewall blocked in the last 3 hours and re-sends them (GET only, at most 40) to the live app **with the scanner header**, so the firewall lets them through. The result shows, per attack, whether the app itself would have been vulnerable without the firewall: it looks for system files, credentials, environment dumps, stack traces, SQL errors, `phpinfo` and directory listings.

The replay goes to the live site, not a separate copy, which is why it only replays read-only GET requests, never sends bodies, and skips any path that looks state-changing (`/delete`, `/update`, `/logout`, `/reset`, and similar), because some apps change data on GET.

#### 18. Attack-surface diff for every deploy

Each deployment records the app's attack surface:

- all routes, plus admin, login, debug and upload routes;
- environment variable names;
- dependencies;
- outbound ports;
- AWS actions used by the code;
- the listening port.

It is compared with the previous deployment. New admin, debug, upload or login routes, new AWS permissions, and new outbound ports are highlighted in the deployment log and on the Security page. Medium- and high-risk changes raise a `surface.changed` incident. The last 15 deployments' changes are kept.

#### 19. Denial-of-wallet guard

Set a monthly budget. Every hour SkyForge projects the month's bill from the last 24 hours of traffic. The estimate is approximate and ignores the free tier. It counts:

- **fixed costs:** ALB, the Fargate task's vCPU and memory, and the WAF web ACL and rules;
- **traffic costs:** ALB LCUs, data transfer, WAF requests, and CloudFront requests and bytes;
- **traffic data:** CloudWatch `AWS/ApplicationELB` and `AWS/CloudFront` metrics.

When the projection passes the budget, SkyForge acts:

- **At 80% of budget:** a warning.
- **Over budget:** a high-severity incident, and Under Attack mode switches on to cut abusive traffic (Protected tier).
- **At 150% with Hard stop on:** the site is taken offline.

S3 website hosting publishes no free request metrics, so for those sites the estimate covers storage only.

#### 20. AI red-team rehearsal

**AI red-team rehearsal** plans an attack against your own site and runs it safely:

1. **Planning.** Gemini (or a built-in planner when no key is set) reads the routes found in the code and picks up to 20 targets where a real attacker would look first.
2. **The probes.** It runs a fixed catalogue of read-only probes:
   - unauthenticated access to admin and account routes;
   - insecure direct object references (`/api/users/1` vs `/2`);
   - open redirects on login routes;
   - reflected input;
   - verbose errors on malformed input;
   - CORS that trusts any origin with credentials;
   - `TRACE`;
   - public API docs, GraphQL introspection and debug consoles.
3. **Limits.** Every request is GET, HEAD or OPTIONS, sequential, at most 80 per run, and goes only to the project's own URL. Routes that look state-changing (`/delete`, `/update`, `/add`, `/logout`, `/reset`, and similar) are removed from the plan and blocked at request time, whoever planned them, because some apps change data on GET.

Findings come with a fix and raise a `redteam.findings` incident.

#### 21. Rotating admin door

With the door on, admin routes answer `404` to everyone. Opening the secret link `https://<site>/__skyforge/door/<token>` makes the firewall redirect into the admin area and set an `HttpOnly` cookie valid for 24 hours. The token is 32 random characters and **rotates every 24 hours**. The new link is sent to every alert channel and shown on the Security page; **Rotate now** forces a new one. Combined with the admin lockdown (#4), either an allow-listed IP or the door gets in.

### Always on

- **Security headers.** nginx-served sites send `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, and `Permissions-Policy`, and hide the nginx version. CloudFront distributions use AWS's managed security-headers policy.
- **ALB hardening.** `drop_invalid_header_fields` guards against request smuggling.
- **AWS Shield Standard.** Network-level DDoS protection on every ALB and CloudFront distribution.
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
   - WAF web ACL (detached from the ALB first), its ban list and admin allowlist; the CloudFront-scope firewall (after its distribution is gone); the canary and honey-credential IAM users and keys.
   - ECS service: SkyForge waits until the tasks have fully stopped. Then the cluster.
   - Listeners, the ALB, and the target group.
   - Security groups: retried for up to 10 minutes while AWS releases network interfaces.
   - Log group, Secrets Manager secret, IAM roles (inline policies such as the code-derived permissions are deleted first), and task definitions.
   - The ECR repository and all its images.
3. **Verified sweep.** SkyForge searches AWS for **anything named for the project**, including resources a crashed or interrupted operation never recorded:
   - ECS cluster, service, and task definitions;
   - ALB and target group;
   - security groups and IAM roles;
   - log group and secret;
   - WAF ACLs and IP sets in both scopes (REGIONAL and CLOUDFRONT);
   - canary and honey-credential users;
   - S3 bucket, CloudFront distributions, and origin access controls;
   - ECR repository.

   It deletes whatever it finds and checks again.
4. **Success only when AWS confirms nothing remains:** *"Verified with AWS: no resources for this project remain, so it no longer incurs charges."* If something survives, teardown fails and lists exactly what is left. **Retry Teardown** is idempotent.

The local build workspace is removed, and the project's security state is reset. Your protection settings (the switches on the Security page) are kept for the next deployment.

---

## Monitoring

The monitor worker runs every minute for each live deployment. It:

- probes the site's health path and records the latency and health status;
- skips the probe while the site is offline;
- completes **Bring online** once the container is healthy;
- records health incidents: after 3 failed probes a `site.down` incident (with one automatic container restart), and `site.recovered` when it answers again;
- runs the scheduled security automation in the background (`server/services/securityAutomation.js`), each task at its own pace:

| Every | Task |
|---|---|
| 10 minutes | Bans from tripwires and decoys (plus the shared attacker list; unbanned IPs stay exempt for 24 hours), canary and honey-key checks, attack-spike detection and automatic Under Attack mode, push-time secret scan |
| 1 hour | Denial-of-wallet cost projection |
| 6 hours | Self-tuning rate limits, leak watch |
| 24 hours | OSV CVE check, admin-door rotation |

**Run all checks now** on the Security page runs every task immediately.

Every health check is also added to an hourly uptime tally, which feeds the Monitoring page and the public status page. The worker also runs the [git watcher](#auto-deploy-on-push) every minute and the [budget check](#costs-and-budget) every 6 hours.

Each check schedules the next, keyed by minute so that duplicate chains merge. When a worker starts, it **re-seeds monitoring for every live site**, so restarts never leave a site unwatched.

---

## After deploy

Everything in this section is on a project's **Site settings**, **Monitoring** and console pages, or on the **Costs** and **Deployments** pages.

### Auto-deploy on push

Turn on **Deploy automatically when you push** and every new commit on the project's branch is deployed. The worker checks GitHub once a minute (`server/services/gitWatcher.js`); the first check only records where the branch is, so switching it on never redeploys an old commit. A push that can't deploy (for example, a missing environment variable) is recorded with the reason instead of failing silently.

When SkyForge runs on a public server, set `GITHUB_WEBHOOK_SECRET` and add a GitHub webhook (`push` and `pull_request` events, content type JSON) pointing at `/api/github/webhook`. Webhooks are verified with the shared secret and trigger the same check immediately.

### Pull-request previews

With **Preview every pull request** on, each open pull request into the branch gets its own temporary copy of the site, rebuilt on every push to the PR and destroyed (with a verified teardown) when the PR is merged or closed. Previews:

- are separate projects that copy the parent's settings and secrets, listed under the parent rather than on their own;
- only come from branches of the same repository, never forks, so outside code never runs with your keys or AWS account;
- are limited to 3 per project, because each runs its own container and load balancer (about $1.20/day while open).

### Custom domains

Add a domain on **Site settings** and SkyForge requests a free certificate from AWS Certificate Manager, then shows two DNS records: one proves you own the domain, the other points visitors at the site. Once AWS issues the certificate, SkyForge attaches it:

| Site served by | Certificate region | What SkyForge changes |
|---|---|---|
| CloudFront (S3 + CloudFront, or ECS + CloudFront) | `us-east-1` | Adds the domain as an alias and the certificate to the distribution |
| Load balancer (ECS Fargate) | the app's region | Adds an HTTPS listener on 443 (mirroring the HTTP listener, including the maintenance page while offline) and opens 443 on the load balancer's security group |

The domain is re-attached after every redeploy. Removing the domain, or destroying the project, deletes the certificate.

### Costs and budget

The **Costs** page shows the whole account's spend this month (by day and by service, from AWS Cost Explorer), a straight-line forecast, and the monthly cost of each running site (measured from real traffic once SkyForge has seen it, otherwise estimated from its size). Cost Explorer charges $0.01 per request, so results are cached for 6 hours; **Refresh** fetches fresh numbers.

Set a **monthly budget** and the worker compares it with your spend every 6 hours, alerting through your alert channels at 80%, when the forecast passes the budget, and when spend goes over. Optionally it also takes every site offline when spend goes over (load balancers keep billing until you destroy the projects). The deploy wizard shows "about $X/day" before you deploy.

### Monitoring: app logs and metrics

The **Monitoring** page shows, for the live version:

- charts of CPU, memory, requests, response time and 4xx/5xx errors (ECS), or requests, error rate and data served (CloudFront), over 1 hour to 7 days;
- 30 days of uptime from the once-a-minute health check;
- the app's own output (stdout/stderr from CloudWatch Logs), live-tailed every 5 seconds, searchable, filterable by level and downloadable.

### Restoring any earlier version

The console's **Versions** list and the **Deployments** page can put any earlier successful version back live, not just the previous one. It reuses that version's task definition (or static release), so nothing is rebuilt, and the switch happens only after the old version passes health checks. SkyForge first checks that the old container image still exists in ECR.

### Plain-English failures

When a deployment fails, the console explains why in plain English and offers a one-click fix where one exists (`server/services/errorExplainer.js`). It recognises, among others: a port mismatch (read from the app's own "listening on" output), running out of memory, a missing environment variable, a database on `localhost`, missing packages, missing build scripts or tools, npm peer-dependency conflicts, Docker not running, the CodeBuild quota, missing AWS permissions, the Fargate quota, CloudFront not being enabled, and network failures. Fixes include changing the port or size and redeploying, switching where images are built, retrying, or opening the right settings page.

### Deployment history

The **Deployments** page is a timeline of every deploy across projects: who or what started it (you, a git push, a pull-request preview, a restore or a teardown), the commit, how long each step took, and what changed from the previous deploy (new code, settings changed, a different target, faster or slower), with a link to the code changes on GitHub.

### Public status page

Switch on a **public status page** and SkyForge gives you a link (`/status/<name>-<random>`) anyone can open, with no login: whether the site is up, 90 days of uptime and recent problems. It never shows your repository, account or AWS details, and **New link** retires the old address.

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

### One command to start or stop everything

```powershell
npm start          # Redis (Docker) + PostgreSQL check + migrations + API + worker + web app
npm stop           # stops the API, worker, web app and Redis (PostgreSQL keeps running)
npm run restart    # stop, then start
npm run status     # what is running, with PIDs and URLs
```

`npm start` starts the Redis container (creating it the first time), starts the PostgreSQL Windows service if it is stopped, applies database migrations, launches the three processes in the background, and waits until the API, worker and web app answer. Then open `http://localhost:5173`. Logs go to `.skyforge/logs/` (`api.log`, `worker.log`, `client.log`). Running `npm start` twice is safe: anything already running is left alone. `npm stop -- --keep-redis` leaves Redis running.

Requirements: Docker Desktop running (for Redis), PostgreSQL installed, `npm run install:all` done once, and `server/.env` filled in.

### Running the processes by hand

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
- IAM user and access-key actions for the canary and honey credentials;
- `iam:ListRolePolicies` and `iam:GetRolePolicy` for the blast-radius map;
- `ec2:AuthorizeSecurityGroupEgress` and `RevokeSecurityGroupEgress` for the outbound firewall;
- `cloudwatch:GetMetricStatistics` for attack-spike detection, self-tuning limits, and the denial-of-wallet guard;
- RDS instance, subnet-group and parameter-group actions plus `iam:CreateServiceLinkedRole` for the managed database;
- CodeBuild project and build actions plus `s3:PutLifecycleConfiguration` for cloud builds;
- `servicequotas:GetServiceQuota` for the readiness check;
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
| `ATTACK_SPIKE_THRESHOLD` | Blocked requests per hour that count as an attack spike (default 300) |
| `GITHUB_WEBHOOK_SECRET` | Enables `POST /api/github/webhook` for instant auto-deploys and previews (otherwise GitHub is checked once a minute) |

`CLIENT_URL` is also used for the "open in SkyForge" link in alerts. Alert channels need no server configuration: each user enters their own on the Settings page.

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
| Infrastructure | `GET /projects/:id/infrastructure`, `POST /projects/:id/infrastructure/target` |
| Security | `GET /projects/:id/security`, `POST /projects/:id/security/tier`, `POST /projects/:id/security/settings`, `POST /projects/:id/security/scan`, `POST /projects/:id/security/under-attack`, `POST /projects/:id/security/unban`, `POST /projects/:id/security/fix` |
| Incidents and tools | `GET /projects/:id/security/incidents`, `POST /projects/:id/security/incidents/:incidentId/resolve`, `POST /projects/:id/security/checks`, `POST /projects/:id/security/door/rotate`, `POST /projects/:id/security/replay`, `POST /projects/:id/security/redteam`, `GET /projects/:id/security/blast-radius`, `GET /projects/:id/security/cost` |
| Alerts | `GET /alerts`, `PUT /alerts`, `POST /alerts/test` |
| Site availability | `POST /projects/:id/site/offline`, `POST /projects/:id/site/online` |
| Deployments | `POST /deployments/project/:projectId`, `GET /deployments/project/:projectId`, `GET /deployments/:id`, `GET /deployments/:id/logs/stream` (SSE), `GET /deployments/:id/queue-position`, `POST /deployments/:id/retry`, `POST /deployments/:id/rollback`, `POST /deployments/project/:projectId/destroy` |
| After deploy | `GET\|POST /projects/:id/automation`, `POST /projects/:id/automation/check`, `GET\|POST\|DELETE /projects/:id/domain`, `POST /projects/:id/domain/check`, `GET /projects/:id/cost/preview`, `GET /projects/:id/monitor/metrics`, `GET /projects/:id/monitor/logs`, `GET /projects/:id/monitor/uptime`, `POST /projects/:id/runtime`, `GET\|POST /projects/:id/status-page` |
| History and recovery | `GET /deployments/history`, `GET /deployments/:id/diagnosis`, `POST /deployments/:id/restore` |
| Costs | `GET /aws/costs`, `POST /aws/budget` |
| Public | `GET /public/status/:slug` (no login), `POST /github/webhook` (signed by GitHub) |
| Health | `GET /healthz`, `GET /readyz` |

---

## Project structure

```text
client/src/
  pages/            Dashboard, Projects, DeploymentPlan (environment), DockerPreview,
                    InfrastructurePreview, DeploymentConsole, Security, Settings, ...
  components/       EnvironmentWizard, TargetChooser, AlertSettingsCard, SecurityPanels,
                    RepositoryIntelligence*, Card, Button, ...
  services/api.js   API client
server/
  config/           env loader, Prisma client
  controllers/      auth, github, aws, project, planning, docker, infrastructure,
                    deployment, security, alert
  services/
    buildPlanner.js     source → app root, runtime, entry point, port
    templateEngine.js   Dockerfile generation (templates/docker/*)
    sourceService.js    download, submodules, build attempts, port bridge
    envScanner.js       environment variables and backing services
    ecsService.js       ECS/ALB provisioning, offline/online, discovery sweep
    ecrService.js       ECR push and image scanning
    securityScanner.js  code scan, self-pentest, scoring, route extraction
    securityService.js  tiers, settings, canary/honey keys, firewall + decoys, leak watch, reports
    wafService.js       AWS WAF rules (both scopes), bans, herd list, attack summary
    canaryService.js    canary and honey IAM credentials
    deceptionService.js decoy files, robots.txt bait, door tokens
    securityPolicy.js   egress ports, code-derived IAM, dependencies, attack surface, pushed secrets
    deploySecurity.js   security gate, code analysis and hardening inside the pipeline
    securityAutomation.js  scheduled checks: spikes, tuning, door, leaks, CVEs, pushes, cost, health
    incidentService.js  incidents, automatic response, AI summaries, alert fan-out
    alertService.js     Email, Slack, Discord, Telegram, and webhook channels
    redTeamService.js   AI red team, attack replay, blast radius
    staticDeployer.js   S3 + CloudFront releases, decoys, CloudFront WAF attachment
    cloudfrontEdgeService.js  CloudFront in front of the ALB
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
- WAF rule generation, including decoys, the admin door, lockdown, challenges, and forwarded-IP rules;
- outbound ports, code-derived IAM policies, dependency parsing, attack-surface diffs, and pushed-secret detection;
- self-tuning limits, cost projection, alert validation and formatting, and the blast radius;
- the code scan and deterministic fixes;
- route extraction;
- a self-pentest against a deliberately vulnerable local server;
- secret handling, serialization, rate limiting, and teardown manifests.

CI installs from both lockfiles, applies migrations to an empty PostgreSQL database, runs tests and syntax checks, builds the client, and audits production dependencies.

---

## Limitations

- **HTTPS.** The plain ECS Fargate target serves HTTP on the ALB address. The CloudFront targets give free HTTPS, but some new AWS accounts must ask AWS Support to enable CloudFront; until then they fall back to HTTP. The security report flags HTTP-only sites.
- **A firewall on S3 sites needs CloudFront.** S3 + CloudFront sites get a CLOUDFRONT-scope firewall, but while CloudFront is unavailable on the account the site runs on S3 website hosting, which cannot have a firewall. Decoys, leak watch, and scanning still apply.
- **CloudFront paths not yet run end to end.** The CloudFront firewall attachment and CloudFront cost metrics are built on the AWS APIs but could not be exercised on an account where CloudFront is still blocked.
- **Leak watch is a scanner, not an inline proxy.** It checks pages and bundles every 6 hours and after each deploy; it does not rewrite responses in flight.
- **Attack replay and the red team run against the live site,** with read-only requests only (routes that look state-changing, such as `/delete` or `/logout`, are never requested), rather than against a separate copy.
- **Honey and canary detection delay.** AWS updates "access key last used" with some delay (usually minutes, occasionally hours), so those alerts are not instant.
- **The read-only filesystem is opt-in.** If the app cannot start that way, SkyForge redeploys it writable. An app that starts but writes to its own folder at runtime (for example a SQLite file) will see those writes fail; leave the setting off for such apps.
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
