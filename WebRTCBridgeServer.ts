/**
 * Amazon Connect to Nova Sonic Bridge Server (Simplified Version)
 * 
 * This module establishes a connection to Amazon Nova Sonic for AI-powered speech processing.
 * This is a simplified version to test Nova Sonic integration before adding WebRTC and KVS.
 * 
 * Features:
 * - Nova Sonic session management
 * - Real-time audio streaming (simplified)
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
 */

import Fastify from 'fastify';
import fastifyFormBody from '@fastify/formbody';
import { randomUUID } from "node:crypto";
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import { IAMClient, CreateRoleCommand, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { STSClient } from "@aws-sdk/client-sts";
import { S2SBidirectionalStreamClient, StreamSession } from './src/nova-client';

// AWS Configuration
const AWS_REGION = process.env.DEPLOYMENT_REGION || "us-east-1";
const ROLE_NAME = "NovaSonicWebRTCBridgeRole";
const POLICY_NAME = "NovaSonicWebRTCBridgePolicy";

// Configuration (passed from Lambda/ECS)
const CONTACT_ID = process.env.CONTACT_ID || 'test-contact-' + Date.now();
const CUSTOMER_PHONE_NUMBER = process.env.CUSTOMER_PHONE_NUMBER || '+1234567890';

// Debug: Log environment variables
console.log('🔍 Environment Variables Debug:', {
    CONTACT_ID: CONTACT_ID,
    CUSTOMER_PHONE_NUMBER: CUSTOMER_PHONE_NUMBER,
    DEPLOYMENT_REGION: process.env.DEPLOYMENT_REGION
});

// Initialize AWS clients
const iamClient = new IAMClient({ region: AWS_REGION });
const stsClient = new STSClient({ region: AWS_REGION });

// Session management
let bedrockClient: S2SBidirectionalStreamClient;
let novaSonicSession: StreamSession;

// Session timeout management
let sessionTimeoutId: NodeJS.Timeout | null = null;
let lastNovaSonicResponseTime: Date = new Date();
const SESSION_TIMEOUT_MS = 60000; // 60 seconds

// Call tracking and logging
interface CallSession {
    sessionId: string;
    customerPhoneNumber: string;
    contactId: string;
    startTime: Date;
    lastActivity: Date;
    transcriptLog: string[];
    novaSonicResponses: string[];
}

const callSession: CallSession = {
    sessionId: randomUUID(),
    customerPhoneNumber: CUSTOMER_PHONE_NUMBER,
    contactId: CONTACT_ID,
    startTime: new Date(),
    lastActivity: new Date(),
    transcriptLog: [],
    novaSonicResponses: []
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
        contactId: callSession.contactId,
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
 * Create IAM role with necessary permissions for Nova Sonic and Bedrock
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
            Description: "Role for Nova Sonic WebRTC Bridge to access Bedrock services",
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

        // Create inline policy for Bedrock permissions
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
 * Initialize Nova Sonic session with correct bidirectional streaming sequence
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
        
        // Initiate the session (this sends sessionStart event automatically)
        await bedrockClient.initiateSession(callSession.sessionId);
        
        console.log('🔧 Session initiated, setting up prompt and content...');

        // CORRECT SEQUENCE according to Nova Sonic documentation:
        // 1. setupPromptStart() - sends promptStart event
        // 2. setupSystemPrompt() - sends contentStart, textInput, contentEnd for text
        // 3. setupStartAudio() - sends contentStart for audio
        
        // Step 1: Set up prompt start (this sends promptStart event)
        console.log('🔧 Step 1: Sending promptStart event...');
        await novaSonicSession.setupPromptStart();
        console.log('🔧 Prompt start configured');
        
        // Small delay to ensure promptStart is processed
        console.log('⏳ Waiting 1 second for promptStart to be processed...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Step 2: Set up system prompt (this sends contentStart, textInput, contentEnd for text)
        console.log('🔧 Step 2: Sending system prompt events (contentStart, textInput, contentEnd)...');
        await novaSonicSession.setupSystemPrompt(undefined, SYSTEM_PROMPT);
        console.log('🔧 System prompt configured');
        
        // Small delay to ensure system prompt is processed
        console.log('⏳ Waiting 1 second for system prompt to be processed...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Step 3: Set up audio content start (this sends contentStart for audio)
        console.log('🔧 Step 3: Sending audio contentStart event...');
        await novaSonicSession.setupStartAudio();
        console.log('🔧 Audio content start configured');

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

    // Track response statistics
    let responseStats = {
        textResponses: 0,
        audioResponses: 0,
        errors: 0,
        totalEvents: 0
    };

    // Add a general event handler to catch all events
    novaSonicSession.onEvent('any', (eventData) => {
        responseStats.totalEvents++;
        console.log('🔍 Nova Sonic Event Received:', {
            type: eventData.type,
            data: eventData.data,
            timestamp: new Date().toISOString(),
            eventNumber: responseStats.totalEvents
        });
        logCallActivity('NOVA_SONIC_EVENT_RECEIVED', { 
            eventType: eventData.type,
            eventData: eventData.data,
            eventNumber: responseStats.totalEvents
        });
    });

    novaSonicSession.onEvent('contentStart', (data) => {
        console.log('🎬 Nova Sonic Content Start:', {
            data,
            timestamp: new Date().toISOString()
        });
        logCallActivity('NOVA_SONIC_CONTENT_START', { novaSonicData: data });
    });

    novaSonicSession.onEvent('textOutput', (data) => {
        responseStats.textResponses++;
        console.log('📝 Nova Sonic Text Output:', {
            content: data.content,
            contentType: typeof data.content,
            contentLength: data.content ? data.content.length : 0,
            responseNumber: responseStats.textResponses,
            timestamp: new Date().toISOString()
        });
        
        // Log the actual text content for debugging
        if (data.content) {
            console.log('📝 Text Content from Nova Sonic:', `"${data.content}"`);
        }
        
        logNovaSonicResponse('TEXT_OUTPUT', data.content);
        logCallActivity('NOVA_SONIC_TEXT_RESPONSE', {
            textContent: data.content,
            responseNumber: responseStats.textResponses
        });
        
        // Reset session timeout on Nova Sonic response
        resetSessionTimeout();
    });

    novaSonicSession.onEvent('audioOutput', (data) => {
        responseStats.audioResponses++;
        console.log('🔊 Nova Sonic Audio Output:', {
            contentLength: data.content ? data.content.length : 0,
            hasContent: !!data.content,
            dataKeys: Object.keys(data),
            responseNumber: responseStats.audioResponses,
            timestamp: new Date().toISOString()
        });
        
        // Log audio content details
        if (data.content) {
            console.log('🔊 Audio Content Details:', {
                base64Length: data.content.length,
                contentType: typeof data.content,
                firstChars: data.content.substring(0, 50) + '...',
                lastChars: '...' + data.content.substring(data.content.length - 50)
            });
        }
        
        logCallActivity('NOVA_SONIC_AUDIO_RECEIVED', { 
            audioLength: data.content ? data.content.length : 0,
            responseNumber: responseStats.audioResponses
        });
        
        // Reset session timeout on Nova Sonic audio response
        resetSessionTimeout();
    });

    novaSonicSession.onEvent('error', (data) => {
        responseStats.errors++;
        console.error('❌ Nova Sonic Error:', {
            errorData: data,
            errorType: data.type || 'unknown',
            timestamp: new Date().toISOString(),
            errorNumber: responseStats.errors
        });
        logCallActivity('NOVA_SONIC_ERROR', { 
            errorData: data,
            errorType: data.type || 'unknown',
            errorNumber: responseStats.errors
        });
    });

    novaSonicSession.onEvent('contentEnd', (data) => {
        console.log('🏁 Nova Sonic Content End:', {
            data,
            timestamp: new Date().toISOString()
        });
        logCallActivity('NOVA_SONIC_CONTENT_END', { novaSonicData: data });
    });

    novaSonicSession.onEvent('streamComplete', () => {
        console.log('✅ Nova Sonic Stream Complete');
        console.log('📊 Final Response Statistics:', {
            totalEvents: responseStats.totalEvents,
            textResponses: responseStats.textResponses,
            audioResponses: responseStats.audioResponses,
            errors: responseStats.errors,
            timestamp: new Date().toISOString()
        });
        logCallActivity('NOVA_SONIC_STREAM_COMPLETE', {
            statistics: responseStats
        });
    });

    // Add handlers for other potential events
    novaSonicSession.onEvent('sessionStart', (data) => {
        console.log('🚀 Nova Sonic Session Start:', {
            sessionData: data,
            timestamp: new Date().toISOString()
        });
        logCallActivity('NOVA_SONIC_SESSION_START', { sessionData: data });
    });
}

/**
 * Simulate audio input to test Nova Sonic response
 */
async function simulateAudioInput() {
    try {
        console.log('🎵 Simulating audio input to test Nova Sonic...');
        
        // Create a simple PCM audio buffer (8kHz, 16-bit, mono)
        const sampleRate = 8000;
        const duration = 1; // 1 second
        const samples = sampleRate * duration;
        const audioData = new Int16Array(samples);
        
        // Generate a simple sine wave
        for (let i = 0; i < samples; i++) {
            audioData[i] = Math.sin(2 * Math.PI * 440 * i / sampleRate) * 16384; // 440 Hz tone
        }
        
        // Convert to base64 for Nova Sonic
        const audioBuffer = Buffer.from(audioData.buffer);
        const base64Audio = audioBuffer.toString('base64');
        
        console.log('🎵 Sending simulated audio to Nova Sonic...');
        logCallActivity('SIMULATED_AUDIO_SENT', { 
            audioLength: audioBuffer.length,
            base64Length: base64Audio.length,
            sampleRate: sampleRate,
            duration: duration
        });
        
        // Send to Nova Sonic
        await novaSonicSession.streamAudio(Buffer.from(base64Audio, 'utf8'));
        
    } catch (error) {
        console.error('❌ Error simulating audio input:', error);
        logCallActivity('SIMULATED_AUDIO_ERROR', { error: error.message });
    }
}

/**
 * Log comprehensive call statistics
 */
function logCallStatistics() {
    const endTime = new Date();
    const duration = endTime.getTime() - callSession.startTime.getTime();
    
    console.log('📊 CALL STATISTICS SUMMARY:', {
        contactId: CONTACT_ID,
        customerPhone: CUSTOMER_PHONE_NUMBER,
        startTime: callSession.startTime.toISOString(),
        endTime: endTime.toISOString(),
        duration: `${duration}ms (${Math.round(duration/1000)}s)`,
        totalNovaSonicResponses: callSession.novaSonicResponses.length,
        totalTranscriptEntries: callSession.transcriptLog.length,
        novaSonicSessionActive: !!novaSonicSession,
        timestamp: new Date().toISOString()
    });
    
    logCallActivity('CALL_STATISTICS', {
        duration,
        totalNovaSonicResponses: callSession.novaSonicResponses.length,
        totalTranscriptEntries: callSession.transcriptLog.length,
        novaSonicSessionActive: !!novaSonicSession
    });
}

/**
 * Cleanup function to properly close connections and log statistics
 */
async function cleanup() {
    try {
        console.log('🧹 Starting cleanup...');
        
        // Clear session timeout
        clearSessionTimeout();
        
        // Log final statistics
        logCallStatistics();
        
        // Close Nova Sonic session properly
        if (novaSonicSession) {
            console.log('🔧 Closing Nova Sonic session properly...');
            
            try {
                // End audio content first
                await novaSonicSession.endAudioContent();
                console.log('🔧 Audio content ended');
                
                // End prompt
                await novaSonicSession.endPrompt();
                console.log('🔧 Prompt ended');
                
                // Close session (this sends sessionEnd event)
                await novaSonicSession.close();
                console.log('🔧 Session closed');
            } catch (error) {
                console.error('❌ Error closing Nova Sonic session:', error);
            }
        }

        // Log final call summary
        const duration = Date.now() - callSession.startTime.getTime();
        console.log(`📊 [CALL SUMMARY] Session ${callSession.sessionId}:`, {
            customerPhoneNumber: callSession.customerPhoneNumber,
            contactId: callSession.contactId,
            startTime: callSession.startTime.toISOString(),
            endTime: new Date().toISOString(),
            duration,
            totalNovaSonicResponses: callSession.novaSonicResponses.length,
            totalTranscriptEntries: callSession.transcriptLog.length
        });

        logCallActivity('CLEANUP_COMPLETED', { duration });

    } catch (error) {
        console.error('❌ Error during cleanup:', error);
        logCallActivity('CLEANUP_ERROR', { error: error.message });
    }
}

/**
 * Start session timeout monitoring
 */
function startSessionTimeoutMonitoring() {
    console.log('⏰ Starting session timeout monitoring (60 seconds)...');
    
    // Clear any existing timeout
    if (sessionTimeoutId) {
        clearTimeout(sessionTimeoutId);
    }
    
    // Set new timeout
    sessionTimeoutId = setTimeout(async () => {
        console.log('⏰ Session timeout reached - no Nova Sonic response for 60 seconds');
        logCallActivity('SESSION_TIMEOUT', { 
            timeoutMs: SESSION_TIMEOUT_MS,
            lastResponseTime: lastNovaSonicResponseTime.toISOString()
        });
        
        // Clean up the session
        await cleanup();
        
        // Exit the process to free up resources
        console.log('🛑 Exiting due to session timeout');
        process.exit(0);
    }, SESSION_TIMEOUT_MS);
    
    logCallActivity('SESSION_TIMEOUT_MONITORING_STARTED', { timeoutMs: SESSION_TIMEOUT_MS });
}

/**
 * Reset session timeout when Nova Sonic responds
 */
function resetSessionTimeout() {
    lastNovaSonicResponseTime = new Date();
    
    // Clear existing timeout
    if (sessionTimeoutId) {
        clearTimeout(sessionTimeoutId);
    }
    
    // Set new timeout
    sessionTimeoutId = setTimeout(async () => {
        console.log('⏰ Session timeout reached - no Nova Sonic response for 60 seconds');
        logCallActivity('SESSION_TIMEOUT', { 
            timeoutMs: SESSION_TIMEOUT_MS,
            lastResponseTime: lastNovaSonicResponseTime.toISOString()
        });
        
        // Clean up the session
        await cleanup();
        
        // Exit the process to free up resources
        console.log('🛑 Exiting due to session timeout');
        process.exit(0);
    }, SESSION_TIMEOUT_MS);
    
    console.log('⏰ Session timeout reset - last Nova Sonic response:', lastNovaSonicResponseTime.toISOString());
}

/**
 * Clear session timeout
 */
function clearSessionTimeout() {
    if (sessionTimeoutId) {
        clearTimeout(sessionTimeoutId);
        sessionTimeoutId = null;
        console.log('⏰ Session timeout cleared');
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
    const now = new Date();
    const timeSinceLastResponse = now.getTime() - lastNovaSonicResponseTime.getTime();
    const timeUntilTimeout = SESSION_TIMEOUT_MS - timeSinceLastResponse;
    
    reply.send({ 
        status: 'healthy',
        sessionId: callSession.sessionId,
        customerPhoneNumber: callSession.customerPhoneNumber,
        contactId: callSession.contactId,
        startTime: callSession.startTime.toISOString(),
        lastNovaSonicResponse: lastNovaSonicResponseTime.toISOString(),
        timeSinceLastResponse: `${Math.round(timeSinceLastResponse / 1000)}s`,
        timeUntilTimeout: `${Math.round(timeUntilTimeout / 1000)}s`,
        sessionTimeoutActive: sessionTimeoutId !== null,
        timestamp: now.toISOString()
    });
});

// Call logs endpoint
fastify.get('/call-logs', async (request, reply) => {
    reply.send({
        sessionId: callSession.sessionId,
        customerPhoneNumber: callSession.customerPhoneNumber,
        contactId: callSession.contactId,
        startTime: callSession.startTime,
        lastActivity: callSession.lastActivity,
        transcriptLog: callSession.transcriptLog,
        novaSonicResponses: callSession.novaSonicResponses
    });
});

// Test endpoint to simulate audio input
fastify.post('/test-audio', async (request, reply) => {
    try {
        await simulateAudioInput();
        reply.send({ status: 'success', message: 'Simulated audio sent to Nova Sonic' });
    } catch (error) {
        reply.status(500).send({ status: 'error', message: error.message });
    }
});

/**
 * Start the server with proper initialization
 */
async function startServer() {
    try {
        console.log('🚀 Initializing Nova Sonic Bridge (Simplified)...');
        console.log(`📞 Call Details: Contact ${CONTACT_ID}, Phone ${CUSTOMER_PHONE_NUMBER}`);

        // Initialize Nova Sonic client
        bedrockClient = await initializeNovaSonicClient();
        
        // Initialize Nova Sonic session
        await initializeNovaSonicSession();
        
        // Start session timeout monitoring
        startSessionTimeoutMonitoring();
        
        // Start the Fastify server for health checks
        await fastify.listen({ port: 3000, host: '0.0.0.0' });
        console.log('✅ Health check server is listening on port 3000');
        console.log('🔗 Health check: http://localhost:3000/health');
        console.log('📊 Call logs: http://localhost:3000/call-logs');
        console.log('🧪 Test audio: POST http://localhost:3000/test-audio');

        logCallActivity('SERVER_STARTED', { 
            port: 3000,
            contactId: CONTACT_ID 
        });

        // Simulate audio input after 5 seconds to test Nova Sonic response
        setTimeout(async () => {
            console.log('🧪 Testing Nova Sonic with simulated audio input...');
            await simulateAudioInput();
        }, 5000);

    } catch (error) {
        console.error('❌ Failed to start server:', error);
        logCallActivity('SERVER_START_FAILED', { error: error.message });
        process.exit(1);
    }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down Nova Sonic Bridge...');
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
    console.log('🚀 Starting Nova Sonic Bridge Server (Simplified)...');
    startServer();
}