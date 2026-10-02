import { GoogleGenAI } from "@google/genai";

const CPU_VALUES = new Set(["0.25 vCPU", "0.5 vCPU", "1 vCPU", "2 vCPU"]);
const MEMORY_VALUES = new Set(["512 MB", "1 GB", "2 GB", "4 GB"]);
const FARGATE_MEMORY_BY_CPU = {
  "0.25 vCPU": ["512 MB"],
  "0.5 vCPU": ["1 GB"],
  "1 vCPU": ["2 GB"],
  "2 vCPU": ["4 GB"],
};

function isStaticFrontend(framework) {
  const value = String(framework || "").toLowerCase();
  return value.includes("react")
    || value.includes("vue")
    || value.includes("angular")
    || (value.includes("svelte") && !value.includes("kit"))
    || value.includes("static html")
    || value === "static"
    || value === "html";
}

export function normalizePlan(plan, metadata = {}) {
  const targetValue = String(plan.deploymentTarget || "").toUpperCase();
  const deploymentTarget = targetValue.includes("ECS") || targetValue.includes("FARGATE")
    ? "AWS_ECS_FARGATE"
    : "AWS_ECS_FARGATE";
  const cpu = CPU_VALUES.has(plan.cpu) ? plan.cpu : "0.5 vCPU";
  const compatibleMemory = FARGATE_MEMORY_BY_CPU[cpu] || FARGATE_MEMORY_BY_CPU["0.5 vCPU"];
  const memory = MEMORY_VALUES.has(plan.memory) && compatibleMemory.includes(plan.memory)
    ? plan.memory
    : compatibleMemory[0];
  const healthCheck = typeof plan.healthCheck === "string" && /^\/[A-Za-z0-9/_-]*$/.test(plan.healthCheck) ? plan.healthCheck : "/";
  return {
    ...plan,
    deploymentTarget,
    cpu,
    memory,
    healthCheck,
    dockerStrategy: metadata.dockerized ? "EXISTING" : "GENERATE",
  };
}

/**
 * AI Deployment Planner Engine (Sprint 5)
 * Uses Gemini to generate structured infrastructure decisions, with a deterministic
 * fallback whenever the optional AI integration is unavailable.
 */

export const AI_MODEL = process.env.GEMINI_MODEL?.trim() || "gemini-flash-lite-latest";

export async function generateAiDeploymentPlan(metadata) {
  const {
    framework = "Generic",
    language = "JavaScript",
    packageManager = "npm",
    buildCommand = "",
    startCommand = "",
    port = 80,
    dockerized = false,
    requiredEnv = [],
  } = metadata;

  // Senior DevOps System Prompt
  const prompt = `You are a senior DevOps engineer and cloud architect.
Analyze this repository metadata and output structured infrastructure decisions for AWS deployment.

Repository Metadata:
Framework: ${framework}
Language: ${language}
Package Manager: ${packageManager}
Build Command: ${buildCommand || "None"}
Start Command: ${startCommand || "Default"}
Port: ${port}
Docker Exists: ${Boolean(dockerized)}
Required Environment Variables: ${Array.isArray(requiredEnv) ? requiredEnv.join(", ") : "None"}

Return ONLY valid JSON matching this schema exactly:
{
  "deploymentTarget": "AWS_ECS_FARGATE",
  "cpu": "0.5 vCPU",
  "memory": "1 GB",
  "healthCheck": "/",
  "dockerStrategy": "${dockerized ? "EXISTING" : "GENERATE"}",
  "terraformStrategy": "FARGATE_TEMPLATE",
  "explanation": "Explain the selected target and sizing."
}

Rules:
1. Choose AWS_ECS_FARGATE for all applications and dynamic/static web services.
2. Use only these CPU values: 0.25 vCPU, 0.5 vCPU, 1 vCPU, 2 vCPU.
3. Use only these memory values: 512 MB, 1 GB, 2 GB, 4 GB.
4. healthCheck must be an absolute path containing only letters, numbers, slash, underscore, or hyphen.
5. Never return markdown or backticks (no \`\`\`json).
6. Never explain outside the JSON object.
7. Return raw JSON ONLY.`;

  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    const ai = new GoogleGenAI({ apiKey });
    const candidateModels = [...new Set([
      AI_MODEL,
      "gemini-flash-lite-latest",
      "gemini-3.5-flash-lite",
      "gemini-3.1-flash-lite",
      "gemini-flash-latest",
    ])];

    for (const modelName of candidateModels) {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: prompt,
          config: {
            responseMimeType: "application/json",
            temperature: 0.2,
          },
        });

        if (response?.text) {
          const cleanedText = response.text.replace(/```json/g, "").replace(/```/g, "").trim();
          const parsed = JSON.parse(cleanedText);
          if (parsed && typeof parsed === "object") {
            return {
              ...normalizePlan(parsed, metadata),
              source: `Gemini ${modelName}`,
              timestamp: new Date().toISOString(),
            };
          }
        }
      } catch (err) {
        console.warn(`Gemini model ${modelName} call notice:`, err.message?.slice(0, 150));
      }
    }
  }

  // Fallback to maintain system stability if Gemini 2.5 Flash API encounters network or service issues
  return generateDevOpsFallbackPlan(metadata);
}

/**
 * Deterministic Senior DevOps Fallback Planner
 * Ensures reliable, instant plans even when offline or during API rate limit spikes.
 */
export function generateDevOpsFallbackPlan(metadata) {
  const { framework = "", port = 80, dockerized = false } = metadata;
  const isFrontend = isStaticFrontend(framework);
  const isJava = framework === "Spring Boot";
  const useStaticHosting = isFrontend && !dockerized;

  const cpu = isJava ? "1 vCPU" : (isFrontend ? "0.25 vCPU" : "0.5 vCPU");
  const memory = isJava ? "2 GB" : (isFrontend ? "512 MB" : "1 GB");
  const healthCheck = "/";
  const deploymentTarget = "AWS_ECS_FARGATE";
  const dockerStrategy = dockerized ? "EXISTING" : "GENERATE";
  const terraformStrategy = "FARGATE_TEMPLATE";

  const explanation = `Recommended AWS ECS Fargate deployment with ${cpu} and ${memory} memory. ${
    dockerStrategy === "GENERATE"
      ? "Automated multi-stage container build optimized with caching and non-root execution."
      : "Using the existing repository Dockerfile."
  } Direct Application Load Balancer routing with health check probe configured at ${healthCheck} on port ${port}.`;

  return {
    ...normalizePlan({ deploymentTarget, cpu, memory, healthCheck }, metadata),
    dockerStrategy,
    terraformStrategy,
    explanation,
    source: "DevOps Intelligence Engine",
    timestamp: new Date().toISOString(),
  };
}

// Retain legacy method for backward compatibility
export async function generateDeploymentPlan(detectionResult) {
  return generateAiDeploymentPlan(detectionResult);
}
