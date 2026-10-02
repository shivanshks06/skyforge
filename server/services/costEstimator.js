/**
 * AWS Cost Estimator Service (Sprint 7)
 * Computes transparent, itemized monthly infrastructure cost estimates for ECS Fargate deployments.
 */

export function estimateInfrastructureCost(target, specs = {}) {
  const { cpu = "0.5 vCPU", memory = "1 GB" } = specs;

  // Target: ECS Fargate
  const cpuMap = {
    "0.25 vCPU": { rate: 0.04048 * 0.25, monthly: 7.39 },
    "0.5 vCPU": { rate: 0.04048 * 0.5, monthly: 14.77 },
    "1 vCPU": { rate: 0.04048 * 1.0, monthly: 29.55 },
    "2 vCPU": { rate: 0.04048 * 2.0, monthly: 59.10 },
  };

  const memMap = {
    "512 MB": { rate: 0.004445 * 0.5, monthly: 1.62 },
    "1 GB": { rate: 0.004445 * 1.0, monthly: 3.24 },
    "2 GB": { rate: 0.004445 * 2.0, monthly: 6.49 },
    "4 GB": { rate: 0.004445 * 4.0, monthly: 12.98 },
  };

  const cpuData = cpuMap[cpu] || cpuMap["0.5 vCPU"];
  const memData = memMap[memory] || memMap["1 GB"];
  const albCost = 16.43; // $0.0225/hr * 730 hrs
  const cloudWatchCost = 2.00;
  const vpcCost = 0.00;

  const total = (cpuData.monthly + memData.monthly + albCost + cloudWatchCost + vpcCost).toFixed(0);

  const breakdown = [
    {
      resource: `ECS Fargate Tasks (${cpu}, ${memory})`,
      rate: `$${(cpuData.rate + memData.rate).toFixed(4)} / task-hour`,
      monthlyCost: parseFloat((cpuData.monthly + memData.monthly).toFixed(2)),
      formattedMonthly: `$${(cpuData.monthly + memData.monthly).toFixed(2)}`,
      category: "Compute",
      notes: "Serverless container execution based on 730 hours/month.",
    },
    {
      resource: "Application Load Balancer (ALB)",
      rate: "$0.0225 / hour",
      monthlyCost: albCost,
      formattedMonthly: `$${albCost.toFixed(2)}`,
      category: "Networking",
      notes: "Dedicated HTTP/HTTPS ingress router with health check probe.",
    },
    {
      resource: "Amazon CloudWatch Logs & Metrics",
      rate: "$0.50 / GB ingested",
      monthlyCost: cloudWatchCost,
      formattedMonthly: `$${cloudWatchCost.toFixed(2)}`,
      category: "Observability",
      notes: "Standard 7-day retention log group for task diagnostics.",
    },
    {
      resource: "Virtual Private Cloud (VPC) & Subnets",
      rate: "Free",
      monthlyCost: 0.00,
      formattedMonthly: "$0.00",
      category: "Networking",
      notes: "Default AWS VPC & Security Groups incur no hourly fee.",
    },
  ];

  return {
    total: `$${total}/month`,
    numericTotal: parseFloat(total),
    currency: "USD",
    isFreeTierEligible: false,
    billingFrequency: "Monthly Estimate",
    breakdown,
  };
}
