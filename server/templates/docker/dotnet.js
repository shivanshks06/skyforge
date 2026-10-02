/**
 * .NET Dockerfile generator (ASP.NET Core, minimal APIs, Blazor Server).
 * Publishes the detected project with the SDK matching its TargetFramework.
 */
export function generateDotnetDockerfile(metadata = {}) {
  const { port = 8080, projectFile = "", dotnetVersion = "8.0" } = metadata;
  const runtimePort = Number.isInteger(Number(port)) && Number(port) > 0 ? Number(port) : 8080;
  const target = /^[A-Za-z0-9_./ -]+\.csproj$/.test(projectFile) ? `"${projectFile}"` : "";

  return `FROM mcr.microsoft.com/dotnet/sdk:${dotnetVersion} AS builder

WORKDIR /src

COPY . .

RUN dotnet publish ${target} -c Release -o /out

FROM mcr.microsoft.com/dotnet/aspnet:${dotnetVersion}

WORKDIR /app

COPY --from=builder /out ./

ENV ASPNETCORE_URLS=http://0.0.0.0:${runtimePort} \\
    ASPNETCORE_ENVIRONMENT=Production \\
    PORT=${runtimePort}

EXPOSE ${runtimePort}

# Run the published entry assembly (the one with a runtimeconfig.json).
CMD ["sh", "-c", "exec dotnet \\"$(basename \\"$(ls *.runtimeconfig.json | head -n 1)\\" .runtimeconfig.json).dll\\""]
`;
}
