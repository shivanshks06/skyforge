/**
 * Go Dockerfile generator. GOTOOLCHAIN=auto downloads whatever Go version go.mod requires,
 * and the main package is discovered when it is not at the module root (cmd/<name>, ...).
 * The runtime keeps the source tree because many Go web apps read templates/static at runtime.
 */
export function generateGoDockerfile(metadata = {}) {
  const { port = 8080 } = metadata;
  const runtimePort = Number.isInteger(Number(port)) && Number(port) > 0 ? Number(port) : 8080;

  return `FROM golang:1-bookworm AS builder

WORKDIR /app

ENV GOTOOLCHAIN=auto \\
    CGO_ENABLED=0

COPY . .

RUN if [ ! -f go.mod ]; then go mod init app && go mod tidy; fi \\
    && go mod download \\
    && if grep -qs '^package main' ./*.go; then PKG=.; \\
       else PKG="$(go list -f '{{if eq .Name "main"}}{{.ImportPath}}{{end}}' ./... | grep -v -e /test -e /example | head -n 1)"; fi \\
    && if [ -z "$PKG" ]; then echo "No Go main package was found." >&2; exit 1; fi \\
    && go build -o /out/server "$PKG"

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tzdata \\
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app /app
COPY --from=builder /out/server /usr/local/bin/server

ENV PORT=${runtimePort} \\
    GIN_MODE=release

EXPOSE ${runtimePort}

CMD ["server"]
`;
}
