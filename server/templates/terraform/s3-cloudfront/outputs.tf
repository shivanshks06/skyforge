# SkyForge Outputs: S3 + CloudFront Static Architecture
output "s3_bucket_name" {
  description = "Name of the S3 static origin bucket"
  value       = aws_s3_bucket.site.id
}

output "s3_bucket_arn" {
  description = "ARN of the S3 static origin bucket"
  value       = aws_s3_bucket.site.arn
}

output "cloudfront_distribution_id" {
  description = "ID of the CloudFront distribution"
  value       = aws_cloudfront_distribution.cdn.id
}

output "cloudfront_domain_name" {
  description = "Global CDN edge domain endpoint"
  value       = aws_cloudfront_distribution.cdn.domain_name
}
