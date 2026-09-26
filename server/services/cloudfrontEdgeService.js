import {
  CloudFrontClient,
  CreateDistributionCommand,
  GetDistributionCommand,
  ListDistributionsCommand,
  UpdateDistributionCommand,
  waitUntilDistributionDeployed,
} from "@aws-sdk/client-cloudfront";
import { emitDeploymentLog } from "./logsService.js";
import { awsDomainSuffixForRegion } from "./awsPartition.js";

function clientConfig(credentials) {
  if (!credentials?.accessKeyId || !credentials?.secretAccessKey) throw new Error("Valid AWS credentials are required for the HTTPS edge.");
  return {
    region: credentials.region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
    },
  };
}

async function findDistribution(cloudfront, originDomain) {
  let marker;
  do {
    const page = await cloudfront.send(new ListDistributionsCommand({ Marker: marker, MaxItems: 100 }));
    const match = page.DistributionList?.Items?.find((item) => item.Origins?.Items?.some((origin) => origin.DomainName === originDomain));
    if (match) return match;
    marker = page.DistributionList?.IsTruncated ? page.DistributionList.NextMarker : undefined;
  } while (marker);
  return null;
}

function configFor(originDomain, callerReference) {
  const originId = `${originDomain}-alb-origin`;
  return {
    CallerReference: callerReference,
    Comment: `SkyForge HTTPS edge for ${originDomain}`,
    Enabled: true,
    Origins: {
      Quantity: 1,
      Items: [{
        Id: originId,
        DomainName: originDomain,
        CustomOriginConfig: {
          HTTPPort: 80,
          HTTPSPort: 443,
          OriginProtocolPolicy: "http-only",
          OriginReadTimeout: 30,
          OriginKeepaliveTimeout: 5,
        },
      }],
    },
    DefaultCacheBehavior: {
      TargetOriginId: originId,
      ViewerProtocolPolicy: "https-only",
      AllowedMethods: { Quantity: 3, Items: ["GET", "HEAD", "OPTIONS"] },
      CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] },
      Compress: true,
      ForwardedValues: {
        QueryString: true,
        Cookies: { Forward: "all" },
        Headers: { Quantity: 3, Items: ["Authorization", "Origin", "Referer"] },
        MinTTL: 0,
        DefaultTTL: 0,
        MaxTTL: 0,
      },
      TrustedSigners: { Enabled: false, Quantity: 0 },
    },
    PriceClass: "PriceClass_All",
  };
}

export async function ensureHttpsEdge({ deploymentId, credentials, loadBalancerDns, onResources }) {
  const cloudfront = new CloudFrontClient(clientConfig(credentials));
  const originDomain = String(loadBalancerDns || "").toLowerCase();
  if (!originDomain.endsWith(`.elb.${awsDomainSuffixForRegion(credentials.region)}`)) throw new Error("Invalid ECS load balancer DNS name.");

  let summary = await findDistribution(cloudfront, originDomain);
  let current = null;
  if (summary) {
    current = await cloudfront.send(new GetDistributionCommand({ Id: summary.Id }));
    await onResources?.({
      edgeDistributionId: summary.Id,
      edgeDistributionArn: current.Distribution?.ARN,
      edgeOriginDomain: originDomain,
    });
  }
  const config = configFor(originDomain, current?.Distribution?.Config?.CallerReference || `skyforge-edge-${deploymentId}`);
  const result = current
    ? await cloudfront.send(new UpdateDistributionCommand({ Id: summary.Id, IfMatch: current.ETag, DistributionConfig: config }))
    : await cloudfront.send(new CreateDistributionCommand({ DistributionConfig: config }));
  const distributionId = result.Distribution?.Id;
  if (!distributionId) throw new Error("CloudFront did not return an HTTPS edge distribution ID.");
  await onResources?.({
    edgeDistributionId: distributionId,
    edgeDistributionArn: result.Distribution?.ARN,
    edgeOriginDomain: originDomain,
  });
  await waitUntilDistributionDeployed(
    { client: cloudfront, maxWaitTime: Number.parseInt(process.env.CLOUDFRONT_WAIT_SECONDS || "900", 10) },
    { Id: distributionId },
  );
  const deployed = await cloudfront.send(new GetDistributionCommand({ Id: distributionId }));
  const domainName = deployed.Distribution?.DomainName;
  if (!domainName) throw new Error("CloudFront did not return an HTTPS edge domain.");
  emitDeploymentLog(deploymentId, { stage: "DEPLOYING", message: `[CLOUDFRONT] HTTPS edge provisioned at https://${domainName}.`, level: "success" });
  return {
    distributionId,
    distributionArn: deployed.Distribution.ARN,
    domainName: `https://${domainName}`,
    originDomain,
  };
}
