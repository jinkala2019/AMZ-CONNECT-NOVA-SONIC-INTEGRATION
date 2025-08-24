# Amazon Connect to Nova Sonic WebRTC Bridge Server (ECS EC2)

A real-time audio bridge that connects Amazon Connect contact center calls to Amazon Nova Sonic's AI-powered speech processing using KVS (Kinesis Video Streams) signaling channels and WebRTC technology for intelligent customer service interactions with comprehensive call logging and transcript tracking. This deployment uses ECS with EC2 instances for better performance and control over long-running calls.

## Getting started

### Prerequisites

#### Local Development
- Node.js 18+ installed
- AWS credentials configured (AWS CLI, environment variables, or IAM role)
- Permissions to create IAM roles and policies
- Amazon Bedrock access enabled

#### Amazon Connect Setup
1. Set up an Amazon Connect instance
2. Configure a contact flow with "Start Media Streaming" block that uses KVS signaling channels
3. Ensure your AWS account has access to Amazon Bedrock, Nova Sonic, and KVS
4. Deploy the WebRTC bridge as an ECS EC2 task that can be invoked by Lambda

### Features
- **KVS Signaling Channel Integration**: Proper integration with Amazon Connect's Start Media Streaming block
- **WebRTC Peer Connection Management**: Real-time media streaming over KVS signaling
- **Inbound Call Processing**: Handles incoming customer calls only
- **Interruption Detection**: Real-time detection and handling of customer interruptions
- **AI-Powered Responses**: Nova Sonic provides intelligent customer service
- **Comprehensive Call Logging**: Tracks all call activities with timestamps
- **Customer Phone Number Tracking**: Correlates calls with customer phone numbers
- **Amazon Connect ContactId Tracking**: Links calls to Amazon Connect contact identifiers
- **KVS Stream ARN Correlation**: Links calls to Amazon Connect stream ARNs
- **Nova Sonic Transcript Logging**: Captures all AI responses and interactions
- **Automatic IAM Management**: Creates necessary roles and permissions programmatically
- **Session Management**: Automatic cleanup of orphaned sessions
- **Health Monitoring**: Built-in health checks and monitoring endpoints


### Setup

#### Environment Variables (Required for ECS EC2 Deployment)
The server automatically creates the necessary IAM role and permissions. For ECS EC2 deployment, these environment variables are required:

- `STREAM_ARN` - KVS stream ARN from Amazon Connect's Start Media Streaming block
- `CONTACT_ID` - Amazon Connect Contact ID for call correlation
- `CUSTOMER_PHONE_NUMBER` - Customer's phone number for logging
- `DEPLOYMENT_REGION` - AWS region (defaults to "us-east-1")

#### Build & Run

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Development mode:**
   ```bash
   npm run dev
   ```

3. **Production mode:**
   ```bash
   npm run build
   npm start
   ```

4. **Deploy to AWS (ECS EC2):**
   ```bash
   npm run deploy
   ```

5. **Cleanup IAM resources:**
   ```bash
   npm run cleanup
   ```

#### Server Endpoints

- **Health Check**: `http://localhost:3000/health`
- **Call Logs**: `http://localhost:3000/call-logs`

> **Note**: This server is designed to run as an ECS EC2 task and connect to KVS signaling channels, not as a standalone WebSocket server.

#### Call Logging API

The server provides comprehensive call logging with the following endpoints:

- **All Active Calls**: `GET /call-logs`
- **Specific Session**: `GET /call-logs?sessionId=<session-id>`
- **Customer Calls**: `GET /call-logs?phoneNumber=<phone-number>`
- **Contact Calls**: `GET /call-logs?contactId=<contact-id>`

Each call log includes:
- Customer phone number
- Amazon Connect ContactId
- KVS stream ARN
- Call start/end times
- Complete transcript log
- All Nova Sonic responses
- Interruption detection events

> **Note**: For production deployment, deploy as an ECS EC2 task that can be invoked by Lambda functions. This architecture ensures proper scaling and isolation for each call, with better performance and control over long-running calls.

## Deployment

### Quick Deployment
```bash
npm run deploy
```

This command will:
1. Build the application and Lambda function
2. Deploy all infrastructure using CloudFormation
3. Build and push the Docker image to ECR
4. Create the ECS task definition
5. Update the Lambda function with actual code

### Manual Deployment
For detailed deployment instructions, see `DEPLOYMENT.md`.

### Architecture
- **ECS EC2 Cluster**: Runs the WebRTC bridge containers
- **Lambda Function**: Invokes ECS tasks for each call
- **Auto Scaling Group**: Manages EC2 instances
- **CloudFormation**: Infrastructure as code deployment 

## Amazon Connect Integration

### Architecture Overview

The solution uses the following architecture:
1. **Amazon Connect Contact Flow** → **Lambda Function** → **ECS EC2 Task** → **KVS Signaling Channel** → **WebRTC Bridge** → **Nova Sonic**

### Setup Amazon Connect Contact Flow

1. **Create a Contact Flow** in Amazon Connect that includes a "Start Media Streaming" block
2. **Configure the Start Media Streaming block** to use KVS signaling channels
3. **Add a Lambda Invoke block** after the Start Media Streaming block to invoke your Lambda function
4. **Pass the Stream ARN, Contact ID, and Customer Phone Number** to the Lambda function
5. **Deploy the contact flow** and assign it to your phone number

### Call Flow

#### Inbound Call Processing
1. Customer calls the Amazon Connect number
2. Contact flow starts media streaming using KVS signaling channels
3. Lambda function is invoked with Stream ARN, Contact ID, and Customer Phone Number
4. Lambda starts an ECS EC2 task with the WebRTC bridge (~30 seconds)
5. **Lambda terminates** - ECS EC2 task handles entire call duration independently
6. ECS EC2 task connects to KVS signaling channel using the Stream ARN
7. WebRTC connection is established between Amazon Connect and the bridge
8. Audio is streamed from Amazon Connect to Nova Sonic via the bridge
9. Nova Sonic processes the audio and responds
10. Response is sent back to Amazon Connect through the WebRTC connection
11. All interactions are logged with customer phone number, Contact ID, and stream ARN
12. **ECS EC2 task runs until call ends** (handles calls of any duration)

> **Note**: This architecture handles long-running calls (>15 minutes) by using Lambda as a quick trigger and ECS EC2 for the entire call duration. This provides better performance and control compared to Fargate. See [LONG_RUNNING_CALLS.md](LONG_RUNNING_CALLS.md) for details.

#### Real-time Logging
The system provides comprehensive logging for each call:
- **Call Start**: Customer phone number, ContactId, stream ARN, session ID
- **Audio Processing**: Inbound/outbound audio events
- **Nova Sonic Responses**: Complete transcripts of AI responses
- **Interruption Detection**: Customer interruption events
- **Call End**: Final summary with duration and response count

### Testing

1. **Start the server**: `npm run dev`
2. **Call your Amazon Connect number**
3. **Monitor logs**: Check console output for detailed call tracking
4. **View call logs**: Access `/call-logs` endpoint for call history
5. **Test interruption**: Interrupt the AI while it's speaking to test detection

### Monitoring and Debugging

Use the following endpoints to monitor your system:

```bash
# Health check
curl http://localhost:3000/health

# All active calls
curl http://localhost:3000/call-logs

# Specific call session
curl "http://localhost:3000/call-logs?sessionId=<session-id>"

# Customer call history
curl "http://localhost:3000/call-logs?phoneNumber=<phone-number>"

# Contact call history
curl "http://localhost:3000/call-logs?contactId=<contact-id>"
```
