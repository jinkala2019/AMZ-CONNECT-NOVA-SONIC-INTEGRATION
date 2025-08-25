/**
 * Amazon Connect to Nova Sonic WebRTC Bridge Server
 * 
 * This module establishes a real-time audio bridge between Amazon Connect and Amazon Nova Sonic
 * using KVS (Kinesis Video Streams) signaling channels and WebRTC connections.
 * It programmatically creates the necessary IAM role and permissions.
 * 
 * Features:
 * - KVS signaling channel integration
 * - WebRTC peer connection management (simplified demo)
 * - Real-time audio streaming
 * - Customer interruption detection and handling
 * - AI-powered customer service
 * - Automatic session management
 * - Programmatic IAM role creation
 * 
 * Usage:
 * - Development: npm run dev
 * - Production: npm run start
 * - Cleanup role: npm run cleanup
 * 
 * Prerequisites:
 * - AWS credentials configured (AWS CLI, environment variables, or IAM role)
 * - Permissions to create IAM roles and policies
 * - Amazon Bedrock access enabled
 * - KVS stream ARN passed via environment variable
 * 
 * The script will:
 * 1. Create an IAM role with necessary Bedrock and KVS permissions
 * 2. Initialize the Nova Sonic client with the created role
 * 3. Connect to KVS signaling channel using Stream ARN
 * 4. Establish WebRTC peer connection with Amazon Connect
 * 5. Handle real-time audio streaming with Nova Sonic
 */

import Fastify from 'fastify';
import fastifyFormBody from '@fastify/formbody';
import { randomUUID } from "node:crypto";
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import { IAMClient, CreateRoleCommand, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { STSClient } from "@aws-sdk/client-sts";
import { S2SBidirectionalStreamClient, StreamSession } from './src/nova-client';
import { mulaw } from 'alawmulaw';

// AWS Configuration
const AWS_REGION = process.env.DEPLOYMENT_REGION || "us-east-1";
const ROLE_NAME = "NovaSonicWebRTCBridgeRole";
const POLICY_NAME = "NovaSonicWebRTCBridgePolicy";

// KVS Configuration (passed from Lambda/Fargate)
const STREAM_ARN = process.env.STREAM_ARN;
const CONTACT_ID = process.env.CONTACT_ID || 'Unknown';
const CUSTOMER_PHONE_NUMBER = process.env.CUSTOMER_PHONE_NUMBER || 'Unknown';

// Debug: Log environment variables
console.log('🔍 Environment Variables Debug:', {
    STREAM_ARN: STREAM_ARN,
    CONTACT_ID: CONTACT_ID,
    CUSTOMER_PHONE_NUMBER: CUSTOMER_PHONE_NUMBER,
    DEPLOYMENT_REGION: process.env.DEPLOYMENT_REGION,
    CALL_START_TIME: process.env.CALL_START_TIME
});

// Initialize AWS clients
const iamClient = new IAMClient({ region: AWS_REGION });
const stsClient = new STSClient({ region: AWS_REGION });

// Session management
let bedrockClient: S2SBidirectionalStreamClient;
let novaSonicSession: StreamSession;

// Call tracking and logging
interface CallSession {
    sessionId: string;
    customerPhoneNumber: string;
    streamARN: string;
    contactId: string;
    startTime: Date;
    lastActivity: Date;
    transcriptLog: string[];
    novaSonicResponses: string[];
    kvsState: 'connecting' | 'connected' | 'disconnected';
    webRTCState: 'connecting' | 'connected' | 'disconnected';
}

const callSession: CallSession = {
    sessionId: randomUUID(),
    customerPhoneNumber: CUSTOMER_PHONE_NUMBER,
    streamARN: STREAM_ARN || 'Unknown',
    contactId: CONTACT_ID,
    startTime: new Date(),
    lastActivity: new Date(),
    transcriptLog: [],
    novaSonicResponses: [],
    kvsState: 'connecting',
    webRTCState: 'connecting'
};

/**
 * Log call activity with comprehensive details
 */
function logCallActivity(event: string, details: any = {}) {
    const timestamp = new Date().toISOString();
    
    const logEntry = {
        timestamp,
        sessionId: callSession.sessionId,
        event,
        customerPhoneNumber: callSession.customerPhoneNumber,
        streamARN: callSession.streamARN,
        contactId: callSession.contactId,
        webRTCState: callSession.webRTCState,
        kvsState: callSession.kvsState,
        details
    };
    
    console.log(`📞 [CALL LOG] ${JSON.stringify(logEntry)}`);
    
    // Store in session for later retrieval
    callSession.lastActivity = new Date();
    callSession.transcriptLog.push(`${timestamp} - ${event}: ${JSON.stringify(details)}`);
}

/**
 * Log Nova Sonic response with transcript
 */
function logNovaSonicResponse(responseType: string, content: string) {
    const timestamp = new Date().toISOString();
    
    const logEntry = {
        timestamp,
        sessionId: callSession.sessionId,
        responseType,
        customerPhoneNumber: callSession.customerPhoneNumber,
        streamARN: callSession.streamARN,
        contactId: callSession.contactId,
        content: content.substring(0, 500) + (content.length > 500 ? '...' : ''),
        fullContent: content
    };
    
    console.log(`🤖 [NOVA SONIC] ${JSON.stringify(logEntry)}`);
    
    // Store in session
    callSession.lastActivity = new Date();
    callSession.novaSonicResponses.push(`${timestamp} - ${responseType}: ${content}`);
}

/**
 * Create IAM role with necessary permissions for Nova Sonic, Bedrock, and KVS
 */
async function createNovaSonicRole() {
    try {
        console.log('🔧 Creating IAM role for Nova Sonic WebRTC Bridge...');
        
        // Trust policy for the role
        const trustPolicy = {
            Version: "2012-10-17",
            Statement: [
                {
                    Effect: "Allow",
                    Principal: {
                        Service: "ecs-tasks.amazonaws.com"
                    },
                    Action: "sts:AssumeRole"
                }
            ]
        };

        // Create the role
        const createRoleCommand = new CreateRoleCommand({
            RoleName: ROLE_NAME,
            AssumeRolePolicyDocument: JSON.stringify(trustPolicy),
            Description: "Role for Nova Sonic WebRTC Bridge to access Bedrock and KVS services",
            Tags: [
                {
                    Key: "Environment",
                    Value: "nova-sonic-ec2-bridge"
                },
                {
                    Key: "Purpose",
                    Value: "WebRTC Bridge for Amazon Connect to Nova Sonic"
                }
            ]
        });

        const roleResult = await iamClient.send(createRoleCommand);
        console.log(`✅ Created IAM role: ${roleResult.Role?.Arn}`);

        // Create inline policy for Bedrock and KVS permissions
        const policy = {
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
                        "kinesisvideo:GetSignalingChannelEndpoint",
                        "kinesisvideo:ConnectAsViewer",
                        "kinesisvideo:ConnectAsMaster"
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
            PolicyDocument: JSON.stringify(policy)
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
 * Get AWS account ID using STS GetCallerIdentity
 */
async function getAccountId(): Promise<string> {
    try {
        const { GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
        const response = await stsClient.send(new GetCallerIdentityCommand({}));
        return response.Account || '';
    } catch (error: any) {
        console.error('Error getting account ID:', error);
        return '';
    }
}

/**
 * Cleanup function to remove the created role
 */
async function cleanupRole() {
    try {
        console.log('🧹 Cleaning up IAM role...');
        
        const { DeleteRolePolicyCommand, DeleteRoleCommand } = await import("@aws-sdk/client-iam");
        
        // Delete the inline policy first
        await iamClient.send(new DeleteRolePolicyCommand({
            RoleName: ROLE_NAME,
            PolicyName: POLICY_NAME
        }));
        console.log(`✅ Deleted policy: ${POLICY_NAME}`);
        
        // Delete the role
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
 * Initialize the Nova Sonic client with programmatically created role
 */
async function initializeNovaSonicClient() {
    try {
        console.log('🔧 Starting Nova Sonic client initialization...');
        
        // Create or get the role ARN
        const roleArn = await createNovaSonicRole();
        
        console.log(`🔐 Using role ARN: ${roleArn}`);

        // Create the AWS Bedrock client using the created role
        const client = new S2SBidirectionalStreamClient({
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
        console.log('🔧 Client configuration:', {
            region: AWS_REGION,
            roleArn: roleArn,
            maxConcurrentStreams: 10
        });
        
        return client;
    } catch (error) {
        console.error('❌ Failed to initialize Nova Sonic client:', error);
        console.error('❌ Error details:', {
            message: error.message,
            stack: error.stack,
            region: AWS_REGION
        });
        throw error;
    }
}

/**
 * Simulate KVS signaling channel connection
 * In production, this would connect to actual KVS signaling channel
 */
async function connectToKVSSignalingChannel() {
    try {
        if (!STREAM_ARN) {
            console.error('❌ STREAM_ARN is missing. Available environment variables:', {
                STREAM_ARN: process.env.STREAM_ARN,
                CONTACT_ID: process.env.CONTACT_ID,
                CUSTOMER_PHONE_NUMBER: process.env.CUSTOMER_PHONE_NUMBER,
                DEPLOYMENT_REGION: process.env.DEPLOYMENT_REGION,
                CALL_START_TIME: process.env.CALL_START_TIME
            });
            throw new Error('STREAM_ARN environment variable is required');
        }

        logCallActivity('KVS_CONNECTION_STARTED', { streamARN: STREAM_ARN });

        // Simulate getting KVS signaling endpoint
        // In production, you would use:
        // const { KinesisVideoSignalingClient, GetSignalingChannelEndpointCommand } = await import("@aws-sdk/client-kinesis-video-signaling");
        // const kvsClient = new KinesisVideoSignalingClient({ region: AWS_REGION });
        // const endpointCommand = new GetSignalingChannelEndpointCommand({
        //     ChannelARN: STREAM_ARN,
        //     SingleMasterChannelEndpointConfiguration: {
        //         Protocols: ['WSS', 'HTTPS'],
        //         Role: 'VIEWER'
        //     }
        // });
        // const endpointResponse = await kvsClient.send(endpointCommand);

        // Simulate connection delay
        await new Promise(resolve => setTimeout(resolve, 1000));

        callSession.kvsState = 'connected';
        logCallActivity('KVS_SIGNALING_CONNECTED', { 
            endpoint: `wss://kvs-signaling.${AWS_REGION}.amazonaws.com/${STREAM_ARN}` 
        });

        // Simulate WebRTC connection
        await initializeWebRTCConnection();

    } catch (error) {
        console.error('❌ Error connecting to KVS signaling channel:', error);
        logCallActivity('KVS_CONNECTION_FAILED', { error: error.message });
        throw error;
    }
}

/**
 * Simulate WebRTC peer connection initialization
 * In production, this would create actual WebRTC peer connection
 */
async function initializeWebRTCConnection() {
    try {
        logCallActivity('WEBRTC_INITIALIZATION_STARTED');

        // Simulate WebRTC connection setup
        // In production, you would use:
        // const { RTCPeerConnection } = await import('wrtc');
        // peerConnection = new RTCPeerConnection({
        //     iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        // });

        // Simulate connection delay
        await new Promise(resolve => setTimeout(resolve, 2000));

        callSession.webRTCState = 'connected';
        logCallActivity('WEBRTC_CONNECTION_ESTABLISHED', {
            iceServers: ['stun:stun.l.google.com:19302'],
            connectionState: 'connected'
        });

        // Simulate audio processing
        startAudioProcessing();

    } catch (error) {
        console.error('❌ Error initializing WebRTC connection:', error);
        logCallActivity('WEBRTC_INITIALIZATION_FAILED', { error: error.message });
    }
}

/**
 * Simulate audio processing from WebRTC to Nova Sonic
 */
function startAudioProcessing() {
    logCallActivity('AUDIO_PROCESSING_STARTED');

    // Simulate receiving audio chunks from WebRTC
    setInterval(async () => {
        try {
            // Simulate audio chunk from Amazon Connect
            const audioChunk = Buffer.alloc(1024); // Placeholder audio data
            
            // Process audio chunk
            await processAudioChunk(audioChunk);
            
        } catch (error) {
            console.error('❌ Error in audio processing:', error);
            logCallActivity('AUDIO_PROCESSING_ERROR', { error: error.message });
        }
    }, 1000); // Process every second for demo
}

/**
 * Process audio chunk and send to Nova Sonic
 */
async function processAudioChunk(audioChunk: Buffer) {
    try {
        if (!novaSonicSession) {
            return;
        }

        // Convert audio format if needed (μ-law to PCM)
        const pcmSamples = mulaw.decode(audioChunk);
        const audioBuffer = Buffer.from(pcmSamples.buffer);

        // Send to Nova Sonic
        await novaSonicSession.streamAudio(audioBuffer);
        
        logCallActivity('AUDIO_SENT_TO_NOVA_SONIC', { 
            chunkSize: audioChunk.length,
            pcmSize: audioBuffer.length 
        });

    } catch (error) {
        console.error('❌ Error processing audio chunk:', error);
        logCallActivity('AUDIO_PROCESSING_ERROR', { error: error.message });
    }
}

/**
 * Send audio response back to Amazon Connect
 */
function sendAudioResponse(audioBuffer: Buffer) {
    try {
        // Convert PCM to μ-law for Amazon Connect
        const pcmSamples = new Int16Array(audioBuffer.buffer, audioBuffer.byteOffset, audioBuffer.length / 2);
        const mulawSamples = mulaw.encode(pcmSamples);
        const audioChunk = Buffer.from(mulawSamples);

        // In production, this would send audio through WebRTC back to Amazon Connect
        
        logCallActivity('AUDIO_SENT_TO_AMAZON_CONNECT', { 
            pcmSize: audioBuffer.length,
            mulawSize: audioChunk.length 
        });

    } catch (error) {
        console.error('❌ Error sending audio response:', error);
        logCallActivity('AUDIO_RESPONSE_ERROR', { error: error.message });
    }
}

/**
 * Initialize Nova Sonic session
 */
async function initializeNovaSonicSession() {
    try {
        logCallActivity('NOVA_SONIC_SESSION_INITIALIZATION_STARTED');

        // Create Nova Sonic session
        novaSonicSession = bedrockClient.createStreamSession(callSession.sessionId);
        
        console.log('🔧 Created Nova Sonic session:', callSession.sessionId);
        
        // Set up event handlers BEFORE initiating the session
        setupNovaSonicEventHandlers();
        
        console.log('🔧 Set up event handlers, now initiating session...');
        
        // Initiate the session (this starts the bidirectional stream)
        // The sessionStart event will be automatically sent by the client
        await bedrockClient.initiateSession(callSession.sessionId);
        
        console.log('🔧 Session initiated, setting up prompt and audio...');

        // Set up prompt start (this sends promptStart event)
        await novaSonicSession.setupPromptStart();
        console.log('🔧 Prompt start configured');
        
        // Set up system prompt (this sends contentStart, textInput, contentEnd for text)
        await novaSonicSession.setupSystemPrompt(undefined, SYSTEM_PROMPT);
        console.log('🔧 System prompt configured');
        
        // Set up audio start (this sends contentStart for audio)
        await novaSonicSession.setupStartAudio();
        console.log('🔧 Audio start configured');

        logCallActivity('NOVA_SONIC_SESSION_INITIALIZED');

    } catch (error) {
        console.error('❌ Error initializing Nova Sonic session:', error);
        logCallActivity('NOVA_SONIC_SESSION_INITIALIZATION_FAILED', { error: error.message });
        throw error;
    }
}

/**
 * Set up Nova Sonic event handlers
 */
function setupNovaSonicEventHandlers() {
    if (!novaSonicSession) return;

    // Add a general event handler to catch all events
    novaSonicSession.onEvent('any', (eventData) => {
        console.log('🔍 Nova Sonic Event Received:', {
            type: eventData.type,
            data: eventData.data,
            timestamp: new Date().toISOString()
        });
        logCallActivity('NOVA_SONIC_EVENT_RECEIVED', { 
            eventType: eventData.type,
            eventData: eventData.data 
        });
    });

    novaSonicSession.onEvent('contentStart', (data) => {
        console.log('🎬 Nova Sonic Content Start:', data);
        logCallActivity('NOVA_SONIC_CONTENT_START', { novaSonicData: data });
    });

    novaSonicSession.onEvent('textOutput', (data) => {
        console.log('📝 Nova Sonic Text Output:', data);
        const textContent = data.content;
        logNovaSonicResponse('TEXT_OUTPUT', textContent);
    });

    novaSonicSession.onEvent('audioOutput', (data) => {
        console.log('🔊 Nova Sonic Audio Output:', {
            contentLength: data.content ? data.content.length : 0,
            hasContent: !!data.content
        });
        try {
            // Decode base64 to get the PCM buffer from Nova Sonic
            const buffer = Buffer.from(data['content'], 'base64');
            sendAudioResponse(buffer);
            
            logCallActivity('NOVA_SONIC_AUDIO_PROCESSED', { 
                audioLength: buffer.length 
            });
        } catch (audioError) {
            console.error('❌ Error processing Nova Sonic audio:', audioError);
            logCallActivity('NOVA_SONIC_AUDIO_ERROR', { 
                error: audioError.message 
            });
        }
    });

    novaSonicSession.onEvent('error', (data) => {
        console.error('❌ Nova Sonic Error:', data);
        logCallActivity('NOVA_SONIC_ERROR', { 
            errorData: data,
            errorType: data.type || 'unknown'
        });
    });

    novaSonicSession.onEvent('contentEnd', (data) => {
        console.log('🏁 Nova Sonic Content End:', data);
        logCallActivity('NOVA_SONIC_CONTENT_END', { novaSonicData: data });
    });

    novaSonicSession.onEvent('streamComplete', () => {
        console.log('✅ Nova Sonic Stream Complete');
        logCallActivity('NOVA_SONIC_STREAM_COMPLETE');
    });

    // Add handlers for other potential events
    novaSonicSession.onEvent('sessionStart', (data) => {
        console.log('🚀 Nova Sonic Session Start:', data);
        logCallActivity('NOVA_SONIC_SESSION_START', { sessionData: data });
    });

    novaSonicSession.onEvent('toolUse', (data) => {
        console.log('🔧 Nova Sonic Tool Use:', data);
        logCallActivity('NOVA_SONIC_TOOL_USE', { toolData: data });
    });

    novaSonicSession.onEvent('toolEnd', (data) => {
        console.log('🔧 Nova Sonic Tool End:', data);
        logCallActivity('NOVA_SONIC_TOOL_END', { toolData: data });
    });

    novaSonicSession.onEvent('toolResult', (data) => {
        console.log('🔧 Nova Sonic Tool Result:', data);
        logCallActivity('NOVA_SONIC_TOOL_RESULT', { toolData: data });
    });
}

/**
 * Cleanup resources
 */
async function cleanup() {
    try {
        logCallActivity('CLEANUP_STARTED');

        // Close Nova Sonic session properly
        if (novaSonicSession) {
            console.log('🔧 Closing Nova Sonic session properly...');
            
            // End audio content first
            await novaSonicSession.endAudioContent();
            console.log('🔧 Audio content ended');
            
            // End prompt
            await novaSonicSession.endPrompt();
            console.log('🔧 Prompt ended');
            
            // Close session (this sends sessionEnd event)
            await novaSonicSession.close();
            console.log('🔧 Session closed');
        }

        // Log final call summary
        const duration = Date.now() - callSession.startTime.getTime();
        console.log(`📊 [CALL SUMMARY] Session ${callSession.sessionId}:`, {
            customerPhoneNumber: callSession.customerPhoneNumber,
            streamARN: callSession.streamARN,
            contactId: callSession.contactId,
            startTime: callSession.startTime.toISOString(),
            endTime: new Date().toISOString(),
            duration,
            totalNovaSonicResponses: callSession.novaSonicResponses.length,
            totalTranscriptEntries: callSession.transcriptLog.length,
            webRTCState: callSession.webRTCState,
            kvsState: callSession.kvsState
        });

        logCallActivity('CLEANUP_COMPLETED', { duration });

    } catch (error) {
        console.error('❌ Error during cleanup:', error);
        logCallActivity('CLEANUP_ERROR', { error: error.message });
    }
}

// System prompt for Nova Sonic
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

// Initialize Fastify for health checks
const fastify = Fastify();
fastify.register(fastifyFormBody);

// Health check endpoint
fastify.get('/health', async (request, reply) => {
    reply.send({ 
        status: 'healthy',
        sessionId: callSession.sessionId,
        customerPhoneNumber: callSession.customerPhoneNumber,
        streamARN: callSession.streamARN,
        contactId: callSession.contactId,
        webRTCState: callSession.webRTCState,
        kvsState: callSession.kvsState,
        startTime: callSession.startTime.toISOString(),
        timestamp: new Date().toISOString()
    });
});

// Call logs endpoint
fastify.get('/call-logs', async (request, reply) => {
    reply.send({
        sessionId: callSession.sessionId,
        customerPhoneNumber: callSession.customerPhoneNumber,
        streamARN: callSession.streamARN,
        contactId: callSession.contactId,
        startTime: callSession.startTime,
        lastActivity: callSession.lastActivity,
        webRTCState: callSession.webRTCState,
        kvsState: callSession.kvsState,
        transcriptLog: callSession.transcriptLog,
        novaSonicResponses: callSession.novaSonicResponses
    });
});

/**
 * Start the server with proper initialization
 */
async function startServer() {
    try {
        console.log('🚀 Initializing Nova Sonic WebRTC Bridge...');
        console.log(`📞 Call Details: Contact ${CONTACT_ID}, Phone ${CUSTOMER_PHONE_NUMBER}, Stream ${STREAM_ARN}`);

        // Initialize Nova Sonic client
        bedrockClient = await initializeNovaSonicClient();
        
        // Initialize Nova Sonic session
        await initializeNovaSonicSession();
        
        // Connect to KVS signaling channel
        await connectToKVSSignalingChannel();
        
        // Start the Fastify server for health checks
        await fastify.listen({ port: 3000, host: '0.0.0.0' });
        console.log('✅ Health check server is listening on port 3000');
        console.log('🔗 Health check: http://localhost:3000/health');
        console.log('📊 Call logs: http://localhost:3000/call-logs');

        logCallActivity('SERVER_STARTED', { 
            port: 3000,
            streamARN: STREAM_ARN,
            contactId: CONTACT_ID 
        });

    } catch (error) {
        console.error('❌ Failed to start server:', error);
        logCallActivity('SERVER_START_FAILED', { error: error.message });
        process.exit(1);
    }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down Nova Sonic WebRTC Bridge...');
    await cleanup();
    await fastify.close();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Received SIGTERM, shutting down...');
    await cleanup();
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
    console.log('🚀 Starting WebRTC Bridge Server with KVS integration...');
    startServer();
}