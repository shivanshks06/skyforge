import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

/**
 * Checks if the extracted workspace is a microservices / multi-service application.
 */
export function isMultiServiceProject(sourceDir) {
  const discovered = detectServices(sourceDir);
  return discovered.length >= 2;
}

/**
 * Discovers sub-services and their configurations.
 */
export function detectServices(sourceDir) {
  const discovered = [];
  const servicesDir = path.join(sourceDir, "services");
  if (fs.existsSync(servicesDir) && fs.statSync(servicesDir).isDirectory()) {
    const entries = fs.readdirSync(servicesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subDir = path.join(servicesDir, entry.name);
      const name = entry.name.toLowerCase();
      const hasPackage = fs.existsSync(path.join(subDir, "package.json"));
      const hasServer = ["server.js", "index.js", "app.js", "main.js"].some((f) => fs.existsSync(path.join(subDir, f)));
      const hasHtml = fs.existsSync(path.join(subDir, "index.html"));

      let port = 3000;
      if (name.includes("auth")) port = 4000;
      else if (name.includes("product")) port = 4001;
      else if (name.includes("order")) port = 4002;
      else if (name.includes("payment") || name.includes("pay")) port = 4003;
      else if (name.includes("frontend") || name.includes("client") || name.includes("web") || name.includes("ui")) port = 80;

      if (hasServer) {
        try {
          const content = fs.readFileSync(path.join(subDir, "server.js"), "utf-8");
          const match = content.match(/\.listen\(\s*(\d{4,5})\b/);
          if (match) port = Number.parseInt(match[1], 10);
        } catch {}
      }

      discovered.push({
        name: entry.name,
        relPath: path.join("services", entry.name).replace(/\\/g, "/"),
        hasPackage,
        hasServer,
        hasHtml,
        port,
        isFrontend: hasHtml && !hasServer,
      });
    }
  }
  return discovered;
}

/**
 * Generates the unified reverse-proxy gateway script.
 */
export function generateGatewayScript(services = [], gatewayPort = 80) {
  return `import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number.parseInt(process.env.PORT || "${gatewayPort}", 10);

// Route mappings: path prefix -> local port
const serviceRoutes = [
  { prefix: "/auth", port: 4000 },
  { prefix: "/products", port: 4001 },
  { prefix: "/order", port: 4002 },
  { prefix: "/payment", port: 4003 },
  { prefix: "/pay", port: 4003 },
];

const discoveredServices = ${JSON.stringify(services, null, 2)};
for (const svc of discoveredServices) {
  if (!svc.isFrontend && svc.hasServer && svc.port !== PORT) {
    const routePrefix = "/" + svc.name.replace(/-service$/i, "");
    if (!serviceRoutes.some((r) => r.prefix === routePrefix)) {
      serviceRoutes.push({ prefix: routePrefix, port: svc.port });
    }
  }
}

// Inter-service DNS interception so microservices can call each other by service name
const defaultLookup = dns.lookup;
const localHostnames = new Set([
  "product", "product-service",
  "auth", "auth-service",
  "order", "order-service",
  "payment", "payment-service",
  "frontend", "frontend-service",
  "localhost"
]);

dns.lookup = (hostname, options, callback) => {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  if (localHostnames.has(String(hostname).toLowerCase())) {
    if (options && options.all) {
      return callback(null, [{ address: "127.0.0.1", family: 4 }]);
    }
    return callback(null, "127.0.0.1", 4);
  }
  return defaultLookup(hostname, options, callback);
};

// Spawn each discovered backend service process
for (const svc of discoveredServices) {
  if (svc.hasServer) {
    const cwd = path.resolve(__dirname, svc.relPath);
    const startFile = ["server.js", "index.js", "app.js", "main.js"].find((f) => fs.existsSync(path.join(cwd, f))) || "server.js";
    console.log(\`[GATEWAY] Starting \${svc.name} on port \${svc.port} (node \${startFile})...\`);
    const proc = spawn("node", ["-r", path.join(__dirname, "skyforge-dns.cjs"), startFile], {
      cwd,
      env: { ...process.env, PORT: String(svc.port) },
      stdio: "pipe",
    });
    proc.stdout.on("data", (data) => console.log(\`[\${svc.name}] \${data.toString().trim()}\`));
    proc.stderr.on("data", (data) => console.error(\`[\${svc.name} ERROR] \${data.toString().trim()}\`));
    proc.on("exit", (code) => console.warn(\`[\${svc.name}] Process exited with code \${code}\`));
  }
}

// Find frontend directory
const frontendDir = (() => {
  const candidates = [
    path.join(__dirname, "services/frontend"),
    path.join(__dirname, "frontend"),
    path.join(__dirname, "client"),
    path.join(__dirname, "public"),
  ];
  return candidates.find((dir) => fs.existsSync(dir) && fs.existsSync(path.join(dir, "index.html"))) || null;
})();

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  // Health probe endpoint
  if (pathname === "/health" || pathname === "/_health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "healthy", timestamp: new Date().toISOString() }));
  }

  // Check API route prefixes
  const targetRoute = serviceRoutes.find((r) => pathname === r.prefix || pathname.startsWith(r.prefix + "/"));
  if (targetRoute) {
    let forwardedPath = req.url;
    if (targetRoute.prefix === "/order" && (pathname === "/order" || pathname === "/order/")) {
      forwardedPath = "/" + (url.search || "");
    } else if (targetRoute.prefix === "/payment" && (pathname === "/payment" || pathname === "/payment/")) {
      forwardedPath = "/pay" + (url.search || "");
    }
    const proxyReq = http.request({
      hostname: "127.0.0.1",
      port: targetRoute.port,
      path: forwardedPath,
      method: req.method,
      headers: { ...req.headers, host: \`127.0.0.1:\${targetRoute.port}\` },
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    });

    proxyReq.on("error", (err) => {
      console.error(\`[PROXY ERROR] \${req.method} \${pathname} -> : \${targetRoute.port} failed: \${err.message}\`);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Service unavailable", details: err.message }));
    });

    return req.pipe(proxyReq, { end: true });
  }

  // Static frontend serving
  if (frontendDir) {
    let filePath = path.join(frontendDir, pathname === "/" ? "index.html" : pathname);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      filePath = path.join(frontendDir, "index.html");
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "text/plain" });
      return fs.createReadStream(filePath).pipe(res);
    }
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(\`[SKYFORGE GATEWAY] Unified reverse proxy listening on port \${PORT}\`);
});
`;
}

/**
 * Preload script for inter-service DNS mapping.
 */
export function generateDnsPreloadScript() {
  return `const dns = require('node:dns');
const defaultLookup = dns.lookup;
const localHosts = new Set([
  'product', 'product-service',
  'auth', 'auth-service',
  'order', 'order-service',
  'payment', 'payment-service',
  'frontend', 'frontend-service',
  'localhost'
]);

dns.lookup = (hostname, options, callback) => {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (localHosts.has(String(hostname).toLowerCase())) {
    if (options && options.all) {
      return callback(null, [{ address: '127.0.0.1', family: 4 }]);
    }
    return callback(null, '127.0.0.1', 4);
  }
  return defaultLookup(hostname, options, callback);
};
`;
}

/**
 * Generates multi-service container Dockerfile.
 */
export function generateMultiServiceDockerfile(port = 80) {
  return `FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache curl bash

COPY . .

RUN for dir in services/*/ apps/*/ ; do \\
      if [ -f "$dir/package.json" ]; then \\
        echo "Installing dependencies in $dir..." && \\
        (cd "$dir" && npm install --no-audit --no-fund) ; \\
      fi ; \\
    done

EXPOSE ${port}

CMD ["node", "skyforge-gateway.mjs"]
`;
}

/**
 * Sets up workspace with gateway and dns files.
 */
export async function setupMultiServiceWorkspace(sourceDir, port = 80) {
  const services = detectServices(sourceDir);
  const gatewayContent = generateGatewayScript(services, port);
  const dnsContent = generateDnsPreloadScript();
  const dockerfileContent = generateMultiServiceDockerfile(port);

  await fsPromises.writeFile(path.join(sourceDir, "skyforge-gateway.mjs"), gatewayContent, "utf-8");
  await fsPromises.writeFile(path.join(sourceDir, "skyforge-dns.cjs"), dnsContent, "utf-8");
  await fsPromises.writeFile(path.join(sourceDir, "Dockerfile.multiservice"), dockerfileContent, "utf-8");

  return { services, port };
}
