# Deployment Sequence Guide

## Why Deployment Order Matters

The deployment sequence is critical because AWS resources have dependencies. Here's why the order matters:

### ❌ **Incorrect Sequence (Original)**
1. Build application
2. Create ECR repository
3. Push Docker image
4. Create task definition (❌ **FAILS** - IAM roles don't exist yet)
5. Create IAM roles
6. Deploy infrastructure

### ✅ **Correct Sequence**
1. Build application and Lambda function
2. Deploy CloudFormation stack (creates all IAM roles first)
3. Build and push Docker image
4. Create task definition (✅ **SUCCEEDS** - IAM roles exist)
5. Update Lambda function with actual code

## Resource Dependencies

### IAM Roles Must Be Created First
- **ECS Task Definition** references `executionRoleArn` and `taskRoleArn`
- **Lambda Function** references `Role` (execution role)
- **EC2 Instances** need instance profile with IAM role
- **CloudFormation** handles these dependencies automatically

### CloudFormation Dependency Resolution
CloudFormation automatically resolves dependencies and creates resources in the correct order:

```yaml
# IAM Roles are created first
ECSTaskExecutionRole:
  Type: AWS::IAM::Role
  # ... role definition

ECSTaskRole:
  Type: AWS::IAM::Role
  # ... role definition

# ECS Cluster can reference the roles
ECSCluster:
  Type: AWS::ECS::Cluster
  # ... cluster definition

# Lambda Function can reference the roles
LambdaFunction:
  Type: AWS::Lambda::Function
  Properties:
    Role: !GetAtt LambdaExecutionRole.Arn  # ✅ Role exists
```

## Complete Deployment Options

### Option 1: Automated Deployment (Recommended)
```bash
npm run deploy:complete
# or
./deploy-complete.sh
```

**Benefits:**
- Single command deployment
- Handles all dependencies automatically
- Less error-prone
- Consistent results

### Option 2: Manual Deployment
Follow the steps in `DEPLOYMENT.md` in the exact order specified.

**When to use:**
- Custom modifications needed
- Debugging specific issues
- Learning the deployment process

## Deployment Architecture

```
CloudFormation Stack
├── IAM Roles (created first)
│   ├── ECSTaskExecutionRole
│   ├── ECSTaskRole
│   ├── LambdaExecutionRole
│   └── ECSInstanceRole
├── ECS Infrastructure
│   ├── ECS Cluster
│   ├── Capacity Provider
│   ├── Auto Scaling Group
│   └── Launch Template
├── Lambda Function
├── ECR Repository
└── CloudWatch Log Groups
```

## Key Benefits of CloudFormation Approach

### 1. **Dependency Management**
- CloudFormation automatically handles resource dependencies
- No manual ordering required
- Rollback capability if deployment fails

### 2. **Consistency**
- Same deployment every time
- Infrastructure as code
- Version control for infrastructure

### 3. **Scalability**
- Easy to replicate in different regions
- Parameter-driven deployment
- Environment-specific configurations

### 4. **Maintenance**
- Single source of truth for infrastructure
- Easy updates and modifications
- Complete cleanup with stack deletion

## Troubleshooting Deployment Issues

### Common Issues and Solutions

#### 1. **IAM Role Not Found**
```
Error: Role arn:aws:iam::123456789012:role/nova-sonic-bridge-task-role does not exist
```
**Solution:** Ensure CloudFormation stack is deployed first, creating all IAM roles.

#### 2. **Task Definition Registration Fails**
```
Error: Invalid role arn:aws:iam::123456789012:role/ecsTaskExecutionRole
```
**Solution:** Wait for CloudFormation to complete IAM role creation before registering task definition.

#### 3. **Lambda Function Update Fails**
```
Error: Invalid role arn:aws:iam::123456789012:role/lambda-execution-role
```
**Solution:** Ensure Lambda execution role exists before updating function code.

### Verification Steps

After deployment, verify all resources exist:

```bash
# Check IAM roles
aws iam get-role --role-name nova-sonic-ecs-stack-ecs-task-execution-role
aws iam get-role --role-name nova-sonic-ecs-stack-nova-sonic-bridge-task-role
aws iam get-role --role-name nova-sonic-ecs-stack-lambda-execution-role

# Check ECS cluster
aws ecs describe-clusters --clusters nova-sonic-ecs-cluster

# Check Lambda function
aws lambda get-function --function-name invoke-ecs-ec2-task

# Check ECR repository
aws ecr describe-repositories --repository-names nova-sonic-bridge
```

## Migration from Manual to Automated

If you have an existing manual deployment:

1. **Backup current configuration**
   ```bash
   aws ecs describe-task-definition --task-definition nova-sonic-bridge > backup-task-def.json
   aws lambda get-function --function-name invoke-ecs-ec2-task > backup-lambda.json
   ```

2. **Deploy CloudFormation stack**
   ```bash
   ./deploy-complete.sh
   ```

3. **Verify migration**
   - Test Lambda function
   - Test ECS task execution
   - Monitor logs for any issues

4. **Clean up old resources** (optional)
   - Delete old IAM roles
   - Remove old ECR repositories
   - Clean up old CloudWatch log groups

## Best Practices

### 1. **Use CloudFormation for All Infrastructure**
- Avoid manual resource creation
- Maintain infrastructure as code
- Enable version control and rollback

### 2. **Parameterize Your Deployment**
- Use CloudFormation parameters for customization
- Environment-specific configurations
- Easy replication across regions

### 3. **Monitor Deployment**
- Check CloudFormation events during deployment
- Verify all resources are created successfully
- Test functionality after deployment

### 4. **Document Your Deployment**
- Keep deployment scripts updated
- Document any custom modifications
- Maintain runbooks for troubleshooting
