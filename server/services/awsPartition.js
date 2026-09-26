export function awsPartitionForRegion(region = "us-east-1") {
  const value = String(region || "").toLowerCase();
  if (value.startsWith("cn-")) return "aws-cn";
  if (value.startsWith("us-gov-")) return "aws-us-gov";
  if (value.startsWith("us-iso-")) return "aws-iso";
  if (value.startsWith("us-isob-")) return "aws-iso-b";
  return "aws";
}

export function awsDomainSuffixForRegion(region = "us-east-1") {
  return awsPartitionForRegion(region) === "aws-cn" ? "amazonaws.com.cn" : "amazonaws.com";
}
