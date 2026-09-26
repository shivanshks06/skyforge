variable "app_name" {
  description = "The name of the application"
  type        = string
}

variable "environment" {
  description = "Deployment environment"
  type        = string
  default     = "production"
}

variable "aws_region" {
  description = "AWS deployment region"
  type        = string
  default     = "us-east-1"
}

variable "cpu" {
  description = "Fargate task CPU units (e.g., 256 for 0.25 vCPU, 512 for 0.5 vCPU, 1024 for 1 vCPU)"
  type        = string
  default     = "512"
}

variable "memory" {
  description = "Fargate task Memory in MB (e.g., 512, 1024, 2048)"
  type        = string
  default     = "1024"
}

variable "container_port" {
  description = "Application listening port"
  type        = number
  default     = 3000
}

variable "health_check_path" {
  description = "Path for ALB health check probe"
  type        = string
  default     = "/"
}

variable "container_image" {
  description = "Container image URI"
  type        = string
  default     = "REPLACE_WITH_VERIFIED_ECR_IMAGE_URI"
}

variable "environment_variables" {
  description = "Environment variables for the application container"
  type        = map(string)
  default     = {}
}
