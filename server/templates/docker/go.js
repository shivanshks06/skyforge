export function generateGoDockerfile(metadata = {}) {
  const {
    port = 8080,
    buildCommand = "CGO_ENABLED=0 go build -o server .",
  } = metadata;
  const runtimePort = Number.isInteger(Number(port)) && Number(port) > 0 ? Number(port) : 8080;
  const runBuild = String(buildCommand || "CGO_ENABLED=0 go build -o server .").replace(/"/g, '\\"');
  const outputMatch = runBuild.match(/(?:^|\s)-o\s+([A-Za-z0-9_./-]+)/);
  const declaredOutput = outputMatch?.[1] || "server";
  const outputPath = declaredOutput.startsWith("/") ? declaredOutput : `/app/${declaredOutput.replace(/^\.\//, "")}`;

  return `FROM golang:1.22-alpine AS builder

WORKDIR /app

RUN apk add --no-cache git ca-certificates

COPY go.mod* go.sum* ./

RUN if [ -f go.mod ]; then go mod download; fi

COPY . .

RUN ${runBuild} && if [ ! -f "${outputPath}" ]; then echo "Expected Go binary ${outputPath} was not produced" >&2; exit 1; fi && cp "${outputPath}" /app/server

FROM alpine:3.19

WORKDIR /app

RUN apk add --no-cache ca-certificates tzdata

COPY --from=builder /app/server ./server

EXPOSE ${runtimePort}

CMD ["./server"]
`;
}
