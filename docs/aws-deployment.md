# AWS Deployment Guide

Complete guide for deploying TaskFlow to AWS using Terraform, ECS Fargate, and managed services.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Prerequisites](#prerequisites)
- [Cost Estimation](#cost-estimation)
- [Infrastructure Setup](#infrastructure-setup)
- [Deployment Process](#deployment-process)
- [Post-Deployment](#post-deployment)
- [Monitoring and Maintenance](#monitoring-and-maintenance)
- [Troubleshooting](#troubleshooting)
- [Rollback Procedures](#rollback-procedures)

## Architecture Overview

TaskFlow on AWS uses a fully managed, highly available architecture:

```
┌─────────────────────────────────────────────────────────────┐
│                        Route 53 (DNS)                        │
└──────────────────┬──────────────────────┬───────────────────┘
                   │                      │
         ┌─────────▼──────────┐  ┌────────▼─────────┐
         │   CloudFront CDN   │  │  Application     │
         │    (Dashboard)     │  │  Load Balancer   │
         └─────────┬──────────┘  └────────┬─────────┘
                   │                      │
         ┌─────────▼──────────┐  ┌────────▼─────────┐
         │   S3 Bucket        │  │   ECS Fargate    │
         │  (Static Assets)   │  │   API Cluster    │
         └────────────────────┘  └────────┬─────────┘
                                          │
                          ┌───────────────┼───────────────┐
                          │               │               │
                  ┌───────▼──────┐ ┌──────▼──────┐ ┌─────▼─────┐
                  │ ECS Fargate  │ │     RDS     │ │ElastiCache│
                  │   Workers    │ │ PostgreSQL  │ │   Redis   │
                  └───────┬──────┘ └─────────────┘ └───────────┘
                          │
                  ┌───────▼──────┐
                  │   MSK        │
                  │  (Kafka)     │
                  └──────────────┘
```

### Components

- **VPC**: Multi-AZ network with public and private subnets
- **ECS Fargate**: Serverless container orchestration for API and Workers
- **Application Load Balancer**: HTTPS traffic distribution with SSL termination
- **RDS PostgreSQL**: Multi-AZ managed database with automated backups
- **ElastiCache Redis**: In-memory cache with automatic failover
- **MSK (Kafka)**: Managed event streaming platform
- **CloudFront**: Global CDN for dashboard static assets
- **Secrets Manager**: Secure storage for credentials and API keys
- **CloudWatch**: Centralized logging and monitoring

## Prerequisites

### Required Tools

1. **AWS CLI** (v2.x)

   ```bash
   # Install AWS CLI
   curl "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o "AWSCLIV2.pkg"
   sudo installer -pkg AWSCLIV2.pkg -target /

   # Configure credentials
   aws configure
   ```

2. **Terraform** (>= 1.5.0)

   ```bash
   # Install via Homebrew
   brew install terraform

   # Verify installation
   terraform version
   ```

3. **Docker** (for building images)

   ```bash
   # Verify Docker is running
   docker --version
   ```

4. **GitHub CLI** (for container registry)
   ```bash
   brew install gh
   gh auth login
   ```

### AWS Account Setup

1. **IAM User with Permissions**
   - AdministratorAccess (for initial setup)
   - Or custom policy with permissions for:
     - VPC, EC2, ECS, RDS, ElastiCache, MSK
     - IAM, Secrets Manager, CloudWatch
     - S3, CloudFront, Route53, ACM

2. **S3 Backend for Terraform State**

   ```bash
   # Create S3 bucket for state
   aws s3api create-bucket \
     --bucket taskflow-terraform-state \
     --region us-east-1

   # Enable versioning
   aws s3api put-bucket-versioning \
     --bucket taskflow-terraform-state \
     --versioning-configuration Status=Enabled

   # Enable encryption
   aws s3api put-bucket-encryption \
     --bucket taskflow-terraform-state \
     --server-side-encryption-configuration '{
       "Rules": [{
         "ApplyServerSideEncryptionByDefault": {
           "SSEAlgorithm": "AES256"
         }
       }]
     }'

   # Create DynamoDB table for state locking
   aws dynamodb create-table \
     --table-name taskflow-terraform-locks \
     --attribute-definitions AttributeName=LockID,AttributeType=S \
     --key-schema AttributeName=LockID,KeyType=HASH \
     --provisioned-throughput ReadCapacityUnits=5,WriteCapacityUnits=5 \
     --region us-east-1
   ```

3. **ACM Certificate** (for HTTPS)

   ```bash
   # Request certificate for your domain
   aws acm request-certificate \
     --domain-name "api.yourdomain.com" \
     --subject-alternative-names "*.yourdomain.com" \
     --validation-method DNS \
     --region us-east-1

   # Note the Certificate ARN for later use
   ```

4. **Route53 Hosted Zone** (optional, for custom domain)
   ```bash
   # Create hosted zone
   aws route53 create-hosted-zone \
     --name yourdomain.com \
     --caller-reference $(date +%s)
   ```

## Cost Estimation

### Monthly Cost Breakdown (us-east-1)

| Service                       | Configuration                | Monthly Cost    |
| ----------------------------- | ---------------------------- | --------------- |
| **ECS Fargate (API)**         | 2 tasks × 0.5 vCPU, 1GB RAM  | ~$30            |
| **ECS Fargate (Workers)**     | 3 tasks × 1 vCPU, 2GB RAM    | ~$90            |
| **RDS PostgreSQL**            | db.t3.medium, Multi-AZ, 50GB | ~$150           |
| **ElastiCache Redis**         | 2 × cache.t3.medium          | ~$120           |
| **MSK**                       | 3 × kafka.t3.small brokers   | ~$250           |
| **Application Load Balancer** | Standard pricing             | ~$25            |
| **NAT Gateway**               | 3 × NAT (high availability)  | ~$100           |
| **CloudWatch Logs**           | ~10GB/month                  | ~$5             |
| **CloudFront**                | 1TB transfer                 | ~$85            |
| **S3**                        | Static assets, logs          | ~$5             |
| **Data Transfer**             | Outbound                     | ~$20            |
| **Secrets Manager**           | 10 secrets                   | ~$4             |
| **Total**                     |                              | **~$884/month** |

### Cost Optimization Tips

1. **Development Environment**: Use smaller instance types and single-AZ deployments
2. **NAT Gateway**: Consider single NAT for non-production (~$67/month savings)
3. **Reserved Capacity**: Commit to 1-year RDS/ElastiCache reserved instances (~30% savings)
4. **Auto-scaling**: Configure aggressive scale-down policies during low traffic
5. **CloudWatch Logs**: Set retention to 7 days for non-production
6. **S3 Lifecycle**: Archive old logs to Glacier after 30 days

## Infrastructure Setup

### Step 1: Clone Repository and Navigate

```bash
git clone https://github.com/YOUR_USERNAME/Resilient_TaskFlow.git
cd Resilient_TaskFlow/infrastructure/terraform
```

### Step 2: Create Environment Configuration

Create a `terraform.tfvars` file for your environment:

```hcl
# terraform.tfvars (Production)
environment = "prod"
aws_region  = "us-east-1"

# VPC Configuration
vpc_cidr             = "10.0.0.0/16"
public_subnet_cidrs  = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
private_subnet_cidrs = ["10.0.11.0/24", "10.0.12.0/24", "10.0.13.0/24"]
enable_nat_gateway   = true

# RDS Configuration
rds_instance_class          = "db.t3.medium"
rds_allocated_storage       = 50
rds_max_allocated_storage   = 200
rds_multi_az                = true
database_name               = "taskflow"
database_username           = "taskflow_admin"

# ElastiCache Configuration
redis_node_type             = "cache.t3.medium"
redis_num_cache_nodes       = 2
redis_automatic_failover    = true

# MSK Configuration
kafka_broker_nodes          = 3
kafka_instance_type         = "kafka.t3.small"
kafka_ebs_volume_size       = 100

# ECS Configuration
api_image           = "ghcr.io/YOUR_USERNAME/taskflow-api:latest"
worker_image        = "ghcr.io/YOUR_USERNAME/taskflow-worker:latest"
api_desired_count   = 2
api_min_capacity    = 2
api_max_capacity    = 10
worker_desired_count = 3
worker_min_capacity  = 1
worker_max_capacity  = 20

# SSL Certificate
acm_certificate_arn = "arn:aws:acm:us-east-1:ACCOUNT_ID:certificate/CERT_ID"

# Domain
dashboard_domain_name = "dashboard.yourdomain.com"

# Secrets (use environment variables instead of hardcoding)
jwt_secret = "WILL_BE_SET_VIA_ENV"
api_key    = "WILL_BE_SET_VIA_ENV"
```

### Step 3: Set Secrets via Environment Variables

```bash
# Export sensitive variables
export TF_VAR_jwt_secret="your-secure-jwt-secret-here"
export TF_VAR_api_key="your-secure-api-key-here"
```

### Step 4: Initialize Terraform

```bash
# Initialize Terraform and download providers
terraform init

# Validate configuration
terraform validate

# Format code
terraform fmt -recursive
```

### Step 5: Plan Infrastructure

```bash
# Create execution plan
terraform plan -out=tfplan

# Review the plan carefully
# Expected resources: ~100+ resources across all modules
```

### Step 6: Apply Infrastructure

```bash
# Apply the plan
terraform apply tfplan

# Confirm with 'yes' when prompted
# Deployment takes approximately 15-20 minutes
```

### Step 7: Save Outputs

```bash
# Export important outputs
terraform output -json > outputs.json

# View specific outputs
terraform output alb_dns_name
terraform output cloudfront_domain_name
```

## Deployment Process

### Build and Push Docker Images

1. **Build Images Locally**

   ```bash
   # Build API image
   docker build -t ghcr.io/YOUR_USERNAME/taskflow-api:latest -f apps/api/Dockerfile .

   # Build Worker image
   docker build -t ghcr.io/YOUR_USERNAME/taskflow-worker:latest -f apps/worker/Dockerfile .

   # Build Dashboard image
   docker build -t ghcr.io/YOUR_USERNAME/taskflow-dashboard:latest -f apps/dashboard/Dockerfile apps/dashboard
   ```

2. **Authenticate to GitHub Container Registry**

   ```bash
   echo $GITHUB_TOKEN | docker login ghcr.io -u YOUR_USERNAME --password-stdin
   ```

3. **Push Images**
   ```bash
   docker push ghcr.io/YOUR_USERNAME/taskflow-api:latest
   docker push ghcr.io/YOUR_USERNAME/taskflow-worker:latest
   docker push ghcr.io/YOUR_USERNAME/taskflow-dashboard:latest
   ```

### Database Migration

1. **Get RDS Endpoint**

   ```bash
   RDS_ENDPOINT=$(terraform output -raw rds_endpoint)
   ```

2. **Create Bastion Host** (if needed for direct access)

   ```bash
   # Launch EC2 instance in public subnet with PostgreSQL client
   # Or use AWS Systems Manager Session Manager
   ```

3. **Run Migrations**
   ```bash
   # Connect via bastion or use ECS task
   DATABASE_URL="postgresql://user:pass@${RDS_ENDPOINT}/taskflow" \
     pnpm run migrate:deploy
   ```

### Deploy Dashboard to S3/CloudFront

1. **Build Dashboard**

   ```bash
   cd apps/dashboard
   pnpm run build
   ```

2. **Upload to S3**

   ```bash
   aws s3 sync dist/ s3://taskflow-prod-dashboard/ --delete
   ```

3. **Invalidate CloudFront Cache**
   ```bash
   DISTRIBUTION_ID=$(terraform output -raw cloudfront_distribution_id)
   aws cloudfront create-invalidation \
     --distribution-id $DISTRIBUTION_ID \
     --paths "/*"
   ```

### Update ECS Services

The ECS services will automatically pull the latest images on next deployment:

```bash
# Force new deployment for API
aws ecs update-service \
  --cluster taskflow-prod-cluster \
  --service taskflow-prod-api \
  --force-new-deployment

# Force new deployment for Workers
aws ecs update-service \
  --cluster taskflow-prod-cluster \
  --service taskflow-prod-worker \
  --force-new-deployment
```

## Post-Deployment

### DNS Configuration

1. **Get Load Balancer DNS**

   ```bash
   terraform output alb_dns_name
   ```

2. **Create Route53 Records**
   ```bash
   # API endpoint
   aws route53 change-resource-record-sets \
     --hosted-zone-id YOUR_ZONE_ID \
     --change-batch '{
       "Changes": [{
         "Action": "CREATE",
         "ResourceRecordSet": {
           "Name": "api.yourdomain.com",
           "Type": "CNAME",
           "TTL": 300,
           "ResourceRecords": [{"Value": "ALB_DNS_NAME"}]
         }
       }]
     }'

   # Dashboard (CloudFront)
   aws route53 change-resource-record-sets \
     --hosted-zone-id YOUR_ZONE_ID \
     --change-batch '{
       "Changes": [{
         "Action": "CREATE",
         "ResourceRecordSet": {
           "Name": "dashboard.yourdomain.com",
           "Type": "CNAME",
           "TTL": 300,
           "ResourceRecords": [{"Value": "CLOUDFRONT_DOMAIN"}]
         }
       }]
     }'
   ```

### Health Checks

```bash
# Check API health
curl https://api.yourdomain.com/health

# Expected response:
# {"status":"healthy","timestamp":"2024-01-15T10:30:00Z"}

# Check dashboard
curl https://dashboard.yourdomain.com

# Expected: HTML content
```

### Verify Services

```bash
# Check ECS tasks
aws ecs list-tasks --cluster taskflow-prod-cluster

# Check RDS status
aws rds describe-db-instances \
  --db-instance-identifier taskflow-prod-postgres \
  --query 'DBInstances[0].DBInstanceStatus'

# Check ElastiCache status
aws elasticache describe-replication-groups \
  --replication-group-id taskflow-prod-redis \
  --query 'ReplicationGroups[0].Status'

# Check MSK status
aws kafka list-clusters --query 'ClusterInfoList[?ClusterName==`taskflow-prod-msk`]'
```

## Monitoring and Maintenance

### CloudWatch Dashboards

Create a custom dashboard:

```bash
aws cloudwatch put-dashboard \
  --dashboard-name TaskFlow-Production \
  --dashboard-body file://cloudwatch-dashboard.json
```

### Key Metrics to Monitor

1. **API Service**
   - Request rate (requests/minute)
   - Error rate (4xx, 5xx)
   - Response time (p50, p95, p99)
   - CPU/Memory utilization

2. **Worker Service**
   - Tasks processed/minute
   - Task success/failure rate
   - Queue depth
   - CPU/Memory utilization

3. **RDS**
   - CPU utilization (<80%)
   - Free storage space (>10GB)
   - Database connections (<180)
   - Read/Write IOPS

4. **ElastiCache**
   - CPU utilization (<75%)
   - Memory usage (<90%)
   - Cache hit rate (>90%)
   - Evictions (should be minimal)

5. **MSK**
   - Broker CPU (<70%)
   - Disk usage per broker (<80%)
   - Under-replicated partitions (0)
   - Network throughput

### Automated Backups

All managed services have automated backups enabled:

- **RDS**: Daily automated backups, 7-day retention
- **ElastiCache**: Daily snapshots, 5-day retention
- **MSK**: Continuous data retention (24 hours)

### Manual Backup

```bash
# RDS snapshot
aws rds create-db-snapshot \
  --db-instance-identifier taskflow-prod-postgres \
  --db-snapshot-identifier taskflow-manual-$(date +%Y%m%d-%H%M%S)

# ElastiCache snapshot
aws elasticache create-snapshot \
  --replication-group-id taskflow-prod-redis \
  --snapshot-name taskflow-manual-$(date +%Y%m%d-%H%M%S)
```

### Scaling Operations

1. **Horizontal Scaling (Auto-scaling)**
   - ECS services auto-scale based on CPU/memory metrics
   - Configured in Terraform with min/max capacity

2. **Vertical Scaling**

   ```bash
   # Update instance types in terraform.tfvars
   rds_instance_class = "db.t3.large"
   redis_node_type    = "cache.t3.large"

   # Apply changes
   terraform plan
   terraform apply
   ```

3. **Manual ECS Scaling**
   ```bash
   # Scale API service
   aws ecs update-service \
     --cluster taskflow-prod-cluster \
     --service taskflow-prod-api \
     --desired-count 5
   ```

## Troubleshooting

### ECS Tasks Not Starting

1. **Check task logs**

   ```bash
   aws logs tail /ecs/taskflow-prod-api --follow
   ```

2. **Verify secrets are accessible**

   ```bash
   aws secretsmanager get-secret-value \
     --secret-id taskflow-prod-secrets
   ```

3. **Check security groups**
   ```bash
   aws ec2 describe-security-groups \
     --filters "Name=group-name,Values=taskflow-prod-*"
   ```

### Database Connection Issues

1. **Test connectivity from ECS task**

   ```bash
   # Run one-off task with psql
   aws ecs run-task \
     --cluster taskflow-prod-cluster \
     --task-definition taskflow-prod-api \
     --count 1 \
     --launch-type FARGATE
   ```

2. **Check RDS security group inbound rules**

   ```bash
   aws ec2 describe-security-groups \
     --group-ids sg-xxxxx \
     --query 'SecurityGroups[0].IpPermissions'
   ```

3. **Verify RDS endpoint is resolvable**
   ```bash
   nslookup taskflow-prod-postgres.xxxxx.us-east-1.rds.amazonaws.com
   ```

### High CPU/Memory Usage

1. **Check CloudWatch metrics**

   ```bash
   aws cloudwatch get-metric-statistics \
     --namespace AWS/ECS \
     --metric-name CPUUtilization \
     --dimensions Name=ServiceName,Value=taskflow-prod-api \
     --start-time 2024-01-15T00:00:00Z \
     --end-time 2024-01-15T23:59:59Z \
     --period 3600 \
     --statistics Average
   ```

2. **Scale up if needed**
   ```bash
   # Increase desired count
   aws ecs update-service \
     --cluster taskflow-prod-cluster \
     --service taskflow-prod-api \
     --desired-count 4
   ```

### CloudFront Not Serving Latest Content

```bash
# Create invalidation
aws cloudfront create-invalidation \
  --distribution-id E1234EXAMPLE \
  --paths "/*"
```

### Terraform State Issues

```bash
# Pull latest state
terraform refresh

# If state is corrupted, restore from S3 versioning
aws s3api list-object-versions \
  --bucket taskflow-terraform-state \
  --prefix terraform.tfstate

# Download specific version
aws s3api get-object \
  --bucket taskflow-terraform-state \
  --key terraform.tfstate \
  --version-id VERSION_ID \
  terraform.tfstate.backup
```

## Rollback Procedures

### Application Rollback

1. **Rollback to Previous Docker Image**

   ```bash
   # Update task definition with previous image
   aws ecs register-task-definition \
     --family taskflow-prod-api \
     --container-definitions '[{
       "name": "api",
       "image": "ghcr.io/YOUR_USERNAME/taskflow-api:v1.2.3",
       ...
     }]'

   # Update service
   aws ecs update-service \
     --cluster taskflow-prod-cluster \
     --service taskflow-prod-api \
     --task-definition taskflow-prod-api:REVISION
   ```

2. **Rollback Database Migration**
   ```bash
   # Run migration rollback
   DATABASE_URL="..." pnpm run migrate:rollback
   ```

### Infrastructure Rollback

1. **Using Terraform**

   ```bash
   # Rollback to previous state
   terraform plan -target=module.ecs
   terraform apply -target=module.ecs
   ```

2. **Using Git**

   ```bash
   # Checkout previous version
   git checkout v1.2.3
   cd infrastructure/terraform
   terraform plan
   terraform apply
   ```

3. **Restore from Backup**
   ```bash
   # RDS: Restore from snapshot
   aws rds restore-db-instance-from-db-snapshot \
     --db-instance-identifier taskflow-prod-postgres-restored \
     --db-snapshot-identifier taskflow-manual-20240115

   # ElastiCache: Create from snapshot
   aws elasticache create-replication-group \
     --replication-group-id taskflow-prod-redis-restored \
     --snapshot-name taskflow-manual-20240115
   ```

## Security Best Practices

1. **Network Security**
   - All services in private subnets
   - Security groups follow least-privilege
   - NAT gateways for outbound internet access
   - VPC Flow Logs enabled

2. **Data Encryption**
   - RDS: Encryption at rest (AES-256)
   - ElastiCache: Encryption at rest and in transit
   - S3: Server-side encryption
   - Secrets Manager: Automatic encryption

3. **Access Control**
   - IAM roles for ECS tasks (no long-lived credentials)
   - Secrets Manager for sensitive data
   - MFA enabled for AWS console access
   - Regular credential rotation

4. **Monitoring**
   - CloudWatch Logs for all services
   - CloudWatch Alarms for critical metrics
   - AWS Config for compliance monitoring
   - VPC Flow Logs for network monitoring

## Additional Resources

- [Terraform AWS Provider Documentation](https://registry.terraform.io/providers/hashicorp/aws/latest/docs)
- [ECS Best Practices](https://docs.aws.amazon.com/AmazonECS/latest/bestpracticesguide/)
- [RDS PostgreSQL Best Practices](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_BestPractices.html)
- [MSK Best Practices](https://docs.aws.amazon.com/msk/latest/developerguide/bestpractices.html)
- [AWS Well-Architected Framework](https://aws.amazon.com/architecture/well-architected/)

## Support

For issues or questions:

- GitHub Issues: https://github.com/YOUR_USERNAME/Resilient_TaskFlow/issues
- Documentation: https://github.com/YOUR_USERNAME/Resilient_TaskFlow/tree/main/docs
- AWS Support: https://console.aws.amazon.com/support/
