// Custom domains with HTTPS. SkyForge requests a free AWS certificate (ACM), shows the DNS records to add, and once
// the certificate is issued attaches it where the site is served:
//   CloudFront (S3 + CloudFront, or ECS behind the HTTPS edge)  alias + certificate on the distribution (cert in us-east-1)
//   load balancer (ECS)                                         an HTTPS listener on port 443 (cert in the app's region)
// The certificate is deleted when the domain is removed or the project is destroyed.
import crypto from "node:crypto";
import {
  ACMClient, RequestCertificateCommand, DescribeCertificateCommand, DeleteCertificateCommand,
} from "@aws-sdk/client-acm";
import {
  ElasticLoadBalancingV2Client as ELBV2Client, DescribeListenersCommand, CreateListenerCommand, AddListenerCertificatesCommand,
  RemoveListenerCertificatesCommand, DeleteListenerCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { EC2Client, AuthorizeSecurityGroupIngressCommand } from "@aws-sdk/client-ec2";
import { CloudFrontClient, GetDistributionConfigCommand, UpdateDistributionCommand } from "@aws-sdk/client-cloudfront";
import { Prisma } from "@prisma/client";
import prisma from "../config/db.js";

const DOMAIN = /^(?=.{4,253}$)(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;

function clientConfig(credentials, region = credentials.region) {
  return {
    region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
    },
  };
}

export function normalizeDomain(value) {
  const domain = String(value || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (!DOMAIN.test(domain)) {
    const error = new Error("Enter a domain like app.example.com (no https://, no path).");
    error.statusCode = 400;
    throw error;
  }
  if (/\.(amazonaws\.com|cloudfront\.net)$/.test(domain)) {
    const error = new Error("Use a domain you own, not an AWS address.");
    error.statusCode = 400;
    throw error;
  }
  return domain;
}

/** Where a live deployment is served from, which decides where the certificate must live. */
export function servingPoint(resources, region) {
  if (!resources) return null;
  const distributionId = resources.edgeDistributionId || (resources.type === "S3_CLOUDFRONT" ? resources.distributionId : null);
  if (distributionId) return { via: "cloudfront", distributionId, certRegion: "us-east-1" };
  if (resources.loadBalancerArn) return { via: "alb", loadBalancerArn: resources.loadBalancerArn, albSecurityGroupId: resources.albSecurityGroupId, targetGroupArn: resources.targetGroupArn, dnsName: resources.loadBalancerDns, certRegion: resources.region || region };
  return null;
}

async function liveResources(projectId) {
  const deployment = await prisma.deployment.findFirst({
    where: { projectId, status: { in: ["LIVE", "ROLLED_BACK"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, resources: true, liveUrl: true },
  });
  return deployment;
}

/** Requests the certificate and returns the records the person must add at their DNS provider. */
export async function requestDomain({ project, credentials, domain: rawDomain }) {
  const domain = normalizeDomain(rawDomain);
  const live = await liveResources(project.id);
  const point = servingPoint(live?.resources, credentials.region);
  if (!point) {
    const error = new Error("Deploy the site first: a custom domain attaches to a live site.");
    error.statusCode = 409;
    throw error;
  }
  const existing = project.customDomain;
  if (existing?.certificateArn && existing.domain !== domain) await deleteCertificate(credentials, existing).catch(() => {});

  const acm = new ACMClient(clientConfig(credentials, point.certRegion));
  const requested = await acm.send(new RequestCertificateCommand({
    DomainName: domain,
    ValidationMethod: "DNS",
    IdempotencyToken: crypto.createHash("sha256").update(`${project.id}:${domain}`).digest("hex").slice(0, 32),
    Tags: [{ Key: "skyforge:project", Value: project.id }, { Key: "ManagedBy", Value: "SkyForge" }],
  }));
  const record = {
    domain,
    certificateArn: requested.CertificateArn,
    certRegion: point.certRegion,
    via: point.via,
    status: "PENDING_VALIDATION",
    requestedAt: new Date().toISOString(),
  };
  await prisma.project.update({ where: { id: project.id }, data: { customDomain: record } });
  // ACM fills in the validation record a few seconds after the request.
  return refreshDomain({ project: { ...project, customDomain: record }, credentials });
}

/** The DNS record that sends visitors to the site. */
function routingRecord(domain, point, live) {
  if (point.via === "alb") return { type: "CNAME", name: domain, value: point.dnsName };
  const host = String(live?.liveUrl || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return { type: "CNAME", name: domain, value: host.endsWith(".cloudfront.net") ? host : `${point.distributionId} (your CloudFront address)` };
}

/** Re-reads the certificate, attaches it once issued, and stores the result. */
export async function refreshDomain({ project, credentials }) {
  const current = project.customDomain;
  if (!current?.certificateArn) return null;
  const acm = new ACMClient(clientConfig(credentials, current.certRegion));
  let certificate;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    certificate = (await acm.send(new DescribeCertificateCommand({ CertificateArn: current.certificateArn }))).Certificate;
    if (certificate?.DomainValidationOptions?.[0]?.ResourceRecord || certificate?.Status !== "PENDING_VALIDATION") break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const validation = certificate?.DomainValidationOptions?.[0]?.ResourceRecord;
  const live = await liveResources(project.id);
  const point = servingPoint(live?.resources, credentials.region);
  const next = {
    ...current,
    certificateStatus: certificate?.Status || "UNKNOWN",
    validation: validation ? { type: validation.Type, name: validation.Name, value: validation.Value } : current.validation || null,
    routing: point ? routingRecord(current.domain, point, live) : current.routing || null,
    checkedAt: new Date().toISOString(),
  };
  if (certificate?.Status === "ISSUED" && point) {
    try {
      await attachCertificate({ credentials, domain: current.domain, certificateArn: current.certificateArn, point });
      next.status = "ACTIVE";
      next.attachedAt = next.attachedAt || new Date().toISOString();
      next.error = null;
    } catch (error) {
      next.status = "ATTACH_FAILED";
      next.error = String(error.message).slice(0, 300);
    }
  } else if (["FAILED", "VALIDATION_TIMED_OUT", "REVOKED", "EXPIRED"].includes(certificate?.Status)) {
    next.status = "FAILED";
    next.error = certificate?.FailureReason ? `AWS could not issue the certificate (${certificate.FailureReason}).` : "AWS could not issue the certificate. Check the DNS record and try again.";
  } else {
    next.status = "PENDING_VALIDATION";
  }
  await prisma.project.update({ where: { id: project.id }, data: { customDomain: next } });
  return next;
}

async function attachCertificate({ credentials, domain, certificateArn, point }) {
  if (point.via === "cloudfront") {
    const cloudfront = new CloudFrontClient(clientConfig(credentials, "us-east-1"));
    const { DistributionConfig: config, ETag } = await cloudfront.send(new GetDistributionConfigCommand({ Id: point.distributionId }));
    const aliases = new Set(config.Aliases?.Items || []);
    const alreadyAttached = aliases.has(domain) && config.ViewerCertificate?.ACMCertificateArn === certificateArn;
    if (alreadyAttached) return;
    aliases.add(domain);
    config.Aliases = { Quantity: aliases.size, Items: [...aliases] };
    config.ViewerCertificate = { ACMCertificateArn: certificateArn, SSLSupportMethod: "sni-only", MinimumProtocolVersion: "TLSv1.2_2021", CloudFrontDefaultCertificate: false };
    await cloudfront.send(new UpdateDistributionCommand({ Id: point.distributionId, IfMatch: ETag, DistributionConfig: config }));
    return;
  }
  const elbv2 = new ELBV2Client(clientConfig(credentials, point.certRegion));
  const listeners = (await elbv2.send(new DescribeListenersCommand({ LoadBalancerArn: point.loadBalancerArn }))).Listeners || [];
  const https = listeners.find((listener) => listener.Port === 443);
  if (https) {
    const attached = (https.Certificates || []).some((cert) => cert.CertificateArn === certificateArn);
    if (!attached) await elbv2.send(new AddListenerCertificatesCommand({ ListenerArn: https.ListenerArn, Certificates: [{ CertificateArn: certificateArn }] }));
  } else {
    // HTTPS serves exactly what HTTP serves (the app, or the maintenance page while offline).
    const http = listeners.find((listener) => listener.Port === 80);
    await elbv2.send(new CreateListenerCommand({
      LoadBalancerArn: point.loadBalancerArn,
      Protocol: "HTTPS",
      Port: 443,
      SslPolicy: "ELBSecurityPolicy-TLS13-1-2-2021-06",
      Certificates: [{ CertificateArn: certificateArn }],
      DefaultActions: http?.DefaultActions?.length ? http.DefaultActions : [{ Type: "forward", TargetGroupArn: point.targetGroupArn }],
      Tags: [{ Key: "ManagedBy", Value: "SkyForge" }],
    }));
  }
  if (point.albSecurityGroupId) {
    const ec2 = new EC2Client(clientConfig(credentials, point.certRegion));
    await ec2.send(new AuthorizeSecurityGroupIngressCommand({
      GroupId: point.albSecurityGroupId,
      IpPermissions: [{ IpProtocol: "tcp", FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: "0.0.0.0/0", Description: "HTTPS for the custom domain" }], Ipv6Ranges: [{ CidrIpv6: "::/0", Description: "HTTPS for the custom domain" }] }],
    })).catch((error) => {
      if (!/Duplicate|already exists/i.test(`${error.name} ${error.message}`)) throw error;
    });
  }
}

async function detachCertificate({ credentials, record, resources }) {
  const point = servingPoint(resources, credentials.region);
  if (!point) return;
  if (point.via === "cloudfront") {
    const cloudfront = new CloudFrontClient(clientConfig(credentials, "us-east-1"));
    const { DistributionConfig: config, ETag } = await cloudfront.send(new GetDistributionConfigCommand({ Id: point.distributionId }));
    const aliases = (config.Aliases?.Items || []).filter((alias) => alias !== record.domain);
    if (aliases.length === (config.Aliases?.Items || []).length && config.ViewerCertificate?.ACMCertificateArn !== record.certificateArn) return;
    config.Aliases = { Quantity: aliases.length, ...(aliases.length ? { Items: aliases } : {}) };
    if (config.ViewerCertificate?.ACMCertificateArn === record.certificateArn) config.ViewerCertificate = { CloudFrontDefaultCertificate: true, MinimumProtocolVersion: "TLSv1", CertificateSource: "cloudfront" };
    await cloudfront.send(new UpdateDistributionCommand({ Id: point.distributionId, IfMatch: ETag, DistributionConfig: config }));
    return;
  }
  const elbv2 = new ELBV2Client(clientConfig(credentials, point.certRegion));
  const listeners = (await elbv2.send(new DescribeListenersCommand({ LoadBalancerArn: point.loadBalancerArn }))).Listeners || [];
  const https = listeners.find((listener) => listener.Port === 443);
  if (!https) return;
  const others = (https.Certificates || []).filter((cert) => cert.CertificateArn !== record.certificateArn);
  if (others.length) await elbv2.send(new RemoveListenerCertificatesCommand({ ListenerArn: https.ListenerArn, Certificates: [{ CertificateArn: record.certificateArn }] }));
  else await elbv2.send(new DeleteListenerCommand({ ListenerArn: https.ListenerArn }));
}

async function deleteCertificate(credentials, record) {
  const acm = new ACMClient(clientConfig(credentials, record.certRegion));
  // A certificate stays "in use" for a short while after it is detached.
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      await acm.send(new DeleteCertificateCommand({ CertificateArn: record.certificateArn }));
      return;
    } catch (error) {
      if (/ResourceNotFound/i.test(error.name)) return;
      if (!/ResourceInUse/i.test(error.name) || attempt === 6) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
}

/** Removes the domain from the site and deletes its certificate. */
export async function removeDomain({ project, credentials }) {
  const record = project.customDomain;
  if (!record?.certificateArn) {
    await prisma.project.update({ where: { id: project.id }, data: { customDomain: Prisma.DbNull } });
    return;
  }
  const live = await liveResources(project.id);
  await detachCertificate({ credentials, record, resources: live?.resources }).catch((error) => {
    if (!/NotFound|NoSuch/i.test(error.name || "")) throw error;
  });
  await deleteCertificate(credentials, record);
  await prisma.project.update({ where: { id: project.id }, data: { customDomain: Prisma.DbNull } });
}

/** After a redeploy (which may rebuild the CloudFront config): put an active domain back. */
export async function reattachCustomDomain({ projectId, credentials, resources, log = () => {} }) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, customDomain: true } });
  const record = project?.customDomain;
  if (!record?.certificateArn || record.status !== "ACTIVE") return;
  const point = servingPoint(resources, credentials.region);
  if (!point) return;
  if (point.certRegion !== record.certRegion) {
    log(`[DOMAIN] ${record.domain}: the site moved between CloudFront and the load balancer; remove and add the domain again to issue a certificate in the right region.`, "warn");
    return;
  }
  await attachCertificate({ credentials, domain: record.domain, certificateArn: record.certificateArn, point });
  log(`[DOMAIN] https://${record.domain} is attached to this release.`, "success");
}

/** Teardown: the certificate is the one domain resource that outlives the load balancer / distribution. */
export async function releaseCustomDomain({ projectId, credentials, log = () => {} }) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { customDomain: true } });
  const record = project?.customDomain;
  if (!record) return;
  if (record.certificateArn && credentials) {
    await deleteCertificate(credentials, record);
    log(`[DOMAIN] Deleted the certificate for ${record.domain}.`, "info");
  }
  await prisma.project.update({ where: { id: projectId }, data: { customDomain: Prisma.DbNull } });
}

