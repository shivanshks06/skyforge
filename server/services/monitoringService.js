// The running app after deploy: its own logs (CloudWatch Logs) and live metrics (CloudWatch).
import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";

const RANGES = {
  "1h": { hours: 1, period: 60 },
  "6h": { hours: 6, period: 300 },
  "24h": { hours: 24, period: 900 },
  "7d": { hours: 168, period: 3600 },
};

function config(credentials, region) {
  return {
    region,
    credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}) },
  };
}

function query(id, namespace, metric, dimensions, stat, period, label, unit) {
  return {
    spec: { Id: id, MetricStat: { Metric: { Namespace: namespace, MetricName: metric, Dimensions: dimensions }, Period: period, Stat: stat }, ReturnData: true },
    label,
    unit,
  };
}

/** The charts that make sense for this deployment's resources. */
function chartsFor(resources, period) {
  const regional = [];
  const edge = [];
  if (resources?.clusterName && resources?.serviceName) {
    const service = [{ Name: "ClusterName", Value: resources.clusterName }, { Name: "ServiceName", Value: resources.serviceName }];
    regional.push(query("cpu", "AWS/ECS", "CPUUtilization", service, "Average", period, "CPU", "%"));
    regional.push(query("memory", "AWS/ECS", "MemoryUtilization", service, "Average", period, "Memory", "%"));
  }
  if (resources?.loadBalancerArn) {
    const balancer = [{ Name: "LoadBalancer", Value: resources.loadBalancerArn.split(":loadbalancer/")[1] }];
    regional.push(query("requests", "AWS/ApplicationELB", "RequestCount", balancer, "Sum", period, "Requests", "count"));
    regional.push(query("latency", "AWS/ApplicationELB", "TargetResponseTime", balancer, "Average", period, "Response time", "ms"));
    regional.push(query("errors5xx", "AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", balancer, "Sum", period, "Server errors (5xx)", "count"));
    regional.push(query("errors4xx", "AWS/ApplicationELB", "HTTPCode_Target_4XX_Count", balancer, "Sum", period, "Client errors (4xx)", "count"));
  }
  const distributionId = resources?.edgeDistributionId || resources?.distributionId;
  if (distributionId) {
    const distribution = [{ Name: "DistributionId", Value: distributionId }, { Name: "Region", Value: "Global" }];
    // CloudFront publishes at most one point per minute and the shortest useful period for these is 60s.
    edge.push(query("edgeRequests", "AWS/CloudFront", "Requests", distribution, "Sum", Math.max(period, 60), resources.loadBalancerArn ? "Edge requests" : "Requests", "count"));
    edge.push(query("edgeErrors", "AWS/CloudFront", "5xxErrorRate", distribution, "Average", Math.max(period, 60), "Edge 5xx rate", "%"));
    edge.push(query("edgeBytes", "AWS/CloudFront", "BytesDownloaded", distribution, "Sum", Math.max(period, 60), "Data served", "bytes"));
  }
  return { regional, edge };
}

async function fetchSeries(client, charts, start, end) {
  if (!charts.length) return [];
  const result = await client.send(new GetMetricDataCommand({ MetricDataQueries: charts.map((chart) => chart.spec), StartTime: start, EndTime: end, ScanBy: "TimestampAscending" }));
  return charts.map((chart) => {
    const data = result.MetricDataResults?.find((item) => item.Id === chart.spec.Id);
    const scale = chart.spec.Id === "latency" ? 1000 : 1; // seconds -> ms
    const points = (data?.Timestamps || []).map((time, index) => ({ t: new Date(time).toISOString(), v: Math.round((data.Values[index] || 0) * scale * 100) / 100 }));
    const values = points.map((point) => point.v);
    const sum = values.reduce((total, value) => total + value, 0);
    return {
      id: chart.spec.Id,
      label: chart.label,
      unit: chart.unit,
      points,
      summary: {
        latest: values.at(-1) ?? null,
        peak: values.length ? Math.max(...values) : null,
        average: values.length ? Math.round((sum / values.length) * 100) / 100 : null,
        total: chart.spec.MetricStat.Stat === "Sum" ? Math.round(sum) : null,
      },
    };
  });
}

/** Time series for the deployment's CPU, memory, traffic, latency and errors. */
export async function appMetrics({ credentials, resources, range = "1h" }) {
  const window = RANGES[range] || RANGES["1h"];
  const end = new Date();
  const start = new Date(end.getTime() - window.hours * 3600_000);
  const { regional, edge } = chartsFor(resources, window.period);
  const region = resources?.region || credentials.region;
  const [regionalSeries, edgeSeries] = await Promise.all([
    fetchSeries(new CloudWatchClient(config(credentials, region)), regional, start, end),
    fetchSeries(new CloudWatchClient(config(credentials, "us-east-1")), edge, start, end).catch(() => []),
  ]);
  return { range, start: start.toISOString(), end: end.toISOString(), series: [...regionalSeries, ...edgeSeries] };
}

/** Recent lines the app itself printed (stdout/stderr), newest last. `filter` is plain text to search for. */
export async function appLogs({ credentials, resources, sinceMs = 15 * 60_000, after = null, filter = "", limit = 300, nextToken = null }) {
  if (!resources?.logGroupName) {
    const error = new Error(resources?.type?.startsWith("S3") ? "Static sites have no server, so there are no app logs. Traffic and errors are under Metrics." : "This deployment has no log group recorded.");
    error.statusCode = 404;
    throw error;
  }
  const logs = new CloudWatchLogsClient(config(credentials, resources.region || credentials.region));
  const term = String(filter || "").trim().slice(0, 100);
  const result = await logs.send(new FilterLogEventsCommand({
    logGroupName: resources.logGroupName,
    // `after` (ms) continues a live tail from the newest line already shown.
    startTime: after ? Number(after) + 1 : Date.now() - Math.min(Math.max(sinceMs, 60_000), 7 * 24 * 3600_000),
    // A quoted term matches it literally (CloudWatch filter syntax); quotes inside are dropped.
    ...(term ? { filterPattern: `"${term.replace(/"/g, "")}"` } : {}),
    limit: Math.min(Math.max(limit, 10), 1000),
    ...(nextToken ? { nextToken } : {}),
  }));
  const events = (result.events || []).map((event) => ({
    id: event.eventId,
    time: new Date(event.timestamp).toISOString(),
    timestamp: event.timestamp,
    message: String(event.message || "").replace(/\s+$/, "").slice(0, 4000),
    level: /\b(error|exception|fatal|traceback|panic)\b/i.test(event.message || "") ? "error" : /\bwarn(ing)?\b/i.test(event.message || "") ? "warn" : "info",
  }));
  return { events, nextToken: result.nextToken || null, logGroup: resources.logGroupName };
}

export const METRIC_RANGES = Object.keys(RANGES);
