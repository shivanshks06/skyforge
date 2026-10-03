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

/**
 * CloudFront in front of the ALB: free HTTPS on *.cloudfront.net for any app. Nothing is cached
 * (TTL 0) and every method, header, cookie, and query string reaches the app, so forms, APIs,
 * sessions, and redirects behave exactly as they do on the ALB. CloudFront adds X-Forwarded-For.
 */
function configFor(originDomain, callerReference) {
  const originId = `${originDomain}-alb-origin`;
  return {
    CallerReference: callerReference,
    Comment: `SkyForge HTTPS edge for ${originDomain}`.slice(0, 128),
    Enabled: true,
    HttpVersion: "http2and3",
    PriceClass: "PriceClass_All",
    Origins: {
      Quantity: 1,
      Items: [{
        Id: originId,
        DomainName: originDomain,
        CustomOriginConfig: {
          HTTPPort: 80,
          HTTPSPort: 443,
          OriginProtocolPolicy: "http-only",
          OriginReadTimeout: 60,
          OriginKeepaliveTimeout: 5,
          OriginSslProtocols: { Quantity: 1, Items: ["TLSv1.2"] },
        },
      }],
    },
    DefaultCacheBehavior: {
      TargetOriginId: originId,
      ViewerProtocolPolicy: "redirect-to-https",
      // AWS managed SecurityHeadersPolicy: HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, XSS protection.
      ResponseHeadersPolicyId: "67f7725c-6f97-4210-82d7-5512b31e9d03",
      AllowedMethods: {
        Quantity: 7,
        Items: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
        CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] },
      },
      Compress: true,
      ForwardedValues: {
        QueryString: true,
        Cookies: { Forward: "all" },
        Headers: { Quantity: 1, Items: ["*"] },
      },
      MinTTL: 0,
      DefaultTTL: 0,
      MaxTTL: 0,
      TrustedSigners: { Enabled: false, Quantity: 0 },
    },
  };
}

/** The edge distribution in front of a load balancer, if one exists (used by the teardown sweep). */
export async function findEdgeForLoadBalancer(credentials, loadBalancerDns) {
  return findDistribution(new CloudFrontClient(clientConfig(credentials)), String(loadBalancerDns || "").toLowerCase());
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
