# Project Structure

This project provides a complete ECS EC2 deployment for the Amazon Connect to Nova Sonic WebRTC Bridge.

## Core Files

### Deployment Files
- **`deploy.sh`** - Main deployment script (run with `npm run deploy`)
- **`ecs-deployment.yaml`** - CloudFormation template for all AWS infrastructure
- **`ecs-task-definition-ec2.json`** - ECS task definition for EC2 launch type
- **`Dockerfile`** - Container image definition

### Application Files
- **`WebRTCBridgeServer.ts`** - Main WebRTC bridge server
- **`src/`** - TypeScript source code
- **`lambda/`** - Lambda function code for invoking ECS tasks

### Documentation
- **`README.md`** - Project overview and quick start
- **`DEPLOYMENT.md`** - Detailed deployment instructions
- **`PROJECT_STRUCTURE.md`** - This file

## Quick Start

1. **Deploy everything:**
   ```bash
   npm run deploy
   ```

2. **Configure Amazon Connect:**
   - Follow instructions in `DEPLOYMENT.md`
   - Set up contact flow to invoke the Lambda function

## Architecture

```
Amazon Connect → Lambda → ECS EC2 Task → Nova Sonic
```

- **Lambda**: Invokes ECS tasks for each call
- **ECS EC2**: Runs WebRTC bridge containers
- **Auto Scaling**: Manages EC2 instances
- **CloudFormation**: Infrastructure as code
