export function generateSpringBootDockerfile(metadata = {}) {
  const { port = 8080, buildTool = "Maven", buildCommand = "" } = metadata;
  const runtimePort = Number.isInteger(Number(port)) && Number(port) > 0 ? Number(port) : 8080;
  const gradle = String(buildTool).toLowerCase().includes("gradle");
  const builderImage = gradle ? "gradle:8.10.2-jdk21-alpine" : "maven:3.9-eclipse-temurin-21-alpine";
  const dependencyStep = gradle
    ? "if [ -x ./gradlew ]; then chmod +x ./gradlew && ./gradlew dependencies --no-daemon || true; else gradle dependencies --no-daemon || true; fi"
    : "mvn -B dependency:go-offline";
  const jarSearch = gradle
    ? "find /app/build/libs -maxdepth 1 -type f -name '*.jar' ! -name '*-plain.jar' | head -n 1"
    : "find /app/target -maxdepth 1 -type f -name '*.jar' ! -name '*-plain.jar' | head -n 1";
  const customBuild = buildCommand && !/^\.\/(?:mvnw|gradlew)\b/.test(String(buildCommand))
    ? String(buildCommand).replace(/"/g, '\\"')
    : "";
  const effectivePackageStep = customBuild || (gradle
    ? "if [ -x ./gradlew ]; then chmod +x ./gradlew && ./gradlew build -x test --no-daemon; else gradle build -x test --no-daemon; fi"
    : "mvn -B clean package -DskipTests");

  return `FROM ${builderImage} AS builder

WORKDIR /app

COPY . .

RUN ${dependencyStep}
RUN ${effectivePackageStep}
RUN JAR_PATH="$(${jarSearch})" && test -n "$JAR_PATH" && cp "$JAR_PATH" /app/app.jar

FROM eclipse-temurin:21-jre-alpine

WORKDIR /app

COPY --from=builder /app/app.jar ./app.jar

EXPOSE ${runtimePort}

CMD ["java", "-jar", "app.jar"]
`;
}
