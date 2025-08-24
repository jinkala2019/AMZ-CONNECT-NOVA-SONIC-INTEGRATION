#!/bin/bash

# Complete ECS EC2 Deployment Script for Nova Sonic WebRTC Bridge
# This script deploys everything using a single CloudFormation template

set -e

# Configuration
STACK_NAME="nova-sonic-ecs-stack"
REGION="us-east-1"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

echo "🚀 Starting complete ECS EC2 deployment for Nova Sonic WebRTC Bridge"
echo "Account ID: $ACCOUNT_ID"
echo "Region: $REGION"
echo "Stack Name: $STACK_NAME"

# Step 1: Build and package the application
echo "📦 Building application..."
npm install
npm run build

# Step 2: Build and package Lambda function
echo "🔧 Building Lambda function..."
cd lambda
npm install
npm run build
cd ..

# Step 3: Get VPC and subnet information with better error handling
echo "🌐 Getting VPC and subnet information..."

# Try to get default VPC first
VPC_ID=$(aws ec2 describe-vpcs --filters "Name=is-default,Values=true" --query 'Vpcs[0].VpcId' --output text 2>/dev/null || echo "")

# If no default VPC, get the first available VPC
if [ -z "$VPC_ID" ] || [ "$VPC_ID" = "None" ]; then
    echo "No default VPC found, getting first available VPC..."
    VPC_ID=$(aws ec2 describe-vpcs --query 'Vpcs[0].VpcId' --output text 2>/dev/null || echo "")
fi

if [ -z "$VPC_ID" ] || [ "$VPC_ID" = "None" ]; then
    echo "❌ Error: No VPC found. Please create a VPC first or specify one manually."
    echo "You can create a VPC using:"
    echo "aws ec2 create-vpc --cidr-block 10.0.0.0/16 --region $REGION"
    exit 1
fi

echo "VPC ID: $VPC_ID"

# Get all subnets in the VPC
echo "Getting subnets in VPC $VPC_ID..."
ALL_SUBNETS=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" --query 'Subnets[*].SubnetId' --output text 2>/dev/null || echo "")

if [ -z "$ALL_SUBNETS" ]; then
    echo "❌ Error: No subnets found in VPC $VPC_ID. Please create subnets first."
    echo "You can create subnets using:"
    echo "aws ec2 create-subnet --vpc-id $VPC_ID --cidr-block 10.0.1.0/24 --availability-zone ${REGION}a"
    exit 1
fi

# Convert to array and get first two subnets (or use all if less than 2)
SUBNET_ARRAY=($ALL_SUBNETS)
if [ ${#SUBNET_ARRAY[@]} -lt 2 ]; then
    echo "⚠️  Warning: Only ${#SUBNET_ARRAY[@]} subnet(s) found. Using the same subnet for both public and private."
    PUBLIC_SUBNETS="${SUBNET_ARRAY[0]}"
    PRIVATE_SUBNETS="${SUBNET_ARRAY[0]}"
else
    # Use first subnet as public, second as private
    PUBLIC_SUBNETS="${SUBNET_ARRAY[0]}"
    PRIVATE_SUBNETS="${SUBNET_ARRAY[1]}"
fi

echo "Public Subnets: $PUBLIC_SUBNETS"
echo "Private Subnets: $PRIVATE_SUBNETS"

# Step 4: Deploy complete CloudFormation stack
echo "☁️ Deploying complete CloudFormation stack..."
aws cloudformation deploy \
    --template-file ecs-deployment.yaml \
    --stack-name $STACK_NAME \
    --parameter-overrides \
        VpcId=$VPC_ID \
        PublicSubnetIds=$PUBLIC_SUBNETS \
        PrivateSubnetIds=$PRIVATE_SUBNETS \
        InstanceType=t3.medium \
        MinSize=1 \
        MaxSize=5 \
        DesiredCapacity=2 \
        ECRRepositoryName=nova-sonic-ec2-bridge \
        LambdaFunctionName=invoke-ecs-ec2-task \
        ECSClusterName=nova-sonic-ecs-cluster \
    --capabilities CAPABILITY_NAMED_IAM \
    --region $REGION

# Step 5: Get stack outputs
echo "📋 Getting stack outputs..."
ECR_REPOSITORY_URI=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION --query 'Stacks[0].Outputs[?OutputKey==`ECRRepositoryUri`].OutputValue' --output text)
ECS_CLUSTER_NAME=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION --query 'Stacks[0].Outputs[?OutputKey==`ECSClusterName`].OutputValue' --output text)
LAMBDA_FUNCTION_NAME=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION --query 'Stacks[0].Outputs[?OutputKey==`LambdaFunctionName`].OutputValue' --output text)
ECSTaskExecutionRoleArn=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION --query 'Stacks[0].Outputs[?OutputKey==`ECSTaskExecutionRoleArn`].OutputValue' --output text)
ECSTaskRoleArn=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION --query 'Stacks[0].Outputs[?OutputKey==`ECSTaskRoleArn`].OutputValue' --output text)

echo "ECR Repository URI: $ECR_REPOSITORY_URI"
echo "ECS Cluster Name: $ECS_CLUSTER_NAME"
echo "Lambda Function Name: $LAMBDA_FUNCTION_NAME"

# Step 6: Build and push Docker image
echo "🐳 Building and pushing Docker image..."
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com

docker build -t nova-sonic-ec2-bridge .
docker tag nova-sonic-ec2-bridge:latest $ECR_REPOSITORY_URI:latest
docker push $ECR_REPOSITORY_URI:latest

# Step 7: Create task definition with correct image URI
echo "📝 Creating task definition..."
sed "s|ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/nova-sonic-ec2-bridge:latest|$ECR_REPOSITORY_URI:latest|g; s|ACCOUNT_ID|$ACCOUNT_ID|g; s|REGION|$REGION|g" ecs-task-definition-ec2.json > task-definition-updated.json

# Step 8: Register task definition
echo "📋 Registering ECS task definition..."
TASK_DEFINITION_ARN=$(aws ecs register-task-definition \
    --cli-input-json file://task-definition-updated.json \
    --region $REGION \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text)

echo "Task Definition ARN: $TASK_DEFINITION_ARN"

# Step 9: Update Lambda function with actual code
echo "🔧 Updating Lambda function with actual code..."
cd lambda
zip -r lambda-deployment.zip dist/ node_modules/ package.json

aws lambda update-function-code \
    --function-name $LAMBDA_FUNCTION_NAME \
    --zip-file fileb://lambda-deployment.zip \
    --region $REGION

cd ..

# Step 10: Cleanup temporary files
echo "🧹 Cleaning up temporary files..."
rm -f task-definition-updated.json
rm -f lambda/lambda-deployment.zip

echo "✅ Deployment completed successfully!"
echo ""
echo "📋 Summary:"
echo "  - Stack Name: $STACK_NAME"
echo "  - ECS Cluster: $ECS_CLUSTER_NAME"
echo "  - Lambda Function: $LAMBDA_FUNCTION_NAME"
echo "  - ECR Repository: $ECR_REPOSITORY_URI"
echo "  - Task Definition: $TASK_DEFINITION_ARN"
echo ""
echo "🔗 Next steps:"
echo "  1. Configure Amazon Connect to invoke the Lambda function"
echo "  2. Test the integration with a phone call"
echo "  3. Monitor logs in CloudWatch"
