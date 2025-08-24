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

# Step 3: Get VPC and subnet information
echo "🌐 Getting VPC and subnet information..."
VPC_ID=$(aws ec2 describe-vpcs --filters "Name=is-default,Values=true" --query 'Vpcs[0].VpcId' --output text)
echo "VPC ID: $VPC_ID"

# Get public subnets
PUBLIC_SUBNETS=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" "Name=map-public-ip-on-launch,Values=true" --query 'Subnets[*].SubnetId' --output text | tr '\t' ',')
echo "Public Subnets: $PUBLIC_SUBNETS"

# Get private subnets
PRIVATE_SUBNETS=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" "Name=map-public-ip-on-launch,Values=false" --query 'Subnets[*].SubnetId' --output text | tr '\t' ',')
echo "Private Subnets: $PRIVATE_SUBNETS"

# Step 4: Deploy complete CloudFormation stack
echo "☁️ Deploying complete CloudFormation stack..."
aws cloudformation deploy \
    --template-file ecs-ec2-complete-deployment.yaml \
    --stack-name $STACK_NAME \
    --parameter-overrides \
        VpcId=$VPC_ID \
        PublicSubnetIds=$PUBLIC_SUBNETS \
        PrivateSubnetIds=$PRIVATE_SUBNETS \
        InstanceType=t3.medium \
        MinSize=1 \
        MaxSize=5 \
        DesiredCapacity=2 \
        ECRRepositoryName=nova-sonic-bridge \
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

docker build -t nova-sonic-bridge .
docker tag nova-sonic-bridge:latest $ECR_REPOSITORY_URI:latest
docker push $ECR_REPOSITORY_URI:latest

# Step 7: Create task definition with correct image URI
echo "📝 Creating task definition..."
sed "s|ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/nova-sonic-bridge:latest|$ECR_REPOSITORY_URI:latest|g; s|ACCOUNT_ID|$ACCOUNT_ID|g; s|REGION|$REGION|g" ecs-task-definition-ec2.json > task-definition-updated.json

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

# Step 10: Clean up temporary files
echo "🧹 Cleaning up temporary files..."
rm -f task-definition-updated.json
rm -f lambda/lambda-deployment.zip

# Step 11: Display deployment summary
echo ""
echo "✅ Complete ECS EC2 deployment completed successfully!"
echo ""
echo "📊 Deployment Summary:"
echo "======================"
echo "ECS Cluster Name: $ECS_CLUSTER_NAME"
echo "Task Definition ARN: $TASK_DEFINITION_ARN"
echo "Lambda Function: $LAMBDA_FUNCTION_NAME"
echo "ECR Repository: $ECR_REPOSITORY_URI"
echo "CloudFormation Stack: $STACK_NAME"
echo ""
echo "🔗 Useful Commands:"
echo "==================="
echo "View ECS cluster: aws ecs describe-clusters --clusters $ECS_CLUSTER_NAME --region $REGION"
echo "List ECS tasks: aws ecs list-tasks --cluster $ECS_CLUSTER_NAME --region $REGION"
echo "View Lambda logs: aws logs tail /aws/lambda/$LAMBDA_FUNCTION_NAME --follow --region $REGION"
echo "View ECS logs: aws logs tail /ecs/nova-sonic-bridge --follow --region $REGION"
echo "Test Lambda: aws lambda invoke --function-name $LAMBDA_FUNCTION_NAME --payload '{\"StreamARN\":\"test\",\"ContactId\":\"test\",\"CustomerPhoneNumber\":\"test\"}' response.json --region $REGION"
echo ""
echo "🚀 Next Steps:"
echo "=============="
echo "1. Configure Amazon Connect contact flow to invoke the Lambda function:"
echo "   Function ARN: arn:aws:lambda:$REGION:$ACCOUNT_ID:function:$LAMBDA_FUNCTION_NAME"
echo "2. Test the deployment by making a call to your Amazon Connect number"
echo "3. Monitor the logs for any issues"
echo "4. Scale the Auto Scaling Group as needed"
echo ""
echo "📝 Amazon Connect Contact Flow Configuration:"
echo "============================================="
echo "Lambda Function ARN: arn:aws:lambda:$REGION:$ACCOUNT_ID:function:$LAMBDA_FUNCTION_NAME"
echo "Input Parameters:"
echo "  {"
echo "    \"StreamARN\": \"\${MediaStreaming.StreamARN}\","
echo "    \"ContactId\": \"\${ContactData.ContactId}\","
echo "    \"CustomerPhoneNumber\": \"\${ContactData.CustomerEndpoint.Address}\""
echo "  }"
