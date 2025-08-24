#!/bin/bash

# ECS EC2 Deployment Script for Nova Sonic WebRTC Bridge
# This script deploys the complete ECS EC2 infrastructure

set -e

# Configuration
STACK_NAME="nova-sonic-ecs-stack"
REGION="us-east-1"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REPOSITORY="nova-sonic-bridge"
CLUSTER_NAME="nova-sonic-ecs-cluster"

echo "🚀 Starting ECS EC2 deployment for Nova Sonic WebRTC Bridge"
echo "Account ID: $ACCOUNT_ID"
echo "Region: $REGION"
echo "Stack Name: $STACK_NAME"

# Step 1: Build and package the application
echo "📦 Building application..."
npm install
npm run build

# Step 2: Create ECR repository if it doesn't exist
echo "🐳 Setting up ECR repository..."
aws ecr describe-repositories --repository-names $ECR_REPOSITORY --region $REGION 2>/dev/null || {
    echo "Creating ECR repository: $ECR_REPOSITORY"
    aws ecr create-repository --repository-name $ECR_REPOSITORY --region $REGION
}

# Step 3: Get ECR login token and login
echo "🔐 Logging into ECR..."
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com

# Step 4: Build and push Docker image
echo "🏗️ Building Docker image..."
docker build -t $ECR_REPOSITORY .

echo "🏷️ Tagging Docker image..."
docker tag $ECR_REPOSITORY:latest $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$ECR_REPOSITORY:latest

echo "⬆️ Pushing Docker image to ECR..."
docker push $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$ECR_REPOSITORY:latest

# Step 5: Get VPC and subnet information
echo "🌐 Getting VPC and subnet information..."
VPC_ID=$(aws ec2 describe-vpcs --filters "Name=is-default,Values=true" --query 'Vpcs[0].VpcId' --output text)
echo "VPC ID: $VPC_ID"

# Get public subnets
PUBLIC_SUBNETS=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" "Name=map-public-ip-on-launch,Values=true" --query 'Subnets[*].SubnetId' --output text | tr '\t' ',')
echo "Public Subnets: $PUBLIC_SUBNETS"

# Get private subnets
PRIVATE_SUBNETS=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" "Name=map-public-ip-on-launch,Values=false" --query 'Subnets[*].SubnetId' --output text | tr '\t' ',')
echo "Private Subnets: $PRIVATE_SUBNETS"

# Step 6: Deploy CloudFormation stack
echo "☁️ Deploying CloudFormation stack..."
aws cloudformation deploy \
    --template-file ecs-ec2-deployment.yaml \
    --stack-name $STACK_NAME \
    --parameter-overrides \
        VpcId=$VPC_ID \
        PublicSubnetIds=$PUBLIC_SUBNETS \
        PrivateSubnetIds=$PRIVATE_SUBNETS \
        InstanceType=t3.medium \
        MinSize=1 \
        MaxSize=5 \
        DesiredCapacity=2 \
    --capabilities CAPABILITY_NAMED_IAM \
    --region $REGION

# Step 7: Get stack outputs
echo "📋 Getting stack outputs..."
CLUSTER_NAME=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION --query 'Stacks[0].Outputs[?OutputKey==`ECSClusterName`].OutputValue' --output text)
CLUSTER_ARN=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION --query 'Stacks[0].Outputs[?OutputKey==`ECSClusterArn`].OutputValue' --output text)
INSTANCE_ROLE_ARN=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION --query 'Stacks[0].Outputs[?OutputKey==`ECSInstanceRoleArn`].OutputValue' --output text)

echo "ECS Cluster Name: $CLUSTER_NAME"
echo "ECS Cluster ARN: $CLUSTER_ARN"
echo "ECS Instance Role ARN: $INSTANCE_ROLE_ARN"

# Step 8: Create ECS task execution role if it doesn't exist
echo "🔑 Creating ECS task execution role..."
aws iam get-role --role-name ecsTaskExecutionRole 2>/dev/null || {
    echo "Creating ecsTaskExecutionRole..."
    aws iam create-role \
        --role-name ecsTaskExecutionRole \
        --assume-role-policy-document '{
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Effect": "Allow",
                    "Principal": {
                        "Service": "ecs-tasks.amazonaws.com"
                    },
                    "Action": "sts:AssumeRole"
                }
            ]
        }'
    
    aws iam attach-role-policy \
        --role-name ecsTaskExecutionRole \
        --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
}

# Step 9: Create ECS task role for Nova Sonic Bridge
echo "🔑 Creating ECS task role for Nova Sonic Bridge..."
aws iam get-role --role-name nova-sonic-bridge-task-role 2>/dev/null || {
    echo "Creating nova-sonic-bridge-task-role..."
    aws iam create-role \
        --role-name nova-sonic-bridge-task-role \
        --assume-role-policy-document '{
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Effect": "Allow",
                    "Principal": {
                        "Service": "ecs-tasks.amazonaws.com"
                    },
                    "Action": "sts:AssumeRole"
                }
            ]
        }'
    
    aws iam put-role-policy \
        --role-name nova-sonic-bridge-task-role \
        --policy-name NovaSonicBridgePolicy \
        --policy-document '{
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
        }'
}

# Step 10: Update task definition with correct image URI
echo "📝 Updating task definition..."
sed "s/ACCOUNT_ID/$ACCOUNT_ID/g; s/REGION/$REGION/g" ecs-task-definition-ec2.json > task-definition-updated.json

# Step 11: Register task definition
echo "📋 Registering ECS task definition..."
TASK_DEFINITION_ARN=$(aws ecs register-task-definition \
    --cli-input-json file://task-definition-updated.json \
    --region $REGION \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text)

echo "Task Definition ARN: $TASK_DEFINITION_ARN"

# Step 12: Deploy Lambda function
echo "🔧 Deploying Lambda function..."
cd lambda
npm install
npm run build
zip -r lambda-deployment.zip dist/ node_modules/ package.json

# Create Lambda execution role if it doesn't exist
aws iam get-role --role-name lambda-execution-role 2>/dev/null || {
    echo "Creating lambda-execution-role..."
    aws iam create-role \
        --role-name lambda-execution-role \
        --assume-role-policy-document '{
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Effect": "Allow",
                    "Principal": {
                        "Service": "lambda.amazonaws.com"
                    },
                    "Action": "sts:AssumeRole"
                }
            ]
        }'
    
    aws iam attach-role-policy \
        --role-name lambda-execution-role \
        --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
    
    aws iam put-role-policy \
        --role-name lambda-execution-role \
        --policy-name ECSPolicy \
        --policy-document "{
            \"Version\": \"2012-10-17\",
            \"Statement\": [
                {
                    \"Effect\": \"Allow\",
                    \"Action\": [
                        \"ecs:RunTask\",
                        \"ecs:StopTask\",
                        \"ecs:DescribeTasks\"
                    ],
                    \"Resource\": \"*\"
                },
                {
                    \"Effect\": \"Allow\",
                    \"Action\": [
                        \"iam:PassRole\"
                    ],
                    \"Resource\": [
                        \"$INSTANCE_ROLE_ARN\",
                        \"arn:aws:iam::$ACCOUNT_ID:role/ecsTaskExecutionRole\",
                        \"arn:aws:iam::$ACCOUNT_ID:role/nova-sonic-bridge-task-role\"
                    ]
                }
            ]
        }"
}

# Deploy Lambda function
aws lambda get-function --function-name invoke-ecs-ec2-task --region $REGION 2>/dev/null && {
    echo "Updating existing Lambda function..."
    aws lambda update-function-code \
        --function-name invoke-ecs-ec2-task \
        --zip-file fileb://lambda-deployment.zip \
        --region $REGION
    
    aws lambda update-function-configuration \
        --function-name invoke-ecs-ec2-task \
        --environment Variables="{
            \"ECS_CLUSTER_NAME\":\"$CLUSTER_NAME\",
            \"ECS_TASK_DEFINITION\":\"nova-sonic-bridge:1\",
            \"AWS_REGION\":\"$REGION\"
        }" \
        --region $REGION
} || {
    echo "Creating new Lambda function..."
    aws lambda create-function \
        --function-name invoke-ecs-ec2-task \
        --runtime nodejs18.x \
        --role arn:aws:iam::$ACCOUNT_ID:role/lambda-execution-role \
        --handler dist/lambda-invoke-ecs-ec2.handler \
        --zip-file fileb://lambda-deployment.zip \
        --timeout 60 \
        --memory-size 256 \
        --environment Variables="{
            \"ECS_CLUSTER_NAME\":\"$CLUSTER_NAME\",
            \"ECS_TASK_DEFINITION\":\"nova-sonic-bridge:1\",
            \"AWS_REGION\":\"$REGION\"
        }" \
        --region $REGION
}

cd ..

# Step 13: Clean up temporary files
echo "🧹 Cleaning up temporary files..."
rm -f task-definition-updated.json
rm -f lambda/lambda-deployment.zip

# Step 14: Display deployment summary
echo ""
echo "✅ ECS EC2 deployment completed successfully!"
echo ""
echo "📊 Deployment Summary:"
echo "======================"
echo "ECS Cluster Name: $CLUSTER_NAME"
echo "ECS Cluster ARN: $CLUSTER_ARN"
echo "Task Definition ARN: $TASK_DEFINITION_ARN"
echo "Lambda Function: invoke-ecs-ec2-task"
echo "ECR Repository: $ECR_REPOSITORY"
echo "CloudFormation Stack: $STACK_NAME"
echo ""
echo "🔗 Useful Commands:"
echo "==================="
echo "View ECS cluster: aws ecs describe-clusters --clusters $CLUSTER_NAME --region $REGION"
echo "List ECS tasks: aws ecs list-tasks --cluster $CLUSTER_NAME --region $REGION"
echo "View Lambda logs: aws logs tail /aws/lambda/invoke-ecs-ec2-task --follow --region $REGION"
echo "View ECS logs: aws logs tail /ecs/nova-sonic-bridge --follow --region $REGION"
echo "Test Lambda: aws lambda invoke --function-name invoke-ecs-ec2-task --payload '{\"StreamARN\":\"test\",\"ContactId\":\"test\",\"CustomerPhoneNumber\":\"test\"}' response.json --region $REGION"
echo ""
echo "🚀 Next Steps:"
echo "=============="
echo "1. Configure Amazon Connect contact flow to invoke the Lambda function"
echo "2. Test the deployment by making a call to your Amazon Connect number"
echo "3. Monitor the logs for any issues"
echo "4. Scale the Auto Scaling Group as needed"
