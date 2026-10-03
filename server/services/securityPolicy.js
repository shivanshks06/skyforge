import { KEY_PATTERNS, extractRoutes, LOGIN_ROUTE } from "./securityScanner.js";

/**
 * Pure analysis used by the security features: what the code needs (outbound ports, AWS
 * permissions), what it exposes (attack surface), and what it depends on (packages for CVE alerts).
 * Everything here works on [{ path, content }] source files and plain values, so it is unit tested.
 */

const CODE_FILE = /\.(js|jsx|ts|tsx|mjs|cjs|py|rb|php|go|java|kt|cs|rs|ex|exs)$/i;
const SKIP = /(^|\/)(node_modules|vendor|dist|build|\.git|tests?|__tests__|spec)\//i;

// ---------------------------------------------------------------- outbound firewall (#3)

const SCHEME_PORTS = {
  postgres: 5432, postgresql: 5432, mysql: 3306, mariadb: 3306, mongodb: 27017, "mongodb+srv": 27017, redis: 6379, rediss: 6380,
  amqp: 5672, amqps: 5671, memcached: 11211, nats: 4222, mqtt: 1883, mqtts: 8883, smtp: 587, smtps: 465, ldap: 389, ldaps: 636,
  mssql: 1433, sqlserver: 1433, kafka: 9092, elasticsearch: 9200, cassandra: 9042, neo4j: 7687, bolt: 7687, clickhouse: 8123,
};
const LIBRARY_PORTS = [
  [/\b(pg|psycopg2?|asyncpg|postgres|sequelize|typeorm|prisma|knex|sqlalchemy|activerecord|pdo_pgsql|lib\/pq|pgx)\b/i, null],
  [/\b(nodemailer|smtplib|ActionMailer|Swift_SmtpTransport|PHPMailer|net\/smtp|lettre)\b/i, [587, 465, 25]],
  [/\b(ioredis|redis-py|from redis|require\(["']redis["']\)|go-redis|predis|Redis::new)\b/i, [6379, 6380]],
  [/\b(mongoose|pymongo|mongodb|motor\.motor_asyncio|mongo-driver)\b/i, [27017]],
  [/\b(mysql2?|pymysql|mysqlclient|mysql-connector|go-sql-driver\/mysql)\b/i, [3306]],
  [/\b(amqplib|pika|bunny|lavinmq|rabbitmq)\b/i, [5672, 5671]],
  [/\b(kafkajs|kafka-python|confluent_kafka|sarama)\b/i, [9092]],
];

/**
 * TCP ports the app needs to reach: HTTPS/HTTP always (APIs, AWS, package CDNs), plus database,
 * cache, queue and mail ports found in environment values or in the libraries the code uses.
 */
export function egressPortsFor({ sourceFiles = [], envValues = {} } = {}) {
  const ports = new Set([80, 443]);
  for (const value of Object.values(envValues)) {
    for (const match of String(value ?? "").matchAll(/\b([a-z][a-z0-9+.-]*):\/\/(?:[^@\s/]*@)?[^:/\s,]+(?::(\d{2,5}))?/gi)) {
      const scheme = match[1].toLowerCase();
      if (match[2]) ports.add(Number(match[2]));
      else if (SCHEME_PORTS[scheme]) ports.add(SCHEME_PORTS[scheme]);
    }
  }
  for (const [name, value] of Object.entries(envValues)) {
    if (/(^|_)PORT$/i.test(name) && /^\d{2,5}$/.test(String(value)) && !/^(PORT|APP_PORT|SERVER_PORT|HTTP_PORT)$/i.test(name)) ports.add(Number(value));
  }
  const code = sourceFiles.filter((file) => file.content && !SKIP.test(file.path) && (CODE_FILE.test(file.path) || /(^|\/)(package\.json|requirements\.txt|Gemfile|composer\.json|go\.mod|pyproject\.toml)$/.test(file.path)));
  const text = code.map((file) => file.content.slice(0, 200_000)).join("\n");
  for (const [pattern, libPorts] of LIBRARY_PORTS) {
    if (pattern.test(text)) for (const port of libPorts || [5432]) ports.add(port);
  }
  return [...ports].filter((port) => Number.isInteger(port) && port > 0 && port < 65536).sort((a, b) => a - b);
}

// ---------------------------------------------------------------- AWS permissions from code (#14)

const JS_CLIENT_SERVICE = {
  s3: "s3", "lib-storage": "s3", dynamodb: "dynamodb", "lib-dynamodb": "dynamodb", sqs: "sqs", sns: "sns", ses: "ses", sesv2: "ses",
  "secrets-manager": "secretsmanager", ssm: "ssm", lambda: "lambda", kinesis: "kinesis", firehose: "firehose", "cognito-identity-provider": "cognito-idp",
  "bedrock-runtime": "bedrock", bedrock: "bedrock", rekognition: "rekognition", textract: "textract", translate: "translate", comprehend: "comprehend",
  polly: "polly", "cloudwatch-logs": "logs", cloudwatch: "cloudwatch", eventbridge: "events", sfn: "states", kms: "kms", ecs: "ecs", ec2: "ec2",
  "s3-presigned-post": "s3", "s3-request-presigner": "s3", athena: "athena", glue: "glue", iot: "iot", "iot-data-plane": "iot", "location": "geo",
  "transcribe": "transcribe", "sagemaker-runtime": "sagemaker", scheduler: "scheduler", appsync: "appsync", "api-gateway": "apigateway",
};
const PY_SERVICE = { s3: "s3", dynamodb: "dynamodb", sqs: "sqs", sns: "sns", ses: "ses", sesv2: "ses", secretsmanager: "secretsmanager", ssm: "ssm", lambda: "lambda", kinesis: "kinesis", firehose: "firehose", "cognito-idp": "cognito-idp", "bedrock-runtime": "bedrock", bedrock: "bedrock", rekognition: "rekognition", textract: "textract", translate: "translate", comprehend: "comprehend", polly: "polly", logs: "logs", cloudwatch: "cloudwatch", events: "events", stepfunctions: "states", kms: "kms", athena: "athena", transcribe: "transcribe", "sagemaker-runtime": "sagemaker" };
const ACTION_ALIASES = {
  "s3:ListObjectsV2": ["s3:ListBucket"], "s3:ListObjects": ["s3:ListBucket"], "s3:HeadObject": ["s3:GetObject"], "s3:HeadBucket": ["s3:ListBucket"],
  "s3:CopyObject": ["s3:GetObject", "s3:PutObject"], "s3:DeleteObjects": ["s3:DeleteObject"], "s3:Upload": ["s3:PutObject", "s3:AbortMultipartUpload"],
  "s3:UploadFile": ["s3:PutObject"], "s3:DownloadFile": ["s3:GetObject"], "s3:GeneratePresignedUrl": ["s3:GetObject"], "s3:GeneratePresignedPost": ["s3:PutObject"],
  "s3:CreateMultipartUpload": ["s3:PutObject"], "s3:UploadPart": ["s3:PutObject"], "s3:CompleteMultipartUpload": ["s3:PutObject"],
  "dynamodb:Get": ["dynamodb:GetItem"], "dynamodb:Put": ["dynamodb:PutItem"], "dynamodb:Update": ["dynamodb:UpdateItem"], "dynamodb:Delete": ["dynamodb:DeleteItem"],
  "dynamodb:BatchGet": ["dynamodb:BatchGetItem"], "dynamodb:BatchWrite": ["dynamodb:BatchWriteItem"], "dynamodb:TransactWrite": ["dynamodb:TransactWriteItems"], "dynamodb:TransactGet": ["dynamodb:TransactGetItems"],
  "lambda:Invoke": ["lambda:InvokeFunction"], "lambda:InvokeAsync": ["lambda:InvokeFunction"],
  "bedrock:Converse": ["bedrock:InvokeModel"], "bedrock:ConverseStream": ["bedrock:InvokeModelWithResponseStream"],
  "ses:SendRawEmail": ["ses:SendRawEmail"], "sts:GetCallerIdentity": [],
};
const PY_METHOD = /\.(get_object|put_object|delete_object|delete_objects|list_objects(?:_v2)?|head_object|copy_object|upload_file|upload_fileobj|download_file|download_fileobj|generate_presigned_url|generate_presigned_post|get_item|put_item|update_item|delete_item|query|scan|batch_get_item|batch_write_item|transact_write_items|send_message|receive_message|delete_message|publish|send_email|send_raw_email|get_secret_value|get_parameter|get_parameters|get_parameters_by_path|invoke|invoke_model|converse|put_record|put_records|put_metric_data|put_log_events|put_events|start_execution|encrypt|decrypt|generate_data_key|detect_labels|detect_text|translate_text|synthesize_speech|start_query_execution|get_query_results)\(/g;
const pascal = (snake) => snake.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("").replace(/V2$/, "V2");

/** Least-privilege IAM policy for the task role, derived from AWS SDK calls in the source. */
export function codePermissionsFor({ sourceFiles = [], envValues = {} } = {}) {
  const actions = new Set();
  const evidence = {};
  const note = (action, file) => {
    for (const resolved of ACTION_ALIASES[action] ?? [action]) {
      actions.add(resolved);
      (evidence[resolved] ||= new Set()).add(file);
    }
  };
  for (const { path: file, content } of sourceFiles) {
    if (!content || SKIP.test(file) || !CODE_FILE.test(file)) continue;
    // AWS SDK for JavaScript v3: import { PutObjectCommand } from "@aws-sdk/client-s3"
    for (const match of content.matchAll(/import\s*(?:type\s*)?\{([^}]+)\}\s*from\s*["']@aws-sdk\/(?:client|lib)-([\w-]+)["']|\{([^}]+)\}\s*=\s*require\(\s*["']@aws-sdk\/(?:client|lib)-([\w-]+)["']\s*\)/g)) {
      const names = match[1] || match[3];
      const service = JS_CLIENT_SERVICE[match[2] || match[4]];
      if (!service) continue;
      for (const name of names.split(",").map((part) => part.trim().split(/\s+as\s+/)[0])) {
        const command = name.match(/^([A-Z]\w+?)Command$/);
        if (command) note(`${service}:${command[1]}`, file);
        if (name === "Upload") note("s3:Upload", file);
        if (name === "getSignedUrl" && service === "s3") note("s3:GetObject", file);
      }
    }
    // Python boto3: boto3.client("s3") / boto3.resource("dynamodb") and their method calls.
    const pyServices = [...content.matchAll(/boto3\.(?:client|resource)\(\s*["']([\w-]+)["']/g)].map((match) => PY_SERVICE[match[1]]).filter(Boolean);
    if (pyServices.length) {
      for (const match of content.matchAll(PY_METHOD)) {
        for (const service of new Set(pyServices)) note(`${service}:${pascal(match[1])}`, file);
      }
    }
    // AWS SDK for JavaScript v2: new AWS.S3() ... .putObject(
    const v2 = [...content.matchAll(/new\s+AWS\.(S3|DynamoDB(?:\.DocumentClient)?|SQS|SNS|SES|SecretsManager|SSM|Lambda|Kinesis)\(/g)].map((match) => ({ S3: "s3", DynamoDB: "dynamodb", "DynamoDB.DocumentClient": "dynamodb", SQS: "sqs", SNS: "sns", SES: "ses", SecretsManager: "secretsmanager", SSM: "ssm", Lambda: "lambda", Kinesis: "kinesis" })[match[1]]);
    if (v2.length) {
      for (const match of content.matchAll(/\.(putObject|getObject|deleteObject|listObjectsV2|headObject|upload|getSignedUrl|get|put|update|delete|query|scan|getItem|putItem|updateItem|deleteItem|sendMessage|receiveMessage|deleteMessage|publish|sendEmail|getSecretValue|getParameter|invoke|putRecord)\(/g)) {
        const action = match[1].charAt(0).toUpperCase() + match[1].slice(1);
        for (const service of new Set(v2)) {
          if (service === "s3" && !/Object|upload|SignedUrl/i.test(action)) continue;
          if (service !== "s3" && /Object|upload|SignedUrl/i.test(action)) continue;
          note(`${service}:${action === "GetSignedUrl" ? "GetObject" : action}`, file);
        }
      }
    }
  }
  const list = [...actions].filter((action) => /^[a-z0-9-]+:[A-Za-z0-9]+$/.test(action)).sort();
  if (!list.length) return { actions: [], policy: null, evidence: {} };
  // Scope S3 to buckets named in the environment when there are any.
  const buckets = Object.entries(envValues)
    .filter(([name, value]) => /BUCKET/i.test(name) && /^[a-z0-9][a-z0-9.-]{2,62}$/.test(String(value || "")))
    .map(([, value]) => value);
  const s3 = list.filter((action) => action.startsWith("s3:"));
  const other = list.filter((action) => !action.startsWith("s3:"));
  const statements = [];
  if (s3.length) {
    statements.push({
      Sid: "S3FromCode",
      Effect: "Allow",
      Action: s3,
      Resource: buckets.length ? buckets.flatMap((bucket) => [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`]) : "*",
    });
  }
  if (other.length) statements.push({ Sid: "ServicesFromCode", Effect: "Allow", Action: other, Resource: "*" });
  return {
    actions: list,
    policy: { Version: "2012-10-17", Statement: statements },
    evidence: Object.fromEntries(Object.entries(evidence).map(([action, files]) => [action, [...files].slice(0, 5)])),
    scopedBuckets: buckets,
  };
}

// ---------------------------------------------------------------- attack surface (#18)

const DEBUG_ROUTE = /debug|test|phpinfo|console|graphiql|swagger|api-docs|__|actuator|metrics|status|health|internal|dev/i;
const ADMIN_ROUTE = /admin|dashboard|manage|staff|backoffice|cms|superuser/i;

export function attackSurfaceFor({ sourceFiles = [], envKeys = [], dependencies = [], port = null, egressPorts = [], framework = null, permissions = [] } = {}) {
  const routes = extractRoutes(sourceFiles).filter((route) => route.length < 120).sort();
  return {
    framework,
    port,
    routes: routes.slice(0, 500),
    adminRoutes: routes.filter((route) => ADMIN_ROUTE.test(route)),
    loginRoutes: routes.filter((route) => LOGIN_ROUTE.test(route)),
    debugRoutes: routes.filter((route) => DEBUG_ROUTE.test(route) && !/health/i.test(route)),
    uploadRoutes: routes.filter((route) => /upload|import|file/i.test(route)),
    envKeys: [...envKeys].sort(),
    dependencies: dependencies.map((dep) => `${dep.ecosystem}:${dep.name}`).sort().slice(0, 2000),
    egressPorts,
    awsPermissions: permissions,
    capturedAt: new Date().toISOString(),
  };
}

const delta = (before = [], after = []) => ({
  added: after.filter((item) => !before.includes(item)),
  removed: before.filter((item) => !after.includes(item)),
});

/** What changed between two deployments' attack surfaces, and how risky the change is. */
export function diffAttackSurface(previous, current) {
  if (!previous) return { first: true, risk: "none", changes: {}, highlights: [] };
  const changes = {};
  for (const key of ["routes", "adminRoutes", "loginRoutes", "debugRoutes", "uploadRoutes", "envKeys", "dependencies", "egressPorts", "awsPermissions"]) {
    const change = delta(previous[key] || [], current[key] || []);
    if (change.added.length || change.removed.length) changes[key] = change;
  }
  if (previous.port !== current.port) changes.port = { from: previous.port, to: current.port };
  const highlights = [];
  if (changes.adminRoutes?.added.length) highlights.push(`New admin route(s): ${changes.adminRoutes.added.slice(0, 5).join(", ")}`);
  if (changes.debugRoutes?.added.length) highlights.push(`New debug/internal route(s): ${changes.debugRoutes.added.slice(0, 5).join(", ")}`);
  if (changes.uploadRoutes?.added.length) highlights.push(`New upload route(s): ${changes.uploadRoutes.added.slice(0, 5).join(", ")}`);
  if (changes.awsPermissions?.added.length) highlights.push(`Code now uses AWS actions: ${changes.awsPermissions.added.slice(0, 6).join(", ")}`);
  if (changes.egressPorts?.added.length) highlights.push(`App now connects out on port(s) ${changes.egressPorts.added.join(", ")}`);
  if (changes.dependencies?.added.length) highlights.push(`${changes.dependencies.added.length} new dependenc${changes.dependencies.added.length === 1 ? "y" : "ies"}`);
  if (changes.routes?.added.length) highlights.push(`${changes.routes.added.length} new route(s)`);
  if (changes.port) highlights.push(`Listening port changed ${changes.port.from} → ${changes.port.to}`);
  const risk = changes.adminRoutes?.added.length || changes.debugRoutes?.added.length || changes.awsPermissions?.added.length
    ? "high"
    : changes.uploadRoutes?.added.length || changes.egressPorts?.added.length || changes.loginRoutes?.added.length ? "medium"
      : Object.keys(changes).length ? "low" : "none";
  return { first: false, risk, changes, highlights };
}

// ---------------------------------------------------------------- dependencies for CVE alerts (#8)

const clean = (version) => String(version || "").trim().replace(/^[\^~>=<v\s]+/, "").split(/\s|,|\|\|/)[0];

/** [{ ecosystem, name, version }] from lockfiles/manifests (OSV ecosystem names). */
export function dependenciesFor(sourceFiles = []) {
  const deps = new Map();
  const add = (ecosystem, name, version) => {
    const v = clean(version);
    if (!name || !/^\d/.test(v)) return;
    deps.set(`${ecosystem}:${name}@${v}`, { ecosystem, name, version: v });
  };
  const byName = (pattern) => sourceFiles.filter((file) => pattern.test(file.path) && !/(^|\/)node_modules\//.test(file.path) && file.content);
  for (const file of byName(/(^|\/)package-lock\.json$/)) {
    try {
      const lock = JSON.parse(file.content);
      for (const [key, value] of Object.entries(lock.packages || {})) {
        if (!key) continue;
        add("npm", value.name || key.replace(/^.*node_modules\//, ""), value.version);
      }
      for (const [name, value] of Object.entries(lock.dependencies || {})) add("npm", name, value.version);
    } catch {}
  }
  const hasNpmLock = deps.size > 0;
  if (!hasNpmLock) {
    for (const file of byName(/(^|\/)package\.json$/)) {
      try {
        const pkg = JSON.parse(file.content);
        for (const [name, range] of Object.entries({ ...pkg.dependencies })) add("npm", name, range);
      } catch {}
    }
  }
  for (const file of byName(/(^|\/)requirements[\w.-]*\.txt$/)) {
    for (const match of file.content.matchAll(/^\s*([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*==\s*([\w.+-]+)/gm)) add("PyPI", match[1].toLowerCase(), match[2]);
  }
  for (const file of byName(/(^|\/)(poetry\.lock|Cargo\.lock)$/)) {
    const ecosystem = /Cargo/.test(file.path) ? "crates.io" : "PyPI";
    for (const match of file.content.matchAll(/\[\[package\]\]\s*\nname\s*=\s*"([^"]+)"\s*\nversion\s*=\s*"([^"]+)"/g)) add(ecosystem, match[1], match[2]);
  }
  for (const file of byName(/(^|\/)Pipfile\.lock$/)) {
    try {
      const lock = JSON.parse(file.content);
      for (const [name, value] of Object.entries(lock.default || {})) add("PyPI", name.toLowerCase(), value.version);
    } catch {}
  }
  for (const file of byName(/(^|\/)go\.mod$/)) {
    for (const match of file.content.matchAll(/^\s*(?:require\s+)?([\w.-]+\.[\w.-]+\/[\w./-]+)\s+v([\w.+-]+)/gm)) add("Go", match[1], match[2]);
  }
  for (const file of byName(/(^|\/)Gemfile\.lock$/)) {
    const specs = file.content.split(/^\s*specs:\s*$/m)[1] || "";
    for (const match of specs.matchAll(/^ {4}([A-Za-z0-9_.-]+) \(([\w.]+)[^)]*\)/gm)) add("RubyGems", match[1], match[2]);
  }
  for (const file of byName(/(^|\/)composer\.lock$/)) {
    try {
      const lock = JSON.parse(file.content);
      for (const pkg of lock.packages || []) add("Packagist", pkg.name, pkg.version);
    } catch {}
  }
  return [...deps.values()].slice(0, 1000);
}

// ---------------------------------------------------------------- secrets in pushed code (#9)

/** Secrets in added lines of a unified diff patch: [{ rule, title, severity, line }]. */
export function secretsInPatch(patch = "") {
  const found = [];
  const lines = String(patch).split("\n");
  let line = 0;
  for (const raw of lines) {
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) {
      line = Number(hunk[1]) - 1;
      continue;
    }
    if (raw.startsWith("-")) continue;
    line += 1;
    if (!raw.startsWith("+")) continue;
    for (const pattern of KEY_PATTERNS) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(raw)) found.push({ rule: pattern.rule, title: pattern.title, severity: pattern.severity, line });
    }
  }
  return found;
}

/** True for file names that must never be pushed (committed environment / key files). */
export function isSensitiveFile(file) {
  if (/(^|\/)\.env\.(example|sample|template|dist|defaults)$/i.test(file)) return false;
  return /(^|\/)(\.env(\.[\w-]+)?|id_rsa|id_ed25519|[^/]*\.pem|[^/]*\.p12|[^/]*\.pfx|credentials\.json|service-account[^/]*\.json)$/i.test(file);
}
