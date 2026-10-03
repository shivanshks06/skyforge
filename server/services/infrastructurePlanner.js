import { TARGETS, normalizeTarget } from "./targets.js";

/**
 * Infrastructure Planner: service topology and architecture graph for the target the project
 * owner chose. It never picks a target on its own.
 */

export const AWS_TARGETS = TARGETS;

/** The explicitly chosen target, or null when the owner has not chosen one yet. */
export function determineDeploymentTarget(project = {}) {
  return normalizeTarget(project.deploymentTarget);
}

/**
 * Plan complete cloud infrastructure topology
 */
export function planInfrastructure(project = {}, customTarget = null) {
  const target = normalizeTarget(customTarget) || determineDeploymentTarget(project);
  if (!target) return null;
  const appName = (project.name || "skyforge-app").toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const port = project.port || 80;

  if (target === AWS_TARGETS.S3_CLOUDFRONT) {
    const services = [
      {
        id: "s3",
        name: "Amazon S3 Bucket",
        category: "Storage",
        description: "Static asset origin bucket with SSE-S3 encryption and blocked public access.",
        status: "Configured",
        specs: "Private, OAC Restricted, 30-day release retention",
      },
      {
        id: "cloudfront",
        name: "Amazon CloudFront CDN",
        category: "Content Delivery",
        description: "Global low-latency edge distribution with HTTPS termination and SPA routing.",
        status: "Configured",
        specs: "Global Edge Network, TLS 1.3",
      },

    ];

    const architectureGraph = {
      nodes: [
        { id: "clients", label: "Global Users", type: "client", icon: "Users" },
        { id: "cloudfront", label: "CloudFront CDN Edge", type: "cdn", icon: "Zap" },
        { id: "s3", label: "Private S3 Origin", type: "storage", icon: "Database" },
      ],
      connections: [
        { from: "clients", to: "cloudfront", label: "HTTPS Request" },
        { from: "cloudfront", to: "s3", label: "Origin Access Control (OAC)" },
      ],
    };

    return {
      target: AWS_TARGETS.S3_CLOUDFRONT,
      displayName: "AWS S3 + CloudFront CDN",
      strategyDescription: "Private serverless static hosting with CloudFront edge delivery, managed TLS, and no origin compute when idle.",
      services,
      architectureGraph,
      requiredModules: ["main.tf", "variables.tf", "outputs.tf", "s3.tf", "cloudfront.tf"],
    };
  }

  // Target: ECS Fargate
  const services = [
    {
      id: "vpc",
      name: "Amazon VPC & Networking",
      category: "Networking",
      description: "Existing or default VPC with at least two validated subnets in different availability zones.",
      status: "Reused",
      specs: "Configured VPC and subnet IDs preferred",
    },
    {
      id: "alb",
      name: "Application Load Balancer (ALB)",
      category: "Traffic Routing",
      description: "Internet-facing HTTP load balancer with health check probe at / routing to ECS tasks.",
      status: "Configured",
      specs: "Port 80, Dynamic Target Group",
    },
    {
      id: "ecs",
      name: "Amazon ECS Fargate Cluster",
      category: "Compute",
      description: "Serverless container execution in the selected VPC, reconciled through a stable ECS service and target group.",
      status: "Configured",
      specs: `${project.cpu || "0.5 vCPU"} / ${project.memory || "1 GB"} RAM, Port ${port}`,
    },
    {
      id: "iam",
      name: "IAM Roles & Permissions",
      category: "Security",
      description: "Least-privilege execution role for ECR and CloudWatch, plus an optional task role for application AWS calls.",
      status: "Configured",
      specs: "Reconciled per project",
    },
    {
      id: "cloudwatch",
      name: "Amazon CloudWatch",
      category: "Observability",
      description: "Centralized logging stream with 7-day retention policy and container metric collection.",
      status: "Configured",
      specs: `/ecs/${appName} Log Stream`,
    },
  ];

  const architectureGraph = {
    nodes: [
      { id: "clients", label: "Internet Traffic", type: "client", icon: "Globe" },
      { id: "igw", label: "Internet Gateway", type: "gateway", icon: "Radio" },
      { id: "alb", label: "Application Load Balancer", type: "loadbalancer", icon: "Sliders" },
      { id: "fargate", label: `ECS Fargate (${project.cpu || "0.5 vCPU"})`, type: "compute", icon: "Cpu" },
      { id: "cloudwatch", label: "CloudWatch Logs", type: "monitoring", icon: "Activity" },
      { id: "iam", label: "Least-Privilege IAM", type: "security", icon: "Shield" },
    ],
    connections: [
      { from: "clients", to: "igw", label: "Public Ingress" },
      { from: "igw", to: "alb", label: "HTTP Port 80" },
      { from: "alb", to: "fargate", label: `Forward to :${port}` },
      { from: "fargate", to: "cloudwatch", label: "Log Streams" },
      { from: "fargate", to: "iam", label: "Assume Role" },
    ],
  };

  if (target === AWS_TARGETS.ECS_CLOUDFRONT) {
    services.unshift({
      id: "cloudfront",
      name: "Amazon CloudFront (HTTPS edge)",
      category: "Content Delivery",
      description: "Free HTTPS on a *.cloudfront.net address in front of the load balancer; forwards every method, header, and cookie with no caching.",
      status: "Configured",
      specs: "TLS 1.2+, HTTP/2 and HTTP/3, falls back to the ALB address until CloudFront is enabled for the account",
    });
    architectureGraph.nodes.splice(1, 0, { id: "cloudfront", label: "CloudFront HTTPS Edge", type: "cdn", icon: "Zap" });
    architectureGraph.connections[0] = { from: "clients", to: "cloudfront", label: "HTTPS" };
    architectureGraph.connections.splice(1, 0, { from: "cloudfront", to: "igw", label: "HTTP to origin" });
  }

  return {
    target,
    displayName: target === AWS_TARGETS.ECS_CLOUDFRONT ? "AWS ECS Fargate + CloudFront" : "AWS ECS Fargate",
    strategyDescription: "Serverless container architecture using validated existing network subnets, a health-checked load balancer, and least-privilege IAM.",
    services,
    architectureGraph,
    requiredModules: ["main.tf", "variables.tf", "outputs.tf", "networking.tf", "ecs.tf", "iam.tf"],
  };
}
