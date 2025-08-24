#!/bin/bash

# Simple ECS UserData script
echo "Starting ECS setup..."

# Update system
yum update -y

# Install ECS agent
yum install -y ecs-init

# Create ECS config directory
mkdir -p /etc/ecs

# Configure ECS cluster
cat > /etc/ecs/ecs.config << 'EOF'
ECS_CLUSTER=nova-sonic-ecs-cluster
ECS_ENABLE_TASK_ENI=true
ECS_ENABLE_TASK_IAM_ROLE=true
ECS_ENABLE_CONTAINER_METADATA=true
ECS_LOGLEVEL=debug
EOF

# Start ECS service
systemctl enable ecs
systemctl start ecs

# Wait a bit for ECS to start
sleep 30

# Check ECS status
systemctl status ecs

echo "ECS setup completed"
