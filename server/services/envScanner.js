import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import axios from "axios";
import * as tar from "tar";
import { listSourceFiles } from "./buildPlanner.js";

/**
 * Environment Scanner: finds the environment variables and backing services an app needs,
 * from its source code, settings classes, config files, and dependency manifests.
 *
 * Variables are "required" when the code has no fallback (it would crash or misbehave without
 * them) and "optional" when a default exists. Reads with an implicit null/empty result
 * (os.getenv("X"), process.env.X) count as required only for secret- or connection-like names.
 */

// Set by the platform or the runtime itself; never something the user must provide.
const IGNORED = /^(PORT|HOST|HOSTNAME|NODE_ENV|PATH|HOME|PWD|USER|SHELL|TERM|LANG|TZ|CI|DEBUG|MODE|DEV|PROD|SSR|BASE_URL|PUBLIC_URL|NEXT_RUNTIME|NEXT_PHASE|PYTHONPATH|PYTHONUNBUFFERED|DJANGO_SETTINGS_MODULE|RAILS_ENV|RACK_ENV|RAILS_MAX_THREADS|WEB_CONCURRENCY|JAVA_HOME|GIN_MODE|GOPATH|npm_.*|VERCEL.*|NETLIFY.*|RENDER.*|HEROKU.*|RAILWAY.*|FLY_.*|GITHUB_.*|AWS_LAMBDA.*|AWS_EXECUTION_ENV|ASPNETCORE_.*|DOTNET_.*|KUBERNETES_.*)$/;
const SENSITIVE = /(SECRET|PASSW|TOKEN|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CLIENT_ID|CLIENT_SECRET|DATABASE|^DB_|_DB_|DSN|MONGO|REDIS|_URI$|_URL$|CONNECTION|AUTH0_|STRIPE_|SUPABASE_|FIREBASE_|OPENAI_|ANTHROPIC_|SMTP_|SENDGRID|TWILIO|BUCKET)/;
const BUILD_TIME_PREFIX = /^(VITE_|NEXT_PUBLIC_|REACT_APP_|NUXT_PUBLIC_|PUBLIC_|EXPO_PUBLIC_|GATSBY_)/;
const PLACEHOLDER = /^(|["']{2}|your[_-].*|<.*>|change[_-]?me|xxx+|\.\.\.|todo|replace.*|secret|example.*|sk_test_.*|pk_test_.*|null|none)$/i;

const SOURCE_FILE = /\.(js|jsx|ts|tsx|mjs|cjs|vue|svelte|astro|py|go|rb|erb|php|java|kt|cs|rs|prisma|properties|ya?ml|toml|json)$/i;
const SKIP_FILE = /(^|\/)(tests?|__tests__|spec|e2e|cypress|playwright|\.github|docs?|examples?|scripts|fixtures|__mocks__|node_modules|vendor|dist|build)\/|\.(test|spec|stories|d)\.[a-z]+$|(^|\/)(jest|vitest|eslint|babel|webpack|rollup|playwright|cypress|tailwind|postcss|prettier|commitlint|lint-staged|vite|next|nuxt|astro|svelte|tsconfig|jsconfig|package-lock|composer\.lock|turbo|renovate)[.\w-]*\.(js|cjs|mjs|ts|json)$/i;
const ENV_TEMPLATES = /(^|\/)\.env\.(example|sample|template|dist|defaults|local\.example)$/i;
const MANIFESTS = /(^|\/)(package\.json|requirements[\w.-]*\.txt|pyproject\.toml|Pipfile|go\.mod|Cargo\.toml|Gemfile|composer\.json|pom\.xml|build\.gradle(\.kts)?|[\w.-]+\.csproj|schema\.prisma)$/i;

export function isScannableFile(file) {
  return ENV_TEMPLATES.test(file) || MANIFESTS.test(file) || (SOURCE_FILE.test(file) && !SKIP_FILE.test(file));
}

const lineOf = (content, index) => content.slice(0, index).split("\n").length;

/** "required" | "optional" for a read that has no explicit default. */
function implicitRead(name) {
  return SENSITIVE.test(name) ? "required" : "optional";
}

function collectReads(file, content) {
  const reads = [];
  const add = (name, kind, index, extra = {}) => {
    if (!name || IGNORED.test(name) || !/^[A-Z_][A-Z0-9_]*$/.test(name)) return;
    reads.push({ name, kind, location: `${file}:${lineOf(content, index)}`, ...extra });
  };
  const each = (regex, handler) => {
    for (const match of content.matchAll(regex)) handler(match);
  };
  const after = (match) => content.slice(match.index + match[0].length, match.index + match[0].length + 40);
  const ext = path.extname(file).toLowerCase();

  if (/\.(js|jsx|ts|tsx|mjs|cjs|vue|svelte|astro)$/.test(ext)) {
    each(/process\.env\.([A-Z_][A-Z0-9_]*)|process\.env\[\s*["'`]([A-Z_][A-Z0-9_]*)["'`]\s*\]/g, (m) => {
      const name = m[1] || m[2];
      const hasDefault = /^\s*(\|\||\?\?|\?[^.])/.test(after(m));
      add(name, BUILD_TIME_PREFIX.test(name) ? "optional" : hasDefault ? "optional" : implicitRead(name), m.index, { buildTime: BUILD_TIME_PREFIX.test(name), hasDefault });
    });
    each(/import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g, (m) => add(m[1], "optional", m.index, { buildTime: true }));
    each(/\{([^{}]{1,400})\}\s*=\s*process\.env\b/g, (m) => {
      for (const part of m[1].split(",")) {
        const name = part.split(/[:=]/)[0].trim();
        add(name, /=/.test(part) ? "optional" : implicitRead(name), m.index, { hasDefault: /=/.test(part) });
      }
    });
  }

  if (ext === ".py") {
    each(/os\.environ\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]/g, (m) => add(m[1], "required", m.index));
    each(/(?:os\.environ\.get|os\.getenv)\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*(,)?/g, (m) => add(m[1], m[2] ? "optional" : implicitRead(m[1]), m.index, { hasDefault: Boolean(m[2]) }));
    // python-decouple config("X") and django-environ env("X") / env.str("X", default=...)
    each(/\b(?:config|env)(?:\.(?:str|bool|int|float|list|dict|json|url|db|db_url|cache|cache_url|email|path))?\(\s*["']([A-Z_][A-Z0-9_]*)["']([^)\n]*)\)/g, (m) => {
      const hasDefault = /default\s*=/.test(m[2]) || (/^\s*,\s*[^=]+$/.test(m[2]) && !/cast\s*=/.test(m[2]));
      add(m[1], hasDefault ? "optional" : "required", m.index, { hasDefault });
    });
    // pydantic BaseSettings: fields without a default must come from the environment.
    each(/^class\s+\w+\s*\([^)]*BaseSettings[^)]*\)\s*:\s*\n((?:[ \t]+.*\n?|\s*\n)+)/gm, (m) => {
      const body = m[1];
      const prefix = body.match(/env_prefix\s*[=:]\s*["']([^"']*)["']/)?.[1] || "";
      const bodyStart = m.index + m[0].indexOf(body);
      for (const field of body.matchAll(/^[ \t]{2,8}([a-z_][a-z0-9_]*)\s*:\s*([^=\n#]+?)\s*(=\s*(.+))?$/gm)) {
        if (field[1].startsWith("_") || field[1] === "model_config") continue;
        const aliased = field[4]?.match(/(?:env|alias|validation_alias)\s*=\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/)?.[1];
        const optionalType = /Optional\[|\|\s*None|None\s*\|/.test(field[2]);
        // Field(...) and Field() without default= still mean "required".
        const fieldWithoutDefault = /^=\s*Field\(/.test(field[3] || "") && !/^=\s*Field\(\s*(default\s*=|default_factory\s*=|[^.)\s][^,)]*\s*[,)])/.test(field[3]);
        const hasDefault = Boolean(field[3]) && !fieldWithoutDefault;
        add((aliased || `${prefix}${field[1]}`).toUpperCase(), hasDefault || optionalType ? "optional" : "required", bodyStart + field.index, { hasDefault });
      }
    });
  }

  if (ext === ".go") {
    each(/os\.Getenv\(\s*"([A-Z_][A-Z0-9_]*)"\s*\)/g, (m) => add(m[1], implicitRead(m[1]), m.index));
    each(/os\.LookupEnv\(\s*"([A-Z_][A-Z0-9_]*)"\s*\)/g, (m) => add(m[1], "optional", m.index, { hasDefault: true }));
  }

  if (/\.(rb|erb|ya?ml)$/.test(ext)) {
    each(/ENV\.fetch\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*(,|\)\s*\{|\)\s*do)?/g, (m) => add(m[1], m[2] ? "optional" : "required", m.index, { hasDefault: Boolean(m[2]) }));
    each(/ENV\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]/g, (m) => {
      const hasDefault = /^\s*(\|\||\.presence\s*\|\|)/.test(after(m));
      add(m[1], hasDefault ? "optional" : implicitRead(m[1]), m.index, { hasDefault });
    });
  }

  if (ext === ".php") {
    each(/\benv\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*(,)?/g, (m) => add(m[1], m[2] ? "optional" : implicitRead(m[1]), m.index, { hasDefault: Boolean(m[2]) }));
    each(/(?:getenv\(\s*|\$_ENV\[\s*|\$_SERVER\[\s*)["']([A-Z_][A-Z0-9_]*)["']/g, (m) => add(m[1], implicitRead(m[1]), m.index));
  }

  if (/\.(java|kt|cs)$/.test(ext)) {
    each(/(?:System\.getenv|Environment\.GetEnvironmentVariable)\(\s*"([A-Z_][A-Z0-9_]*)"\s*\)/g, (m) => {
      const hasDefault = /^\s*(\?\?|\?:)/.test(after(m));
      add(m[1], hasDefault ? "optional" : implicitRead(m[1]), m.index, { hasDefault });
    });
  }

  // Spring/Quarkus/Micronaut placeholders: ${VAR} is required, ${VAR:default} is not.
  if (/(^|\/)(application|bootstrap)[\w-]*\.(properties|ya?ml)$/i.test(file)) {
    each(/\$\{([A-Z_][A-Z0-9_]*)(:[^}]*)?\}/g, (m) => add(m[1], m[2] ? "optional" : "required", m.index, { hasDefault: Boolean(m[2]) }));
  }

  if (ext === ".rs") {
    each(/(?:std::)?env::var\(\s*"([A-Z_][A-Z0-9_]*)"\s*\)/g, (m) => {
      const tail = after(m);
      const kind = /^\s*\.(unwrap_or|ok\(\)|is_ok|unwrap_or_else|unwrap_or_default)/.test(tail) ? "optional"
        : /^\s*(\.(unwrap|expect)\(|\?)/.test(tail) ? "required" : implicitRead(m[1]);
      add(m[1], kind, m.index);
    });
    each(/\b(?:dotenv|env)!\(\s*"([A-Z_][A-Z0-9_]*)"/g, (m) => add(m[1], "required", m.index, { buildTime: true }));
  }

  if (ext === ".prisma") {
    each(/env\(\s*"([A-Z_][A-Z0-9_]*)"\s*\)/g, (m) => add(m[1], "required", m.index));
  }

  if (ENV_TEMPLATES.test(file)) {
    each(/^[ \t]*(?:export[ \t]+)?([A-Z_][A-Z0-9_]*)[ \t]*=[ \t]*(.*)$/gm, (m) => {
      const value = m[2].replace(/\s+#.*$/, "").trim();
      add(m[1], PLACEHOLDER.test(value.replace(/^["']|["']$/g, "")) ? "required" : "optional", m.index, {
        fromTemplate: true,
        exampleValue: PLACEHOLDER.test(value.replace(/^["']|["']$/g, "")) ? undefined : value.replace(/^["']|["']$/g, "").slice(0, 120),
      });
    });
  }
  return reads;
}

/** Dependency names declared across all manifests (lower-cased). */
function dependencyNames(files) {
  const names = new Set();
  const addAll = (iterable) => {
    for (const name of iterable) if (name) names.add(String(name).toLowerCase());
  };
  for (const { path: file, content } of files) {
    const base = path.posix.basename(file);
    if (base === "package.json") {
      try {
        const pkg = JSON.parse(content);
        addAll(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }));
      } catch {}
    } else if (/^requirements[\w.-]*\.txt$/i.test(base)) {
      addAll(content.split("\n").map((line) => line.trim().split(/[\s=<>~![;@]/)[0]).filter((name) => name && !name.startsWith("#") && !name.startsWith("-")));
    } else if (base === "pyproject.toml" || base === "Pipfile") {
      addAll([...content.matchAll(/["']([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*(?:[<>=~!^][^"']*)?["']/g)].map((m) => m[1]));
      addAll([...content.matchAll(/^([A-Za-z0-9_.-]+)\s*=/gm)].map((m) => m[1]));
    } else if (base === "go.mod") {
      addAll([...content.matchAll(/^\s*(?:require\s+)?([\w.-]+\.[\w.-]+\/[\w./-]+)\s+v/gm)].map((m) => m[1]));
    } else if (base === "Cargo.toml" || base === "Gemfile") {
      addAll([...content.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)].map((m) => m[1]));
      addAll([...content.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)].map((m) => m[1]));
      for (const m of content.matchAll(/features\s*=\s*\[([^\]]*)\]/g)) addAll([...m[1].matchAll(/"([^"]+)"/g)].map((f) => `feature:${f[1]}`));
    } else if (base === "composer.json") {
      try {
        addAll(Object.keys(JSON.parse(content).require || {}));
      } catch {}
    } else if (base === "pom.xml" || /^build\.gradle/.test(base)) {
      addAll([...content.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)].map((m) => m[1]));
      addAll([...content.matchAll(/["'][\w.-]+:([\w.-]+)(?::[^"']*)?["']/g)].map((m) => m[1]));
    } else if (base.endsWith(".csproj")) {
      addAll([...content.matchAll(/PackageReference\s+Include="([^"]+)"/g)].map((m) => m[1]));
    } else if (base === "schema.prisma") {
      const provider = content.match(/datasource\s+\w+\s*\{[^}]*provider\s*=\s*"(\w+)"/)?.[1];
      if (provider) names.add(`prisma:${provider.toLowerCase()}`);
    }
  }
  return names;
}

const SERVICES = [
  { id: "postgres", label: "PostgreSQL", envHint: "DATABASE_URL", deps: ["pg", "postgres", "pg-promise", "@neondatabase/serverless", "@vercel/postgres", "psycopg2", "psycopg2-binary", "psycopg", "asyncpg", "github.com/lib/pq", "github.com/jackc/pgx/v5", "github.com/jackc/pgx/v4", "gorm.io/driver/postgres", "tokio-postgres", "feature:postgres", "postgresql", "org.postgresql", "npgsql", "npgsql.entityframeworkcore.postgresql", "prisma:postgresql", "prisma:cockroachdb"] },
  { id: "mysql", label: "MySQL / MariaDB", envHint: "DATABASE_URL", deps: ["mysql", "mysql2", "pymysql", "mysqlclient", "aiomysql", "github.com/go-sql-driver/mysql", "gorm.io/driver/mysql", "feature:mysql", "mysql-connector-j", "mysql-connector-java", "mysqlconnector", "pomelo.entityframeworkcore.mysql", "prisma:mysql"] },
  { id: "mongodb", label: "MongoDB", envHint: "MONGODB_URI", deps: ["mongoose", "mongodb", "pymongo", "motor", "mongoengine", "go.mongodb.org/mongo-driver", "mongoid", "mongo", "spring-boot-starter-data-mongodb", "mongodb.driver", "prisma:mongodb"] },
  { id: "redis", label: "Redis", envHint: "REDIS_URL", deps: ["redis", "ioredis", "bullmq", "bull", "@upstash/redis", "rq", "github.com/go-redis/redis/v8", "github.com/redis/go-redis/v9", "sidekiq", "spring-boot-starter-data-redis", "stackexchange.redis"] },
  { id: "sqlite", label: "SQLite (file database)", envHint: null, deps: ["sqlite3", "better-sqlite3", "feature:sqlite", "prisma:sqlite", "gorm.io/driver/sqlite", "github.com/mattn/go-sqlite3", "microsoft.entityframeworkcore.sqlite"] },
];

/**
 * Scans in-memory files: [{ path, content }]. Returns
 * { variables: [{ name, required, buildTime, hasDefault, exampleValue, locations }], services, scannedFiles }.
 */
export function scanEnvironment(files) {
  const byName = new Map();
  for (const { path: file, content } of files) {
    if (!content || !isScannableFile(file)) continue;
    for (const read of collectReads(file, content)) {
      const entry = byName.get(read.name) || { name: read.name, kinds: new Set(), locations: [], buildTime: false, hasDefault: false, fromTemplate: false, exampleValue: undefined };
      entry.kinds.add(read.kind);
      entry.buildTime ||= Boolean(read.buildTime);
      entry.hasDefault ||= Boolean(read.hasDefault);
      if (read.fromTemplate) {
        entry.fromTemplate = true;
        entry.exampleValue ??= read.exampleValue;
      } else if (entry.locations.length < 3) {
        entry.locations.push(read.location);
      }
      byName.set(read.name, entry);
    }
  }

  const variables = [...byName.values()].map((entry) => {
    const inCode = entry.locations.length > 0;
    // An explicit default anywhere wins; template-only keys use their example value as the signal.
    const required = !entry.hasDefault && !entry.buildTime && entry.kinds.has("required") && (inCode || !entry.exampleValue);
    return {
      name: entry.name,
      required,
      buildTime: entry.buildTime,
      hasDefault: entry.hasDefault || Boolean(entry.exampleValue),
      exampleValue: entry.exampleValue,
      locations: inCode ? entry.locations : [".env.example"],
    };
  }).sort((a, b) => Number(b.required) - Number(a.required) || a.name.localeCompare(b.name));

  const deps = dependencyNames(files.filter(({ path: file }) => MANIFESTS.test(file)));
  const varNames = variables.map((variable) => variable.name);
  const services = SERVICES.filter((service) => service.deps.some((dep) => deps.has(dep))).map((service) => ({
    id: service.id,
    label: service.label,
    evidence: service.deps.filter((dep) => deps.has(dep)).slice(0, 3).map((dep) => dep.replace(/^(prisma|feature):/, "$1 ")),
    envVars: varNames.filter((name) => (service.id === "redis" ? /REDIS/ : service.id === "mongodb" ? /MONGO/ : /DATABASE|^DB_|_DB_|POSTGRES|MYSQL|PG/).test(name)),
    envHint: service.envHint,
  }));
  return { variables, services, scannedFiles: files.length, scannedAt: new Date().toISOString() };
}

const COMMITTED_ENV = /^\.env(\.(local|production|prod|development))?$/;

/** Source files of a checked-out repository: [{ path, content }]. Committed .env files appear with empty content. */
export function collectSourceFiles(root, { maxFiles = 4000, maxBytes = 256 * 1024 } = {}) {
  const files = [];
  for (const name of fs.readdirSync(root)) if (COMMITTED_ENV.test(name)) files.push({ path: name, content: "" });
  for (const file of listSourceFiles(root, { maxDepth: 8, maxFiles: 20_000 })) {
    if (files.length >= maxFiles || !isScannableFile(file)) continue;
    try {
      const full = path.join(root, file);
      if (fs.statSync(full).size > maxBytes) continue;
      files.push({ path: file, content: fs.readFileSync(full, "utf-8") });
    } catch {}
  }
  // listSourceFiles skips dot-files' parents only for dirs; env templates live at the root.
  for (const name of [".env.example", ".env.sample", ".env.template", ".env.dist"]) {
    if (!files.some((file) => file.path === name) && fs.existsSync(path.join(root, name))) {
      files.push({ path: name, content: fs.readFileSync(path.join(root, name), "utf-8") });
    }
  }
  return files;
}

/** Scans a checked-out repository directory. */
export function scanDirectory(root, options) {
  return scanEnvironment(collectSourceFiles(root, options));
}

/**
 * Streams a GitHub tarball and scans it without writing to disk. One API request regardless of
 * repository size; aborts quietly (returns null) for archives over the size budget.
 */
export async function scanGitHubRepository(options) {
  const files = await fetchGitHubSourceFiles(options);
  return files ? scanEnvironment(files) : null;
}

/** Source files from a GitHub tarball ([{ path, content }]), or null when over the size budget. */
export async function fetchGitHubSourceFiles({ owner, repo, ref, token, maxDownloadBytes = 80 * 1024 * 1024 }) {
  const response = await axios.get(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tarball${ref ? `/${encodeURIComponent(ref)}` : ""}`,
    {
      responseType: "stream",
      timeout: 60_000,
      headers: { Accept: "application/vnd.github+json", "User-Agent": "SkyForge-Env-Scanner", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    },
  );
  const files = [];
  let downloaded = 0;
  let collectedBytes = 0;
  response.data.on("data", (chunk) => {
    downloaded += chunk.length;
    if (downloaded > maxDownloadBytes) response.data.destroy(new Error("ARCHIVE_TOO_LARGE"));
  });
  const parser = new tar.Parser({
    onReadEntry(entry) {
      const file = String(entry.path || "").replace(/\\/g, "/").split("/").slice(1).join("/");
      if (entry.type === "File" && COMMITTED_ENV.test(file)) {
        files.push({ path: file, content: "" });
        entry.resume();
        return;
      }
      const wanted = entry.type === "File" && file && isScannableFile(file) && entry.size <= 256 * 1024 && collectedBytes < 40 * 1024 * 1024 && files.length < 4000;
      if (!wanted) {
        entry.resume();
        return;
      }
      const chunks = [];
      entry.on("data", (chunk) => chunks.push(chunk));
      entry.on("end", () => {
        const content = Buffer.concat(chunks).toString("utf-8");
        collectedBytes += content.length;
        files.push({ path: file, content });
      });
    },
  });
  try {
    await pipeline(response.data, zlib.createGunzip(), parser);
  } catch (error) {
    if (error.message === "ARCHIVE_TOO_LARGE") return null;
    throw error;
  }
  return files;
}

/** Validates an analysis object received from a client before it is stored. */
export function sanitizeEnvAnalysis(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const name = (item) => (typeof item === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(item) ? item : null);
  const text = (item, max = 200) => (typeof item === "string" ? item.slice(0, max) : undefined);
  const variables = (Array.isArray(value.variables) ? value.variables : []).slice(0, 300)
    .filter((variable) => name(variable?.name))
    .map((variable) => ({
      name: variable.name,
      required: variable.required === true,
      buildTime: variable.buildTime === true,
      hasDefault: variable.hasDefault === true,
      exampleValue: text(variable.exampleValue, 120),
      locations: (Array.isArray(variable.locations) ? variable.locations : []).slice(0, 3).map((location) => text(location)).filter(Boolean),
    }));
  const services = (Array.isArray(value.services) ? value.services : []).slice(0, 10)
    .filter((service) => SERVICES.some((known) => known.id === service?.id))
    .map((service) => ({
      id: service.id,
      label: SERVICES.find((known) => known.id === service.id).label,
      envHint: SERVICES.find((known) => known.id === service.id).envHint,
      evidence: (Array.isArray(service.evidence) ? service.evidence : []).slice(0, 3).map((item) => text(item, 80)).filter(Boolean),
      envVars: (Array.isArray(service.envVars) ? service.envVars : []).map(name).filter(Boolean).slice(0, 10),
    }));
  const ignored = (Array.isArray(value.ignored) ? value.ignored : []).map(name).filter(Boolean).slice(0, 100);
  return { variables, services, ignored, scannedAt: text(value.scannedAt, 40) || new Date().toISOString() };
}

/** Required variable names, minus the ones the user marked as not needed. */
export function effectiveRequiredEnv(project) {
  const ignored = new Set(Array.isArray(project?.envAnalysis?.ignored) ? project.envAnalysis.ignored : []);
  return (Array.isArray(project?.requiredEnv) ? project.requiredEnv : []).filter((name) => !ignored.has(name));
}

/** Configured values that point at the container itself, which never reaches a real database. */
export function localhostWarnings(values = {}) {
  return Object.entries(values)
    .filter(([, value]) => typeof value === "string" && /^[a-z][\w+.-]*:\/\/([^@/]*@)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])([:/]|$)/i.test(value.trim()))
    .map(([name]) => name);
}
