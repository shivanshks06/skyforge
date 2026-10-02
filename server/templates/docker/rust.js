/**
 * Rust Dockerfile generator. Builds on Debian (glibc) because crates such as openssl-sys fail on
 * musl, then runs the package's binary next to the source tree for runtime assets.
 */
export function generateRustDockerfile(metadata = {}) {
  const { port = 8080, binaryName = "" } = metadata;
  const runtimePort = Number.isInteger(Number(port)) && Number(port) > 0 ? Number(port) : 8080;
  const preferred = /^[A-Za-z0-9_-]+$/.test(binaryName) ? binaryName : "";

  return `FROM rust:1-bookworm AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev \\
    && rm -rf /var/lib/apt/lists/*

COPY . .

RUN cargo build --release \\
    && BIN="${preferred ? `target/release/${preferred}` : ""}" \\
    && if [ -z "$BIN" ] || [ ! -x "$BIN" ]; then \\
         BIN="$(find target/release -maxdepth 1 -type f -perm -u+x ! -name '*.so' ! -name '*.d' | head -n 1)"; \\
       fi \\
    && if [ -z "$BIN" ]; then echo "cargo build produced no executable binary." >&2; exit 1; fi \\
    && cp "$BIN" /usr/local/bin/app-server

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 tzdata \\
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app /app
COPY --from=builder /usr/local/bin/app-server /usr/local/bin/app-server
RUN rm -rf /app/target

ENV PORT=${runtimePort} \\
    HOST=0.0.0.0 \\
    ROCKET_ADDRESS=0.0.0.0 \\
    ROCKET_PORT=${runtimePort}

EXPOSE ${runtimePort}

CMD ["app-server"]
`;
}
