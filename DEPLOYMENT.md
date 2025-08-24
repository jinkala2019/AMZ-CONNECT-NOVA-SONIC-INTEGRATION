# ECS EC2 Deployment Guide for Nova Sonic WebRTC Bridge

This guide provides step-by-step instructions for deploying the Nova Sonic WebRTC Bridge using ECS with EC2 instances.

## Architecture

```
Amazon Connect → Lambda → ECS EC2 Task → Nova Sonic
```

- **Lambda Function**: Invokes ECS tasks for each call
- **ECS EC2 Cluster**: Runs WebRTC bridge containers on EC2 instances
- **Auto Scaling Group**: Manages EC2 instances automatically
- **CloudFormation**: Infrastructure as code deployment

## Prerequisites

1. **AWS CLI** configured with appropriate permissions
2. **Docker** installed and running
3. **Node.js** and **npm** installed
4. **VPC** with at least one subnet (public or private)
5. **AWS Permissions** for:
   - CloudFormation
   - ECS
   - EC2
   - Lambda
   - ECR
   - IAM
   - CloudWatch Logs

## Deployment Options

### 1.1 Automated Deployment
The easiest way to deploy everything is using the deployment script:

```bash
# Make the script executable
chmod +x deploy.sh

# Run the deployment
./deploy.sh
```

This script will:
- Automatically detect your VPC and subnets
- Build the application and Lambda function
- Deploy all infrastructure using CloudFormation
- Build and push the Docker image to ECR
- Create the ECS task definition
- Update the Lambda function with actual code

### 1.2 Manual Deployment (If Automated Fails)

If the automated deployment fails due to VPC/subnet issues, you can deploy manually:

#### Step 1: Get Your VPC and Subnet Information
```bash
# List all VPCs
aws ec2 describe-vpcs --query 'Vpcs[*].[VpcId,CidrBlock,IsDefault]' --output table

# List subnets in a specific VPC (replace vpc-xxxxxxxxx with your VPC ID)
aws ec2 describe-subnets --filters "Name=vpc-id,Values=vpc-xxxxxxxxx" --query 'Subnets[*].[SubnetId,CidrBlock,AvailabilityZone]' --output table
```

#### Step 2: Deploy with Specific Parameters
```bash
# Deploy the complete infrastructure
aws cloudformation deploy \
    --template-file ecs-deployment.yaml \
    --stack-name nova-sonic-ecs-stack \
    --parameter-overrides \
        VpcId=vpc-xxxxxxxxx \
        PublicSubnetIds=subnet-xxxxxxxxx \
        PrivateSubnetIds=subnet-yyyyyyyyy \
        InstanceType=t3.medium \
        MinSize=1 \
        MaxSize=5 \
        DesiredCapacity=2 \
        ECRRepositoryName=nova-sonic-ec2-bridge \
        LambdaFunctionName=invoke-ecs-ec2-task \
        ECSClusterName=nova-sonic-ecs-cluster \
    --capabilities CAPABILITY_NAMED_IAM \
    --region us-east-1
```

#### Step 3: Build and Deploy Application
```bash
# Build the application
npm install
npm run build

# Build Lambda function
cd lambda
npm install
npm run build
cd ..

# Get ECR repository URI
ECR_REPOSITORY_URI=$(aws cloudformation describe-stacks --stack-name nova-sonic-ecs-stack --region us-east-1 --query 'Stacks[0].Outputs[?OutputKey==`ECRRepositoryUri`].OutputValue' --output text)

# Login to ECR
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin $ECR_REPOSITORY_URI

# Build and push Docker image
docker build -t nova-sonic-ec2-bridge .
docker tag nova-sonic-ec2-bridge:latest $ECR_REPOSITORY_URI:latest
docker push $ECR_REPOSITORY_URI:latest

# Create and register task definition
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
sed "s|ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/nova-sonic-ec2-bridge:latest|$ECR_REPOSITORY_URI:latest|g; s|ACCOUNT_ID|$ACCOUNT_ID|g; s|REGION|us-east-1|g" ecs-task-definition-ec2.json > task-definition-updated.json

aws ecs register-task-definition --cli-input-json file://task-definition-updated.json --region us-east-1

# Update Lambda function
cd lambda
zip -r lambda-deployment.zip dist/ node_modules/ package.json
aws lambda update-function-code --function-name invoke-ecs-ec2-task --zip-file fileb://lambda-deployment.zip --region us-east-1
cd ..
```

### 1.3 Troubleshooting VPC/Subnet Issues

If you encounter "parameter value for parameter name PrivateSubnetIds does not exist":

1. **Check if you have a VPC:**
   ```bash
   aws ec2 describe-vpcs --query 'Vpcs[*].[VpcId,CidrBlock,IsDefault]' --output table
   ```

2. **Create a VPC if none exists:**
   ```bash
   # Create VPC
   VPC_ID=$(aws ec2 create-vpc --cidr-block 10.0.0.0/16 --query 'Vpc.VpcId' --output text)
   
   # Create subnet
   SUBNET_ID=$(aws ec2 create-subnet --vpc-id $VPC_ID --cidr-block 10.0.1.0/24 --availability-zone us-east-1a --query 'Subnet.SubnetId' --output text)
   
   # Create internet gateway
   IGW_ID=$(aws ec2 create-internet-gateway --query 'InternetGateway.InternetGatewayId' --output text)
   aws ec2 attach-internet-gateway --vpc-id $VPC_ID --internet-gateway-id $IGW_ID
   
   # Create route table
   ROUTE_TABLE_ID=$(aws ec2 create-route-table --vpc-id $VPC_ID --query 'RouteTable.RouteTableId' --output text)
   aws ec2 create-route --route-table-id $ROUTE_TABLE_ID --destination-cidr-block 0.0.0.0/0 --gateway-id $IGW_ID
   aws ec2 associate-route-table --subnet-id $SUBNET_ID --route-table-id $ROUTE_TABLE_ID
   
   echo "VPC ID: $VPC_ID"
   echo "Subnet ID: $SUBNET_ID"
   ```

3. **Use the created VPC and subnet in your deployment:**
   ```bash
   aws cloudformation deploy \
       --template-file ecs-deployment.yaml \
       --stack-name nova-sonic-ecs-stack \
       --parameter-overrides \
           VpcId=$VPC_ID \
           PublicSubnetIds=$SUBNET_ID \
           PrivateSubnetIds=$SUBNET_ID \
           InstanceType=t3.medium \
           MinSize=1 \
           MaxSize=5 \
           DesiredCapacity=2 \
           ECRRepositoryName=nova-sonic-ec2-bridge \
           LambdaFunctionName=invoke-ecs-ec2-task \
           ECSClusterName=nova-sonic-ecs-cluster \
       --capabilities CAPABILITY_NAMED_IAM \
       --region us-east-1
   ```

## Manual Deployment Steps

If you prefer to deploy step by step:

### Step 1: Build Application
```bash
npm install
npm run build
```

### Step 2: Build Lambda Function
```bash
cd lambda
npm install
npm run build
cd ..
```

### Step 3: Deploy Infrastructure with CloudFormation
```bash
# Deploy the complete infrastructure
aws cloudformation deploy \
    --template-file ecs-deployment.yaml \
    --stack-name nova-sonic-ecs-stack \
    --parameter-overrides \
        VpcId=vpc-xxxxxxxxx \
        PublicSubnetIds=subnet-xxxxxxxxx \
        PrivateSubnetIds=subnet-yyyyyyyyy \
        InstanceType=t3.medium \
        MinSize=1 \
        MaxSize=5 \
        DesiredCapacity=2 \
        ECRRepositoryName=nova-sonic-ec2-bridge \
        LambdaFunctionName=invoke-ecs-ec2-task \
        ECSClusterName=nova-sonic-ecs-cluster \
    --capabilities CAPABILITY_NAMED_IAM \
    --region us-east-1
```

### Step 4: Build and Push Docker Image
```bash
# Get ECR repository URI
ECR_REPOSITORY_URI=$(aws cloudformation describe-stacks --stack-name nova-sonic-ecs-stack --region us-east-1 --query 'Stacks[0].Outputs[?OutputKey==`ECRRepositoryUri`].OutputValue' --output text)

# Login to ECR
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin $ECR_REPOSITORY_URI

# Build and push image
docker build -t nova-sonic-ec2-bridge .
docker tag nova-sonic-ec2-bridge:latest $ECR_REPOSITORY_URI:latest
docker push $ECR_REPOSITORY_URI:latest
```

### Step 5: Create Task Definition
```bash
# Update task definition with correct image URI
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
sed "s|ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/nova-sonic-ec2-bridge:latest|$ECR_REPOSITORY_URI:latest|g; s|ACCOUNT_ID|$ACCOUNT_ID|g; s|REGION|us-east-1|g" ecs-task-definition-ec2.json > task-definition-updated.json

# Register task definition
aws ecs register-task-definition --cli-input-json file://task-definition-updated.json --region us-east-1
```

### Step 6: Update Lambda Function
```bash
cd lambda
zip -r lambda-deployment.zip dist/ node_modules/ package.json

aws lambda update-function-code \
    --function-name invoke-ecs-ec2-task \
    --zip-file fileb://lambda-deployment.zip \
    --region us-east-1

cd ..
```

## Amazon Connect Configuration

### Contact Flow Setup
1. Open Amazon Connect console
2. Navigate to your instance
3. Go to **Contact flows**
4. Create or edit a contact flow
5. Add a **Lambda** block
6. Configure the Lambda function:
   - **Function ARN**: `arn:aws:lambda:us-east-1:ACCOUNT_ID:function:invoke-ecs-ec2-task`
   - **Input parameters**:
     ```json
     {
       "StreamARN": "${MediaStreaming.StreamARN}",
       "ContactId": "${ContactData.ContactId}",
       "CustomerPhoneNumber": "${ContactData.CustomerEndpoint.Address}"
     }
     ```

### Media Streaming Setup
1. In your contact flow, add a **Media streaming** block
2. Configure:
   - **Stream type**: Audio
   - **Stream ARN**: Use the output from the Media streaming block
   - **Enable real-time transcription**: Optional

## Testing

### Test Lambda Function
```bash
aws lambda invoke \
    --function-name invoke-ecs-ec2-task \
    --payload '{"StreamARN":"test","ContactId":"test","CustomerPhoneNumber":"test"}' \
    response.json \
    --region us-east-1
```

### Monitor Logs
```bash
# Lambda logs
aws logs tail /aws/lambda/invoke-ecs-ec2-task --follow --region us-east-1

# ECS logs
aws logs tail /ecs/nova-sonic-ec2-bridge --follow --region us-east-1
```

## Cleanup

To remove all resources:

```bash
# Delete CloudFormation stack
aws cloudformation delete-stack --stack-name nova-sonic-ecs-stack --region us-east-1

# Wait for deletion to complete
aws cloudformation wait stack-delete-complete --stack-name nova-sonic-ecs-stack --region us-east-1

# Clean up local files
rm -f task-definition-updated.json
rm -f lambda/lambda-deployment.zip
```

## Troubleshooting

### Common Issues

1. **VPC/Subnet not found**: Use the manual deployment steps above
2. **Permission denied**: Ensure your AWS credentials have the required permissions
3. **Docker build fails**: Check that Docker is running and you have sufficient disk space
4. **ECS task fails to start**: Check the ECS task logs in CloudWatch
5. **Lambda timeout**: Increase the timeout in the CloudFormation template

### Useful Commands

```bash
# Check ECS cluster status
aws ecs describe-clusters --clusters nova-sonic-ecs-cluster --region us-east-1

# List ECS tasks
aws ecs list-tasks --cluster nova-sonic-ecs-cluster --region us-east-1

# Describe ECS task
aws ecs describe-tasks --cluster nova-sonic-ecs-cluster --tasks TASK_ARN --region us-east-1

# Check Auto Scaling Group
aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names nova-sonic-ecs-stack-asg --region us-east-1

# Check EC2 instances
aws ec2 describe-instances --filters "Name=tag:Name,Values=Nova Sonic ECS Instance" --region us-east-1
```
