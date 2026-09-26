function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateResourceManifests(resources) {
  for (const [index, manifest] of resources.entries()) {
    if (!isPlainObject(manifest)) {
      throw new Error(`Cloud resource manifest ${index + 1} is malformed.`);
    }
    if (manifest.region !== undefined && !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(String(manifest.region))) {
      throw new Error(`Cloud resource manifest ${index + 1} has an invalid AWS region.`);
    }
    if (manifest.accountId !== undefined && manifest.accountId !== null && !/^\d{12}$/.test(String(manifest.accountId))) {
      throw new Error(`Cloud resource manifest ${index + 1} has an invalid AWS account ID.`);
    }
    if (manifest.type === "S3_CLOUDFRONT" || manifest.type === "S3_STATIC_WEBSITE") {
      if (typeof manifest.bucket !== "string" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(manifest.bucket)) {
        throw new Error(`Cloud resource manifest ${index + 1} has an invalid S3 bucket identity.`);
      }
      continue;
    }
    if (manifest.type === "ECS_FARGATE") {
      if (manifest.repositoryName !== undefined && !/^[a-z0-9][a-z0-9._/-]{1,238}[a-z0-9]$/.test(String(manifest.repositoryName))) {
        throw new Error(`Cloud resource manifest ${index + 1} has an invalid ECR repository name.`);
      }
      const hasIdentity = [
        "repositoryName",
        "clusterName",
        "serviceName",
        "loadBalancerArn",
        "targetGroupArn",
        "listenerArn",
        "albSecurityGroupId",
        "taskSecurityGroupId",
        "executionRoleName",
        "taskRoleName",
        "logGroupName",
        "taskDefinitionFamily",
        "secretName",
        "loadBalancerName",
        "targetGroupName",
        "edgeDistributionId",
      ].some((key) => typeof manifest[key] === "string" && manifest[key].trim());
      if (!hasIdentity) {
        throw new Error(`Cloud resource manifest ${index + 1} has no verifiable ECS or ECR identity.`);
      }
      continue;
    }
    throw new Error(`Cloud resource manifest ${index + 1} has an unsupported resource type.`);
  }
  return resources;
}

export function mergeRollbackResources(currentResources = {}, previousResources = {}) {
  if (currentResources.type === "S3_CLOUDFRONT") {
    return {
      ...currentResources,
      ...previousResources,
      type: "S3_CLOUDFRONT",
      region: currentResources.region || previousResources.region,
      accountId: currentResources.accountId || previousResources.accountId,
      bucket: currentResources.bucket || previousResources.bucket,
      distributionId: currentResources.distributionId || previousResources.distributionId,
      oacId: currentResources.oacId || previousResources.oacId,
      releasePrefix: previousResources.releasePrefix || currentResources.releasePrefix,
      defaultRoot: previousResources.defaultRoot || currentResources.defaultRoot,
    };
  }
  return {
    ...currentResources,
    imageUri: previousResources.imageUri || currentResources.imageUri,
    taskDefinitionArn: previousResources.taskDefinitionArn || currentResources.taskDefinitionArn,
  };
}

export function uniqueResources(deployments) {
  const byStableKey = new Map();
  const anonymous = [];
  for (const deployment of deployments) {
    const resources = deployment.resources;
    if (resources === null || resources === undefined) continue;
    if (!isPlainObject(resources)) {
      anonymous.push(resources);
      continue;
    }
    const stableKey = resources.type === "ECS_FARGATE" && resources.clusterName && resources.serviceName
      ? `ECS_FARGATE:${resources.region || ""}:${resources.accountId || ""}:${resources.clusterName}:${resources.serviceName}`
      : (resources.type === "S3_CLOUDFRONT" || resources.type === "S3_STATIC_WEBSITE") && (resources.distributionId || resources.bucket)
        ? `S3_STATIC:${resources.region || ""}:${resources.accountId || ""}:${resources.distributionId || resources.bucket}`
        : null;
    if (!stableKey) {
      anonymous.push(resources);
      continue;
    }
    const existing = byStableKey.get(stableKey);
    if (!existing) {
      byStableKey.set(stableKey, { ...resources });
      continue;
    }
    const merged = { ...resources, ...existing };
    for (const [key, value] of Object.entries(existing)) {
      if ((value === null || value === undefined || value === "") && resources[key] !== undefined && resources[key] !== null && resources[key] !== "") {
        merged[key] = resources[key];
      }
    }
    byStableKey.set(stableKey, merged);
  }
  return [...byStableKey.values(), ...anonymous];
}
