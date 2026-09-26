/**
 * Rust Production Multi-Stage Dockerfile Generator
 * Compiles a release binary and runs in minimal Alpine runtime.
 */
export function generateRustDockerfile(metadata = {}) {
  const {
    port = 8080,
    buildCommand = "cargo build --release",
    startCommand = "",
  } = metadata;
  const runtimePort = Number.isInteger(Number(port)) && Number(port) > 0 ? Number(port) : 8080;
  const binaryName = String(startCommand).split(/[\\\\/]/).pop();
  const runStart = /^[A-Za-z0-9._-]+$/.test(binaryName)
    ? `/app/bin/${binaryName}`
    : "find /app/bin -type f -executable | head -n 1 | xargs -I {} {}";

  return `FROM rust:1.77-alpine AS builder

WORKDIR /app

RUN apk add --no-cache musl-dev

COPY Cargo.toml* Cargo.lock* ./

COPY . .

RUN ${buildCommand || "cargo build --release"}

FROM alpine:3.19

WORKDIR /app

RUN apk add --no-cache ca-certificates tzdata

COPY --from=builder /app/target/release/* /app/bin/

EXPOSE ${runtimePort}

CMD ["sh", "-c", "${runStart}"]
`;
}
