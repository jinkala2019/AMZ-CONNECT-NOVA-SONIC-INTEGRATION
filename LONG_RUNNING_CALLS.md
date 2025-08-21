# Handling Long-Running Calls (>15 minutes)

## **🚨 Problem: Lambda 15-Minute Timeout**

### **The Issue:**
- **Lambda timeout**: Maximum 15 minutes
- **Audio calls**: Can last 30+ minutes, even hours
- **Result**: Lambda terminates while call is still active
- **Impact**: Call disconnection, poor user experience

### **Current Architecture Limitation:**
```
Amazon Connect → Lambda (15min max) → Fargate Task
                    ↑
              TIMEOUT HERE!
```

## **✅ Solution: Lambda as Trigger Only**

### **Recommended Architecture:**
```
Amazon Connect → Lambda (trigger) → Fargate Task (long-running)
                    ↑                    ↑
              Returns immediately    Handles entire call
              (~30 seconds)         (hours if needed)
```

### **Key Changes:**

1. **Lambda Role**: Start Fargate task only
2. **Lambda Duration**: ~30 seconds (task startup)
3. **Fargate Role**: Handle entire call duration
4. **Call Management**: Fargate manages WebRTC + Nova Sonic

## **🔧 Implementation Details**

### **Lambda Function Behavior:**
```typescript
// Lambda starts Fargate task and returns immediately
export const handler = async (event: LambdaEvent): Promise<LambdaResponse> => {
    // 1. Validate parameters
    // 2. Start Fargate task
    // 3. Return immediately with task ARN
    // 4. Lambda terminates (~30 seconds total)
    
    return {
        statusCode: 200,
        body: JSON.stringify({
            success: true,
            taskArn,
            message: 'Fargate task started for long-running call',
            note: 'Lambda terminates here. Fargate handles entire call.'
        })
    };
};
```

### **Fargate Task Behavior:**
```typescript
// Fargate task runs for entire call duration
async function startServer() {
    // 1. Initialize Nova Sonic client
    // 2. Connect to KVS signaling channel
    // 3. Handle WebRTC connection
    // 4. Process audio streaming
    // 5. Run until call ends (hours if needed)
    // 6. Cleanup and terminate
}
```

## **📊 Call Duration Handling**

### **Short Calls (< 15 minutes):**
- ✅ Lambda + Fargate both work
- ✅ No timeout issues
- ✅ Standard flow

### **Long Calls (15+ minutes):**
- ✅ Lambda starts Fargate and terminates
- ✅ Fargate handles entire call
- ✅ No timeout issues
- ✅ Seamless user experience

### **Very Long Calls (1+ hours):**
- ✅ Fargate continues running
- ✅ WebRTC connection maintained
- ✅ Nova Sonic session active
- ✅ All logging and monitoring works

## **🔄 Alternative Architectures**

### **Option 1: Step Functions (Recommended for Complex Workflows)**
```
Amazon Connect → Lambda → Step Function → Fargate Task
                    ↑           ↑
              Quick trigger    Long-running workflow
```

**Benefits:**
- Step Functions can run for up to 1 year
- Better error handling and retry logic
- Visual workflow management
- Built-in monitoring and logging

### **Option 2: EventBridge + SQS Pattern**
```
Amazon Connect → Lambda → EventBridge → SQS → Fargate Task
                    ↑           ↑
              Quick trigger    Asynchronous processing
```

**Benefits:**
- Decoupled architecture
- Better scalability
- Retry mechanisms
- Dead letter queues

### **Option 3: Direct Fargate Service**
```
Amazon Connect → Fargate Service (always running)
                    ↑
              Direct connection
```

**Benefits:**
- No Lambda involved
- Faster response times
- Always available
- Better for high-volume scenarios

## **⚙️ Configuration Updates**

### **Lambda Configuration:**
```bash
# Set Lambda timeout to 1 minute (enough for task startup)
aws lambda update-function-configuration \
  --function-name invoke-fargate-task \
  --timeout 60
```

### **Fargate Task Configuration:**
```json
{
  "family": "nova-sonic-bridge",
  "cpu": "1024",
  "memory": "2048",
  "requiresCompatibilities": ["FARGATE"],
  "networkMode": "awsvpc",
  "containerDefinitions": [
    {
      "name": "nova-sonic-bridge",
      "image": "nova-sonic-bridge:latest",
      "essential": true,
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/nova-sonic-bridge",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
```

## **📈 Monitoring and Observability**

### **CloudWatch Metrics:**
- **Lambda**: Invocation count, duration, errors
- **Fargate**: CPU, memory, task count, duration
- **KVS**: Stream metrics, connection status
- **Nova Sonic**: API calls, response times

### **Logging Strategy:**
```typescript
// Lambda logs (short duration)
console.log('🚀 Lambda started Fargate task:', { taskArn, contactId });

// Fargate logs (long duration)
console.log('📞 Call started:', { contactId, startTime });
console.log('🎵 Audio processing:', { chunkSize, timestamp });
console.log('🤖 Nova Sonic response:', { responseType, content });
console.log('📞 Call ended:', { contactId, duration, endTime });
```

### **Alerts and Notifications:**
- **Lambda failures**: Immediate alert
- **Fargate task failures**: Alert within 1 minute
- **Long-running calls**: Alert after 30 minutes
- **High resource usage**: CPU/memory alerts

## **💰 Cost Optimization**

### **Lambda Costs:**
- **Duration**: ~30 seconds per call
- **Memory**: 256MB (minimal)
- **Cost**: Very low (~$0.0001 per call)

### **Fargate Costs:**
- **Duration**: Entire call length
- **Resources**: 1 vCPU, 2GB RAM
- **Cost**: ~$0.04 per hour per call

### **Cost Comparison:**
| Call Duration | Lambda Cost | Fargate Cost | Total Cost |
|---------------|-------------|--------------|------------|
| 5 minutes     | $0.0001     | $0.003       | $0.0031    |
| 15 minutes    | $0.0001     | $0.01        | $0.0101    |
| 1 hour        | $0.0001     | $0.04        | $0.0401    |
| 4 hours       | $0.0001     | $0.16        | $0.1601    |

## **🔒 Security Considerations**

### **Network Security:**
- Use private subnets for Fargate tasks
- Configure security groups for minimal access
- Use VPC endpoints for AWS services

### **IAM Security:**
- Lambda: Minimal permissions (ECS:RunTask only)
- Fargate: Full permissions for call handling
- Follow principle of least privilege

### **Data Security:**
- Encrypt data in transit (TLS/WSS)
- Encrypt data at rest (EBS volumes)
- Use AWS KMS for sensitive data

## **🚀 Deployment Strategy**

### **Phase 1: Lambda-Triggered (Current)**
- ✅ Quick implementation
- ✅ Handles long calls
- ✅ Cost-effective
- ✅ Easy monitoring

### **Phase 2: Step Functions (Future)**
- 🔄 Better error handling
- 🔄 Visual workflow management
- 🔄 Advanced retry logic
- 🔄 Better observability

### **Phase 3: Direct Fargate Service (Scale)**
- 🔄 Highest performance
- 🔄 Lowest latency
- 🔄 Best for high volume
- 🔄 More complex setup

## **🧪 Testing Strategy**

### **Short Call Testing:**
```bash
# Test 5-minute call
curl -X POST "your-amazon-connect-endpoint" \
  -d '{"duration": "5m", "test": true}'
```

### **Long Call Testing:**
```bash
# Test 30-minute call
curl -X POST "your-amazon-connect-endpoint" \
  -d '{"duration": "30m", "test": true}'
```

### **Stress Testing:**
```bash
# Test multiple concurrent calls
for i in {1..10}; do
  curl -X POST "your-amazon-connect-endpoint" \
    -d "{\"duration\": \"1h\", \"test\": true, \"callId\": \"$i\"}" &
done
```

## **📋 Implementation Checklist**

- [ ] Update Lambda timeout to 60 seconds
- [ ] Configure Fargate task for long-running calls
- [ ] Update monitoring and alerting
- [ ] Test short calls (< 15 minutes)
- [ ] Test long calls (> 15 minutes)
- [ ] Test very long calls (> 1 hour)
- [ ] Monitor costs and optimize
- [ ] Document procedures
- [ ] Train operations team

## **🎯 Summary**

**The Lambda-Triggered Architecture solves the 15-minute timeout problem by:**

1. **Lambda**: Quick trigger (~30 seconds) to start Fargate task
2. **Fargate**: Long-running container that handles entire call
3. **Result**: No timeout issues, seamless user experience
4. **Cost**: Minimal additional cost
5. **Scalability**: Handles calls of any duration

**This approach is production-ready and handles the real-world scenario of long customer service calls.**
