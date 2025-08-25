# Continuous Mode Improvements

## Overview
This document outlines the improvements made to address cold start delays and timeout issues in the Nova Sonic WebRTC Bridge.

## Key Improvements

### 1. Extended Session Timeout
- **Previous**: 60 seconds timeout
- **New**: 300 seconds (5 minutes) timeout
- **Benefit**: More time for Nova Sonic to process and respond to audio input

### 2. Continuous Mode Architecture
- **Previous**: Start new ECS task for each call
- **New**: Single continuously running ECS task that handles multiple calls
- **Benefits**:
  - Eliminates cold start delays
  - Maintains persistent Nova Sonic connection
  - Faster call handling
  - Better resource utilization

### 3. Keep-Alive Mechanism
- **Feature**: Automatic ping every 30 seconds to maintain Nova Sonic connection
- **Benefit**: Prevents connection timeouts and ensures bridge stays ready

## Architecture Changes

### WebRTCBridgeServer.ts
- Added `/handle-call` endpoint for incoming calls
- Implemented continuous mode with keep-alive pings
- Extended session timeout to 300 seconds
- Added comprehensive logging for call handling

### New Lambda Function
- **File**: `lambda/lambda-invoke-continuous-bridge.ts`
- **Purpose**: Calls the continuously running bridge instead of starting new tasks
- **Benefits**: Faster response times, no cold starts

### Dockerfile
- Updated to run in continuous mode by default
- Command: `node dist/WebRTCBridgeServer.js --continuous`

### CloudFormation Template
- Added new Lambda function for continuous bridge invocation
- Maintains existing infrastructure for backward compatibility

## Usage

### Option 1: Continuous Mode (Recommended)
1. Deploy the stack - ECS task runs continuously
2. Lambda calls `/handle-call` endpoint for each incoming call
3. Bridge maintains Nova Sonic connection across calls

### Option 2: Per-Call Mode (Legacy)
1. Lambda starts new ECS task for each call
2. Each task initializes its own Nova Sonic connection
3. Higher latency but isolated call handling

## Deployment

```bash
# Deploy with continuous mode
npm run deploy
```

## Testing

### Health Check
```bash
curl http://localhost:3000/health
```

### Test Audio
```bash
curl -X POST http://localhost:3000/test-audio
```

### Handle Call
```bash
curl -X POST http://localhost:3000/handle-call \
  -H "Content-Type: application/json" \
  -d '{
    "contactId": "test-contact-123",
    "customerPhoneNumber": "+1234567890",
    "streamARN": "arn:aws:kinesisvideo:us-east-1:123456789012:stream/test-stream"
  }'
```

## Monitoring

### Logs
- ECS task logs: CloudWatch `/ecs/nova-sonic-ec2-bridge`
- Lambda logs: CloudWatch for both Lambda functions

### Metrics
- Session timeout events
- Keep-alive ping success/failure
- Call handling response times
- Nova Sonic response statistics

## Configuration

### Environment Variables
- `SESSION_TIMEOUT_MS`: Session timeout in milliseconds (default: 300000)
- `KEEP_ALIVE_INTERVAL`: Keep-alive ping interval in milliseconds (default: 30000)

### Timeout Settings
- **Session Timeout**: 300 seconds (5 minutes)
- **Lambda Timeout**: 60 seconds
- **Health Check Timeout**: 5 seconds
- **Keep-Alive Interval**: 30 seconds

## Benefits

1. **Reduced Latency**: No cold start delays
2. **Better Reliability**: Persistent Nova Sonic connection
3. **Improved Performance**: Faster call handling
4. **Resource Efficiency**: Single task handles multiple calls
5. **Extended Timeout**: More time for Nova Sonic processing

## Next Steps

1. Deploy the updated stack
2. Test with continuous mode
3. Monitor performance and Nova Sonic responses
4. Gradually add back WebRTC/KVS features if needed
