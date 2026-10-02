import test from "node:test";
import assert from "node:assert/strict";
import { scanEnvironment, effectiveRequiredEnv, localhostWarnings } from "../services/envScanner.js";

const scan = (files) => {
  const result = scanEnvironment(Object.entries(files).map(([path, content]) => ({ path, content })));
  const byName = Object.fromEntries(result.variables.map((variable) => [variable.name, variable]));
  return { ...result, byName };
};

test("pydantic settings fields without defaults are required (Auth0 FastAPI sample)", () => {
  const { byName } = scan({
    "application/config.py": [
      "from pydantic import BaseSettings, Field",
      "",
      "class Settings(BaseSettings):",
      "    auth0_audience: str",
      "    auth0_domain: str",
      "    client_origin_url: str",
      "    reload: bool",
      "    port: int = 6060",
      "    log_level: str = Field('info')",
      "    api_token: str = Field(..., env='SERVICE_TOKEN')",
      "",
      "settings = Settings()",
    ].join("\n"),
  });
  for (const name of ["AUTH0_AUDIENCE", "AUTH0_DOMAIN", "CLIENT_ORIGIN_URL", "RELOAD", "SERVICE_TOKEN"]) assert.equal(byName[name]?.required, true, name);
  assert.equal(byName.LOG_LEVEL.required, false);
  assert.equal(byName.PORT, undefined); // set by the platform
  assert.equal(byName.AUTH0_DOMAIN.locations[0], "application/config.py:5");
});

test("defaults make variables optional; secret-like reads without one are required", () => {
  const { byName } = scan({
    "src/server.js": [
      "const db = process.env.DATABASE_URL;",
      "const level = process.env.LOG_LEVEL || 'info';",
      "const feature = process.env.FEATURE_FLAG;",
      "const { STRIPE_SECRET_KEY, REGION = 'us' } = process.env;",
      "const api = import.meta.env.VITE_API_URL;",
    ].join("\n"),
    "app/settings.py": "SECRET_KEY = os.environ['DJANGO_SECRET']\nDEBUG = os.getenv('DJANGO_DEBUG', 'false')\nKEY = config('SENTRY_DSN')\n",
    "main.go": 'url := os.Getenv("REDIS_URL")\nname := os.Getenv("APP_NAME")\n',
    "src/main.rs": 'let key = env::var("JWT_SECRET").expect("set");\nlet n = env::var("WORKERS").unwrap_or("4".into());\n',
    "config/application.yml": "spring:\n  datasource:\n    url: ${JDBC_URL}\n    pool: ${POOL_SIZE:10}\n",
  });
  const required = (name) => byName[name]?.required;
  assert.equal(required("DATABASE_URL"), true);
  assert.equal(required("LOG_LEVEL"), false);
  assert.equal(required("FEATURE_FLAG"), false);
  assert.equal(required("STRIPE_SECRET_KEY"), true);
  assert.equal(required("REGION"), false);
  assert.equal(byName.VITE_API_URL.buildTime, true);
  assert.equal(required("VITE_API_URL"), false);
  assert.equal(required("DJANGO_SECRET"), true);
  assert.equal(required("DJANGO_DEBUG"), false);
  assert.equal(required("SENTRY_DSN"), true);
  assert.equal(required("REDIS_URL"), true);
  assert.equal(required("APP_NAME"), false);
  assert.equal(required("JWT_SECRET"), true);
  assert.equal(required("WORKERS"), false);
  assert.equal(required("JDBC_URL"), true);
  assert.equal(required("POOL_SIZE"), false);
});

test(".env.example placeholders are required, concrete examples are optional, tests are ignored", () => {
  const { byName } = scan({
    ".env.example": "OPENAI_API_KEY=\nLOG_FORMAT=json\nAPP_SECRET=changeme\n",
    "test/setup.js": "process.env.TEST_ONLY_SECRET_KEY",
  });
  assert.equal(byName.OPENAI_API_KEY.required, true);
  assert.equal(byName.APP_SECRET.required, true);
  assert.equal(byName.LOG_FORMAT.required, false);
  assert.equal(byName.LOG_FORMAT.exampleValue, "json");
  assert.equal(byName.TEST_ONLY_SECRET_KEY, undefined);
});

test("databases and caches are detected from dependencies", () => {
  const { services } = scan({
    "package.json": JSON.stringify({ dependencies: { express: "4", mongoose: "8", ioredis: "5" } }),
    "requirements.txt": "Django==5.0\npsycopg2-binary>=2.9\n",
    "prisma/schema.prisma": 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
  });
  assert.deepEqual(services.map((service) => service.id).sort(), ["mongodb", "postgres", "redis"]);
  assert.deepEqual(services.find((service) => service.id === "postgres").envVars, ["DATABASE_URL"]);
});

test("ignored variables are not required and localhost connection strings are flagged", () => {
  assert.deepEqual(effectiveRequiredEnv({ requiredEnv: ["A", "B"], envAnalysis: { ignored: ["B"] } }), ["A"]);
  assert.deepEqual(localhostWarnings({ DATABASE_URL: "postgres://u:p@localhost:5432/db", REDIS_URL: "redis://cache.example.com:6379", NAME: "localhost" }), ["DATABASE_URL"]);
});
