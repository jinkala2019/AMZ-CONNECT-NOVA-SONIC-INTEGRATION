# ECS EC2 Migration Guide

This guide explains the migration from ECS Fargate to ECS EC2 for the Nova Sonic WebRTC Bridge deployment.

## Why Migrate to ECS EC2?

### Problems with Fargate
1. **Call Control Loss**: When Lambda invokes a Fargate task, the call control is lost after Lambda returns control to the contact flow
2. **No Nova Sonic Response**: The system doesn't see responses from Nova Sonic due to the architecture limitations
3. **Cold Start Delays**: Fargate tasks have longer cold start times compared to EC2 instances
4. **Limited Control**: Less control over the underlying infrastructure and networking

### Benefits of ECS EC2
1. **Better Performance**: EC2 instances provide better performance for real-time audio processing
2. **Persistent Connections**: EC2 instances maintain persistent connections throughout the call duration
3. **Better Control**: More control over networking, security groups, and instance configuration
4. **Cost Optimization**: Can use Spot instances and reserved instances for cost savings
5. **Auto Scaling**: Better auto-scaling capabilities with more granular control

## Key Changes Made

### 1. Lambda Function Changes
- **File**: `lambda-invoke-fargate.ts` → `lambda/lambda-invoke-ecs-ec2.ts`
- **Launch Type**: `FARGATE` → `EC2`
- **Network Configuration**: Removed `awsvpcConfiguration` (not needed for EC2)
- **Function Name**: `invoke-fargate-task` → `invoke-ecs-ec2-task`

### 2. Task Definition Changes
- **File**: `task-definition.json` → `ecs-task-definition-ec2.json`
- **Network Mode**: `awsvpc` → `bridge`
- **Compatibility**: `FARGATE` → `EC2`
- **Port Mappings**: Added `hostPort` mapping for EC2
- **Health Checks**: Added container health checks

### 3. Infrastructure Changes
- **CloudFormation Template**: `ecs-ec2-deployment.yaml` (new)
- **ECS Cluster**: `nova-sonic-cluster` → `nova-sonic-ecs-cluster`
- **Auto Scaling Group**: Added for EC2 instance management
- **Launch Template**: Added for EC2 instance configuration
- **Load Balancer**: Added for health checks and monitoring

### 4. Deployment Script
- **File**: `deploy-ecs-ec2.sh` (new)
- **Automated Deployment**: Complete automation of EC2 infrastructure
- **IAM Roles**: Automatic creation of required IAM roles
- **ECR Integration**: Automated Docker image building and pushing

## Architecture Comparison

### Fargate Architecture
```
Amazon Connect → Lambda → Fargate Task → KVS → Nova Sonic
     ↓              ↓           ↓         ↓        ↓
   Call Flow    Quick Start   Container  Stream   AI Response
   (15min max)   (60s max)   (15min max)  Real-time  Real-time
```

### EC2 Architecture
```
Amazon Connect → Lambda → ECS EC2 Task → KVS → Nova Sonic
     ↓              ↓           ↓         ↓        ↓
   Call Flow    Quick Start   Container  Stream   AI Response
   (15min max)   (60s max)   (No limit)  Real-time  Real-time
```

## Migration Steps

### 1. Backup Current Deployment
```bash
# Export current configuration
aws ecs describe-task-definition --task-definition nova-sonic-bridge > backup-task-def.json
aws lambda get-function --function-name invoke-fargate-task > backup-lambda.json
```

### 2. Deploy New EC2 Infrastructure
```bash
# Run the deployment script
chmod +x deploy-ecs-ec2.sh
./deploy-ecs-ec2.sh
```

### 3. Update Amazon Connect Contact Flow
- Change Lambda function ARN from `invoke-fargate-task` to `invoke-ecs-ec2-task`
- Test the new contact flow

### 4. Verify Deployment
```bash
# Check ECS cluster
aws ecs describe-clusters --clusters nova-sonic-ecs-cluster

# Check Lambda function
aws lambda get-function --function-name invoke-ecs-ec2-task

# Test Lambda invocation
aws lambda invoke --function-name invoke-ecs-ec2-task \
  --payload '{"StreamARN":"test","ContactId":"test","CustomerPhoneNumber":"test"}' \
  response.json
```

### 5. Monitor and Test
```bash
# Monitor logs
aws logs tail /aws/lambda/invoke-ecs-ec2-task --follow
aws logs tail /ecs/nova-sonic-bridge --follow

# Test end-to-end
# Make a call to your Amazon Connect number
```

## Configuration Differences

### Environment Variables
| Fargate | EC2 |
|---------|-----|
| `SUBNET_IDS` | Not required |
| `SECURITY_GROUP_IDS` | Not required |
| `ECS_CLUSTER_NAME` | `nova-sonic-ecs-cluster` |
| `ECS_TASK_DEFINITION` | `nova-sonic-bridge:1` |

### Network Configuration
| Fargate | EC2 |
|---------|-----|
| `awsvpc` network mode | `bridge` network mode |
| Requires subnet configuration | Uses instance networking |
| ENI per task | Shared networking |

### Resource Allocation
| Fargate | EC2 |
|---------|-----|
| CPU/Memory per task | CPU/Memory per instance |
| Pay per task | Pay per instance |
| Limited customization | Full customization |

## Troubleshooting

### Common Issues

1. **Task Fails to Start**
   - Check ECS instance role permissions
   - Verify task definition compatibility
   - Check CloudWatch logs

2. **Network Connectivity Issues**
   - Verify security group rules
   - Check VPC and subnet configuration
   - Test connectivity from EC2 instances

3. **Lambda Invocation Fails**
   - Check Lambda execution role
   - Verify ECS cluster name
   - Check task definition ARN

4. **Performance Issues**
   - Monitor EC2 instance metrics
   - Check auto-scaling configuration
   - Optimize instance types

### Monitoring Commands
```bash
# Check ECS cluster status
aws ecs describe-clusters --clusters nova-sonic-ecs-cluster

# List running tasks
aws ecs list-tasks --cluster nova-sonic-ecs-cluster

# Describe specific task
aws ecs describe-tasks --cluster nova-sonic-ecs-cluster --tasks <task-arn>

# Check EC2 instances
aws ec2 describe-instances --filters "Name=tag:Name,Values=Nova Sonic ECS Instance"

# Monitor logs
aws logs tail /aws/lambda/invoke-ecs-ec2-task --follow
aws logs tail /ecs/nova-sonic-bridge --follow
```

## Rollback Plan

If issues occur, you can rollback to Fargate:

1. **Restore Lambda Function**
   ```bash
   aws lambda update-function-code --function-name invoke-fargate-task --zip-file fileb://backup-lambda.zip
   ```

2. **Restore Task Definition**
   ```bash
   aws ecs register-task-definition --cli-input-json file://backup-task-def.json
   ```

3. **Update Contact Flow**
   - Change Lambda ARN back to `invoke-fargate-task`

4. **Clean Up EC2 Resources**
   ```bash
   aws cloudformation delete-stack --stack-name nova-sonic-ecs-stack
   ```

## Cost Comparison

### Fargate Costs
- Pay per task execution
- CPU and memory allocation per task
- No upfront costs
- Higher per-task costs

### EC2 Costs
- Pay per instance hour
- Shared resources across tasks
- Can use Spot instances for savings
- Reserved instances for predictable workloads
- Generally lower costs for high-volume workloads

## Performance Benefits

1. **Faster Task Startup**: EC2 instances are already running
2. **Better Resource Utilization**: Shared resources across tasks
3. **Persistent Connections**: No connection drops during calls
4. **Lower Latency**: Direct instance networking
5. **Better Monitoring**: More granular metrics and logs

## Security Considerations

1. **Network Security**: Use private subnets for EC2 instances
2. **IAM Roles**: Follow principle of least privilege
3. **Security Groups**: Restrict access to necessary ports only
4. **Encryption**: Enable encryption at rest and in transit
5. **Monitoring**: Set up CloudWatch alarms and logging
