import { NODE_INSTALL_STEP, shellQuoteForCmd, nodeImage } from "./nodeInstall.js";

/**
 * Next.js Dockerfile generator. Keeps the whole built workspace so next.config, custom
 * servers, and runtime assets are available to `next start`.
 */
export function generateNextJsDockerfile(metadata = {}) {
  const {
    buildCommand = "npm run build",
    startCommand = "",
    port = 3000,
    nodeVersion = "22",
  } = metadata;
  const runtimePort = Number.isInteger(Number(port)) && Number(port) > 0 ? Number(port) : 3000;
  const runBuild = buildCommand || "npm run build";
  const runStart = startCommand || `npx next start -H 0.0.0.0 -p ${runtimePort}`;

  return `FROM ${nodeImage(nodeVersion)}

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1 \\
    PORT=${runtimePort} \\
    HOSTNAME=0.0.0.0

COPY . .

${NODE_INSTALL_STEP}

# A public directory is optional in Next.js projects.
RUN mkdir -p public && (${runBuild} || NODE_OPTIONS=--openssl-legacy-provider ${runBuild})

ENV NODE_ENV=production

EXPOSE ${runtimePort}

CMD ["sh", "-c", "${shellQuoteForCmd(runStart)}"]
`;
}
