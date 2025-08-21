# Deployment Guide: Amazon Connect to Nova Sonic WebRTC Bridge

This guide explains how to deploy the WebRTC bridge that connects Amazon Connect to Nova Sonic using KVS signaling channels.

## Architecture Overview

```
Amazon Connect Contact Flow
    ↓ (Start Media Streaming → KVS Signaling Channel)
Lambda Function
    ↓ (Invoke Fargate Task)
Fargate Task (WebRTC Bridge)
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
   - Amazon ECS (Fargate)
   - AWS Lambda
   - Amazon ECR (for container images)

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
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
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
      "essential": true
    }
  ]
}
```

### 2.2 Create Task Definition
```bash
aws ecs register-task-definition --cli-input-json file://task-definition.json
```

## Step 3: Create Required IAM Roles

### 3.1 ECS Task Execution Role
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

### 3.2 ECS Task Role (for Nova Sonic Bridge)
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

### 3.3 Lambda Execution Role
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

## Step 4: Deploy Lambda Function

### 4.1 Package Lambda Function
```bash
# Install dependencies for Lambda
cd lambda
npm install
npm run build

# Create deployment package
zip -r lambda-deployment.zip dist/ node_modules/ package.json
```

### 4.2 Deploy Lambda
```bash
aws lambda create-function \
  --function-name invoke-fargate-task \
  --runtime nodejs18.x \
  --role arn:aws:iam::<account-id>:role/lambda-execution-role \
  --handler dist/lambda-invoke-fargate.handler \
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

> **Note**: Lambda timeout is set to 60 seconds (enough for Fargate task startup). The Lambda terminates after starting the Fargate task, which handles the entire call duration independently. This solves the 15-minute Lambda timeout limitation for long-running calls.

## Step 5: Create ECS Cluster

```bash
aws ecs create-cluster --cluster-name nova-sonic-cluster
```

## Step 6: Configure Amazon Connect Contact Flow

### 6.1 Contact Flow Blocks

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

### 6.2 Deploy Contact Flow
1. Save the contact flow
2. Publish the contact flow
3. Assign to your phone number

## Step 7: Testing the Deployment

### 7.1 Test Lambda Function
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

### 7.2 Monitor Fargate Tasks
```bash
# List running tasks
aws ecs list-tasks --cluster nova-sonic-cluster

# Describe specific task
aws ecs describe-tasks --cluster nova-sonic-cluster --tasks <task-arn>

# View task logs
aws logs tail /ecs/nova-sonic-bridge --follow
```

### 7.3 Test End-to-End
1. Call your Amazon Connect number
2. Monitor Lambda logs: `aws logs tail /aws/lambda/invoke-fargate-task --follow`
3. Monitor Fargate task logs: `aws logs tail /ecs/nova-sonic-bridge --follow`
4. Check health endpoint: `curl http://<task-ip>:3000/health`

## Step 8: Monitoring and Troubleshooting

### 8.1 CloudWatch Logs
- Lambda logs: `/aws/lambda/invoke-fargate-task`
- Fargate logs: `/ecs/nova-sonic-bridge`

### 8.2 Key Metrics to Monitor
- Lambda invocation count and duration
- ECS task count and CPU/memory usage
- KVS stream metrics
- Nova Sonic API calls

### 8.3 Common Issues
1. **Task fails to start**: Check ECS task role permissions
2. **KVS connection fails**: Verify Stream ARN and KVS permissions
3. **Nova Sonic errors**: Check Bedrock access and model availability
4. **Network issues**: Verify subnet and security group configuration

## Step 9: Scaling and Optimization

### 9.1 Auto Scaling
- Configure ECS service auto-scaling based on CPU/memory usage
- Set up Lambda concurrency limits
- Monitor and adjust task definition resources

### 9.2 Cost Optimization
- Use Spot instances for non-critical workloads
- Monitor and optimize task resource allocation
- Set up CloudWatch alarms for cost monitoring

## Security Considerations

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

## Cleanup

To remove all resources:
```bash
# Delete Lambda function
aws lambda delete-function --function-name invoke-fargate-task

# Delete ECS cluster
aws ecs delete-cluster --cluster nova-sonic-cluster

# Delete ECR repository
aws ecr delete-repository --repository-name nova-sonic-bridge --force

# Delete IAM roles
aws iam delete-role --role-name nova-sonic-bridge-task-role
aws iam delete-role --role-name lambda-execution-role

# Delete CloudWatch log groups
aws logs delete-log-group --log-group-name /aws/lambda/invoke-fargate-task
aws logs delete-log-group --log-group-name /ecs/nova-sonic-bridge
```
