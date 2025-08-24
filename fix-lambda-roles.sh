#!/bin/bash

# Simple script to fix Lambda role issue without affecting ECS instances
echo "🔧 Fixing Lambda role issue only..."

# Get current stack outputs
STACK_NAME="nova-sonic-ecs-stack"
REGION="us-east-1"

echo "📋 Getting stack outputs..."
ECSTaskExecutionRoleArn=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION --query 'Stacks[0].Outputs[?OutputKey==`ECSTaskExecutionRoleArn`].OutputValue' --output text)
ECSTaskRoleArn=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION --query 'Stacks[0].Outputs[?OutputKey==`ECSTaskRoleArn`].OutputValue' --output text)
LAMBDA_FUNCTION_NAME=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION --query 'Stacks[0].Outputs[?OutputKey==`LambdaFunctionName`].OutputValue' --output text)

echo "ECS Task Execution Role ARN: $ECSTaskExecutionRoleArn"
echo "ECS Task Role ARN: $ECSTaskRoleArn"
echo "Lambda Function Name: $LAMBDA_FUNCTION_NAME"

# Extract role names from ARNs
TASK_EXECUTION_ROLE_NAME=$(echo $ECSTaskExecutionRoleArn | sed 's/.*\///')
TASK_ROLE_NAME=$(echo $ECSTaskRoleArn | sed 's/.*\///')

echo "Task Execution Role Name: $TASK_EXECUTION_ROLE_NAME"
echo "Task Role Name: $TASK_ROLE_NAME"

# Build Lambda code
echo "🔨 Building Lambda TypeScript code..."
cd lambda
npm install
npm run build

# Create deployment package
echo "📦 Creating Lambda deployment package..."
zip -r lambda-deployment.zip dist/ node_modules/ package.json

# Update Lambda function
echo "🔧 Updating Lambda function..."
aws lambda update-function-code \
    --function-name $LAMBDA_FUNCTION_NAME \
    --zip-file fileb://lambda-deployment.zip \
    --region $REGION

cd ..

# Update task definition with correct role ARNs
echo "📝 Updating task definition with correct role ARNs..."
sed "s|nova-sonic-ecs-stack-ecs-task-execution-role|$TASK_EXECUTION_ROLE_NAME|g; s|nova-sonic-ecs-stack-nova-sonic-ec2-bridge-task-role|$TASK_ROLE_NAME|g" ecs-task-definition-ec2.json > task-definition-fixed.json

# Register updated task definition
echo "📋 Registering updated task definition..."
TASK_DEFINITION_ARN=$(aws ecs register-task-definition \
    --cli-input-json file://task-definition-fixed.json \
    --region $REGION \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text)

echo "✅ Updated Task Definition ARN: $TASK_DEFINITION_ARN"

# Cleanup
rm -f task-definition-fixed.json
rm -f lambda/lambda-deployment.zip

echo "✅ Lambda role issue fixed!"
echo "📋 Summary:"
echo "  - Lambda function updated with real code"
echo "  - Task definition updated with correct role ARNs"
echo "  - ECS instances remain unchanged"
