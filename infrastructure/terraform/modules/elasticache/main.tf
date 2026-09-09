# ElastiCache Redis Module for TaskFlow

# Subnet Group
resource "aws_elasticache_subnet_group" "main" {
  name       = "${var.name_prefix}-redis-subnet-group"
  subnet_ids = var.subnet_ids
  
  tags = merge(
    var.tags,
    {
      Name = "${var.name_prefix}-redis-subnet-group"
    }
  )
}

# Security Group
resource "aws_security_group" "redis" {
  name        = "${var.name_prefix}-redis-sg"
  description = "Security group for ElastiCache Redis"
  vpc_id      = var.vpc_id
  
  ingress {
    description     = "Redis from allowed security groups"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = var.allowed_security_groups
  }
  
  egress {
    description = "Allow all outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  
  tags = merge(
    var.tags,
    {
      Name = "${var.name_prefix}-redis-sg"
    }
  )
}

# Parameter Group
resource "aws_elasticache_parameter_group" "main" {
  name   = "${var.name_prefix}-redis7"
  family = var.parameter_group_family
  
  parameter {
    name  = "maxmemory-policy"
    value = "allkeys-lru"
  }
  
  parameter {
    name  = "timeout"
    value = "300"
  }
  
  tags = merge(
    var.tags,
    {
      Name = "${var.name_prefix}-redis7-params"
    }
  )
}

# Replication Group (Redis Cluster)
resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "${var.name_prefix}-redis"
  description          = "TaskFlow Redis cluster"
  
  engine               = "redis"
  engine_version       = var.engine_version
  node_type            = var.node_type
  num_cache_clusters   = var.num_cache_nodes
  
  parameter_group_name = aws_elasticache_parameter_group.main.name
  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = [aws_security_group.redis.id]
  
  port = 6379
  
  automatic_failover_enabled = var.automatic_failover_enabled
  multi_az_enabled           = var.automatic_failover_enabled
  
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token_enabled         = true
  auth_token                 = random_password.auth_token.result
  
  snapshot_retention_limit = 5
  snapshot_window          = "03:00-05:00"
  maintenance_window       = "sun:05:00-sun:07:00"
  
  notification_topic_arn = var.sns_topic_arn
  
  auto_minor_version_upgrade = true
  
  log_delivery_configuration {
    destination      = aws_cloudwatch_log_group.redis_slow_log.name
    destination_type = "cloudwatch-logs"
    log_format       = "json"
    log_type         = "slow-log"
  }
  
  tags = merge(
    var.tags,
    {
      Name = "${var.name_prefix}-redis"
    }
  )
}

# Random auth token
resource "random_password" "auth_token" {
  length  = 32
  special = false  # Redis auth token doesn't support special characters
}

# Store auth token in Secrets Manager
resource "aws_secretsmanager_secret" "auth_token" {
  name = "${var.name_prefix}-redis-auth-token"
  
  tags = merge(
    var.tags,
    {
      Name = "${var.name_prefix}-redis-auth-token"
    }
  )
}

resource "aws_secretsmanager_secret_version" "auth_token" {
  secret_id     = aws_secretsmanager_secret.auth_token.id
  secret_string = random_password.auth_token.result
}

# CloudWatch Log Group for slow log
resource "aws_cloudwatch_log_group" "redis_slow_log" {
  name              = "/aws/elasticache/redis/${var.name_prefix}"
  retention_in_days = 7
  
  tags = var.tags
}

# CloudWatch Alarms
resource "aws_cloudwatch_metric_alarm" "cpu" {
  alarm_name          = "${var.name_prefix}-redis-cpu-utilization"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "2"
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ElastiCache"
  period              = "300"
  statistic           = "Average"
  threshold           = "75"
  alarm_description   = "This metric monitors Redis CPU utilization"
  
  dimensions = {
    CacheClusterId = aws_elasticache_replication_group.main.id
  }
  
  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "memory" {
  alarm_name          = "${var.name_prefix}-redis-memory-utilization"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "2"
  metric_name         = "DatabaseMemoryUsagePercentage"
  namespace           = "AWS/ElastiCache"
  period              = "300"
  statistic           = "Average"
  threshold           = "90"
  alarm_description   = "This metric monitors Redis memory utilization"
  
  dimensions = {
    CacheClusterId = aws_elasticache_replication_group.main.id
  }
  
  tags = var.tags
}
