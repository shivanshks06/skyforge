// Turns a failed deployment's error and logs into a plain-English explanation with a suggested fix.
// Each rule looks at the error text and the deployment log; the first match wins. A fix is something the UI can do
// in one click: retry, change a runtime setting (port, memory), switch where images are built, or open a page.

const FARGATE_MEMORY = { "0.25 vCPU": ["512 MB", "1 GB", "2 GB"], "0.5 vCPU": ["1 GB", "2 GB", "4 GB"], "1 vCPU": ["2 GB", "4 GB"], "2 vCPU": ["4 GB"] };
const MEMORY_STEPS = ["512 MB", "1 GB", "2 GB", "4 GB"];

/** The next size up that Fargate accepts, as { cpu, memory }, or null at the top. */
export function nextSize(cpu = "0.5 vCPU", memory = "1 GB") {
  const index = MEMORY_STEPS.indexOf(memory);
  for (const candidate of MEMORY_STEPS.slice(index + 1)) {
    if (FARGATE_MEMORY[cpu]?.includes(candidate)) return { cpu, memory: candidate };
    const order = Object.keys(FARGATE_MEMORY);
    const cpuForIt = order.find((key) => FARGATE_MEMORY[key].includes(candidate) && order.indexOf(key) >= order.indexOf(cpu));
    if (cpuForIt) return { cpu: cpuForIt, memory: candidate };
  }
  return null;
}

/** A port the app announced in its output ("listening on 8000", "Uvicorn running on http://0.0.0.0:8000"). */
export function announcedPort(text) {
  const patterns = [
    /running on https?:\/\/[^\s:/]+:(\d{2,5})/i,
    /listening (?:on|at)(?: port)?[^0-9\n]{0,30}(\d{2,5})/i,
    /server (?:started|running|is running) (?:on|at)(?: port)?[^0-9\n]{0,30}(\d{2,5})/i,
    /started server on [^\s:]*:(\d{2,5})/i,
    /bound to [^\s:]*:(\d{2,5})/i,
    /port[:= ]+(\d{2,5})\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const port = Number(match?.[1]);
    if (port >= 80 && port <= 65535 && ![443, 5432, 3306, 6379, 27017].includes(port)) return port;
  }
  return null;
}

const retry = { kind: "retry", label: "Try again" };
const link = (label, to) => ({ kind: "link", label, to });

const RULES = [
  {
    id: "config-changed",
    test: ({ error }) => /configuration changed after this deployment was queued/i.test(error),
    explain: () => ({
      title: "Settings changed while this deployment was waiting",
      explanation: "You changed the project's settings after pressing Deploy, so SkyForge stopped rather than deploy an outdated configuration.",
      steps: ["Deploy again: the new settings will be used."],
      fixes: [retry],
    }),
  },
  {
    id: "missing-env",
    test: ({ error }) => /Environment variable (\w+) is not configured/i.test(error),
    explain: ({ error, project }) => {
      const key = error.match(/Environment variable (\w+) is not configured/i)[1];
      return {
        title: `The app needs ${key}, which hasn't been set`,
        explanation: `Your code reads ${key} (an API key, password or address that is not stored in GitHub). SkyForge won't deploy without it because the app would crash or misbehave.`,
        steps: [`Open Environment and fill in ${key}.`, "Deploy again."],
        fixes: [link(`Add ${key}`, `/project/${project.id}/plan`)],
      };
    },
  },
  {
    id: "docker-not-running",
    test: ({ text }) => /Cannot connect to the Docker daemon|error during connect|docker_engine|Is the docker daemon running|docker: command not found|'docker' is not recognized/i.test(text),
    explain: ({ project }) => ({
      title: "Docker isn't running on this computer",
      explanation: "This project builds its container image on this machine, which needs Docker Desktop running.",
      steps: ["Start Docker Desktop and wait until it says it is running.", "Deploy again.", "Or build in AWS instead (needs CodeBuild available on your account)."],
      fixes: [retry, { kind: "buildMode", label: "Build in AWS instead", mode: "cloud" }, link("Build settings", `/project/${project.id}/deploy`)],
    }),
  },
  {
    id: "codebuild-quota",
    test: ({ text }) => /Cannot have more than 0 builds|AccountLimitExceededException.*build/i.test(text),
    explain: () => ({
      title: "AWS hasn't enabled cloud builds on your account yet",
      explanation: "New AWS accounts start with a CodeBuild limit of 0. SkyForge normally falls back to building on this computer.",
      steps: ["Build on this computer (Docker Desktop must be running).", "To use cloud builds later, ask AWS Support to raise the CodeBuild concurrent-build quota."],
      fixes: [{ kind: "buildMode", label: "Build on this computer", mode: "local" }],
    }),
  },
  {
    id: "out-of-memory",
    test: ({ text }) => /exit code:? 137|OutOfMemory|OOMKilled|JavaScript heap out of memory|MemoryError|Cannot allocate memory/i.test(text),
    explain: ({ project }) => {
      const bigger = nextSize(project.cpu || "0.5 vCPU", project.memory || "1 GB");
      return {
        title: "The app ran out of memory",
        explanation: `The container was stopped because it used more than its ${project.memory || "1 GB"} of memory.`,
        steps: bigger ? [`Give it ${bigger.memory}${bigger.cpu !== project.cpu ? ` and ${bigger.cpu}` : ""} (costs a little more per hour).`, "Deploy again."] : ["It is already at the largest size SkyForge offers; reduce the app's memory use."],
        fixes: bigger ? [{ kind: "runtime", label: `Use ${bigger.memory} and redeploy`, patch: bigger, redeploy: true }] : [],
      };
    },
  },
  {
    id: "localhost-database",
    test: ({ text }) => /ECONNREFUSED (?:127\.0\.0\.1|localhost|::1|\[::1\]):(5432|3306|27017|6379)|connect to server at "?(?:localhost|127\.0\.0\.1)"?.*(?:5432|3306)|Can't connect to (?:local )?MySQL server on '?(?:localhost|127\.0\.0\.1)/i.test(text),
    explain: ({ project }) => ({
      title: "The app is looking for a database on its own machine",
      explanation: "Its database address points at localhost, which worked on your computer but doesn't exist in AWS.",
      steps: ["Let SkyForge create a managed database, or paste the address of a hosted one (Neon, Supabase, PlanetScale...).", "Deploy again."],
      fixes: [link("Set up a database", `/project/${project.id}/plan`)],
    }),
  },
  {
    id: "port-mismatch",
    test: ({ error, text, project }) => {
      if (!/health check|did not become stable|unhealthy|Health checks failed|Target\.FailedHealthChecks|503/i.test(`${error}\n${text}`)) return false;
      const port = announcedPort(text);
      return Boolean(port && project.port && port !== Number(project.port));
    },
    explain: ({ text, project }) => {
      const port = announcedPort(text);
      return {
        title: `The app listens on port ${port}, but SkyForge sent traffic to ${project.port}`,
        explanation: `The app's own output says it is listening on ${port}. The load balancer was checking ${project.port}, found nothing there, and marked it unhealthy.`,
        steps: [`Switch the port to ${port}.`, "Deploy again."],
        fixes: [{ kind: "runtime", label: `Use port ${port} and redeploy`, patch: { port }, redeploy: true }],
      };
    },
  },
  {
    id: "health-path",
    test: ({ error, project }) => /Health check failed.*HTTP (404|401|403)/i.test(error) && project.healthCheck && project.healthCheck !== "/",
    explain: ({ project }) => ({
      title: `The health-check page ${project.healthCheck} doesn't exist`,
      explanation: `SkyForge checks ${project.healthCheck} to decide whether the app is up, but the app answered "not found" there.`,
      steps: ["Check the home page (/) instead.", "Deploy again."],
      fixes: [{ kind: "runtime", label: "Check / instead and redeploy", patch: { healthCheck: "/" }, redeploy: true }],
    }),
  },
  {
    id: "missing-module",
    test: ({ text }) => /Cannot find module '([^'.][^']*)'|ModuleNotFoundError: No module named '([^']+)'|Error: Cannot find package '([^']+)'/i.test(text),
    explain: ({ text }) => {
      const match = text.match(/Cannot find module '([^'.][^']*)'|ModuleNotFoundError: No module named '([^']+)'|Error: Cannot find package '([^']+)'/i);
      const name = match[1] || match[2] || match[3];
      const python = Boolean(match[2]);
      return {
        title: `The package "${name}" is missing`,
        explanation: `The code imports ${name}, but it isn't listed in ${python ? "requirements.txt" : "package.json dependencies"}, so it wasn't installed in the container. It probably works on your computer because it's installed there.`,
        steps: [python ? `Add ${name.split(".")[0]} to requirements.txt.` : `Run "npm install ${name.split("/").slice(0, name.startsWith("@") ? 2 : 1).join("/")}" and commit package.json.`, "Push the change, then deploy again."],
        fixes: [retry],
      };
    },
  },
  {
    id: "missing-build-script",
    test: ({ text }) => /Missing script:? "?build"?|npm ERR! missing script: build/i.test(text),
    explain: ({ project }) => ({
      title: "package.json has no build script",
      explanation: "SkyForge ran \"npm run build\", but the project doesn't define one.",
      steps: ["If the project needs no build step, clear the build command in the deployment plan.", "Otherwise add a \"build\" script to package.json and push it."],
      fixes: [link("Open deployment plan", `/project/${project.id}/plan`)],
    }),
  },
  {
    id: "tool-not-found",
    test: ({ text }) => /\b(vite|react-scripts|next|tsc|nest|ng|nuxt|webpack): (?:not found|command not found)/i.test(text),
    explain: ({ text }) => {
      const tool = text.match(/\b(vite|react-scripts|next|tsc|nest|ng|nuxt|webpack): (?:not found|command not found)/i)[1];
      return {
        title: `The build tool "${tool}" wasn't installed`,
        explanation: `${tool} is usually a dev dependency. It wasn't installed where the build ran, often because the frontend lives in a subfolder with its own package.json.`,
        steps: ["Make sure the package.json that lists " + tool + " is in the folder being built.", "Deploy again; SkyForge re-detects folder layouts on each deploy."],
        fixes: [retry],
      };
    },
  },
  {
    id: "peer-deps",
    test: ({ text }) => /npm ERR! code ERESOLVE|ERESOLVE unable to resolve dependency tree/i.test(text),
    explain: () => ({
      title: "npm couldn't agree on package versions",
      explanation: "Two packages want different versions of the same dependency. Newer npm refuses to install this by default.",
      steps: ["Add a file named .npmrc to the repository containing: legacy-peer-deps=true", "Push it, then deploy again."],
      fixes: [retry],
    }),
  },
  {
    id: "no-index-html",
    test: ({ error }) => /index\.html/i.test(error) && /static|output/i.test(error),
    explain: ({ project }) => ({
      title: "The build didn't produce a website",
      explanation: "A static site needs an index.html in its build output (usually dist/ or build/), and none was found.",
      steps: ["Check the build command really builds the site (e.g. \"npm run build\").", "If this is a server app (Express, Next.js server, an API), deploy it to ECS Fargate instead of S3."],
      fixes: [link("Change target", `/project/${project.id}/infrastructure`)],
    }),
  },
  {
    id: "no-dockerfile",
    test: ({ error }) => /requires a Dockerfile|No Dockerfile could be generated/i.test(error),
    explain: ({ project }) => ({
      title: "There's no Dockerfile to build from",
      explanation: "The project is set to use the repository's own Dockerfile, but there isn't one, and SkyForge couldn't generate one.",
      steps: ["Let SkyForge generate the Dockerfile (Docker page → Generate).", "Deploy again."],
      fixes: [link("Open Docker settings", `/project/${project.id}/docker`)],
    }),
  },
  {
    id: "permission",
    test: ({ text }) => /not authorized to perform: ([\w:*-]+)|AccessDenied(?:Exception)?|UnauthorizedOperation/i.test(text),
    explain: ({ text }) => {
      const action = text.match(/not authorized to perform: ([\w:*-]+)/i)?.[1];
      return {
        title: action ? `AWS denied the permission ${action}` : "AWS denied a permission SkyForge needs",
        explanation: "The AWS access SkyForge uses is missing a permission for this step.",
        steps: ["Open the AWS Guide → Permissions, and update the SkyForge policy in IAM with the latest template.", "Deploy again."],
        fixes: [link("Open AWS Guide", "/dashboard/aws-guide#permissions")],
      };
    },
  },
  {
    id: "fargate-quota",
    test: ({ text }) => /vCPU limit|You've reached the limit on the number of vCPUs|reached the limit.*Fargate|ServiceQuota/i.test(text),
    explain: () => ({
      title: "Your AWS account hit its Fargate limit",
      explanation: "AWS caps how much container capacity new accounts can run at once.",
      steps: ["Destroy projects you aren't using, or choose a smaller size.", "Or ask AWS Support to raise the \"Fargate On-Demand vCPU\" quota."],
      fixes: [link("Open AWS Guide", "/dashboard/aws-guide")],
    }),
  },
  {
    id: "cloudfront-unverified",
    test: ({ text }) => /CloudFront.*(?:verif|not (?:yet )?(?:enabled|available))|account.*must be verified.*CloudFront/i.test(text),
    explain: ({ project }) => ({
      title: "CloudFront isn't enabled on your AWS account yet",
      explanation: "New AWS accounts must be verified before they can create CloudFront distributions.",
      steps: ["Deploy with the ECS Fargate target (no CloudFront) for now.", "Ask AWS Support for \"Account verification for CloudFront\" to use HTTPS on a cloudfront.net address."],
      fixes: [link("Change target", `/project/${project.id}/infrastructure`)],
    }),
  },
  {
    id: "push-stalled",
    test: ({ text }) => /push.*stalled|stalled.*push|no upload progress/i.test(text),
    explain: () => ({
      title: "Uploading the image to AWS stalled",
      explanation: "The connection to AWS stopped making progress while uploading the container image. This is a network problem, not a problem with your code.",
      steps: ["Check your internet connection (VPNs and some Wi-Fi networks cause this).", "Try again: layers that already finished uploading are skipped."],
      fixes: [retry],
    }),
  },
  {
    id: "network",
    test: ({ text }) => /ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|socket hang up|forcibly closed|TLS handshake timeout|network is unreachable|i\/o timeout/i.test(text),
    explain: () => ({
      title: "The connection dropped",
      explanation: "SkyForge couldn't reach GitHub, Docker Hub or AWS for a moment. Nothing is wrong with the project.",
      steps: ["Check your internet connection.", "Try again."],
      fixes: [retry],
    }),
  },
  {
    id: "database-wait",
    test: ({ error }) => /Database .* (?:did not become available|is stopped|is still|is in state)/i.test(error),
    explain: ({ error }) => ({
      title: "The managed database isn't ready",
      explanation: error.split(/\r?\n/)[0],
      steps: ["A brand-new database can take 10-15 minutes. Wait a few minutes, then try again."],
      fixes: [retry],
    }),
  },
  {
    id: "container-crash",
    test: ({ error, text }) => /did not become stable|Essential container in task exited|CannotStartContainerError|exited with code|Health check failed/i.test(`${error}\n${text}`),
    explain: ({ project }) => ({
      title: "The app started but kept stopping",
      explanation: "AWS started the container, but it exited or never answered health checks. The reason is usually in the app's own output.",
      steps: ["Open Monitoring → Logs to see what the app printed before it stopped.", "Common causes: a missing environment variable, a wrong port, or a database it can't reach."],
      fixes: [link("Open app logs", `/project/${project.id}/monitor`), retry],
    }),
  },
];

/** The explanation for a failed deployment, or null when it didn't fail. */
export function explainFailure({ deployment, project, logs = [] }) {
  if (!deployment || !["FAILED", "DESTROY_FAILED"].includes(deployment.status)) return null;
  const error = String(deployment.error || "");
  const text = [error, ...logs.slice(-400).map((entry) => (typeof entry === "string" ? entry : entry?.message || ""))].join("\n");
  const context = { error, text, project, deployment };
  for (const rule of RULES) {
    if (rule.test(context)) return { id: rule.id, step: deployment.currentStep, ...rule.explain(context) };
  }
  return {
    id: "unknown",
    step: deployment.currentStep,
    title: `The ${String(deployment.currentStep || "deployment").toLowerCase().replaceAll("_", " ")} step failed`,
    explanation: error.split(/\r?\n/)[0].slice(0, 300) || "SkyForge didn't record a reason.",
    steps: ["Read the last red lines in the log below.", "Try again: many failures are temporary."],
    fixes: [retry],
  };
}
