# Deployment Guide: Amazon Connect to Nova Sonic WebRTC Bridge (ECS EC2)

This guide explains how to deploy the WebRTC bridge that connects Amazon Connect to Nova Sonic using KVS signaling channels with ECS EC2 for better performance and control over long-running calls.

## Architecture Overview

```
Amazon Connect Contact Flow
    ↓ (Start Media Streaming → KVS Signaling Channel)
Lambda Function
    ↓ (Invoke ECS EC2 Task)
ECS EC2 Task (WebRTC Bridge)
    ↓ (Connect to KVS Signaling Channel)
KVS Signaling Channel
    ↓ (WebRTC Connection)
Amazon Connect Media Stream
    ↓ (Audio Processing)
Nova Sonic AI
```

## Prerequisites

1. **AWS Account Setup**
   - AWS CLI configured
   - Appropriate permissions for ECS, Lambda, IAM, KVS, and Bedrock
   - Amazon Connect instance configured

2. **Required AWS Services**
   - Amazon Connect
   - Amazon Bedrock (with Nova Sonic access)
   - Amazon Kinesis Video Streams
   - Amazon ECS (EC2)
   - AWS Lambda
   - Amazon ECR (for container images)
   - Amazon EC2 (for ECS instances)
   - Auto Scaling Groups

## Step 1: Build and Package the Application

### 1.1 Build the TypeScript Application
```bash
npm install
npm run build
```

### 1.2 Create Docker Image
```dockerfile
# Dockerfile
FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm ci --only=production

# Copy built application
COPY dist/ ./dist/
COPY WebRTCBridgeServer.js ./

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start the application
CMD ["node", "WebRTCBridgeServer.js"]
```

### 1.3 Build and Push to ECR
```bash
# Create ECR repository
aws ecr create-repository --repository-name nova-sonic-bridge

# Get ECR login token
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <account-id>.dkr.ecr.us-east-1.amazonaws.com

# Build and tag image
docker build -t nova-sonic-bridge .
docker tag nova-sonic-bridge:latest <account-id>.dkr.ecr.us-east-1.amazonaws.com/nova-sonic-bridge:latest

# Push to ECR
docker push <account-id>.dkr.ecr.us-east-1.amazonaws.com/nova-sonic-bridge:latest
```

## Step 2: Create ECS Task Definition

### 2.1 Task Definition JSON
```json
{
  "family": "nova-sonic-bridge",
  "networkMode": "bridge",
  "requiresCompatibilities": ["EC2"],
  "cpu": "1024",
  "memory": "2048",
  "executionRoleArn": "arn:aws:iam::<account-id>:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::<account-id>:role/nova-sonic-bridge-task-role",
  "containerDefinitions": [
    {
      "name": "nova-sonic-bridge",
      "image": "<account-id>.dkr.ecr.us-east-1.amazonaws.com/nova-sonic-bridge:latest",
      "portMappings": [
        {
          "containerPort": 3000,
          "hostPort": 3000,
          "protocol": "tcp"
        }
      ],
      "environment": [
        { "name": "AWS_REGION", "value": "us-east-1" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/nova-sonic-bridge",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "ecs"
        }
      },
      "essential": true,
      "healthCheck": {
        "command": [
          "CMD-SHELL",
          "curl -f http://localhost:3000/health || exit 1"
        ],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 60
      }
    }
  ]
}
```

### 2.2 Create Task Definition
```bash
aws ecs register-task-definition --cli-input-json file://ecs-task-definition-ec2.json
```

## Step 3: Deploy ECS EC2 Infrastructure

### 3.1 Deploy CloudFormation Stack
```bash
# Deploy the ECS EC2 infrastructure
aws cloudformation deploy \
    --template-file ecs-ec2-deployment.yaml \
    --stack-name nova-sonic-ecs-stack \
    --capabilities CAPABILITY_NAMED_IAM \
    --region us-east-1
```

## Step 4: Create Required IAM Roles

### 4.1 ECS Task Execution Role
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "*"
    }
  ]
}
```

### 4.2 ECS Task Role (for Nova Sonic Bridge)
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        "bedrock:ListFoundationModels",
        "bedrock:GetFoundationModel"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "kinesisvideo:GetSignalingChannelEndpoint",
        "kinesisvideo:ConnectAsViewer",
        "kinesisvideo:ConnectAsMaster"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:PutRolePolicy",
        "iam:DeleteRole",
        "iam:DeleteRolePolicy"
      ],
      "Resource": "*"
    }
  ]
}
```

### 4.3 Lambda Execution Role
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecs:RunTask",
        "ecs:StopTask",
        "ecs:DescribeTasks"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "iam:PassRole"
      ],
      "Resource": [
        "arn:aws:iam::<account-id>:role/ecsTaskExecutionRole",
        "arn:aws:iam::<account-id>:role/nova-sonic-bridge-task-role"
      ]
    }
  ]
}
```

## Step 5: Deploy Lambda Function

### 5.1 Package Lambda Function
```bash
# Install dependencies for Lambda
cd lambda
npm install
npm run build

# Create deployment package
zip -r lambda-deployment.zip dist/ node_modules/ package.json
```

### 5.2 Deploy Lambda
```bash
aws lambda create-function \
  --function-name invoke-fargate-task \
  --runtime nodejs18.x \
  --role arn:aws:iam::<account-id>:role/lambda-execution-role \
  --handler dist/lambda-invoke-ecs-ec2.handler \
  --zip-file fileb://lambda-deployment.zip \
  --timeout 60 \
  --memory-size 256 \
  --environment Variables='{
    "ECS_CLUSTER_NAME":"nova-sonic-cluster",
    "ECS_TASK_DEFINITION":"nova-sonic-bridge:1",
    "SUBNET_IDS":"subnet-12345678,subnet-87654321",
    "SECURITY_GROUP_IDS":"sg-12345678"
  }'
```

> **Note**: Lambda timeout is set to 60 seconds (enough for ECS EC2 task startup). The Lambda terminates after starting the ECS EC2 task, which handles the entire call duration independently. This solves the 15-minute Lambda timeout limitation for long-running calls.

## Step 6: Create ECS Cluster

```bash
aws ecs create-cluster --cluster-name nova-sonic-ecs-cluster
```

## Step 7: Configure Amazon Connect Contact Flow

### 7.1 Contact Flow Blocks

1. **Start Media Streaming Block**
   - Stream Type: Real-time
   - Audio Track: Both inbound/outbound
   - This automatically creates a KVS stream and provides the Stream ARN

2. **Set Contact Attributes Block**
   - Store Stream ARN: `${MediaStreaming.StreamARN}`
   - Store Contact ID: `${ContactData.ContactId}`
   - Store Customer Phone: `${ContactData.CustomerEndpoint.Address}`

3. **Invoke Lambda Function Block**
   - Function ARN: `arn:aws:lambda:us-east-1:<account-id>:function:invoke-fargate-task`
   - Input Parameters:
     ```json
     {
       "StreamARN": "${MediaStreaming.StreamARN}",
       "ContactId": "${ContactData.ContactId}",
       "CustomerPhoneNumber": "${ContactData.CustomerEndpoint.Address}"
     }
     ```

### 7.2 Deploy Contact Flow
1. Save the contact flow
2. Publish the contact flow
3. Assign to your phone number

## Step 8: Testing the Deployment

### 8.1 Test Lambda Function
```bash
aws lambda invoke \
  --function-name invoke-fargate-task \
  --payload '{
    "StreamARN": "arn:aws:kinesisvideo:us-east-1:123456789012:stream/test-stream",
    "ContactId": "test-contact-123",
    "CustomerPhoneNumber": "+1234567890"
  }' \
  response.json
```

### 8.2 Monitor ECS EC2 Tasks
```bash
# List running tasks
aws ecs list-tasks --cluster nova-sonic-ecs-cluster

# Describe specific task
aws ecs describe-tasks --cluster nova-sonic-ecs-cluster --tasks <task-arn>

# View task logs
aws logs tail /ecs/nova-sonic-bridge --follow
```

### 8.3 Test End-to-End
1. Call your Amazon Connect number
2. Monitor Lambda logs: `aws logs tail /aws/lambda/invoke-ecs-ec2-task --follow`
3. Monitor ECS EC2 task logs: `aws logs tail /ecs/nova-sonic-bridge --follow`
4. Check health endpoint: `curl http://<task-ip>:3000/health`

## Step 9: Monitoring and Troubleshooting

### 9.1 CloudWatch Logs
- Lambda logs: `/aws/lambda/invoke-ecs-ec2-task`
- ECS EC2 logs: `/ecs/nova-sonic-bridge`

### 9.2 Key Metrics to Monitor
- Lambda invocation count and duration
- ECS task count and CPU/memory usage
- KVS stream metrics
- Nova Sonic API calls

### 9.3 Common Issues
1. **Task fails to start**: Check ECS task role permissions
2. **KVS connection fails**: Verify Stream ARN and KVS permissions
3. **Nova Sonic errors**: Check Bedrock access and model availability
4. **Network issues**: Verify subnet and security group configuration

## Step 10: Scaling and Optimization

### 10.1 Auto Scaling
- Configure ECS service auto-scaling based on CPU/memory usage
- Set up Lambda concurrency limits
- Monitor and adjust task definition resources

### 10.2 Cost Optimization
- Use Spot instances for non-critical workloads
- Monitor and optimize task resource allocation
- Set up CloudWatch alarms for cost monitoring

## Step 11: Security Considerations

1. **Network Security**
   - Use private subnets for Fargate tasks
   - Configure security groups to allow only necessary traffic
   - Use VPC endpoints for AWS service access

2. **IAM Security**
   - Follow principle of least privilege
   - Regularly rotate access keys
   - Use IAM roles instead of access keys

3. **Data Security**
   - Encrypt data in transit and at rest
   - Use AWS KMS for sensitive data
   - Implement proper logging and monitoring

## Step 12: Cleanup

To remove all resources:
```bash
# Delete Lambda function
aws lambda delete-function --function-name invoke-ecs-ec2-task

# Delete ECS cluster
aws ecs delete-cluster --cluster nova-sonic-ecs-cluster

# Delete ECR repository
aws ecr delete-repository --repository-name nova-sonic-bridge --force

# Delete IAM roles
aws iam delete-role --role-name nova-sonic-bridge-task-role
aws iam delete-role --role-name lambda-execution-role

# Delete CloudWatch log groups
aws logs delete-log-group --log-group-name /aws/lambda/invoke-ecs-ec2-task
aws logs delete-log-group --log-group-name /ecs/nova-sonic-bridge
```
