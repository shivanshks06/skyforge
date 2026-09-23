/**
 * Repository Intelligence Detection Engine
 * Deterministic detection for 20+ frameworks, docker specs, package managers, ports, and environment variables.
 */

// List of important files to fetch for inspection
export const IMPORTANT_FILES = [
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "composer.json",
  "Cargo.toml",
  "Dockerfile",
  "docker-compose.yml",
  "next.config.js",
  "next.config.mjs",
  "vite.config.js",
  "tsconfig.json",
  "angular.json",
  "nest-cli.json",
  "manage.py",
  "artisan",
  ".env.example",
  ".env.template",
];

/**
 * Detect Package Manager from file tree
 */
export function detectPackageManager(tree) {
  if (tree.some((f) => f.path === "package-lock.json")) return "npm";
  if (tree.some((f) => f.path === "yarn.lock")) return "yarn";
  if (tree.some((f) => f.path === "pnpm-lock.yaml")) return "pnpm";
  if (tree.some((f) => f.path.includes("bun.lock"))) return "bun";
  if (tree.some((f) => f.path === "poetry.lock")) return "poetry";
  if (tree.some((f) => f.path === "Pipfile.lock")) return "pipenv";
  if (tree.some((f) => f.path === "Cargo.lock")) return "cargo";
  if (tree.some((f) => f.path === "pom.xml")) return "maven";
  if (tree.some((f) => f.path === "build.gradle")) return "gradle";
  return "npm";
}

/**
 * Detect Environment Variables from .env files or source code references
 */
export function detectEnvironmentVariables(files) {
  const envVars = new Set();

  // 1. Check .env.example or .env.template
  const envFileContent = files[".env.example"] || files[".env.template"];
  if (envFileContent) {
    const lines = envFileContent.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
        const key = trimmed.split("=")[0].trim();
        if (key) envVars.add(key);
      }
    }
  }

  // 2. Scan code files for process.env.KEY or os.environ.get("KEY")
  const regexNode = /process\.env\.([A-Z0-9_]+)/g;
  const regexPy = /(?:os\.environ\.get|os\.getenv)\(['"]([A-Z0-9_]+)['"]\)/g;

  for (const [filename, content] of Object.entries(files)) {
    if (!content || typeof content !== "string") continue;
    let match;

    while ((match = regexNode.exec(content)) !== null) {
      if (match[1] && !["NODE_ENV", "PATH", "HOME"].includes(match[1])) {
        envVars.add(match[1]);
      }
    }

    while ((match = regexPy.exec(content)) !== null) {
      if (match[1]) {
        envVars.add(match[1]);
      }
    }
  }

  return Array.from(envVars);
}

/**
 * Detect Listening Port from source code or package.json
 */
export function detectPort(tree, files, framework) {
  // Check common explicit port assignments in code
  for (const content of Object.values(files)) {
    if (!content || typeof content !== "string") continue;
    const portMatch = content.match(/(?:PORT\s*=\s*|listen\(|port:\s*)(\d{4})/i);
    if (portMatch && portMatch[1]) {
      const portNum = parseInt(portMatch[1], 10);
      if (portNum >= 1000 && portNum <= 9999) {
        return portNum;
      }
    }
  }

  // Framework default port heuristics
  switch (framework) {
    case "Next.js":
    case "React":
    case "Vue":
    case "Angular":
      return 3000;
    case "Express":
    case "NestJS":
      return 5000;
    case "FastAPI":
    case "Flask":
    case "Django":
      return 8000;
    case "Spring Boot":
      return 8080;
    case "Go":
      return 8080;
    case "Laravel":
      return 8000;
    default:
      return 8080;
  }
}

/**
 * Core Framework Detection Engine using weighted confidence rules
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

  // Defined Framework Rule Matrix
  const rules = [
    {
      name: "Next.js",
      language: "JavaScript / TypeScript",
      calculateScore: () => {
        let score = 0;
        if (tree.some((f) => f.path.startsWith("next.config."))) score += 50;
        if (pkg?.dependencies?.next || pkg?.devDependencies?.next) score += 50;
        return score;
      },
      buildCommand: "npm run build",
      startCommand: "npm run start",
    },
    {
      name: "React",
      language: "JavaScript / TypeScript",
      calculateScore: () => {
        let score = 0;
        if (pkgString.includes('"react"')) score += 40;
        if (tree.some((f) => f.path === "vite.config.js" || f.path === "vite.config.ts")) score += 30;
        if (files["package.json"]) score += 20;
        if (tree.some((f) => f.path.includes("App.jsx") || f.path.includes("App.tsx"))) score += 10;
        return score;
      },
      buildCommand: pkg?.scripts?.build || "npm run build",
      startCommand: pkg?.scripts?.preview || "npx serve -s dist",
    },
    {
      name: "NestJS",
      language: "TypeScript",
      calculateScore: () => {
        let score = 0;
        if (pkgString.includes('"@nestjs/core"')) score += 70;
        if (tree.some((f) => f.path === "nest-cli.json")) score += 30;
        return score;
      },
      buildCommand: "npm run build",
      startCommand: "npm run start:prod",
    },
    {
      name: "Vue",
      language: "JavaScript / TypeScript",
      calculateScore: () => {
        let score = 0;
        if (pkgString.includes('"vue"')) score += 60;
        if (tree.some((f) => f.path.includes("vue.config") || f.path.includes("vite.config"))) score += 40;
        return score;
      },
      buildCommand: "npm run build",
      startCommand: "npm run preview",
    },
    {
      name: "Angular",
      language: "TypeScript",
      calculateScore: () => {
        let score = 0;
        if (tree.some((f) => f.path === "angular.json")) score += 50;
        if (pkgString.includes('"@angular/core"')) score += 50;
        return score;
      },
      buildCommand: "npm run build",
      startCommand: "npm start",
    },
    {
      name: "Express",
      language: "JavaScript / Node.js",
      calculateScore: () => {
        let score = 0;
        if (pkgString.includes('"express"')) score += 60;
        if (tree.some((f) => ["server.js", "app.js", "index.js"].includes(f.path))) score += 40;
        return score;
      },
      buildCommand: pkg?.scripts?.build || "",
      startCommand: pkg?.scripts?.start || "node server.js",
    },
    {
      name: "FastAPI",
      language: "Python",
      calculateScore: () => {
        let score = 0;
        if (reqString.includes("fastapi")) score += 70;
        if (tree.some((f) => f.path === "main.py")) score += 30;
        return score;
      },
      buildCommand: "",
      startCommand: "uvicorn main:app --host 0.0.0.0 --port 8000",
    },
    {
      name: "Flask",
      language: "Python",
      calculateScore: () => {
        let score = 0;
        if (reqString.includes("flask")) score += 70;
        if (tree.some((f) => f.path === "app.py")) score += 30;
        return score;
      },
      buildCommand: "",
      startCommand: "python app.py",
    },
    {
      name: "Django",
      language: "Python",
      calculateScore: () => {
        let score = 0;
        if (tree.some((f) => f.path === "manage.py")) score += 60;
        if (reqString.includes("django")) score += 40;
        return score;
      },
      buildCommand: "python manage.py collectstatic --noinput",
      startCommand: "gunicorn app.wsgi:application --bind 0.0.0.0:8000",
    },
    {
      name: "Spring Boot",
      language: "Java",
      calculateScore: () => {
        let score = 0;
        if (tree.some((f) => f.path === "pom.xml" || f.path === "build.gradle")) score += 40;
        if (files["pom.xml"]?.includes("spring-boot") || files["build.gradle"]?.includes("spring-boot")) score += 60;
        return score;
      },
      buildCommand: "./mvnw clean package -DskipTests",
      startCommand: "java -jar target/*.jar",
    },
    {
      name: "Go",
      language: "Go",
      calculateScore: () => {
        let score = 0;
        if (tree.some((f) => f.path === "go.mod")) score += 100;
        return score;
      },
      buildCommand: "go build -o main .",
      startCommand: "./main",
    },
    {
      name: "Laravel",
      language: "PHP",
      calculateScore: () => {
        let score = 0;
        if (tree.some((f) => f.path === "artisan")) score += 60;
        if (composerString.includes("laravel/framework")) score += 40;
        return score;
      },
      buildCommand: "composer install --no-dev --optimize-autoloader",
      startCommand: "php artisan serve --host=0.0.0.0 --port=8000",
    },
  ];

  // Evaluate scores for all candidate frameworks
  let bestMatch = {
    framework: "Unknown",
    language: "Unknown",
    buildCommand: "",
    startCommand: "",
    confidence: 0,
  };

  for (const rule of rules) {
    const score = rule.calculateScore();
    if (score > bestMatch.confidence) {
      bestMatch = {
        framework: rule.name,
        language: rule.language,
        buildCommand: rule.buildCommand,
        startCommand: rule.startCommand,
        confidence: Math.min(score, 100),
      };
    }
  }

  // Fallback for general Node.js project if no framework reached high threshold
  if (bestMatch.confidence === 0 && pkg) {
    bestMatch = {
      framework: "Node.js (Generic)",
      language: "JavaScript / Node.js",
      buildCommand: pkg.scripts?.build || "",
      startCommand: pkg.scripts?.start || "node index.js",
      confidence: 50,
    };
  }

  // Additional detections
  const packageManager = detectPackageManager(tree);
  const requiredEnv = detectEnvironmentVariables(files);
  const dockerized = tree.some((f) => f.path === "Dockerfile" || f.path === "docker-compose.yml");
  const port = detectPort(tree, files, bestMatch.framework);

  return {
    ...bestMatch,
    packageManager,
    dockerized,
    existingDockerfile: dockerized ? "Dockerfile" : null,
    requiredEnv,
    port,
  };
}
