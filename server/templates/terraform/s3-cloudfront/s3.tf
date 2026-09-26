# SkyForge Modular Terraform: S3 Static Website Storage & Security Controls
# 1. S3 Storage Bucket
resource "aws_s3_bucket" "site" {
  bucket        = "${var.app_name}-static-origin"
  force_destroy = true

  tags = {
    Name = "${var.app_name}-static-origin"
  }
}

# 2. Block all direct public access (Only CloudFront OAC permitted)
resource "aws_s3_bucket_public_access_block" "site" {
  bucket = aws_s3_bucket.site.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# 3. Server-Side Encryption (AES256 standard)
resource "aws_s3_bucket_server_side_encryption_configuration" "site" {
  bucket = aws_s3_bucket.site.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# 4. Bucket Policy: Restrict Read Access exclusively to CloudFront OAC
resource "aws_s3_bucket_policy" "site_policy" {
  bucket = aws_s3_bucket.site.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontServicePrincipalReadOnly"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.site.arn}/*"
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.cdn.arn
        }
      }
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.site]
}
