import crypto from "node:crypto";
import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { decryptSecret } from "./secretService.js";

export function generateExternalId() {
  return `skyforge_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function getSkyForgeAccountId() {
  const accountId = process.env.SKYFORGE_AWS_ACCOUNT_ID?.trim();
  if (!/^\d{12}$/.test(accountId || "")) {
    throw new Error("SKYFORGE_AWS_ACCOUNT_ID must be configured as the 12-digit AWS account running SkyForge.");
  }
  return accountId;
}

function wrapRoleCredentialError(error) {
  if (/Could not load credentials from any providers|CredentialsProviderError/i.test(error?.message || "")) {
    return new Error(
      "SkyForge cannot assume the connected AWS role because its API/worker runtime has no AWS IAM identity. Run SkyForge on ECS/Fargate with a task role that allows sts:AssumeRole, or configure an AWS SSO/profile identity for local development.",
    );
  }
  return error;
}

export function generateCloudFormationTemplate(externalId, skyforgeAccountId = getSkyForgeAccountId(), region = "ap-south-1") {
  if (!/^skyforge_[a-f0-9]{16,64}$/.test(externalId || "")) {
    throw new Error("A valid SkyForge external ID is required.");
  }
  const partition = region.startsWith("cn-") ? "aws-cn" : region.startsWith("us-gov-") ? "aws-us-gov" : "aws";

  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: "SkyForge cross-account deployment role with external-ID protected least-privilege access",
    Parameters: {
      ExternalId: {
        Type: "String",
        Default: externalId,
        MinLength: 20,
        AllowedPattern: "^skyforge_[a-f0-9]+$",
      },
    },
    Resources: {
      SkyForgeDeploymentRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          RoleName: `SkyForgeDeploymentRole-${externalId.slice(-8)}`,
          Description: "Lets the configured SkyForge deployment service manage this account",
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [{
              Effect: "Allow",
              Principal: { AWS: `arn:${partition}:iam::${skyforgeAccountId}:root` },
              Action: "sts:AssumeRole",
              Condition: { StringEquals: { "sts:ExternalId": { Ref: "ExternalId" } } },
            }],
          },
          Policies: [{
            PolicyName: "SkyForgeDeploymentPolicy",
            PolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Sid: "ECSDeployment",
                  Effect: "Allow",
                  Action: [
                    "ecs:CreateCluster", "ecs:DeleteCluster", "ecs:DescribeClusters",
                    "ecs:RegisterTaskDefinition", "ecs:DeregisterTaskDefinition", "ecs:DescribeTaskDefinition",
                    "ecs:ListTaskDefinitions", "ecs:CreateService", "ecs:UpdateService", "ecs:DeleteService",
                    "ecs:DescribeServices", "ecs:ListServices", "ecs:ListTasks", "ecs:DescribeTasks",
                  ],
                  Resource: "*",
                },
                {
                  Sid: "ECRDeployment",
                  Effect: "Allow",
                  Action: [
                    "ecr:GetAuthorizationToken", "ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer",
                    "ecr:BatchGetImage", "ecr:PutImage", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
                    "ecr:CompleteLayerUpload", "ecr:CreateRepository", "ecr:DescribeRepositories", "ecr:DescribeImages", "ecr:ListTagsForResource", "ecr:TagResource",
                    "ecr:DeleteRepository",
                  ],
                  Resource: "*",
                },
                {
                  Sid: "S3CloudFrontDeployment",
                  Effect: "Allow",
                  Action: [
                    "s3:CreateBucket", "s3:DeleteBucket", "s3:GetBucketLocation", "s3:ListBucket", "s3:PutBucketPolicy", "s3:PutBucketPublicAccessBlock", "s3:GetBucketTagging", "s3:PutBucketTagging",
                    "s3:ListBucketVersions", "s3:GetObject", "s3:PutObject", "s3:DeleteObject",
                    "s3:PutEncryptionConfiguration", "s3:GetEncryptionConfiguration", "s3:PutLifecycleConfiguration",
                    "cloudfront:CreateDistribution", "cloudfront:GetDistribution", "cloudfront:UpdateDistribution",
                    "cloudfront:DeleteDistribution", "cloudfront:CreateInvalidation", "cloudfront:ListDistributions",
                    "cloudfront:CreateOriginAccessControl", "cloudfront:GetOriginAccessControl",
                    "cloudfront:DeleteOriginAccessControl",
                  ],
                  Resource: "*",
                },
                {
                  Sid: "LoadBalancerAndNetwork",
                  Effect: "Allow",
                  Action: [
                    "ec2:DescribeVpcs", "ec2:DescribeSubnets", "ec2:DescribeSecurityGroups", "ec2:DescribeManagedPrefixLists",
                    "ec2:CreateSecurityGroup", "ec2:DeleteSecurityGroup", "ec2:AuthorizeSecurityGroupIngress",
                    "ec2:RevokeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress", "ec2:RevokeSecurityGroupEgress",
                    "elasticloadbalancing:CreateLoadBalancer", "elasticloadbalancing:DeleteLoadBalancer",
                    "elasticloadbalancing:DescribeLoadBalancers", "elasticloadbalancing:CreateTargetGroup",
                    "elasticloadbalancing:DeleteTargetGroup", "elasticloadbalancing:DescribeTargetGroups", "elasticloadbalancing:ModifyTargetGroup", "elasticloadbalancing:ModifyTargetGroupAttributes", "elasticloadbalancing:DescribeTargetHealth",
                    "elasticloadbalancing:CreateListener", "elasticloadbalancing:DeleteListener", "elasticloadbalancing:ModifyListener",
                    "elasticloadbalancing:DescribeListeners", "elasticloadbalancing:AddTags", "elasticloadbalancing:RemoveTags",
                  ],
                  Resource: "*",
                },
                {
                  Sid: "IAMAndLogs",
                  Effect: "Allow",
                  Action: [
                    "iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy",
                    "iam:PassRole", "iam:ListAttachedRolePolicies", "iam:ListRolePolicies", "iam:GetRolePolicy",
                    "logs:CreateLogGroup", "logs:DeleteLogGroup", "logs:DescribeLogGroups",
                    "secretsmanager:CreateSecret", "secretsmanager:DescribeSecret", "secretsmanager:PutSecretValue", "secretsmanager:DeleteSecret",
                    "logs:CreateLogStream", "logs:PutLogEvents", "logs:GetLogEvents",
                  ],
                  Resource: "*",
                },
                {
                  Sid: "SecurityFeatures",
                  Effect: "Allow",
                  Action: [
                    "wafv2:CreateWebACL", "wafv2:UpdateWebACL", "wafv2:DeleteWebACL", "wafv2:GetWebACL", "wafv2:ListWebACLs",
                    "wafv2:AssociateWebACL", "wafv2:DisassociateWebACL", "wafv2:GetWebACLForResource", "wafv2:ListResourcesForWebACL",
                    "wafv2:CreateIPSet", "wafv2:UpdateIPSet", "wafv2:DeleteIPSet", "wafv2:GetIPSet", "wafv2:ListIPSets",
                    "wafv2:GetSampledRequests", "wafv2:TagResource", "cloudwatch:GetMetricStatistics",
                    "rds:CreateDBInstance", "rds:DeleteDBInstance", "rds:DescribeDBInstances", "rds:AddTagsToResource",
                    "rds:CreateDBSubnetGroup", "rds:DeleteDBSubnetGroup", "rds:DescribeDBSubnetGroups",
                    "rds:CreateDBParameterGroup", "rds:ModifyDBParameterGroup", "rds:DeleteDBParameterGroup", "rds:DescribeDBParameterGroups",
                    "iam:CreateServiceLinkedRole",
                    "elasticloadbalancing:SetWebAcl", "elasticloadbalancing:ModifyLoadBalancerAttributes", "elasticloadbalancing:DescribeRules", "elasticloadbalancing:CreateRule", "elasticloadbalancing:DeleteRule",
                    "iam:CreateUser", "iam:GetUser", "iam:DeleteUser", "iam:TagUser", "iam:CreateAccessKey", "iam:DeleteAccessKey",
                    "iam:ListAccessKeys", "iam:GetAccessKeyLastUsed",
                    "ecr:PutImageScanningConfiguration", "ecr:DescribeImageScanFindings", "ecr:StartImageScan",
                  ],
                  Resource: "*",
                },
              ],
            },
          }],
        },
      },
    },
    Outputs: {
      RoleArn: { Value: { "Fn::GetAtt": ["SkyForgeDeploymentRole", "Arn"] } },
    },
  };
}

export function getCloudFormationLaunchUrl(region = "ap-south-1") {
  const safeRegion = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region) ? region : "us-east-1";
  return `https://console.aws.amazon.com/cloudformation/home?region=${encodeURIComponent(safeRegion)}#/stacks/create/template`;
}

export async function verifyAwsConnection({ roleArn, externalId, region = "ap-south-1" }) {
  if (!roleArn || typeof roleArn !== "string") throw new Error("Valid IAM Role ARN is required.");

  const arnMatch = roleArn.trim().match(/^arn:(aws(?:-[a-z]+)?):iam::(\d{12}):role\/(.+)$/i);
  if (!arnMatch) throw new Error("Invalid IAM Role ARN format.");
  if (!/^skyforge_[a-f0-9]{16,64}$/.test(externalId || "")) {
    throw new Error("A valid SkyForge external ID is required before connecting a role.");
  }

  const [, partition, accountId, roleName] = arnMatch;
  const stsClient = new STSClient({ region });
  let response;
  try {
    response = await stsClient.send(new AssumeRoleCommand({
      RoleArn: roleArn.trim(),
      RoleSessionName: `skyforge-verify-${Date.now()}`,
      ExternalId: externalId,
      DurationSeconds: 900,
    }));
  } catch (error) {
    throw wrapRoleCredentialError(error);
  }

  if (!response.Credentials?.AccessKeyId) throw new Error("AWS did not return usable role credentials.");

  const identity = await new STSClient({
    region,
    credentials: {
      accessKeyId: response.Credentials.AccessKeyId,
      secretAccessKey: response.Credentials.SecretAccessKey,
      sessionToken: response.Credentials.SessionToken,
    },
  }).send(new GetCallerIdentityCommand({}));

  if (identity.Account !== accountId) throw new Error("The assumed role identity did not match the requested AWS account.");

  return {
    verified: true,
    accountId: identity.Account,
    roleArn: roleArn.trim(),
    roleName,
    partition,
    region,
    mode: "LIVE_AWS",
  };
}

export async function verifyAwsAccessKeys({ accessKeyId, secretAccessKey, sessionToken, region = "ap-south-1" }) {
  if (!accessKeyId || !secretAccessKey) throw new Error("AWS Access Key ID and Secret Access Key are required.");
  const identity = await new STSClient({
    region,
    credentials: {
      accessKeyId: accessKeyId.trim(),
      secretAccessKey: secretAccessKey.trim(),
      ...(sessionToken?.trim() ? { sessionToken: sessionToken.trim() } : {}),
    },
  }).send(new GetCallerIdentityCommand({}));

  return { verified: true, accountId: identity.Account, arn: identity.Arn, userId: identity.UserId, region };
}

export async function getAwsCredentials(connection) {
  if (!connection || (connection.status && connection.status !== "CONNECTED")) return null;

  if (connection.authType === "ROLE_ARN" && connection.roleArn) {
    if (!connection.externalId) throw new Error("The AWS role connection is missing its external ID. Reconnect the AWS account.");
    let response;
    try {
      response = await new STSClient({ region: connection.region || "ap-south-1" }).send(new AssumeRoleCommand({
        RoleArn: connection.roleArn,
        RoleSessionName: `skyforge-deploy-${Date.now()}`,
        ExternalId: connection.externalId,
        DurationSeconds: 3600,
      }));
    } catch (error) {
      throw wrapRoleCredentialError(error);
    }

    if (!response.Credentials) throw new Error("AWS did not return usable deployment credentials.");
    return {
      accessKeyId: response.Credentials.AccessKeyId,
      secretAccessKey: response.Credentials.SecretAccessKey,
      sessionToken: response.Credentials.SessionToken,
      region: connection.region,
      accountId: connection.accountId,
    };
  }

  if (connection.authType === "ACCESS_KEYS" && connection.accessKeyId && connection.secretAccessKey) {
    return {
      accessKeyId: decryptSecret(connection.accessKeyId).trim(),
      secretAccessKey: decryptSecret(connection.secretAccessKey).trim(),
      ...(connection.sessionToken ? { sessionToken: decryptSecret(connection.sessionToken).trim() } : {}),
      region: connection.region || "ap-south-1",
      accountId: connection.accountId,
    };
  }

  return null;
}
