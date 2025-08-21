/**
 * Lambda Function to Invoke Fargate Task for WebRTC Bridge
 * 
 * This Lambda function is invoked by Amazon Connect after the "Start Media Streaming" block
 * to start a Fargate task that runs the WebRTC bridge connecting to KVS signaling channels.
 * 
 * Input from Amazon Connect:
 * - Stream ARN from the Start Media Streaming block
 * - Contact ID for call correlation
 * - Customer Phone Number for logging
 * 
 * Output:
 * - Fargate task ARN
 * - Status of task creation
 */

import { ECSClient, RunTaskCommand } from "@aws-sdk/client-ecs";

const ecsClient = new ECSClient({ region: process.env.AWS_REGION || 'us-east-1' });

interface LambdaEvent {
    StreamARN: string;
    ContactId: string;
    CustomerPhoneNumber: string;
}

interface LambdaResponse {
    statusCode: number;
    body: string;
    headers?: Record<string, string>;
}

export const handler = async (event: LambdaEvent): Promise<LambdaResponse> => {
    try {
        console.log('🚀 Lambda invoked with event:', JSON.stringify(event, null, 2));

        const { StreamARN, ContactId, CustomerPhoneNumber } = event;

        // Validate required parameters
        if (!StreamARN || !ContactId || !CustomerPhoneNumber) {
            throw new Error('Missing required parameters: StreamARN, ContactId, or CustomerPhoneNumber');
        }

        // Prepare task definition overrides
        const containerOverrides = [{
            name: 'nova-sonic-bridge',
            environment: [
                { name: 'STREAM_ARN', value: StreamARN },
                { name: 'CONTACT_ID', value: ContactId },
                { name: 'CUSTOMER_PHONE_NUMBER', value: CustomerPhoneNumber },
                { name: 'AWS_REGION', value: process.env.AWS_REGION || 'us-east-1' },
                { name: 'CALL_START_TIME', value: new Date().toISOString() }
            ]
        }];

        // Prepare network configuration
        const networkConfiguration = {
            awsvpcConfiguration: {
                subnets: process.env.SUBNET_IDS?.split(',') || [],
                securityGroups: process.env.SECURITY_GROUP_IDS?.split(',') || [],
                assignPublicIp: 'ENABLED' as const
            }
        };

        // Create RunTask command
        const runTaskCommand = new RunTaskCommand({
            cluster: process.env.ECS_CLUSTER_NAME,
            taskDefinition: process.env.ECS_TASK_DEFINITION,
            launchType: 'FARGATE',
            networkConfiguration,
            overrides: {
                containerOverrides
            }
        });

        console.log('📋 Starting Fargate task for long-running call:', {
            cluster: process.env.ECS_CLUSTER_NAME,
            taskDefinition: process.env.ECS_TASK_DEFINITION,
            streamARN: StreamARN,
            contactId: ContactId,
            customerPhoneNumber: CustomerPhoneNumber,
            note: 'Lambda will return immediately after task starts'
        });

        // Execute the task (non-blocking)
        const result = await ecsClient.send(runTaskCommand);

        if (!result.tasks || result.tasks.length === 0) {
            throw new Error('No tasks were started');
        }

        const task = result.tasks[0];
        const taskArn = task.taskArn;
        const taskStatus = task.lastStatus;

        console.log('✅ Fargate task started successfully for long-running call:', {
            taskArn,
            taskStatus,
            streamARN: StreamARN,
            contactId: ContactId,
            note: 'Task will handle entire call duration independently'
        });

        // Return success response immediately (Lambda terminates here)
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                taskArn,
                taskStatus,
                streamARN: StreamARN,
                contactId: ContactId,
                customerPhoneNumber: CustomerPhoneNumber,
                message: 'Fargate task started successfully for long-running WebRTC bridge',
                note: 'Lambda terminates here. Fargate task handles entire call duration.',
                callStartTime: new Date().toISOString()
            }),
            headers: {
                'Content-Type': 'application/json'
            }
        };

    } catch (error) {
        console.error('❌ Error starting Fargate task:', error);
        
        return {
            statusCode: 500,
            body: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                message: 'Failed to start Fargate task for WebRTC bridge'
            }),
            headers: {
                'Content-Type': 'application/json'
            }
        };
    }
};

// Example usage in Amazon Connect Contact Flow:
/*
Contact Flow Block Configuration:

1. Start Media Streaming Block:
   - Stream Type: Real-time
   - Audio Track: Both inbound/outbound
   - Output: Stream ARN automatically available

2. Set Contact Attributes Block:
   - Store Stream ARN: ${MediaStreaming.StreamARN}
   - Store Contact ID: ${ContactData.ContactId}
   - Store Customer Phone: ${ContactData.CustomerEndpoint.Address}

3. Invoke Lambda Function Block:
   - Function ARN: arn:aws:lambda:region:account:function:invoke-fargate-task
   - Input Parameters:
     {
       "StreamARN": "${MediaStreaming.StreamARN}",
       "ContactId": "${ContactData.ContactId}",
       "CustomerPhoneNumber": "${ContactData.CustomerEndpoint.Address}"
     }
*/
