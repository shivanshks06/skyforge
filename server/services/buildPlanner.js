import fs from "node:fs";
import path from "node:path";

/**
 * Build Planner: decides how to containerize a repository from its checked-out source.
 *
 * Project metadata is captured from the GitHub API when a project is imported, often for a
 * different branch and from manifest files alone, so the worker re-derives everything that
 * affects the image here: where the app lives, its runtime and version, the build and start
 * commands, and the port it listens on.
 */

const SKIP_DIRS = new Set([
  ".git", ".github", "node_modules", "vendor", "target", "dist", "build", "out", ".next", ".nuxt", ".output",
  "__pycache__", ".venv", "venv", "env", ".tox", "bin", "obj", ".idea", ".vscode", "coverage", ".gradle", "tmp", "log",
]);
const ROOT_MARKERS = [
  "package.json", "requirements.txt", "pyproject.toml", "Pipfile", "manage.py", "go.mod", "Cargo.toml", "pom.xml",
  "build.gradle", "build.gradle.kts", "composer.json", "Gemfile", "index.php", "index.html", "Dockerfile",
];
const PREFERRED_DIRS = ["app", "server", "backend", "api", "web", "website", "site", "src", "frontend", "client", "www", "public", "docs"];
const SERVER_PACKAGES = ["express", "fastify", "koa", "@nestjs/core", "@hapi/hapi", "hapi", "restify", "@adonisjs/core", "hono", "@feathersjs/feathers", "sails", "loopback", "@loopback/core", "polka", "micro"];
const SPA_PACKAGES = ["react-scripts", "vite", "@angular/core", "@vue/cli-service", "vue", "svelte", "preact", "parcel", "parcel-bundler", "webpack", "@stencil/core", "solid-js", "gatsby", "@docusaurus/core", "vuepress", "vitepress", "@11ty/eleventy", "lit"];
const NODE_ENTRY_FILES = [
  "server.js", "index.js", "app.js", "main.js", "server.mjs", "index.mjs", "app.mjs",
  "src/server.js", "src/index.js", "src/app.js", "src/main.js", "server/index.js", "server/server.js", "bin/www", "api/index.js",
];
const TS_ENTRY_FILES = ["server.ts", "index.ts", "app.ts", "main.ts", "src/server.ts", "src/index.ts", "src/app.ts", "src/main.ts", "server/index.ts"];

const exists = (dir, relative) => fs.existsSync(path.join(dir, relative));

function readText(file, maxBytes = 256 * 1024) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return "";
    return fs.readFileSync(file, "utf-8");
  } catch {
    return "";
  }
}

function readJson(file) {
  try {
    return JSON.parse(readText(file));
  } catch {
    return null;
  }
}

/** Lists source files (posix relative paths), skipping dependency and build output folders. */
export function listSourceFiles(root, { maxDepth = 6, maxFiles = 6000 } = {}) {
  const files = [];
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length && files.length < maxFiles) {
    const { dir, depth } = queue.shift();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && depth < maxDepth) queue.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile()) {
        files.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  }
  return files;
}

function hasRootMarker(dir) {
  if (ROOT_MARKERS.some((marker) => exists(dir, marker))) return true;
  try {
    return fs.readdirSync(dir).some((name) => /\.(csproj|fsproj)$/.test(name));
  } catch {
    return false;
  }
}

/** Finds the directory holding the application: the repository root or the nearest folder with a project manifest. */
export function findAppRoot(sourceDir) {
  if (hasRootMarker(sourceDir)) return sourceDir;
  const queue = [{ dir: sourceDir, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (depth >= 3) continue;
    let children = [];
    try {
      children = fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith("."))
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    const rank = (name) => {
      const index = PREFERRED_DIRS.indexOf(name.toLowerCase());
      return index < 0 ? PREFERRED_DIRS.length : index;
    };
    children.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    for (const name of children) {
      if (hasRootMarker(path.join(dir, name))) return path.join(dir, name);
    }
    for (const name of children) queue.push({ dir: path.join(dir, name), depth: depth + 1 });
  }
  return sourceDir;
}

/** Scans likely entry files for a hard-coded listen port. */
function detectSourcePort(appRoot, files) {
  const candidates = files
    .filter((file) => /\.(js|mjs|cjs|ts|py|go|rs|java|kt|rb|php|cs|properties|ya?ml|toml|json)$/.test(file))
    .filter((file) => !/(^|\/)(test|tests|__tests__|spec|docs|examples?)\//i.test(file) && !/lock|\.min\./i.test(file))
    .sort((a, b) => a.split("/").length - b.split("/").length)
    .slice(0, 80);
  const patterns = [
    /server\.port\s*[=:]\s*(\d{2,5})/i,
    /\.listen\(\s*(\d{2,5})\b/,
    /PORT["']?\]?\s*(?:\|\||\?\?|,|or)\s*["']?(\d{2,5})/,
    /ListenAndServe\(\s*["'][^"':]*:(\d{2,5})["']/,
    /\.run\([^)]*port\s*=\s*(\d{2,5})/,
    /\.bind\(\s*\(?["'][^"']*:(\d{2,5})["']/,
    /\.bind\(\s*\(\s*["'][^"']*["']\s*,\s*(\d{2,5})\s*\)/,
    /(?:^|\s)port\s*[:=]\s*(\d{4,5})\b/m,
  ];
  for (const file of candidates) {
    const content = readText(path.join(appRoot, file), 128 * 1024);
    if (!content) continue;
    for (const pattern of patterns) {
      const port = Number.parseInt(content.match(pattern)?.[1] || "", 10);
      if (port >= 80 && port <= 65535 && port !== 443) return port;
    }
  }
  return null;
}

const dependencyMajor = (pkg, name) => {
  const range = pkg?.dependencies?.[name] || pkg?.devDependencies?.[name];
  return range ? Number.parseInt(String(range).match(/(\d+)/)?.[1] || "", 10) || null : null;
};

function nodeMajor(appRoot, pkg) {
  const declared = [readText(path.join(appRoot, ".nvmrc")), readText(path.join(appRoot, ".node-version")), toolVersion(appRoot, "nodejs", "node"), pkg?.engines?.node]
    .map((value) => String(value || "").trim())
    .find(Boolean) || "";
  const major = Number.parseInt(declared.match(/(\d+)/)?.[1] || "", 10);
  if (declared && major && !(/lts|latest|>=?\s*\d|\*/.test(declared) && !/^\^?~?v?\d/.test(declared))) {
    return String(Math.min(Math.max(major, 14), 24));
  }
  // Undeclared: older toolchains only build on the Node release they were written for.
  const nodeSass = dependencyMajor(pkg, "node-sass");
  if (nodeSass !== null && nodeSass <= 4) return "14";
  if ((nodeSass !== null && nodeSass <= 6) || (dependencyMajor(pkg, "gatsby") ?? 99) <= 3) return "16";
  return "22";
}

function pythonVersion(appRoot) {
  const declared = readText(path.join(appRoot, ".python-version")) || toolVersion(appRoot, "python") || readText(path.join(appRoot, "runtime.txt"))
    || (readText(path.join(appRoot, "pyproject.toml")).match(/requires-python\s*=\s*["'][^0-9]*([\d.]+)/)?.[1] ?? "");
  const [major, minor] = String(declared).match(/(\d)\.(\d+)/)?.slice(1).map(Number) || [];
  if (major !== 3 || !minor) return "3.12";
  return `3.${Math.min(Math.max(minor, 8), 13)}`;
}

function javaVersion(appRoot) {
  const build = `${readText(path.join(appRoot, "pom.xml"))}\n${readText(path.join(appRoot, "build.gradle"))}\n${readText(path.join(appRoot, "build.gradle.kts"))}`;
  const declared = Number.parseInt(
    build.match(/<(?:java\.version|maven\.compiler\.(?:release|source|target))>\s*(?:1\.)?(\d+)/)?.[1]
    || build.match(/languageVersion(?:\.set\()?\s*(?:=\s*)?JavaLanguageVersion\.of\((\d+)\)/)?.[1]
    || build.match(/sourceCompatibility\s*=\s*['"]?(?:JavaVersion\.VERSION_)?(?:1[._])?(\d+)/)?.[1]
    || "", 10);
  return String([8, 11, 17, 21].find((version) => version >= (declared || 17)) || 21);
}

function rubyVersion(appRoot) {
  const declared = readText(path.join(appRoot, ".ruby-version")) || toolVersion(appRoot, "ruby") || readText(path.join(appRoot, "Gemfile")).match(/^\s*ruby\s+["']([\d.]+)/m)?.[1] || "";
  const match = declared.match(/(\d)\.(\d)/);
  return match ? `${match[1]}.${match[2]}` : "3.3";
}

// asdf/mise pin runtimes in .tool-versions, e.g. "python 3.10.5" or "nodejs 18.17.0".
function toolVersion(appRoot, ...tools) {
  const content = readText(path.join(appRoot, ".tool-versions"));
  for (const tool of tools) {
    const match = content.match(new RegExp(`^\\s*${tool}\\s+(\\S+)`, "m"));
    if (match) return match[1];
  }
  return "";
}

function relativeModule(file) {
  return file.replace(/\.py$/, "").split("/").join(".");
}

function planNode(appRoot, files, pkg, port) {
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const has = (name) => Object.prototype.hasOwnProperty.call(deps, name);
  const scripts = pkg.scripts || {};
  const nodeVersion = nodeMajor(appRoot, pkg);
  const build = scripts.build ? "npm run build" : "";
  const isServerPackage = SERVER_PACKAGES.some(has);

  if (has("next")) {
    const config = files.filter((file) => /^next\.config\.(js|mjs|ts|cjs)$/.test(file))
      .map((file) => readText(path.join(appRoot, file)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""))
      .join("\n");
    if (/output\s*:\s*["']export["']/.test(config)) {
      return { framework: "Next.js Static Export (SPA)", language: "JavaScript", buildCommand: build || "npx next build", port: 80, nodeVersion };
    }
    const start = scripts.start && !/next\s+start/.test(scripts.start) ? "npm start" : "";
    return { framework: "Next.js", language: "JavaScript", buildCommand: build || "npx next build", startCommand: start, port: port || 3000, nodeVersion };
  }
  if (has("nuxt") || has("nuxt3")) {
    return { framework: "Nuxt (Node)", language: "JavaScript", buildCommand: build || "npx nuxi build", startCommand: "node .output/server/index.mjs", port: port || 3000, nodeVersion };
  }
  if (has("@remix-run/serve") || has("@remix-run/node") || has("@react-router/serve")) {
    return { framework: "Remix (Node)", language: "JavaScript", buildCommand: build, startCommand: scripts.start ? "npm start" : "npx remix-serve build/index.js", port: port || 3000, nodeVersion };
  }
  if (has("@sveltejs/kit")) {
    if (has("@sveltejs/adapter-node")) return { framework: "SvelteKit (Node)", language: "JavaScript", buildCommand: build, startCommand: "node build", port: port || 3000, nodeVersion };
    if (has("@sveltejs/adapter-static")) return { framework: "SvelteKit Static (SPA)", language: "JavaScript", buildCommand: build, port: 80, nodeVersion };
    return { framework: "SvelteKit (Node)", language: "JavaScript", buildCommand: build, startCommand: `npm run preview -- --host 0.0.0.0 --port ${port || 4173}`, port: port || 4173, nodeVersion };
  }
  if (has("astro")) {
    if (has("@astrojs/node")) return { framework: "Astro (Node)", language: "JavaScript", buildCommand: build, startCommand: "node ./dist/server/entry.mjs", port: port || 4321, nodeVersion };
    return { framework: "Astro Static (SPA)", language: "JavaScript", buildCommand: build || "npx astro build", port: 80, nodeVersion };
  }

  const startScript = scripts.start || "";
  const startIsDevServer = /(react-scripts|vite|ng|vue-cli-service|parcel|webpack(-dev-server)?|gatsby|docusaurus|live-server|http-server|serve)\b(?!.*node )/.test(startScript)
    && !/\bnode\b|ts-node|tsx\b|nodemon/.test(startScript);
  if (!isServerPackage && build && (SPA_PACKAGES.some(has) || startIsDevServer || !startScript)) {
    // Build scripts often chain a type-check ("tsc && vite build"); if only that step fails, the
    // bundler alone can still produce a working site.
    const bundlerBuild = has("vite") ? "npx vite build" : has("react-scripts") ? "CI=false npx react-scripts build" : "";
    return { framework: "Frontend SPA", language: "JavaScript", buildCommand: build, fallbackBuildCommand: bundlerBuild, port: 80, nodeVersion };
  }

  let startCommand = "";
  if (scripts["start:prod"]) startCommand = "npm run start:prod";
  else if (startScript && !startIsDevServer) startCommand = "npm start";
  else if (scripts.serve && !/vue-cli-service|vite/.test(scripts.serve)) startCommand = "npm run serve";
  else if (pkg.main && exists(appRoot, pkg.main)) startCommand = `node ${pkg.main}`;
  else {
    const entry = NODE_ENTRY_FILES.find((file) => exists(appRoot, file));
    const tsEntry = TS_ENTRY_FILES.find((file) => exists(appRoot, file));
    if (entry) startCommand = `node ${entry}`;
    else if (tsEntry) startCommand = `npx --yes tsx ${tsEntry}`;
    else if (scripts.dev) startCommand = "npm run dev";
  }
  if (!startCommand) {
    if (files.some((file) => /(^|\/)index\.html$/.test(file))) return null; // plain static site that ships a package.json
    startCommand = "npm start";
  }
  const framework = has("@nestjs/core") ? "NestJS" : has("express") ? "Express" : has("fastify") ? "Fastify" : "Node.js";
  return { framework, language: "JavaScript", buildCommand: build, startCommand, port: port || 3000, nodeVersion };
}

function planPython(appRoot, files, port) {
  const pyFiles = files.filter((file) => file.endsWith(".py") && file.split("/").length <= 3 && !/(^|\/)(tests?|migrations|docs)\//.test(file));
  const version = pythonVersion(appRoot);
  const manage = files.find((file) => /(^|\/)manage\.py$/.test(file) && file.split("/").length <= 2);
  if (manage) {
    const baseDir = path.posix.dirname(manage);
    const wsgi = files.find((file) => file.endsWith("/wsgi.py") && path.posix.dirname(path.posix.dirname(file)) === baseDir)
      || files.find((file) => file.endsWith("/wsgi.py"));
    const cd = baseDir === "." ? "" : `cd ${baseDir} && `;
    const module = wsgi ? relativeModule(path.posix.relative(baseDir, wsgi)) : "";
    const runPort = port || 8000;
    const startCommand = module
      ? `${cd}python manage.py migrate --noinput || true; python manage.py collectstatic --noinput >/dev/null 2>&1 || true; exec gunicorn ${module}:application --bind 0.0.0.0:${runPort} --workers 2 --timeout 120`
      : "";
    return { framework: "Django", language: "Python", startCommand, port: runPort, pythonVersion: version };
  }

  const sources = pyFiles.map((file) => ({ file, content: readText(path.join(appRoot, file), 128 * 1024) }));
  const find = (regex) => sources.map(({ file, content }) => ({ file, match: content.match(regex) })).find(({ match }) => match);
  const launch = (file, command) => {
    const dir = path.posix.dirname(file);
    return dir === "." ? command : `cd ${dir} && ${command}`;
  };
  const moduleName = (file) => path.posix.basename(file, ".py");

  const streamlit = find(/^\s*import streamlit|^\s*from streamlit/m);
  if (streamlit) {
    const runPort = port || 8501;
    return { framework: "Streamlit", language: "Python", startCommand: launch(streamlit.file, `exec streamlit run ${path.posix.basename(streamlit.file)} --server.port ${runPort} --server.address 0.0.0.0 --server.headless true`), port: runPort, pythonVersion: version };
  }
  const fastapi = find(/^(\w+)\s*(?::\s*\w+\s*)?=\s*(?:fastapi\.)?FastAPI\(/m);
  if (fastapi) {
    const runPort = port || 8000;
    return { framework: "FastAPI", language: "Python", startCommand: launch(fastapi.file, `exec uvicorn ${moduleName(fastapi.file)}:${fastapi.match[1]} --host 0.0.0.0 --port ${runPort}`), port: runPort, pythonVersion: version };
  }
  const flask = find(/^(\w+)\s*=\s*(?:flask\.)?Flask\(/m);
  const factory = find(/^def (create_app)\(/m);
  if (flask || factory) {
    const runPort = port || 5000;
    const target = flask ? `${moduleName(flask.file)}:${flask.match[1]}` : `'${moduleName(factory.file)}:create_app()'`;
    return { framework: "Flask", language: "Python", startCommand: launch((flask || factory).file, `exec gunicorn --bind 0.0.0.0:${runPort} --workers 2 --timeout 120 ${target}`), port: runPort, pythonVersion: version };
  }
  const gradio = find(/^\s*import gradio|^\s*from gradio/m);
  if (gradio) {
    const runPort = port || 7860;
    return { framework: "Gradio", language: "Python", startCommand: launch(gradio.file, `GRADIO_SERVER_NAME=0.0.0.0 GRADIO_SERVER_PORT=${runPort} exec python ${path.posix.basename(gradio.file)}`), port: runPort, pythonVersion: version };
  }
  const entry = ["main.py", "app.py", "server.py", "run.py", "wsgi.py", "application.py"].find((file) => files.includes(file));
  return { framework: "Python", language: "Python", startCommand: entry ? `exec python ${entry}` : "", port: port || 8000, pythonVersion: version };
}

function staticRootFor(appRoot, files) {
  const candidates = [".", "public", "docs", "site", "www", "html", "src", "dist", "build"];
  const found = candidates.find((dir) => files.includes(dir === "." ? "index.html" : `${dir}/index.html`));
  if (found) return found;
  const nested = files.filter((file) => file.endsWith("/index.html")).sort((a, b) => a.split("/").length - b.split("/").length)[0];
  return nested ? path.posix.dirname(nested) : null;
}

function exposedPort(dockerfile) {
  const ports = [...readText(dockerfile).matchAll(/^\s*EXPOSE\s+(\d+)/gim)].map((match) => Number.parseInt(match[1], 10));
  return ports.at(-1) || null;
}

/**
 * Returns { appRoot, relativeRoot, strategy: "generated" | "repository", metadata, port, summary }.
 * `metadata` is a project-shaped object for generateDockerfile; `strategy: "repository"` means
 * the repository's own Dockerfile is the only viable build.
 */
export function planBuild(sourceDir) {
  const appRoot = findAppRoot(sourceDir);
  const relativeRoot = path.relative(sourceDir, appRoot).split(path.sep).join("/") || ".";
  const files = listSourceFiles(appRoot);
  const fileSet = new Set(files);
  const sourcePort = detectSourcePort(appRoot, files);
  const repositoryDockerfile = fileSet.has("Dockerfile") ? path.join(appRoot, "Dockerfile") : null;
  const finish = (metadata, extra = {}) => ({
    appRoot,
    relativeRoot,
    strategy: "generated",
    metadata,
    port: Number(metadata.port) || 80,
    repositoryDockerfile,
    summary: `${metadata.framework}${metadata.startCommand ? ` (start: ${metadata.startCommand.replace(/^.*exec /, "")})` : ""} on port ${metadata.port}${relativeRoot !== "." ? ` in ${relativeRoot}/` : ""}`,
    ...extra,
  });

  const pkg = fileSet.has("package.json") ? readJson(path.join(appRoot, "package.json")) : null;
  const isPython = ["requirements.txt", "pyproject.toml", "Pipfile", "manage.py", "setup.py"].some((file) => fileSet.has(file))
    || (files.some((file) => file.endsWith(".py") && !file.includes("/")) && !pkg);

  if (fileSet.has("manage.py")) return finish(planPython(appRoot, files, sourcePort));
  if (pkg && !fileSet.has("go.mod") && !fileSet.has("Cargo.toml") && !fileSet.has("composer.json") && !fileSet.has("Gemfile")) {
    const node = planNode(appRoot, files, pkg, sourcePort);
    if (node) return finish(node);
  }
  if (isPython) return finish(planPython(appRoot, files, sourcePort));
  if (fileSet.has("go.mod") || files.some((file) => file.endsWith(".go") && !file.includes("/"))) {
    return finish({ framework: "Go", language: "Go", port: sourcePort || 8080 });
  }
  if (fileSet.has("Cargo.toml")) {
    const cargo = readText(path.join(appRoot, "Cargo.toml"));
    const binaryName = cargo.match(/\[\[bin\]\][^[]*?name\s*=\s*["']([^"']+)/)?.[1] || cargo.match(/\[package\][^[]*?name\s*=\s*["']([^"']+)/)?.[1] || "";
    return finish({ framework: "Rust", language: "Rust", port: sourcePort || 8080, binaryName });
  }
  if (["pom.xml", "build.gradle", "build.gradle.kts"].some((file) => fileSet.has(file))) {
    const gradle = !fileSet.has("pom.xml");
    return finish({ framework: "Spring Boot", language: "Java", buildTool: gradle ? "Gradle" : "Maven", port: sourcePort || 8080, javaVersion: javaVersion(appRoot) });
  }
  if (fileSet.has("composer.json") || files.some((file) => file.endsWith(".php") && file.split("/").length <= 2)) {
    const docRoot = fileSet.has("public/index.php") || fileSet.has("artisan") ? "public" : (fileSet.has("index.php") || fileSet.has("index.html") ? "." : path.posix.dirname(files.find((file) => file.endsWith("index.php")) || "index.php"));
    return finish({ framework: fileSet.has("artisan") ? "Laravel" : "PHP", language: "PHP", port: 8080, docRoot });
  }
  const gemfileText = fileSet.has("Gemfile") ? readText(path.join(appRoot, "Gemfile")) : "";
  if (fileSet.has("_config.yml") && (/jekyll|github-pages/.test(gemfileText) || files.some((file) => /^_(layouts|posts|includes)\//.test(file)))) {
    return finish({ framework: "Jekyll", language: "Ruby", port: 80, rubyVersion: rubyVersion(appRoot) });
  }
  if (fileSet.has("Gemfile")) {
    const gemfile = gemfileText;
    const rails = fileSet.has("config/application.rb") || /gem\s+["']rails["']/.test(gemfile);
    const runPort = sourcePort || (rails ? 3000 : 4567);
    let startCommand = "";
    if (!rails && !fileSet.has("config.ru")) {
      const entry = ["app.rb", "main.rb", "server.rb"].find((file) => fileSet.has(file));
      if (entry) startCommand = `exec bundle exec ruby ${entry} -o 0.0.0.0 -p ${runPort}`;
    }
    return finish({ framework: rails ? "Rails" : "Ruby", language: "Ruby", port: runPort, startCommand, rubyVersion: rubyVersion(appRoot) });
  }
  const projectFile = files.filter((file) => /\.(csproj|fsproj)$/.test(file) && !/test/i.test(file))
    .sort((a, b) => Number(/Sdk\s*=\s*"Microsoft\.NET\.Sdk\.Web"/.test(readText(path.join(appRoot, b)))) - Number(/Sdk\s*=\s*"Microsoft\.NET\.Sdk\.Web"/.test(readText(path.join(appRoot, a)))) || a.split("/").length - b.split("/").length)[0];
  if (projectFile) {
    const target = readText(path.join(appRoot, projectFile)).match(/<TargetFrameworks?>\s*net(?:coreapp)?(\d+\.\d+)/)?.[1] || "8.0";
    return finish({ framework: "ASP.NET Core", language: "C#", port: sourcePort || 8080, projectFile, dotnetVersion: target });
  }
  const staticRoot = staticRootFor(appRoot, files);
  if (staticRoot) return finish({ framework: "Static HTML", language: "HTML", port: 80, staticRoot });
  if (repositoryDockerfile) {
    const port = exposedPort(repositoryDockerfile) || sourcePort || 8080;
    return { appRoot, relativeRoot, strategy: "repository", metadata: null, port, repositoryDockerfile, summary: `repository Dockerfile on port ${port}` };
  }
  throw new Error("No deployable web application was found: the repository has no recognizable app (Node, Python, Go, Rust, Java, PHP, Ruby, .NET), no index.html, and no Dockerfile.");
}

export { exposedPort };
