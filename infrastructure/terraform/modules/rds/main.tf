# RDS PostgreSQL Module for TaskFlow

# DB Subnet Group
resource "aws_db_subnet_group" "main" {
  name       = "${var.name_prefix}-db-subnet-group"
  subnet_ids = var.subnet_ids
  
  tags = merge(
    var.tags,
    {
      Name = "${var.name_prefix}-db-subnet-group"
    }
  )
}

# Security Group
resource "aws_security_group" "rds" {
  name        = "${var.name_prefix}-rds-sg"
  description = "Security group for RDS PostgreSQL"
  vpc_id      = var.vpc_id
  
  ingress {
    description     = "PostgreSQL from allowed security groups"
    from_port       = 5432
    to_port         = 5432
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
      Name = "${var.name_prefix}-rds-sg"
    }
  )
}

# Parameter Group
resource "aws_db_parameter_group" "main" {
  name   = "${var.name_prefix}-postgres16"
  family = "postgres16"
  
  parameter {
    name  = "log_connections"
    value = "1"
  }
  
  parameter {
    name  = "log_disconnections"
    value = "1"
  }
  
  parameter {
    name  = "log_statement"
    value = "all"
  }
  
  parameter {
    name  = "shared_preload_libraries"
    value = "pg_stat_statements"
  }
  
  parameter {
    name  = "pg_stat_statements.track"
    value = "all"
  }
  
  parameter {
    name  = "max_connections"
    value = "200"
  }
  
  tags = merge(
    var.tags,
    {
      Name = "${var.name_prefix}-postgres16-params"
    }
  )
}

# Random password for master user
resource "random_password" "master" {
  length  = 32
  special = true
}

# RDS Instance
resource "aws_db_instance" "main" {
  identifier     = "${var.name_prefix}-postgres"
  engine         = "postgres"
  engine_version = var.engine_version
  
  instance_class        = var.instance_class
  allocated_storage     = var.allocated_storage
  max_allocated_storage = var.max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true
  
  db_name  = var.database_name
  username = var.master_username
  password = random_password.master.result
  
  db_subnet_group_name   = aws_db_subnet_group.main.name
  parameter_group_name   = aws_db_parameter_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  
  multi_az               = var.multi_az
  publicly_accessible    = false
  
  backup_retention_period = var.backup_retention_period
  backup_window          = "03:00-04:00"
  maintenance_window     = "sun:04:00-sun:05:00"
  
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  
  deletion_protection = var.deletion_protection
  skip_final_snapshot = var.skip_final_snapshot
  final_snapshot_identifier = var.skip_final_snapshot ? null : "${var.name_prefix}-final-snapshot-${formatdate("YYYY-MM-DD-hhmm", timestamp())}"
  
  performance_insights_enabled    = true
  performance_insights_retention_period = 7
  
  auto_minor_version_upgrade = true
  
  tags = merge(
    var.tags,
    {
      Name = "${var.name_prefix}-postgres"
    }
  )
}

# Store password in Secrets Manager
resource "aws_secretsmanager_secret" "db_password" {
  name = "${var.name_prefix}-db-master-password"
  
  tags = merge(
    var.tags,
    {
      Name = "${var.name_prefix}-db-master-password"
    }
  )
}

resource "aws_secretsmanager_secret_version" "db_password" {
  secret_id     = aws_secretsmanager_secret.db_password.id
  secret_string = random_password.master.result
}

# CloudWatch Alarms
resource "aws_cloudwatch_metric_alarm" "cpu" {
  alarm_name          = "${var.name_prefix}-rds-cpu-utilization"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "2"
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = "300"
  statistic           = "Average"
  threshold           = "80"
  alarm_description   = "This metric monitors RDS CPU utilization"
  
  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.id
  }
  
  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "storage" {
  alarm_name          = "${var.name_prefix}-rds-free-storage"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = "2"
  metric_name         = "FreeStorageSpace"
  namespace           = "AWS/RDS"
  period              = "300"
  statistic           = "Average"
  threshold           = "10737418240"  # 10 GB in bytes
  alarm_description   = "This metric monitors RDS free storage space"
  
  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.id
  }
  
  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "connections" {
  alarm_name          = "${var.name_prefix}-rds-database-connections"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "2"
  metric_name         = "DatabaseConnections"
  namespace           = "AWS/RDS"
  period              = "300"
  statistic           = "Average"
  threshold           = "180"  # 90% of max_connections
  alarm_description   = "This metric monitors RDS database connections"
  
  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.id
  }
  
  tags = var.tags
}
