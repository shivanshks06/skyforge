# SkyForge Input Variables: S3 + CloudFront Static Architecture
variable "app_name" {
  description = "Unique application name"
  type        = string
  default     = "skyforge-app"
}

variable "aws_region" {
  description = "Primary AWS region"
  type        = string
  default     = "us-east-1"
}

variable "custom_domain" {
  description = "Optional custom domain name for CloudFront distribution"
  type        = string
  default     = ""
}
