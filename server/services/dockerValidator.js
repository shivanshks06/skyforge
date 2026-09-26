/**
 * Dockerfile Validation Service (Sprint 6)
 * Validates syntax, essential instructions, security best-practices, and deployment readiness.
 */

export function validateDockerfile(content) {
  if (!content || typeof content !== "string" || content.trim().length === 0) {
    return {
      isValid: false,
      checks: {
        hasFrom: false,
        hasWorkdir: false,
        hasCmd: false,
        hasExpose: false,
      },
      errors: ["Dockerfile is empty or unreadable."],
      warnings: [],
      score: 0,
      details: {
        baseImages: [],
        exposedPorts: [],
        workdir: null,
        isMultiStage: false,
      },
    };
  }

  // Remove comment lines for clean parsing
  const lines = content.split("\n");
  const instructionLines = lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  // Check 1: FROM exists (valid base image)
  const fromMatches = instructionLines.filter((l) => /^FROM\s+/i.test(l));
  const hasFrom = fromMatches.length > 0;
  const isMultiStage = fromMatches.length > 1;
  const baseImages = fromMatches.map((l) => l.replace(/^FROM\s+/i, "").split(/\s+/)[0]);
  const lastFromIndex = instructionLines.map((line) => /^FROM\s+/i.test(line) ? 1 : 0).lastIndexOf(1);
  const finalStageLines = lastFromIndex >= 0 ? instructionLines.slice(lastFromIndex) : instructionLines;

  // Check 2: WORKDIR exists (container filesystem organization)
  const workdirMatch = finalStageLines.find((l) => /^WORKDIR\s+/i.test(l));
  const hasWorkdir = Boolean(workdirMatch);
  const workdir = workdirMatch ? workdirMatch.replace(/^WORKDIR\s+/i, "").trim() : null;

  // Check 3: CMD or ENTRYPOINT exists in the final stage.
  const cmdMatch = finalStageLines.find((l) => /^(CMD|ENTRYPOINT)\s+/i.test(l));
  const hasCmd = Boolean(cmdMatch);

  // Check 4: EXPOSE exists in the final stage (container port for ECS routing).
  const exposeMatches = finalStageLines.filter((l) => /^EXPOSE\s+/i.test(l));
  const hasExpose = exposeMatches.length > 0;
  const exposedPorts = exposeMatches.map((l) => {
    const parts = l.replace(/^EXPOSE\s+/i, "").trim().split(/\s+/);
    return parseInt(parts[0], 10);
  }).filter((p) => !isNaN(p));

  const errors = [];
  const warnings = [];

  if (!hasFrom) {
    errors.push("Missing FROM instruction. A valid base image must be specified.");
  }
  if (!hasCmd) {
    errors.push("Missing CMD or ENTRYPOINT instruction. Container will exit immediately on launch.");
  }
  if (!hasWorkdir) {
    warnings.push("Missing WORKDIR instruction. Working directory defaults to root /.");
  }
  if (!hasExpose) {
    warnings.push("Missing EXPOSE instruction. Cloud load balancer might not determine target port.");
  }

  // Best practice security check
  const hasUser = instructionLines.some((l) => /^USER\s+/i.test(l));
  if (!hasUser) {
    warnings.push("Container runs as root user. Consider adding a non-root USER instruction for hardened cloud security.");
  }

  const passedChecksCount = [hasFrom, hasWorkdir, hasCmd, hasExpose].filter(Boolean).length;
  const score = Math.round((passedChecksCount / 4) * 100);

  const isValid = hasFrom && hasCmd; // Essential runnable threshold

  return {
    isValid,
    checks: {
      hasFrom,
      hasWorkdir,
      hasCmd,
      hasExpose,
    },
    passedChecksCount,
    totalChecks: 4,
    score,
    errors,
    warnings,
    details: {
      baseImages,
      exposedPorts,
      workdir,
      isMultiStage,
      hasUser,
    },
  };
}
