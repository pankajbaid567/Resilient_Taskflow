# Main Terraform configuration for TaskFlow AWS Infrastructure
# This is the root module that orchestrates all infrastructure components

terraform {
  required_version = ">= 1.5.0"
  
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  
  # Configure S3 backend for state management
  backend "s3" {
    bucket         = "taskflow-terraform-state"
    key            = "terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "taskflow-terraform-locks"
  }
}

# Provider configuration
provider "aws" {
  region = var.aws_region
  
  default_tags {
    tags = {
      Project     = "TaskFlow"
      Environment = var.environment
      ManagedBy   = "Terraform"
      Repository  = "github.com/YOUR_USERNAME/Resilient_TaskFlow"
    }
  }
}

# Data sources
data "aws_caller_identity" "current" {}
data "aws_availability_zones" "available" {
  state = "available"
}

# Local variables
locals {
  name_prefix = "taskflow-${var.environment}"
  
  common_tags = {
    Project     = "TaskFlow"
    Environment = var.environment
    ManagedBy   = "Terraform"
  }
  
  azs = slice(data.aws_availability_zones.available.names, 0, var.az_count)
}

# VPC Module
module "vpc" {
  source = "./modules/vpc"
  
  name_prefix         = local.name_prefix
  vpc_cidr            = var.vpc_cidr
  availability_zones  = local.azs
  public_subnet_cidrs = var.public_subnet_cidrs
  private_subnet_cidrs = var.private_subnet_cidrs
  enable_nat_gateway  = var.enable_nat_gateway
  enable_vpn_gateway  = var.enable_vpn_gateway
  
  tags = local.common_tags
}

# RDS PostgreSQL Module
module "rds" {
  source = "./modules/rds"
  
  name_prefix               = local.name_prefix
  vpc_id                   = module.vpc.vpc_id
  subnet_ids               = module.vpc.private_subnet_ids
  allowed_security_groups  = [module.ecs.api_security_group_id, module.ecs.worker_security_group_id]
  
  instance_class           = var.rds_instance_class
  allocated_storage        = var.rds_allocated_storage
  max_allocated_storage    = var.rds_max_allocated_storage
  engine_version           = var.rds_engine_version
  database_name            = var.database_name
  master_username          = var.database_username
  backup_retention_period  = var.rds_backup_retention_period
  multi_az                 = var.rds_multi_az
  
  tags = local.common_tags
}

# ElastiCache Redis Module
module "elasticache" {
  source = "./modules/elasticache"
  
  name_prefix              = local.name_prefix
  vpc_id                   = module.vpc.vpc_id
  subnet_ids               = module.vpc.private_subnet_ids
  allowed_security_groups  = [module.ecs.api_security_group_id, module.ecs.worker_security_group_id]
  
  node_type                = var.redis_node_type
  num_cache_nodes          = var.redis_num_cache_nodes
  engine_version           = var.redis_engine_version
  parameter_group_family   = var.redis_parameter_group_family
  automatic_failover_enabled = var.redis_automatic_failover
  
  tags = local.common_tags
}

# Secrets Manager
module "secrets" {
  source = "./modules/secrets"
  
  name_prefix    = local.name_prefix
  database_url   = module.rds.connection_string
  redis_url      = module.elasticache.primary_endpoint_address
  jwt_secret     = var.jwt_secret
  api_key        = var.api_key
  
  tags = local.common_tags
}

# Application Load Balancer
module "alb" {
  source = "./modules/alb"
  
  name_prefix             = local.name_prefix
  vpc_id                  = module.vpc.vpc_id
  subnet_ids              = module.vpc.public_subnet_ids
  certificate_arn         = var.acm_certificate_arn
  enable_deletion_protection = var.alb_enable_deletion_protection
  
  tags = local.common_tags
}

# ECS Cluster and Services
module "ecs" {
  source = "./modules/ecs"
  
  name_prefix                = local.name_prefix
  vpc_id                     = module.vpc.vpc_id
  private_subnet_ids         = module.vpc.private_subnet_ids
  alb_target_group_arn       = module.alb.target_group_arn
  
  # Container images
  api_image                  = var.api_image
  worker_image               = var.worker_image
  
  # Task configuration
  api_cpu                    = var.api_cpu
  api_memory                 = var.api_memory
  api_desired_count          = var.api_desired_count
  api_min_capacity           = var.api_min_capacity
  api_max_capacity           = var.api_max_capacity
  
  worker_cpu                 = var.worker_cpu
  worker_memory              = var.worker_memory
  worker_desired_count       = var.worker_desired_count
  worker_min_capacity        = var.worker_min_capacity
  worker_max_capacity        = var.worker_max_capacity
  
  # Secrets
  secrets_arn                = module.secrets.secret_arn
  
  # Database and cache
  database_security_group_id = module.rds.security_group_id
  redis_security_group_id    = module.elasticache.security_group_id
  
  tags = local.common_tags
}

# CloudFront for Dashboard
module "cloudfront" {
  source = "./modules/cloudfront"
  
  name_prefix         = local.name_prefix
  s3_bucket_name      = "${local.name_prefix}-dashboard"
  certificate_arn     = var.acm_certificate_arn
  domain_name         = var.dashboard_domain_name
  
  tags = local.common_tags
}

# Outputs
output "vpc_id" {
  description = "VPC ID"
  value       = module.vpc.vpc_id
}

output "alb_dns_name" {
  description = "ALB DNS name"
  value       = module.alb.alb_dns_name
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID"
  value       = module.cloudfront.distribution_id
}

output "cloudfront_domain_name" {
  description = "CloudFront domain name"
  value       = module.cloudfront.domain_name
}

output "rds_endpoint" {
  description = "RDS endpoint"
  value       = module.rds.endpoint
  sensitive   = true
}

output "redis_endpoint" {
  description = "Redis endpoint"
  value       = module.elasticache.primary_endpoint_address
  sensitive   = true
}

output "ecs_cluster_name" {
  description = "ECS cluster name"
  value       = module.ecs.cluster_name
}

output "api_service_name" {
  description = "API service name"
  value       = module.ecs.api_service_name
}

output "worker_service_name" {
  description = "Worker service name"
  value       = module.ecs.worker_service_name
}
