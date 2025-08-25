/**
 * Lambda Function to Invoke Continuous WebRTC Bridge
 * 
 * This Lambda function is invoked by Amazon Connect after the "Start Media Streaming" block
 * to call the continuously running WebRTC bridge that maintains Nova Sonic connection.
 * 
 * Input from Amazon Connect:
 * - Stream ARN from the Start Media Streaming block
 * - Contact ID for call correlation
 * - Customer Phone Number for logging
 * 
 * Output:
 * - Call handling status
 * - Session information
 */

import { ECSClient, ListTasksCommand, DescribeTasksCommand } from "@aws-sdk/client-ecs";

const ecsClient = new ECSClient({ region: process.env.DEPLOYMENT_REGION || 'us-east-1' });

interface LambdaEvent {
    Details: {
        Parameters: {
            StreamARN: string;
            ContactId: string;
            CustomerPhoneNumber: string;
        };
    };
    Name: string;
}

interface LambdaResponse {
    statusCode: number;
    body: string;
    headers?: Record<string, string>;
}

export const handler = async (event: LambdaEvent): Promise<LambdaResponse> => {
    try {
        console.log('🚀 Lambda invoked with event:', JSON.stringify(event, null, 2));

        // Validate event structure
        if (!event.Details || !event.Details.Parameters) {
            console.error('❌ Invalid event structure. Expected event.Details.Parameters');
            throw new Error('Invalid event structure. Expected event.Details.Parameters');
        }

        const { StreamARN, ContactId, CustomerPhoneNumber } = event.Details.Parameters;

        // Validate required parameters
        if (!StreamARN || !ContactId || !CustomerPhoneNumber) {
            throw new Error('Missing required parameters: StreamARN, ContactId, or CustomerPhoneNumber');
        }

        // Find the running ECS task
        const listTasksCommand = new ListTasksCommand({
            cluster: process.env.ECS_CLUSTER_NAME,
            family: 'nova-sonic-ec2-bridge',
            desiredStatus: 'RUNNING'
        });

        const listResult = await ecsClient.send(listTasksCommand);
        
        if (!listResult.taskArns || listResult.taskArns.length === 0) {
            throw new Error('No running ECS tasks found for nova-sonic-ec2-bridge');
        }

        const taskArn = listResult.taskArns[0];
        console.log('📋 Found running task:', taskArn);

        // Get task details to find the private IP
        const describeTasksCommand = new DescribeTasksCommand({
            cluster: process.env.ECS_CLUSTER_NAME,
            tasks: [taskArn]
        });

        const describeResult = await ecsClient.send(describeTasksCommand);
        
        if (!describeResult.tasks || describeResult.tasks.length === 0) {
            throw new Error('Could not get task details');
        }

        const task = describeResult.tasks[0];
        const privateIp = task.containers?.[0]?.networkInterfaces?.[0]?.privateIpv4Address;

        if (!privateIp) {
            throw new Error('Could not get task private IP address');
        }

        console.log('🌐 Task private IP:', privateIp);

        // Call the continuous bridge endpoint
        const bridgeUrl = `http://${privateIp}:3000/handle-call`;
        const payload = {
            contactId: ContactId,
            customerPhoneNumber: CustomerPhoneNumber,
            streamARN: StreamARN
        };

        console.log('📞 Calling continuous bridge:', {
            url: bridgeUrl,
            payload: payload
        });

        // Make HTTP request to the bridge
        const response = await fetch(bridgeUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Bridge call failed: ${response.status} ${errorText}`);
        }

        const bridgeResponse = await response.json();

        console.log('✅ Bridge call successful:', bridgeResponse);

        // Return success response
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                taskArn,
                taskPrivateIp: privateIp,
                streamARN: StreamARN,
                contactId: ContactId,
                customerPhoneNumber: CustomerPhoneNumber,
                bridgeResponse,
                message: 'Call handled by continuous WebRTC bridge',
                callStartTime: new Date().toISOString()
            }),
            headers: {
                'Content-Type': 'application/json'
            }
        };

    } catch (error) {
        console.error('❌ Error calling continuous bridge:', error);
        
        return {
            statusCode: 500,
            body: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                message: 'Failed to call continuous WebRTC bridge'
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
   - Function ARN: arn:aws:lambda:region:account:function:invoke-continuous-bridge
   - Input Parameters:
     {
       "Details": {
         "Parameters": {
           "StreamARN": "${MediaStreaming.StreamARN}",
           "ContactId": "${ContactData.ContactId}",
           "CustomerPhoneNumber": "${ContactData.CustomerEndpoint.Address}"
         }
       }
     }
*/
