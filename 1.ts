/**
 * Amazon Connect to Nova Sonic WebRTC Bridge
 * 
 * This module establishes a real-time audio bridge between Amazon Connect and Amazon Nova Sonic.
 * It programmatically creates the necessary IAM role and permissions instead of requiring
 * environment variables.
 * 
 * Usage:
 * - Normal startup: node 1.js
 * - Cleanup role: node 1.js --cleanup
 * 
 * Prerequisites:
 * - AWS credentials configured (AWS CLI, environment variables, or IAM role)
 * - Permissions to create IAM roles and policies
 * - Amazon Bedrock access enabled
 * 
 * The script will:
 * 1. Create an IAM role with necessary Bedrock permissions
 * 2. Initialize the Nova Sonic client with the created role
 * 3. Start the WebRTC bridge server
 */

import Fastify from 'fastify';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import { randomUUID } from "node:crypto";
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import { IAMClient, CreateRoleCommand, AttachRolePolicyCommand, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { S2SBidirectionalStreamClient, StreamSession } from './src/nova-client';
import { mulaw } from 'alawmulaw';

// AWS Configuration
const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const ROLE_NAME = "NovaSonicWebRTCBridgeRole";
const POLICY_NAME = "NovaSonicWebRTCBridgePolicy";

// Initialize AWS clients
const iamClient = new IAMClient({ region: AWS_REGION });
const stsClient = new STSClient({ region: AWS_REGION });

/**
 * Create IAM role with necessary permissions for Nova Sonic and Bedrock
 */
async function createNovaSonicRole() {
    try {
        console.log('🔧 Creating IAM role for Nova Sonic WebRTC Bridge...');
        
        // Trust policy for the role - allows current user and EC2 instances
        const trustPolicy = {
            Version: "2012-10-17",
            Statement: [
                {
                    Effect: "Allow",
                    Principal: {
                        Service: "ec2.amazonaws.com"
                    },
                    Action: "sts:AssumeRole"
                },
                {
                    Effect: "Allow",
                    Principal: {
                        AWS: "*" // In production, you should restrict this to specific ARNs
                    },
                    Action: "sts:AssumeRole",
                    Condition: {
                        StringEquals: {
                            "aws:RequestTag/Environment": "nova-sonic-bridge"
                        }
                    }
                }
            ]
        };

        // Create the role
        const createRoleCommand = new CreateRoleCommand({
            RoleName: ROLE_NAME,
            AssumeRolePolicyDocument: JSON.stringify(trustPolicy),
            Description: "Role for Nova Sonic WebRTC Bridge to access Bedrock services",
            Tags: [
                {
                    Key: "Environment",
                    Value: "nova-sonic-bridge"
                },
                {
                    Key: "Purpose",
                    Value: "WebRTC Bridge for Amazon Connect to Nova Sonic"
                }
            ]
        });

        const roleResult = await iamClient.send(createRoleCommand);
        console.log(`✅ Created IAM role: ${roleResult.Role?.Arn}`);

        // Create inline policy for Bedrock permissions
        const bedrockPolicy = {
            Version: "2012-10-17",
            Statement: [
                {
                    Effect: "Allow",
                    Action: [
                        "bedrock:InvokeModel",
                        "bedrock:InvokeModelWithResponseStream",
                        "bedrock:ListFoundationModels",
                        "bedrock:GetFoundationModel"
                    ],
                    Resource: "*"
                },
                {
                    Effect: "Allow",
                    Action: [
                        "logs:CreateLogGroup",
                        "logs:CreateLogStream",
                        "logs:PutLogEvents"
                    ],
                    Resource: "*"
                }
            ]
        };

        // Attach the inline policy
        const putPolicyCommand = new PutRolePolicyCommand({
            RoleName: ROLE_NAME,
            PolicyName: POLICY_NAME,
            PolicyDocument: JSON.stringify(bedrockPolicy)
        });

        await iamClient.send(putPolicyCommand);
        console.log(`✅ Attached policy: ${POLICY_NAME}`);

        return roleResult.Role?.Arn;
    } catch (error: any) {
        if (error.name === 'EntityAlreadyExistsException') {
            console.log(`✅ Role ${ROLE_NAME} already exists, using existing role`);
            const accountId = await getAccountId();
            return `arn:aws:iam::${accountId}:role/${ROLE_NAME}`;
        }
        console.error('❌ Error creating IAM role:', error);
        throw error;
    }
}

/**
 * Cleanup function to remove the created role (for testing/cleanup purposes)
 */
async function cleanupRole() {
    try {
        console.log('🧹 Cleaning up IAM role...');
        
        // Delete the inline policy first
        const { DeleteRolePolicyCommand } = await import("@aws-sdk/client-iam");
        await iamClient.send(new DeleteRolePolicyCommand({
            RoleName: ROLE_NAME,
            PolicyName: POLICY_NAME
        }));
        console.log(`✅ Deleted policy: ${POLICY_NAME}`);
        
        // Delete the role
        const { DeleteRoleCommand } = await import("@aws-sdk/client-iam");
        await iamClient.send(new DeleteRoleCommand({
            RoleName: ROLE_NAME
        }));
        console.log(`✅ Deleted role: ${ROLE_NAME}`);
    } catch (error: any) {
        if (error.name === 'NoSuchEntityException') {
            console.log(`✅ Role ${ROLE_NAME} doesn't exist, nothing to clean up`);
        } else {
            console.error('❌ Error cleaning up role:', error);
        }
    }
}

/**
 * Get AWS account ID using STS GetCallerIdentity
 */
async function getAccountId(): Promise<string> {
    try {
        const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
        const stsClient = new STSClient({ region: AWS_REGION });
        
        const response = await stsClient.send(new GetCallerIdentityCommand({}));
        return response.Account || '';
    } catch (error: any) {
        console.error('Error getting account ID:', error);
        // Fallback: try to extract from error message
        const match = error.message.match(/arn:aws:iam::(\d+):role/);
        return match ? match[1] : '';
    }
}

/**
 * Initialize the Nova Sonic client with programmatically created role
 */
async function initializeNovaSonicClient() {
    try {
        // Create or get the role ARN
        const roleArn = await createNovaSonicRole();
        
        console.log(`🔐 Using role ARN: ${roleArn}`);

        // Create the AWS Bedrock client using the created role
        const bedrockClient = new S2SBidirectionalStreamClient({
            requestHandlerConfig: {
                maxConcurrentStreams: 10,
            },
            clientConfig: {
                region: AWS_REGION,
                credentials: fromTemporaryCredentials({
                    params: {
                        RoleArn: roleArn,
                        RoleSessionName: `nova-sonic-session-${Date.now()}`
                    }
                })
            }
        });

        console.log('✅ Nova Sonic client initialized successfully');
        return bedrockClient;
    } catch (error) {
        console.error('❌ Failed to initialize Nova Sonic client:', error);
        throw error;
    }
}

// Initialize the client (will be called before starting the server)
let bedrockClient: S2SBidirectionalStreamClient;

// Session management for inbound calls
const sessionMap: Record<string, StreamSession> = {};
const sessionActivityTimes: Record<string, number> = {};

/**
 * Cleanup orphaned sessions periodically
 */
function cleanupOrphanedSessions() {
    const now = Date.now();
    const sessionIds = Object.keys(sessionMap);
    
    sessionIds.forEach(async (sessionId) => {
        try {
            const session = sessionMap[sessionId];
            const lastActivity = sessionActivityTimes[sessionId] || 0;
            
            // Close sessions that have been inactive for more than 5 minutes
            if (session && now - lastActivity > 5 * 60 * 1000) {
                console.log(`🧹 Cleaning up orphaned session: ${sessionId}`);
                await session.close();
                delete sessionMap[sessionId];
                delete sessionActivityTimes[sessionId];
            }
        } catch (error) {
            console.error(`❌ Error cleaning up session ${sessionId}:`, error);
            delete sessionMap[sessionId];
            delete sessionActivityTimes[sessionId];
        }
    });
}

// Run cleanup every 2 minutes
setInterval(cleanupOrphanedSessions, 2 * 60 * 1000);

const SYSTEM_PROMPT = `You are a customer service agent for a car rental company, "The Car Genie". 
You are handling INBOUND calls only from customers who have called our service.

IMPORTANT GUIDELINES:
- Keep responses professional, polite, and concise (2-3 sentences maximum)
- Always acknowledge when a customer interrupts you and respond appropriately
- If interrupted, stop your current response and address the customer's immediate concern
- Be patient and understanding with customer interruptions
- Maintain a helpful and professional tone even when interrupted
- Use phrases like "I understand you'd like to interrupt" or "Let me address your concern" when interrupted

INTERRUPTION HANDLING:
- When a customer interrupts, immediately stop your current response
- Acknowledge the interruption politely
- Ask the customer to clarify their immediate concern
- Provide a brief, direct answer to their question
- Offer to continue with the previous topic if needed

You are here to answer questions related to car rentals:
- Booking status inquiries
- Cancellations and modifications
- Extensions and renewals
- Policy questions
- General customer service

At all costs, avoid answering any general real world questions or questions unrelated to "The Car Genie" car rental company.

For any booking-related actions, please confirm with the customer before invoking tools.

Start with a warm greeting: "Thank you for calling The Car Genie. My name is [AI Name], and I'm here to help you with your car rental needs. How may I assist you today?"`;

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Root Route - Inbound Calls Only
fastify.get('/', async (request, reply) => {
    reply.send({ 
        message: 'Amazon Connect to Nova Sonic WebRTC Bridge - INBOUND CALLS ONLY',
        status: 'healthy',
        timestamp: new Date().toISOString(),
        endpoints: {
            websocket: '/media-stream',
            health: '/health'
        },
        features: [
            'Inbound call processing only',
            'Customer interruption detection',
            'Real-time audio streaming',
            'AI-powered customer service'
        ]
    });
});

// Health check endpoint
fastify.get('/health', async (request, reply) => {
    reply.send({ 
        status: 'healthy',
        activeSessions: Object.keys(sessionMap).length,
        timestamp: new Date().toISOString()
    });
});

// WebSocket route for media-stream (Amazon Connect) - INBOUND CALLS ONLY
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('🟢 Amazon Connect INBOUND call connected');

        // Create a session for this inbound call
        const sessionId = randomUUID();
        const session: StreamSession = bedrockClient.createStreamSession(sessionId);
        sessionMap[sessionId] = session; // Store the session in the map
        sessionActivityTimes[sessionId] = Date.now(); // Track activity time
        bedrockClient.initiateSession(sessionId); // Initiate the session

        // Session state tracking for interruption handling
        let isAgentSpeaking = false;
        let lastCustomerAudioTime = Date.now();
        let interruptionDetected = false;
        let audioBufferQueue: Buffer[] = [];
        let sessionInterruptionFlag = false;
        const INTERRUPTION_THRESHOLD = 500; // 500ms threshold for interruption detection

        console.log(`📞 Created session ${sessionId} for inbound call`);

        // Handle incoming messages from Amazon Connect
        connection.on('message', async (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'connected':
                        console.log(`🔗 Connected event received for session: ${sessionId}`);
                        await session.setupPromptStart();
                        break;

                    case 'start':
                        console.log(`🎬 Stream started for inbound call - ARN: ${data.streamARN}`);
                        await session.setupSystemPrompt(undefined, SYSTEM_PROMPT);
                        await session.setupStartAudio();
                        session.streamARN = data.streamARN;
                        break;

                    case 'media':
                        if (!session.streamARN) {
                            console.warn('⚠️ Received media before stream start');
                            break;
                        }

                        // Track customer audio activity for interruption detection
                        if (data.media.track === 'inbound') {
                            lastCustomerAudioTime = Date.now();
                            sessionActivityTimes[sessionId] = Date.now(); // Update activity time
                            
                            // Check for interruption while agent is speaking
                            if (isAgentSpeaking && !interruptionDetected) {
                                const timeSinceAgentStarted = Date.now() - lastCustomerAudioTime;
                                if (timeSinceAgentStarted < INTERRUPTION_THRESHOLD) {
                                    interruptionDetected = true;
                                    console.log(`🔄 Customer interruption detected in session ${sessionId}`);
                                    
                                    // Mark interruption for Nova Sonic to handle in the response
                                    sessionInterruptionFlag = true;
                                }
                            }
                        }

                        // Process audio data
                        try {
                            // Convert from 8-bit μ-law to 16-bit LPCM
                            const audioInput = Buffer.from(data.media.payload, 'base64');
                            const pcmSamples = mulaw.decode(audioInput);
                            const audioBuffer = Buffer.from(pcmSamples.buffer);

                            // Queue audio for processing (helps with interruption handling)
                            audioBufferQueue.push(audioBuffer);
                            
                            // Process audio in batches for better interruption detection
                            if (audioBufferQueue.length >= 3) { // Process every 3 audio chunks
                                const combinedBuffer = Buffer.concat(audioBufferQueue);
                                await session.streamAudio(combinedBuffer);
                                audioBufferQueue = [];
                            }
                        } catch (audioError) {
                            console.error(`❌ Audio processing error in session ${sessionId}:`, audioError);
                        }
                        break;

                    case 'stop':
                        console.log(`🛑 Stream stopped for session ${sessionId}`);
                        // Process any remaining audio in queue
                        if (audioBufferQueue.length > 0) {
                            const remainingBuffer = Buffer.concat(audioBufferQueue);
                            await session.streamAudio(remainingBuffer);
                            audioBufferQueue = [];
                        }
                        // End the session gracefully
                        await session.endAudioContent();
                        break;

                    default:
                        console.log(`📡 Non-media event received: ${data.event}`);
                        break;
                }
            } catch (error) {
                console.error(`❌ Error parsing message in session ${sessionId}:`, error);
                connection.close();
            }
        });

        // Handle connection close
        connection.on('close', () => {
            console.log(`📞 Amazon Connect INBOUND call disconnected for session: ${sessionId}`);
            delete sessionMap[sessionId];
            delete sessionActivityTimes[sessionId];
        });

        // Handle Nova Sonic events for inbound calls
        session.onEvent('contentStart', (data) => {
            console.log(`🎤 Agent started speaking in session ${sessionId}`);
            isAgentSpeaking = true;
            interruptionDetected = false; // Reset interruption flag
        });

        session.onEvent('textOutput', (data) => {
            const textPreview = data.content.substring(0, 100) + (data.content.length > 100 ? '...' : '');
            console.log(`💬 Agent text output in session ${sessionId}: ${textPreview}`);
            
            // Check if this response acknowledges an interruption
            if (sessionInterruptionFlag && data.content.toLowerCase().includes('interrupt')) {
                console.log(`✅ Agent acknowledged interruption in session ${sessionId}`);
                sessionInterruptionFlag = false;
            }
        });

        session.onEvent('audioOutput', (data) => {
            try {
                // Decode base64 to get the PCM buffer from Nova Sonic
                const buffer = Buffer.from(data['content'], 'base64');
                const pcmSamples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / Int16Array.BYTES_PER_ELEMENT);
                
                // Encode to μ-law (8-bit) for Amazon Connect
                const mulawSamples = mulaw.encode(pcmSamples);
                const payload = Buffer.from(mulawSamples).toString('base64');

                // Create audio response message for Amazon Connect
                const audioResponse = {
                    event: "media",
                    media: {
                        track: "outbound",
                        payload
                    },
                    streamARN: session.streamARN
                };

                // Send audio response back to Amazon Connect
                connection.send(JSON.stringify(audioResponse));
                
                console.log(`🔊 Sent audio response to customer in session ${sessionId}`);
            } catch (audioError) {
                console.error(`❌ Error processing agent audio output in session ${sessionId}:`, audioError);
            }
        });

        session.onEvent('error', (data) => {
            console.error(`❌ Nova Sonic error in session ${sessionId}:`, data);
            isAgentSpeaking = false; // Reset speaking state on error
        });

        session.onEvent('toolUse', async (data) => {
            console.log(`🔧 Tool use detected in session ${sessionId}: ${data.toolName}`);
            // Handle tool use for inbound calls (e.g., booking lookups, policy checks)
            // TODO: Implement specific tool logic for car rental services
        });

        session.onEvent('toolResult', (data) => {
            console.log(`📋 Tool result received in session ${sessionId}:`, data);
        });

        session.onEvent('contentEnd', (data) => {
            console.log(`🔚 Agent finished speaking in session ${sessionId}`);
            isAgentSpeaking = false;
            interruptionDetected = false; // Reset interruption flag
        });

        session.onEvent('streamComplete', () => {
            console.log(`✅ Stream completed for inbound call session ${sessionId}, ARN: ${session.streamARN}`);
            isAgentSpeaking = false;
        });
    });
});

/**
 * Start the server with proper initialization
 */
async function startServer() {
    try {
        // Initialize the Nova Sonic client first
        console.log('🚀 Initializing Nova Sonic WebRTC Bridge...');
        bedrockClient = await initializeNovaSonicClient();
        
        // Start the Fastify server
        await fastify.listen({ port: 3000, host: '0.0.0.0' });
        console.log('✅ Server is listening on port 3000');
        console.log('📡 WebSocket endpoint: ws://localhost:3000/media-stream');
        console.log('🔗 Health check: http://localhost:3000/');
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down Nova Sonic WebRTC Bridge...');
    await fastify.close();
    process.exit(0);
});

// Export functions for external use
export { startServer, cleanupRole, createNovaSonicRole };

// Handle command line arguments
const args = process.argv.slice(2);
if (args.includes('--cleanup')) {
    console.log('🧹 Running cleanup...');
    cleanupRole().then(() => {
        console.log('✅ Cleanup completed');
        process.exit(0);
    }).catch((error) => {
        console.error('❌ Cleanup failed:', error);
        process.exit(1);
    });
} else {
    // Start the server
    startServer();
}