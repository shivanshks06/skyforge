/**
 * Java Dockerfile generator (Spring Boot, Quarkus, Micronaut, plain Maven/Gradle web apps).
 * Prefers the repository's wrapper, skips tests, and runs the first runnable jar.
 */
export function generateSpringBootDockerfile(metadata = {}) {
  const { port = 8080, buildTool = "Maven", javaVersion = "21" } = metadata;
  const runtimePort = Number.isInteger(Number(port)) && Number(port) > 0 ? Number(port) : 8080;
  const gradle = String(buildTool).toLowerCase().includes("gradle");
  const builderImage = gradle ? `gradle:8-jdk${javaVersion}` : `maven:3-eclipse-temurin-${javaVersion}`;
  const packageStep = gradle
    ? "if [ -f ./gradlew ]; then chmod +x ./gradlew && ./gradlew build -x test --no-daemon; else gradle build -x test --no-daemon; fi"
    : "if [ -f ./mvnw ]; then chmod +x ./mvnw && ./mvnw -B package -DskipTests; else mvn -B package -DskipTests; fi";
  const jarSearch = gradle ? "build/libs" : "target";

  return `FROM ${builderImage} AS builder

WORKDIR /app

COPY . .

RUN ${packageStep}
RUN JAR_PATH="$(find /app -path '*/${jarSearch}/*.jar' ! -name '*-plain.jar' ! -name '*-sources.jar' ! -name '*-javadoc.jar' ! -name 'original-*.jar' -printf '%s %p\\n' | sort -rn | head -n 1 | cut -d' ' -f2-)" \\
    && if [ -z "$JAR_PATH" ]; then echo "The build produced no runnable jar." >&2; exit 1; fi \\
    && cp "$JAR_PATH" /app/app.jar

FROM eclipse-temurin:${javaVersion}-jre

WORKDIR /app

COPY --from=builder /app/app.jar ./app.jar

ENV PORT=${runtimePort} \\
    SERVER_PORT=${runtimePort} \\
    QUARKUS_HTTP_PORT=${runtimePort} \\
    MICRONAUT_SERVER_PORT=${runtimePort} \\
    JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75"

EXPOSE ${runtimePort}

CMD ["java", "-jar", "app.jar"]
`;
}
