#!/bin/bash

# ECS Instance Troubleshooting Script
echo "🔍 ECS Instance Troubleshooting Script"
echo "======================================"

# Get stack name
STACK_NAME="nova-sonic-ecs-stack"
REGION="us-east-1"

echo "📋 Checking ECS Cluster..."
CLUSTER_NAME=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION --query 'Stacks[0].Outputs[?OutputKey==`ECSClusterName`].OutputValue' --output text 2>/dev/null || echo "nova-sonic-ecs-cluster")

echo "ECS Cluster: $CLUSTER_NAME"

# Check ECS cluster status
echo "📊 ECS Cluster Status:"
aws ecs describe-clusters --clusters $CLUSTER_NAME --region $REGION --query 'clusters[0].{Status:status,RunningTasksCount:runningTasksCount,PendingTasksCount:pendingTasksCount,RegisteredContainerInstancesCount:registeredContainerInstancesCount}' --output table

# List container instances
echo "🖥️  Container Instances:"
aws ecs list-container-instances --cluster $CLUSTER_NAME --region $REGION --query 'containerInstanceArns' --output table

# Get EC2 instances
echo "🖥️  EC2 Instances:"
aws ec2 describe-instances --filters "Name=tag:Name,Values=Nova Sonic ECS Instance" "Name=instance-state-name,Values=running" --region $REGION --query 'Reservations[*].Instances[*].{InstanceId:InstanceId,State:State.Name,PrivateIP:PrivateIpAddress,PublicIP:PublicIpAddress,SubnetId:SubnetId,LaunchTime:LaunchTime}' --output table

# Check Auto Scaling Group
echo "📈 Auto Scaling Group:"
ASG_NAME=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION --query 'Stacks[0].Outputs[?OutputKey==`AutoScalingGroupName`].OutputValue' --output text 2>/dev/null || echo "nova-sonic-ecs-stack-asg")

aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names $ASG_NAME --region $REGION --query 'AutoScalingGroups[0].{DesiredCapacity:DesiredCapacity,MinSize:MinSize,MaxSize:MaxSize,Instances:Instances[*].{InstanceId:InstanceId,HealthStatus:HealthStatus,LifecycleState:LifecycleState}}' --output table

echo "🔍 To check EC2 instance logs, SSH into an instance and run:"
echo "sudo tail -f /var/log/ecs/ecs-agent.log"
echo "sudo tail -f /var/log/ecs/ecs-init.log"
echo "sudo systemctl status ecs"
