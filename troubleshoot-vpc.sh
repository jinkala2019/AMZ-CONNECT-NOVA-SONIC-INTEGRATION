#!/bin/bash

# VPC and Subnet Troubleshooting Script for Nova Sonic ECS Deployment
# This script helps identify and fix VPC/subnet issues

set -e

REGION="us-east-1"

echo "🔍 VPC and Subnet Troubleshooting Script"
echo "========================================"
echo ""

# Check if AWS CLI is configured
echo "1. Checking AWS CLI configuration..."
if ! aws sts get-caller-identity > /dev/null 2>&1; then
    echo "❌ AWS CLI is not configured or credentials are invalid."
    echo "Please run: aws configure"
    exit 1
fi
echo "✅ AWS CLI is configured"

# Check for VPCs
echo ""
echo "2. Checking for VPCs..."
VPC_COUNT=$(aws ec2 describe-vpcs --query 'length(Vpcs)' --output text 2>/dev/null || echo "0")

if [ "$VPC_COUNT" -eq 0 ]; then
    echo "❌ No VPCs found in your account."
    echo ""
    echo "Creating a new VPC..."
    
    # Create VPC
    VPC_ID=$(aws ec2 create-vpc --cidr-block 10.0.0.0/16 --query 'Vpc.VpcId' --output text)
    echo "✅ Created VPC: $VPC_ID"
    
    # Create subnet
    SUBNET_ID=$(aws ec2 create-subnet --vpc-id $VPC_ID --cidr-block 10.0.1.0/24 --availability-zone ${REGION}a --query 'Subnet.SubnetId' --output text)
    echo "✅ Created subnet: $SUBNET_ID"
    
    # Create internet gateway
    IGW_ID=$(aws ec2 create-internet-gateway --query 'InternetGateway.InternetGatewayId' --output text)
    aws ec2 attach-internet-gateway --vpc-id $VPC_ID --internet-gateway-id $IGW_ID
    echo "✅ Created and attached internet gateway: $IGW_ID"
    
    # Create route table
    ROUTE_TABLE_ID=$(aws ec2 create-route-table --vpc-id $VPC_ID --query 'RouteTable.RouteTableId' --output text)
    aws ec2 create-route --route-table-id $ROUTE_TABLE_ID --destination-cidr-block 0.0.0.0/0 --gateway-id $IGW_ID
    aws ec2 associate-route-table --subnet-id $SUBNET_ID --route-table-id $ROUTE_TABLE_ID
    echo "✅ Created route table and associated with subnet: $ROUTE_TABLE_ID"
    
    echo ""
    echo "🎉 VPC setup completed successfully!"
    echo "VPC ID: $VPC_ID"
    echo "Subnet ID: $SUBNET_ID"
    echo ""
    echo "You can now deploy using:"
    echo "aws cloudformation deploy \\"
    echo "    --template-file ecs-deployment.yaml \\"
    echo "    --stack-name nova-sonic-ecs-stack \\"
    echo "    --parameter-overrides \\"
    echo "        VpcId=$VPC_ID \\"
    echo "        PublicSubnetIds=$SUBNET_ID \\"
    echo "        PrivateSubnetIds=$SUBNET_ID \\"
    echo "        InstanceType=t3.medium \\"
    echo "        MinSize=1 \\"
    echo "        MaxSize=5 \\"
    echo "        DesiredCapacity=2 \\"
    echo "        ECRRepositoryName=nova-sonic-ec2-bridge \\"
    echo "        LambdaFunctionName=invoke-ecs-ec2-task \\"
    echo "        ECSClusterName=nova-sonic-ecs-cluster \\"
    echo "    --capabilities CAPABILITY_NAMED_IAM \\"
    echo "    --region $REGION"
    
else
    echo "✅ Found $VPC_COUNT VPC(s)"
    
    # List VPCs
    echo ""
    echo "Available VPCs:"
    aws ec2 describe-vpcs --query 'Vpcs[*].[VpcId,CidrBlock,IsDefault]' --output table
    
    # Get default VPC
    DEFAULT_VPC=$(aws ec2 describe-vpcs --filters "Name=is-default,Values=true" --query 'Vpcs[0].VpcId' --output text 2>/dev/null || echo "")
    
    if [ -n "$DEFAULT_VPC" ] && [ "$DEFAULT_VPC" != "None" ]; then
        echo ""
        echo "✅ Found default VPC: $DEFAULT_VPC"
        VPC_ID=$DEFAULT_VPC
    else
        echo ""
        echo "⚠️  No default VPC found. Using first available VPC."
        VPC_ID=$(aws ec2 describe-vpcs --query 'Vpcs[0].VpcId' --output text)
        echo "Selected VPC: $VPC_ID"
    fi
    
    # Check subnets
    echo ""
    echo "3. Checking subnets in VPC $VPC_ID..."
    SUBNET_COUNT=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" --query 'length(Subnets)' --output text 2>/dev/null || echo "0")
    
    if [ "$SUBNET_COUNT" -eq 0 ]; then
        echo "❌ No subnets found in VPC $VPC_ID"
        echo ""
        echo "Creating a new subnet..."
        
        # Create subnet
        SUBNET_ID=$(aws ec2 create-subnet --vpc-id $VPC_ID --cidr-block 10.0.1.0/24 --availability-zone ${REGION}a --query 'Subnet.SubnetId' --output text)
        echo "✅ Created subnet: $SUBNET_ID"
        
        # Check if VPC has internet gateway
        IGW_COUNT=$(aws ec2 describe-internet-gateways --filters "Name=attachment.vpc-id,Values=$VPC_ID" --query 'length(InternetGateways)' --output text)
        
        if [ "$IGW_COUNT" -eq 0 ]; then
            echo "Creating internet gateway..."
            IGW_ID=$(aws ec2 create-internet-gateway --query 'InternetGateway.InternetGatewayId' --output text)
            aws ec2 attach-internet-gateway --vpc-id $VPC_ID --internet-gateway-id $IGW_ID
            echo "✅ Created and attached internet gateway: $IGW_ID"
            
            # Create route table
            ROUTE_TABLE_ID=$(aws ec2 create-route-table --vpc-id $VPC_ID --query 'RouteTable.RouteTableId' --output text)
            aws ec2 create-route --route-table-id $ROUTE_TABLE_ID --destination-cidr-block 0.0.0.0/0 --gateway-id $IGW_ID
            aws ec2 associate-route-table --subnet-id $SUBNET_ID --route-table-id $ROUTE_TABLE_ID
            echo "✅ Created route table and associated with subnet: $ROUTE_TABLE_ID"
        fi
        
    else
        echo "✅ Found $SUBNET_COUNT subnet(s) in VPC $VPC_ID"
        
        # List subnets
        echo ""
        echo "Available subnets:"
        aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" --query 'Subnets[*].[SubnetId,CidrBlock,AvailabilityZone,MapPublicIpOnLaunch]' --output table
        
        # Get subnet IDs
        SUBNET_IDS=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" --query 'Subnets[*].SubnetId' --output text)
        SUBNET_ARRAY=($SUBNET_IDS)
        
        if [ ${#SUBNET_ARRAY[@]} -lt 2 ]; then
            echo ""
            echo "⚠️  Only ${#SUBNET_ARRAY[@]} subnet(s) found. Using the same subnet for both public and private."
            PUBLIC_SUBNETS="${SUBNET_ARRAY[0]}"
            PRIVATE_SUBNETS="${SUBNET_ARRAY[0]}"
        else
            echo ""
            echo "✅ Using first subnet as public, second as private"
            PUBLIC_SUBNETS="${SUBNET_ARRAY[0]}"
            PRIVATE_SUBNETS="${SUBNET_ARRAY[1]}"
        fi
        
        echo "Public Subnets: $PUBLIC_SUBNETS"
        echo "Private Subnets: $PRIVATE_SUBNETS"
    fi
    
    echo ""
    echo "🎉 VPC and subnet setup completed!"
    echo "VPC ID: $VPC_ID"
    if [ -n "$SUBNET_ID" ]; then
        echo "Subnet ID: $SUBNET_ID"
        echo ""
        echo "You can now deploy using:"
        echo "aws cloudformation deploy \\"
        echo "    --template-file ecs-deployment.yaml \\"
        echo "    --stack-name nova-sonic-ecs-stack \\"
        echo "    --parameter-overrides \\"
        echo "        VpcId=$VPC_ID \\"
        echo "        PublicSubnetIds=$SUBNET_ID \\"
        echo "        PrivateSubnetIds=$SUBNET_ID \\"
        echo "        InstanceType=t3.medium \\"
        echo "        MinSize=1 \\"
        echo "        MaxSize=5 \\"
        echo "        DesiredCapacity=2 \\"
        echo "        ECRRepositoryName=nova-sonic-ec2-bridge \\"
        echo "        LambdaFunctionName=invoke-ecs-ec2-task \\"
        echo "        ECSClusterName=nova-sonic-ecs-cluster \\"
        echo "    --capabilities CAPABILITY_NAMED_IAM \\"
        echo "    --region $REGION"
    else
        echo "Public Subnets: $PUBLIC_SUBNETS"
        echo "Private Subnets: $PRIVATE_SUBNETS"
        echo ""
        echo "You can now deploy using:"
        echo "aws cloudformation deploy \\"
        echo "    --template-file ecs-deployment.yaml \\"
        echo "    --stack-name nova-sonic-ecs-stack \\"
        echo "    --parameter-overrides \\"
        echo "        VpcId=$VPC_ID \\"
        echo "        PublicSubnetIds=$PUBLIC_SUBNETS \\"
        echo "        PrivateSubnetIds=$PRIVATE_SUBNETS \\"
        echo "        InstanceType=t3.medium \\"
        echo "        MinSize=1 \\"
        echo "        MaxSize=5 \\"
        echo "        DesiredCapacity=2 \\"
        echo "        ECRRepositoryName=nova-sonic-ec2-bridge \\"
        echo "        LambdaFunctionName=invoke-ecs-ec2-task \\"
        echo "        ECSClusterName=nova-sonic-ecs-cluster \\"
        echo "    --capabilities CAPABILITY_NAMED_IAM \\"
        echo "    --region $REGION"
    fi
fi

echo ""
echo "📝 Note: If you prefer to use the automated deployment script, run:"
echo "   ./deploy.sh"
