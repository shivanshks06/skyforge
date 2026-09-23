/**
 * Deployment Planner (AI / Rule-based Hybrid Engine)
 * Generates Dockerfile specifications and infrastructure configuration based on detection results.
 */

export async function generateDeploymentPlan(detectionResult) {
  const { framework, language, buildCommand, startCommand, packageManager, port, dockerized } = detectionResult;

  if (dockerized) {
    return {
      source: "Existing Dockerfile",
      recommendedAction: "Use existing Dockerfile found in repository root.",
      dockerfile: "# Using existing Dockerfile from repository",
      port,
      environmentConfig: detectionResult.requiredEnv,
    };
  }

  let generatedDockerfile = "";

  if (framework === "React" || framework === "Vue") {
    generatedDockerfile = `FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN ${packageManager} install
COPY . .
RUN ${buildCommand || "npm run build"}

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE ${port}
CMD ["nginx", "-g", "daemon off;"]`;
  } else if (framework === "Next.js") {
    generatedDockerfile = `FROM node:18-alpine AS runner
WORKDIR /app
COPY package*.json ./
RUN ${packageManager} install
COPY . .
RUN ${buildCommand || "npm run build"}
EXPOSE ${port}
ENV PORT ${port}
CMD ["${startCommand || "npm run start"}"]`;
  } else if (framework === "FastAPI" || framework === "Flask") {
    generatedDockerfile = `FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE ${port}
CMD [${startCommand.split(" ").map(s => `"${s}"`).join(", ")}]`;
  } else if (framework === "Go") {
    generatedDockerfile = `FROM golang:1.21-alpine AS builder
WORKDIR /app
COPY go.mod ./
RUN go mod download
COPY . .
RUN ${buildCommand || "go build -o main ."}

FROM alpine:latest
WORKDIR /root/
COPY --from=builder /app/main .
EXPOSE ${port}
CMD ["./main"]`;
  } else {
    // Default Node.js / Express fallback Dockerfile generator
    generatedDockerfile = `FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN ${packageManager} install --production
COPY . .
EXPOSE ${port}
CMD ["${startCommand || "node server.js"}"]`;
  }

  return {
    source: "AI / Automated Generation",
    recommendedAction: `Automated container spec generated for ${framework} (${language})`,
    dockerfile: generatedDockerfile,
    port,
    environmentConfig: detectionResult.requiredEnv,
  };
}
