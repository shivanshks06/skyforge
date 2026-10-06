// Account-wide AWS spend, per-project estimates, and the monthly budget.
import { Prisma } from "@prisma/client";
import prisma from "../config/db.js";
import { getAwsCredentials } from "../services/awsConnectionService.js";
import { accountSpend, normalizeBudget, projectedCost } from "../services/costService.js";
import { publicStatus } from "../services/statusService.js";

async function userCredentials(userId) {
  const connection = await prisma.awsConnection.findUnique({ where: { userId } });
  const credentials = connection ? await getAwsCredentials(connection) : null;
  if (!credentials?.accessKeyId) {
    const error = new Error("Connect an AWS account to see costs.");
    error.statusCode = 409;
    throw error;
  }
  return credentials;
}

export const getCosts = async (req, res) => {
  try {
    const userId = req.user.id;
    const [user, projects] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { budget: true } }),
      prisma.project.findMany({
        where: { userId },
        select: {
          id: true, name: true, deploymentTarget: true, cpu: true, memory: true, databaseConfig: true, siteOffline: true, protection: true, parentProjectId: true,
          deployments: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true } },
        },
      }),
    ]);
    // Only running projects cost money; destroyed or never-deployed ones are left out.
    const running = projects.filter((project) => ["LIVE", "ROLLED_BACK"].includes(project.deployments[0]?.status));
    const perProject = running.map((project) => {
      const estimate = projectedCost(project);
      const measured = project.protection?.wallet;
      return {
        id: project.id,
        name: project.name,
        preview: Boolean(project.parentProjectId),
        offline: project.siteOffline,
        monthly: measured?.total ?? estimate?.monthly ?? null,
        source: measured?.total !== undefined ? "measured traffic" : "estimate",
        measuredAt: measured?.at || null,
      };
    }).sort((a, b) => (b.monthly || 0) - (a.monthly || 0));

    let spend = null;
    let spendError = null;
    try {
      spend = await accountSpend({ credentials: await userCredentials(userId), refresh: req.query.refresh === "1" });
    } catch (error) {
      spendError = /not authorized|AccessDenied/i.test(`${error.name} ${error.message}`)
        ? "Your AWS access can't read billing data. Add ce:GetCostAndUsage to the SkyForge IAM policy (AWS Guide → Permissions)."
        : /OptInRequired|not enabled|DataUnavailable/i.test(`${error.name} ${error.message}`)
          ? "Cost Explorer isn't switched on for this account yet. Open Billing → Cost Explorer once in the AWS console; data appears within 24 hours."
          : error.statusCode ? error.message : `Could not read AWS costs: ${String(error.message).slice(0, 160)}`;
    }
    const runningMonthly = perProject.reduce((sum, item) => sum + (item.monthly || 0), 0);
    return res.json({
      spend,
      spendError,
      projects: perProject,
      runningMonthly: Math.round(runningMonthly * 100) / 100,
      runningDaily: Math.round((runningMonthly / 30) * 100) / 100,
      budget: user?.budget ? { monthlyUsd: user.budget.monthlyUsd, action: user.budget.action } : null,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Failed to load costs" });
  }
};

export const updateBudget = async (req, res) => {
  try {
    const budget = normalizeBudget(req.body || {});
    const current = await prisma.user.findUnique({ where: { id: req.user.id }, select: { budget: true } });
    // Changing the amount re-arms this month's alerts.
    const next = budget.monthlyUsd ? { ...budget, alerted: current?.budget?.monthlyUsd === budget.monthlyUsd ? current?.budget?.alerted || {} : {} } : null;
    await prisma.user.update({ where: { id: req.user.id }, data: { budget: next ?? Prisma.DbNull } });
    return res.json({ budget: next ? { monthlyUsd: next.monthlyUsd, action: next.action } : null });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Failed to save the budget" });
  }
};

/** Public: no login. Shows only what a status page should (name, state, uptime). */
export const getPublicStatus = async (req, res) => {
  try {
    const status = await publicStatus(req.params.slug);
    if (!status) return res.status(404).json({ message: "Status page not found." });
    res.set("Cache-Control", "public, max-age=30");
    return res.json(status);
  } catch {
    return res.status(500).json({ message: "Status is temporarily unavailable." });
  }
};
