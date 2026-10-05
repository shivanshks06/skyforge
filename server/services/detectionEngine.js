/**
 * Repository Intelligence Detection Engine
 * Deterministic rule-based detection for 10 deployment properties across 20+ frameworks.
 */

// List of important files to fetch for inspection without full repo cloning
export const IMPORTANT_FILES = [
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "requirements.txt",
  "pyproject.toml",
  "Pipfile",
  "Pipfile.lock",
  "poetry.lock",
  "go.mod",
  "go.sum",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "composer.lock",
  "Cargo.toml",
  "Cargo.lock",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "vite.config.js",
  "vite.config.ts",
  "vite.config.mjs",
  "tsconfig.json",
  "angular.json",
  "nest-cli.json",
  "nuxt.config.js",
  "nuxt.config.ts",
  "svelte.config.js",
  "astro.config.mjs",
  "manage.py",
  "artisan",
  ".env.example",
  ".env.template",
  ".env.sample",
  ".env.local.example",
];

/**
 * Step 6 — Detect Package Manager from file tree lockfiles
 */
export function detectPackageManager(tree, language = "JavaScript") {
  const hasFile = (name) => tree.some((f) => f.path === name || f.path?.endsWith(`/${name}`));

  if (hasFile("pnpm-lock.yaml")) return "pnpm";
  if (hasFile("yarn.lock")) return "yarn";
  if (hasFile("bun.lockb") || hasFile("bun.lock")) return "bun";
  if (hasFile("package-lock.json")) return "npm";
  if (hasFile("poetry.lock")) return "poetry";
  if (hasFile("Pipfile.lock") || hasFile("Pipfile")) return "pipenv";
  if (hasFile("Cargo.lock") || hasFile("Cargo.toml")) return "cargo";
  if (hasFile("composer.lock") || hasFile("composer.json")) return "composer";
  if (hasFile("go.sum") || hasFile("go.mod")) return "go";
  if (hasFile("pom.xml")) return "maven";
  if (hasFile("build.gradle") || hasFile("build.gradle.kts")) return "gradle";

  // Fallback defaults per language
  if (language === "Python") return "pip";
  if (language === "Go") return "go";
  if (language === "Rust") return "cargo";
  if (language === "Java") return "maven";
  if (language === "PHP") return "composer";
  return "npm";
}

/**
 * Detect Build Tool / Bundler
 */
export function detectBuildTool(tree, files, pkg) {
  const hasFile = (name) => tree.some((f) => f.path === name || f.path?.endsWith(`/${name}`));

  if (
    hasFile("vite.config.js") ||
    hasFile("vite.config.ts") ||
    hasFile("vite.config.mjs") ||
    pkg?.dependencies?.vite ||
    pkg?.devDependencies?.vite
  ) {
    return "Vite";
  }

  if (
    hasFile("next.config.js") ||
    hasFile("next.config.mjs") ||
    hasFile("next.config.ts") ||
    pkg?.dependencies?.next ||
    pkg?.devDependencies?.next
  ) {
    return "Next.js Compiler";
  }

  if (
    hasFile("nuxt.config.js") ||
    hasFile("nuxt.config.ts") ||
    pkg?.dependencies?.nuxt
  ) {
    return "Nuxt / Nitro";
  }

  if (
    hasFile("astro.config.mjs") ||
    pkg?.dependencies?.astro
  ) {
    return "Astro";
  }

  if (hasFile("angular.json") || pkg?.dependencies?.["@angular/core"]) {
    return "Angular CLI";
  }

  if (hasFile("nest-cli.json") || pkg?.dependencies?.["@nestjs/core"]) {
    return "Nest CLI";
  }

  if (hasFile("webpack.config.js") || pkg?.devDependencies?.webpack) {
    return "Webpack";
  }

  if (hasFile("turbo.json") || pkg?.devDependencies?.turbo) {
    return "Turbopack";
  }

  if (hasFile("Cargo.toml")) return "Cargo";
  if (hasFile("pom.xml")) return "Maven";
  if (hasFile("build.gradle") || hasFile("build.gradle.kts")) return "Gradle";
  if (hasFile("go.mod")) return "Go Toolchain";
  if (hasFile("requirements.txt") || hasFile("pyproject.toml")) return "Python Pip";

  return "Standard";
}

/**
 * Step 10 — Detect Environment Variables
 * Scans .env templates and source code references
 */
export function detectEnvironmentVariables(files) {
  const envVars = new Set();
  const IGNORED_VARS = new Set([
    "NODE_ENV",
    "PATH",
    "PORT",
    "HOME",
    "USER",
    "PWD",
    "SHELL",
    "LANG",
    "HOSTNAME",
    "TERM",
    "SHLVL",
    "npm_config_user_agent",
  ]);

  // 1. Check .env template files
  const envTemplates = [".env.example", ".env.template", ".env.sample", ".env.local.example"];
  for (const tpl of envTemplates) {
    const content = files[tpl];
    if (content && typeof content === "string") {
      const lines = content.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
          const key = trimmed.split("=")[0].trim();
          if (key && !IGNORED_VARS.has(key)) {
            envVars.add(key);
          }
        }
      }
    }
  }

  // 2. Scan code files for process.env.KEY, import.meta.env.KEY, os.environ.get("KEY"), os.getenv("KEY")
  const regexNode = /process\.env\.([A-Z0-9_]+)/g;
  const regexVite = /import\.meta\.env\.([A-Z0-9_]+)/g;
  const regexPy = /(?:os\.environ\.get|os\.getenv)\(['"]([A-Z0-9_]+)['"]\)/g;
  const regexGo = /os\.Getenv\(['"]([A-Z0-9_]+)['"]\)/g;

  for (const content of Object.values(files)) {
    if (!content || typeof content !== "string") continue;
    let match;

    while ((match = regexNode.exec(content)) !== null) {
      if (match[1] && !IGNORED_VARS.has(match[1])) {
        envVars.add(match[1]);
      }
    }

    while ((match = regexVite.exec(content)) !== null) {
      if (match[1] && !IGNORED_VARS.has(match[1])) {
        envVars.add(match[1]);
      }
    }

    while ((match = regexPy.exec(content)) !== null) {
      if (match[1] && !IGNORED_VARS.has(match[1])) {
        envVars.add(match[1]);
      }
    }

    while ((match = regexGo.exec(content)) !== null) {
      if (match[1] && !IGNORED_VARS.has(match[1])) {
        envVars.add(match[1]);
      }
    }
  }

  return Array.from(envVars);
}

/**
 * Step 8 — Detect Listening Port
 * Scans code for explicit port assignments, falling back to framework defaults.
 */
export function detectPort(tree, files, framework, buildTool) {
  // 1. The repository's own Dockerfile says which port the container listens on.
  const exposed = String(files.Dockerfile || "").match(/^\s*EXPOSE\s+(\d{2,5})/im);
  if (exposed) {
    const portNum = parseInt(exposed[1], 10);
    if (portNum > 0 && portNum <= 65535) return portNum;
  }

  // 2. Explicit ports in code (compose/YAML files describe host mappings, not the app)
  const portPatterns = [
    /(?:process\.env\.PORT\s*\|\|\s*|PORT\s*=\s*|listen\(|port:\s*|port\s*=\s*)(\d{4,5})/i,
    /uvicorn\.run\(.*port\s*=\s*(\d{4,5})/i,
    /app\.run\(.*port\s*=\s*(\d{4,5})/i,
  ];

  for (const [name, content] of Object.entries(files)) {
    if (!content || typeof content !== "string" || /\.(ya?ml|json|lock|toml)$|compose|Dockerfile|\.env/i.test(name)) continue;
    for (const pattern of portPatterns) {
      const match = content.match(pattern);
      if (match && match[1]) {
        const portNum = parseInt(match[1], 10);
        if (portNum >= 1000 && portNum <= 65535) {
          return portNum;
        }
      }
    }
  }

  // 2. Framework default port heuristics
  if (buildTool === "Vite" || framework?.includes("Vite")) {
    return 5173;
  }

  switch (framework) {
    case "React":
    case "React + Vite":
      return buildTool === "Vite" ? 5173 : 3000;
    case "Next.js":
      return 3000;
    case "Nuxt":
    case "SvelteKit":
    case "Astro":
    case "Remix":
      return 3000;
    case "Vue":
    case "Vue + Vite":
      return buildTool === "Vite" ? 5173 : 8080;
    case "Angular":
      return 4200;
    case "Express":
    case "NestJS":
    case "Fastify":
    case "Flask":
      return 5000;
    case "FastAPI":
    case "Django":
    case "Laravel":
      return 8000;
    case "Spring Boot":
    case "Go":
    case "Go (Gin)":
    case "Rust":
      return 8080;
    default:
      return 3000;
  }
}

/**
 * Step 9 — Detect Docker Support
 */
export function detectDocker(tree) {
  const hasDockerfile = tree.some((entry) => entry.path === "Dockerfile");
  return {
    dockerized: hasDockerfile,
    dockerStatus: hasDockerfile ? "Existing Dockerfile" : "Will be generated",
  };
}

/**
 * Step 4 & 7 — Deterministic Rule-Based Framework Detection Engine
 */
export async function detectProject(tree, files) {
  let pkg = null;
  if (files["package.json"]) {
    try {
      pkg = JSON.parse(files["package.json"]);
    } catch {
      pkg = null;
    }
  }

  const pkgString = files["package.json"] || "";
  const reqString = files["requirements.txt"] || files["pyproject.toml"] || "";
  const composerString = files["composer.json"] || "";
  const cargoString = files["Cargo.toml"] || "";
  const goModString = files["go.mod"] || "";

  const hasTreeFile = (name) => tree.some((f) => f.path === name || f.path?.endsWith(`/${name}`));

  // Rule Matrix for 20+ Frameworks
  const rules = [
    {
      name: "React + Vite",
      displayFramework: "React + Vite",
      language: hasTreeFile("tsconfig.json") || tree.some((f) => f.path?.endsWith(".tsx")) ? "TypeScript" : "JavaScript",
      calculateScore: () => {
        let score = 0;
        if (pkgString.includes('"react"')) score += 40;
        if (hasTreeFile("vite.config.js") || hasTreeFile("vite.config.ts") || hasTreeFile("vite.config.mjs")) score += 30;
        if (files["package.json"]) score += 20;
        if (tree.some((f) => f.path?.includes("App.jsx") || f.path?.includes("App.tsx") || f.path?.includes("main.jsx") || f.path?.includes("main.tsx"))) score += 10;
        return score;
      },
      getBuildCommand: (pm) => pkg?.scripts?.build ? `${pm} run build` : "npm run build",
      getStartCommand: (pm) => pkg?.scripts?.preview ? `${pm} run preview` : `${pm} start`,
      buildTool: "Vite",
      defaultPort: 5173,
      deploymentTarget: "AWS ECS Fargate",
    },
    {
      name: "React",
      displayFramework: "React",
      language: hasTreeFile("tsconfig.json") || tree.some((f) => f.path?.endsWith(".tsx")) ? "TypeScript" : "JavaScript",
      calculateScore: () => {
        let score = 0;
        if (pkgString.includes('"react"') && !pkgString.includes('"next"')) score += 50;
        if (files["package.json"]) score += 30;
        if (tree.some((f) => f.path?.includes("App.jsx") || f.path?.includes("App.js") || f.path?.includes("App.tsx"))) score += 18;
        return score;
      },
      getBuildCommand: (pm) => pkg?.scripts?.build ? `${pm} run build` : "npm run build",
      getStartCommand: (pm) => pkg?.scripts?.start ? `${pm} start` : "npm start",
      buildTool: "Webpack / CRA",
      defaultPort: 3000,
      deploymentTarget: "AWS ECS Fargate",
    },
    {
      name: "Next.js",
      displayFramework: "Next.js",
      language: hasTreeFile("tsconfig.json") || tree.some((f) => f.path?.endsWith(".tsx") || f.path?.endsWith(".ts")) ? "TypeScript" : "JavaScript",
      calculateScore: () => {
        let score = 0;
        if (hasTreeFile("next.config.js") || hasTreeFile("next.config.mjs") || hasTreeFile("next.config.ts")) score += 45;
        if (pkgString.includes('"next"')) score += 45;
        if (files["package.json"]) score += 10;
        return score;
      },
      getBuildCommand: (pm) => pkg?.scripts?.build ? `${pm} run build` : "npm run build",
      getStartCommand: (pm) => pkg?.scripts?.start ? `${pm} run start` : "npm run start",
      buildTool: "Next.js Compiler",
      defaultPort: 3000,
      deploymentTarget: "AWS ECS Fargate",
    },
    {
      name: "Express",
      displayFramework: "Express",
      language: hasTreeFile("tsconfig.json") || tree.some((f) => f.path?.endsWith(".ts")) ? "TypeScript" : "JavaScript",
      calculateScore: () => {
        let score = 0;
        if (pkgString.includes('"express"')) score += 50;
        if (tree.some((f) => ["server.js", "app.js", "index.js", "src/server.js", "src/app.js", "src/index.js"].includes(f.path))) score += 35;
        if (files["package.json"]) score += 15;
        return score;
      },
      getBuildCommand: (pm) => pkg?.scripts?.build ? `${pm} run build` : "",
      getStartCommand: (pm) => {
        if (pkg?.scripts?.start) return `${pm} start`;
        const main = pkg?.main || (hasTreeFile("server.js") ? "server.js" : "index.js");
        return `node ${main}`;
      },
      buildTool: "Node.js",
      defaultPort: 5000,
      deploymentTarget: "AWS ECS Fargate",
    },
    {
      name: "NestJS",
      displayFramework: "NestJS",
      language: "TypeScript",
      calculateScore: () => {
        let score = 0;
        if (pkgString.includes('"@nestjs/core"')) score += 55;
        if (hasTreeFile("nest-cli.json")) score += 35;
        if (files["package.json"]) score += 10;
        return score;
      },
      getBuildCommand: (pm) => pkg?.scripts?.build ? `${pm} run build` : "npm run build",
      getStartCommand: (pm) => pkg?.scripts?.["start:prod"] ? `${pm} run start:prod` : `${pm} start`,
      buildTool: "Nest CLI",
      defaultPort: 5000,
      deploymentTarget: "AWS ECS Fargate",
    },
    {
      name: "Vue",
      displayFramework: hasTreeFile("vite.config.js") || hasTreeFile("vite.config.ts") ? "Vue + Vite" : "Vue",
      language: hasTreeFile("tsconfig.json") || tree.some((f) => f.path?.endsWith(".ts")) ? "TypeScript" : "JavaScript",
      calculateScore: () => {
        let score = 0;
        if (pkgString.includes('"vue"')) score += 50;
        if (hasTreeFile("vite.config.js") || hasTreeFile("vite.config.ts") || hasTreeFile("vue.config.js")) score += 35;
        if (files["package.json"]) score += 15;
        return score;
      },
      getBuildCommand: (pm) => pkg?.scripts?.build ? `${pm} run build` : "npm run build",
      getStartCommand: (pm) => pkg?.scripts?.preview ? `${pm} run preview` : `${pm} start`,
      buildTool: hasTreeFile("vite.config.js") || hasTreeFile("vite.config.ts") ? "Vite" : "Vue CLI",
      defaultPort: hasTreeFile("vite.config.js") || hasTreeFile("vite.config.ts") ? 5173 : 8080,
      deploymentTarget: "AWS ECS Fargate",
    },
    {
      name: "Angular",
      displayFramework: "Angular",
      language: "TypeScript",
      calculateScore: () => {
        let score = 0;
        if (hasTreeFile("angular.json")) score += 50;
        if (pkgString.includes('"@angular/core"')) score += 40;
        if (files["package.json"]) score += 10;
        return score;
      },
      getBuildCommand: (pm) => pkg?.scripts?.build ? `${pm} run build` : "npm run build",
      getStartCommand: (pm) => pkg?.scripts?.start ? `${pm} start` : "npm start",
      buildTool: "Angular CLI",
      defaultPort: 4200,
      deploymentTarget: "AWS ECS Fargate",
    },
    {
      name: "FastAPI",
      displayFramework: "FastAPI",
      language: "Python",
      calculateScore: () => {
        let score = 0;
        if (reqString.includes("fastapi")) score += 55;
        if (tree.some((f) => f.path === "main.py" || f.path === "app/main.py")) score += 35;
        if (files["requirements.txt"] || files["pyproject.toml"]) score += 10;
        return score;
      },
      getBuildCommand: () => "",
      getStartCommand: () => "uvicorn main:app --host 0.0.0.0 --port 8000",
      buildTool: "Python Pip",
      defaultPort: 8000,
      deploymentTarget: "AWS ECS Fargate",
    },
    {
      name: "Flask",
      displayFramework: "Flask",
      language: "Python",
      calculateScore: () => {
        let score = 0;
        if (reqString.includes("flask")) score += 55;
        if (tree.some((f) => f.path === "app.py" || f.path === "wsgi.py")) score += 35;
        if (files["requirements.txt"] || files["pyproject.toml"]) score += 10;
        return score;
      },
      getBuildCommand: () => "",
      getStartCommand: () => "python app.py",
      buildTool: "Python Pip",
      defaultPort: 5000,
      deploymentTarget: "AWS ECS Fargate",
    },
    {
      name: "Django",
      displayFramework: "Django",
      language: "Python",
      calculateScore: () => {
        let score = 0;
        if (hasTreeFile("manage.py")) score += 55;
        if (reqString.includes("django") || /django/i.test(files.Dockerfile || "")) score += 35;
        if (tree.some((f) => /(^|\/)(wsgi|asgi)\.py$/.test(f.path || "")) && tree.some((f) => /(^|\/)settings\.py$/.test(f.path || ""))) score += 30;
        if (files["requirements.txt"] || files["pyproject.toml"]) score += 10;
        return score;
      },
      getBuildCommand: () => "python manage.py collectstatic --noinput",
      getStartCommand: () => {
        const wsgi = tree.find((f) => /^[A-Za-z_]\w*\/wsgi\.py$/.test(f.path || ""));
        return wsgi ? `gunicorn ${wsgi.path.split("/")[0]}.wsgi:application --bind 0.0.0.0:8000` : "";
      },
      buildTool: "Python Pip",
      defaultPort: 8000,
      deploymentTarget: "AWS ECS Fargate",
    },
    {
      name: "Spring Boot",
      displayFramework: "Spring Boot",
      language: "Java",
      calculateScore: () => {
        let score = 0;
        if (hasTreeFile("pom.xml") || hasTreeFile("build.gradle")) score += 35;
        if (files["pom.xml"]?.includes("spring-boot") || files["build.gradle"]?.includes("spring-boot")) score += 55;
        if (tree.some((f) => f.path?.endsWith("Application.java"))) score += 10;
        return score;
      },
      getBuildCommand: () => hasTreeFile("pom.xml") ? "./mvnw clean package -DskipTests" : "./gradlew build -x test",
      getStartCommand: () => "java -jar target/*.jar",
      buildTool: hasTreeFile("pom.xml") ? "Maven" : "Gradle",
      defaultPort: 8080,
      deploymentTarget: "AWS ECS Fargate",
    },
    {
      name: "Go",
      displayFramework: goModString.includes("gin-gonic/gin") ? "Go (Gin)" : (goModString.includes("gofiber/fiber") ? "Go (Fiber)" : "Go"),
      language: "Go",
      calculateScore: () => {
        let score = 0;
        if (hasTreeFile("go.mod")) score += 60;
        if (tree.some((f) => f.path === "main.go" || f.path?.endsWith(".go"))) score += 35;
        if (hasTreeFile("go.sum")) score += 5;
        return score;
      },
      getBuildCommand: () => "CGO_ENABLED=0 go build -o server .",
      getStartCommand: () => "./server",
      buildTool: "Go Toolchain",
      defaultPort: 8080,
      deploymentTarget: "AWS ECS Fargate",
    },
    {
      name: "Laravel",
      displayFramework: "Laravel",
      language: "PHP",
      calculateScore: () => {
        let score = 0;
        if (hasTreeFile("artisan")) score += 55;
        if (composerString.includes("laravel/framework")) score += 35;
        if (hasTreeFile("composer.json")) score += 10;
        return score;
      },
      getBuildCommand: () => "composer install --no-dev --optimize-autoloader",
      getStartCommand: () => "php artisan serve --host=0.0.0.0 --port=8000",
      buildTool: "Composer",
      defaultPort: 8000,
      deploymentTarget: "AWS ECS Fargate",
    },
    {
      name: "Rust",
      displayFramework: cargoString.includes("actix-web") ? "Rust (Actix-web)" : (cargoString.includes("axum") ? "Rust (Axum)" : "Rust"),
      language: "Rust",
      calculateScore: () => {
        let score = 0;
        if (hasTreeFile("Cargo.toml")) score += 60;
        if (tree.some((f) => f.path === "src/main.rs" || f.path?.endsWith(".rs"))) score += 35;
        if (hasTreeFile("Cargo.lock")) score += 5;
        return score;
      },
      getBuildCommand: () => "cargo build --release",
      getStartCommand: () => "./target/release/main",
      buildTool: "Cargo",
      defaultPort: 8080,
      deploymentTarget: "AWS ECS Fargate",
    },
    {
      name: "Static HTML",
      displayFramework: "Static HTML / JS",
      language: "HTML / JavaScript",
      calculateScore: () => {
        let score = 0;
        // Server-side templates (Django/Flask/Rails/Laravel views) are not a static site.
        const staticIndex = tree.some((f) => /^(index\.html|(public|static|site|www|dist|docs|src)\/index\.html)$/i.test(f.path || ""));
        if (staticIndex && !pkgString.includes('"react"') && !pkgString.includes('"vue"') && !hasTreeFile("next.config.js") && !hasTreeFile("next.config.mjs")) score += 65;
        if (tree.some((f) => f.path?.endsWith(".css"))) score += 15;
        if (tree.some((f) => f.path?.endsWith(".js") && !f.path?.includes("node_modules"))) score += 15;
        const backend = ["manage.py", "requirements.txt", "pyproject.toml", "go.mod", "pom.xml", "build.gradle", "Gemfile", "composer.json", "Cargo.toml", "artisan"].some((name) => hasTreeFile(name));
        if (backend) score -= 60;
        return Math.max(0, score);
      },
      getBuildCommand: () => "",
      getStartCommand: () => "",
      buildTool: "Static Assets",
      defaultPort: 80,
      deploymentTarget: "AWS ECS Fargate",
    },
    {
      name: "Microservices",
      displayFramework: "Microservice Architecture",
      language: "Polyglot / Multi-service",
      calculateScore: () => {
        let score = 0;
        if (tree.some((f) => f.path?.startsWith("services/") || f.path?.startsWith("apps/"))) score += 55;
        if (tree.some((f) => f.path?.toLowerCase().includes("dockerfile"))) score += 25;
        if (hasTreeFile("docker-compose.yml") || hasTreeFile("docker-compose.yaml")) score += 20;
        return score;
      },
      getBuildCommand: () => "",
      getStartCommand: () => "docker compose up",
      buildTool: "Multi-container",
      defaultPort: 80,
      deploymentTarget: "AWS ECS Fargate",
    },
  ];

  // Evaluate candidate framework scores
  let bestRule = null;
  let highestScore = 0;

  for (const rule of rules) {
    const score = rule.calculateScore();
    if (score > highestScore) {
      highestScore = score;
      bestRule = rule;
    }
  }

  // Package Manager Detection
  const detectedLanguage = bestRule?.language || (pkg ? "JavaScript" : (files["requirements.txt"] ? "Python" : "JavaScript"));
  const packageManager = detectPackageManager(tree, detectedLanguage);

  let framework = bestRule?.displayFramework || "Generic Project";
  let language = detectedLanguage;
  let buildTool = bestRule ? bestRule.buildTool : detectBuildTool(tree, files, pkg);
  let buildCommand = bestRule ? bestRule.getBuildCommand(packageManager) : (pkg?.scripts?.build ? `${packageManager} run build` : "");
  let startCommand = bestRule ? bestRule.getStartCommand(packageManager) : (pkg?.scripts?.start ? `${packageManager} start` : "");
  let deploymentTarget = bestRule ? bestRule.deploymentTarget : "AWS ECS Fargate";
  let confidence = Math.min(Math.max(highestScore, 85), 98);

  // Fallback for general Node.js project if no high specific framework
  if (highestScore === 0 && pkg) {
    framework = "Node.js";
    language = "JavaScript";
    buildTool = detectBuildTool(tree, files, pkg);
    buildCommand = pkg.scripts?.build ? `${packageManager} run build` : "";
    startCommand = pkg.scripts?.start ? `${packageManager} start` : "node index.js";
    confidence = 90;
  }

  // Docker Detection
  const { dockerized, dockerStatus } = detectDocker(tree);

  // Environment Variables Detection
  const requiredEnv = detectEnvironmentVariables(files);

  // Port Detection
  const port = detectPort(tree, files, framework, buildTool);

  return {
    language,
    framework,
    packageManager,
    buildTool,
    buildCommand,
    startCommand,
    port,
    dockerized,
    dockerStatus,
    requiredEnv,
    deploymentTarget,
    confidence,
  };
}
