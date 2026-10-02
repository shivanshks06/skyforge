/**
 * Infrastructure Planner Service (Sprint 7)
 * Implements a deterministic AWS Decision Matrix to select optimal infrastructure targets,
 * assemble service topologies, and produce visual architecture graph metadata.
 */

export const AWS_TARGETS = {
  ECS_FARGATE: "AWS_ECS_FARGATE",
};

/**
 * Every project deploys to ECS Fargate; static frontends ship as nginx containers.
 */
export function determineDeploymentTarget() {
  return AWS_TARGETS.ECS_FARGATE;
}

/**
 * Plan complete cloud infrastructure topology
 */
export function planInfrastructure(project = {}) {
  const appName = (project.name || "skyforge-app").toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const port = project.port || 80;

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

  return {
    target: AWS_TARGETS.ECS_FARGATE,
    displayName: "AWS ECS Fargate",
    strategyDescription: "Serverless container architecture using validated existing network subnets, a health-checked load balancer, and least-privilege IAM.",
    services,
    architectureGraph,
    requiredModules: ["main.tf", "variables.tf", "outputs.tf", "networking.tf", "ecs.tf", "iam.tf"],
  };
}
