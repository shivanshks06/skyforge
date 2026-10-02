import { NODE_INSTALL_STEP, shellQuoteForCmd, nodeImage } from "./nodeInstall.js";

/**
 * Node.js server Dockerfile generator (Express, Fastify, Koa, NestJS, Nuxt, SvelteKit, plain Node).
 * Installs with lockfile fallbacks, runs the build script when present, and starts the
 * detected entry point with PORT/HOST set so the app listens where the load balancer expects.
 */
export function generateExpressDockerfile(metadata = {}) {
  const {
    buildCommand,
    startCommand = "npm start",
    port = 3000,
    nodeVersion = "22",
  } = metadata;
  const runtimePort = Number.isInteger(Number(port)) && Number(port) > 0 ? Number(port) : 3000;
  const buildStep = buildCommand
    ? `\nRUN ${buildCommand} || NODE_OPTIONS=--openssl-legacy-provider ${buildCommand}\n`
    : "";

  return `FROM ${nodeImage(nodeVersion)}

WORKDIR /app

ENV PORT=${runtimePort} \\
    HOST=0.0.0.0 \\
    HOSTNAME=0.0.0.0

COPY . .

${NODE_INSTALL_STEP}
${buildStep}
ENV NODE_ENV=production

EXPOSE ${runtimePort}

CMD ["sh", "-c", "${shellQuoteForCmd(startCommand || "npm start")}"]
`;
}
