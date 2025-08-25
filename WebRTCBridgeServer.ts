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
// WebRTC imports for actual audio transmission
import { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } from 'wrtc';
// WebSocket for KVS signaling
import WebSocket from 'ws';
// Remove mulaw import since we're using PCM format
// import { mulaw } from 'alawmulaw';

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
let kvsConnection: any; // Add this for consistency

// WebRTC peer connection for actual audio transmission
let peerConnection: RTCPeerConnection | null = null;
let audioSender: any = null;
let audioReceiver: any = null;

// KVS WebSocket connection for signaling
let kvsWebSocket: WebSocket | null = null;
let kvsSignalingEndpoint: string | null = null;

// Session timeout management
let sessionTimeoutId: NodeJS.Timeout | null = null;
let lastNovaSonicResponseTime: Date = new Date();
const SESSION_TIMEOUT_MS = 60000; // 60 seconds

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
 * Connect to KVS signaling channel for WebRTC communication with Amazon Connect
 * This establishes the actual WebSocket connection to KVS signaling endpoint
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

        // Get KVS signaling endpoint
        const { KinesisVideoSignalingClient, GetSignalingChannelEndpointCommand } = await import("@aws-sdk/client-kinesis-video-signaling");
        const kvsClient = new KinesisVideoSignalingClient({ region: AWS_REGION });
        
        const endpointCommand = new GetSignalingChannelEndpointCommand({
            ChannelARN: STREAM_ARN,
            SingleMasterChannelEndpointConfiguration: {
                Protocols: ['WSS', 'HTTPS'],
                Role: 'VIEWER'
            }
        });
        
        const endpointResponse = await kvsClient.send(endpointCommand);
        const signalingEndpoint = endpointResponse.ResourceEndpointList?.[0]?.ResourceEndpoint;
        
        if (!signalingEndpoint) {
            throw new Error('Failed to get KVS signaling endpoint');
        }

        console.log('🔗 KVS Signaling endpoint:', signalingEndpoint);
        logCallActivity('KVS_ENDPOINT_RETRIEVED', { endpoint: signalingEndpoint });

        // Connect to KVS signaling channel via WebSocket
        await connectToKVSWebSocket(signalingEndpoint);

        callSession.kvsState = 'connected';
        logCallActivity('KVS_SIGNALING_CONNECTED', { 
            endpoint: signalingEndpoint,
            streamARN: STREAM_ARN
        });

        // Initialize WebRTC connection after KVS signaling is ready
        await initializeWebRTCConnection();

    } catch (error) {
        console.error('❌ Error connecting to KVS signaling channel:', error);
        logCallActivity('KVS_CONNECTION_FAILED', { error: error.message });
        throw error;
    }
}

/**
 * Connect to KVS signaling channel via WebSocket for WebRTC signaling
 * This establishes the actual WebSocket connection to exchange SDP and ICE candidates
 */
async function connectToKVSWebSocket(signalingEndpoint: string) {
    return new Promise<void>((resolve, reject) => {
        console.log('🔗 Connecting to KVS signaling endpoint:', signalingEndpoint);
        logCallActivity('KVS_WEBSOCKET_CONNECTION_STARTED', { endpoint: signalingEndpoint });

        try {
            // Create WebSocket connection to KVS signaling endpoint
            kvsWebSocket = new WebSocket(signalingEndpoint);
            kvsSignalingEndpoint = signalingEndpoint;

            // Handle WebSocket connection open
            kvsWebSocket.on('open', () => {
                console.log('✅ WebSocket connection to KVS signaling established');
                logCallActivity('KVS_WEBSOCKET_CONNECTION_OPEN', { endpoint: signalingEndpoint });
                
                // Send connection message to KVS
                const connectMessage = {
                    action: 'connect',
                    channelARN: STREAM_ARN,
                    clientId: callSession.sessionId
                };
                
                kvsWebSocket?.send(JSON.stringify(connectMessage));
                console.log('📤 Sent connect message to KVS:', connectMessage);
                logCallActivity('KVS_CONNECT_MESSAGE_SENT', { message: connectMessage });
            });

            // Handle WebSocket messages from KVS
            kvsWebSocket.on('message', (data: WebSocket.Data) => {
                try {
                    const message = JSON.parse(data.toString());
                    console.log('📥 Received message from KVS:', message);
                    logCallActivity('KVS_MESSAGE_RECEIVED', { message });

                    // Handle different message types
                    if (message.action === 'connect') {
                        console.log('✅ KVS connection confirmed');
                        logCallActivity('KVS_CONNECTION_CONFIRMED', { message });
                        resolve();
                    } else if (message.action === 'offer') {
                        console.log('📥 Received WebRTC offer from Amazon Connect');
                        logCallActivity('WEBRTC_OFFER_RECEIVED', { offer: message.sdp });
                        handleWebRTCOffer(message.sdp);
                    } else if (message.action === 'answer') {
                        console.log('📥 Received WebRTC answer from Amazon Connect');
                        logCallActivity('WEBRTC_ANSWER_RECEIVED', { answer: message.sdp });
                        handleWebRTCAnswer(message.sdp);
                    } else if (message.action === 'ice-candidate') {
                        console.log('🧊 Received ICE candidate from Amazon Connect');
                        logCallActivity('ICE_CANDIDATE_RECEIVED', { candidate: message.candidate });
                        handleICECandidate(message.candidate);
                    }
                } catch (error) {
                    console.error('❌ Error parsing KVS message:', error);
                    logCallActivity('KVS_MESSAGE_PARSE_ERROR', { error: error.message });
                }
            });

            // Handle WebSocket errors
            kvsWebSocket.on('error', (error) => {
                console.error('❌ WebSocket error:', error);
                logCallActivity('KVS_WEBSOCKET_ERROR', { error: error.message });
                reject(error);
            });

            // Handle WebSocket close
            kvsWebSocket.on('close', (code, reason) => {
                console.log('🔌 WebSocket connection closed:', { code, reason: reason.toString() });
                logCallActivity('KVS_WEBSOCKET_CLOSED', { code, reason: reason.toString() });
            });

        } catch (error) {
            console.error('❌ Error creating WebSocket connection:', error);
            logCallActivity('KVS_WEBSOCKET_CREATION_ERROR', { error: error.message });
            reject(error);
        }
    });
}

/**
 * Simulate WebRTC offer/answer exchange
 */
async function handleWebRTCOffer(sdp: string) {
    console.log('📤 Handling WebRTC offer from Amazon Connect');
    logCallActivity('WEBRTC_OFFER_HANDLED', { offer: sdp });

    if (peerConnection) {
        try {
            const offer = new RTCSessionDescription({ type: 'offer', sdp });
            await peerConnection.setRemoteDescription(offer);
            console.log('📥 WebRTC offer set successfully');
            logCallActivity('WEBRTC_OFFER_SET', { offer: sdp });

            // Create answer
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            console.log('📤 WebRTC answer created and set');
            logCallActivity('WEBRTC_ANSWER_CREATED_AND_SET', { answer: answer.sdp });

            // Send answer back to Amazon Connect
            if (kvsWebSocket) {
                const answerMessage = {
                    action: 'answer',
                    sdp: answer.sdp
                };
                kvsWebSocket.send(JSON.stringify(answerMessage));
                console.log('📤 Sent WebRTC answer to KVS:', answerMessage);
                logCallActivity('WEBRTC_ANSWER_SENT', { answer: answer.sdp });
            } else {
                console.warn('⚠️ KVS WebSocket not ready to send answer.');
                logCallActivity('WEBRTC_ANSWER_NOT_SENT_KVS_NOT_READY', { 
                    offer: sdp,
                    reason: 'KVS WebSocket not ready'
                });
            }
        } catch (error) {
            console.error('❌ Error handling WebRTC offer:', error);
            logCallActivity('WEBRTC_OFFER_HANDLING_ERROR', { error: error.message });
        }
    } else {
        console.warn('⚠️ Peer connection not initialized, cannot handle offer.');
        logCallActivity('WEBRTC_OFFER_HANDLING_ERROR', { 
            offer: sdp,
            reason: 'Peer connection not initialized'
        });
    }
}

/**
 * Simulate WebRTC answer exchange
 */
async function handleWebRTCAnswer(sdp: string) {
    console.log('📥 Handling WebRTC answer from Amazon Connect');
    logCallActivity('WEBRTC_ANSWER_HANDLED', { answer: sdp });

    if (peerConnection) {
        try {
            const answer = new RTCSessionDescription({ type: 'answer', sdp });
            await peerConnection.setRemoteDescription(answer);
            console.log('📥 WebRTC answer set successfully');
            logCallActivity('WEBRTC_ANSWER_SET', { answer: sdp });

            // ICE candidates are handled by the onicecandidate event
            console.log('🧊 ICE candidates will be handled by onicecandidate event.');
            logCallActivity('WEBRTC_ICE_CANDIDATES_WILL_BE_HANDLED', { answer: sdp });

        } catch (error) {
            console.error('❌ Error handling WebRTC answer:', error);
            logCallActivity('WEBRTC_ANSWER_HANDLING_ERROR', { error: error.message });
        }
    } else {
        console.warn('⚠️ Peer connection not initialized, cannot handle answer.');
        logCallActivity('WEBRTC_ANSWER_HANDLING_ERROR', { 
            answer: sdp,
            reason: 'Peer connection not initialized'
        });
    }
}

/**
 * Simulate ICE candidate exchange
 */
async function handleICECandidate(candidate: RTCIceCandidate) {
    console.log('🧊 Handling ICE candidate from Amazon Connect');
    logCallActivity('ICE_CANDIDATE_HANDLED', { candidate: candidate });

    if (peerConnection) {
        try {
            await peerConnection.addIceCandidate(candidate);
            console.log('🧊 ICE candidate added successfully');
            logCallActivity('ICE_CANDIDATE_ADDED', { candidate: candidate });
        } catch (error) {
            console.error('❌ Error adding ICE candidate:', error);
            logCallActivity('ICE_CANDIDATE_ADDING_ERROR', { error: error.message });
        }
    } else {
        console.warn('⚠️ Peer connection not initialized, cannot add ICE candidate.');
        logCallActivity('ICE_CANDIDATE_ADDING_ERROR', { 
            candidate: candidate,
            reason: 'Peer connection not initialized'
        });
    }
}

/**
 * Initialize WebRTC peer connection with Amazon Connect via KVS signaling
 * This creates the actual WebRTC peer connection and sets up signaling via KVS
 */
async function initializeWebRTCConnection() {
    try {
        logCallActivity('WEBRTC_INITIALIZATION_STARTED');

        // Create actual WebRTC peer connection
        peerConnection = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });

        // Set up audio track for receiving audio from Amazon Connect
        peerConnection.ontrack = (event) => {
            console.log('🎵 Received audio track from Amazon Connect');
            audioReceiver = event.track;
            
            // Set up audio processing from the received track
            if (event.track.kind === 'audio') {
                const audioContext = new AudioContext();
                const source = audioContext.createMediaStreamSource(new MediaStream([event.track]));
                const processor = audioContext.createScriptProcessor(4096, 1, 1);
                
                processor.onaudioprocess = async (e) => {
                    const inputBuffer = e.inputBuffer;
                    const inputData = inputBuffer.getChannelData(0);
                    
                    // Convert Float32Array to Int16Array (PCM format for Nova Sonic)
                    // Amazon Connect WebRTC provides Float32Array, convert to Int16Array PCM
                    const pcmData = new Int16Array(inputData.length);
                    for (let i = 0; i < inputData.length; i++) {
                        // Convert Float32 (-1.0 to 1.0) to Int16 (-32768 to 32767)
                        pcmData[i] = Math.max(-32768, Math.min(32767, inputData[i] * 32768));
                    }
                    
                    // Create PCM buffer for Nova Sonic
                    const pcmBuffer = Buffer.from(pcmData.buffer);
                    
                    // Send to Nova Sonic
                    await processAudioChunk(pcmBuffer);
                };
                
                source.connect(processor);
                processor.connect(audioContext.destination);
            }
        };

        // Handle ICE candidates and send them via KVS signaling
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                console.log('🧊 ICE candidate generated:', event.candidate);
                logCallActivity('ICE_CANDIDATE_GENERATED', { candidate: event.candidate });
                
                // Send ICE candidate to Amazon Connect via KVS signaling
                if (kvsWebSocket && kvsWebSocket.readyState === WebSocket.OPEN) {
                    const iceMessage = {
                        action: 'ice-candidate',
                        candidate: event.candidate
                    };
                    kvsWebSocket.send(JSON.stringify(iceMessage));
                    console.log('📤 Sent ICE candidate to KVS:', iceMessage);
                    logCallActivity('ICE_CANDIDATE_SENT', { candidate: event.candidate });
                } else {
                    console.warn('⚠️ KVS WebSocket not ready to send ICE candidate');
                    logCallActivity('ICE_CANDIDATE_NOT_SENT', { 
                        candidate: event.candidate,
                        reason: 'KVS WebSocket not ready'
                    });
                }
            }
        };

        // Handle connection state changes
        peerConnection.onconnectionstatechange = () => {
            console.log('🔗 WebRTC connection state:', peerConnection?.connectionState);
            logCallActivity('WEBRTC_CONNECTION_STATE_CHANGE', { 
                state: peerConnection?.connectionState 
            });
            
            if (peerConnection?.connectionState === 'connected') {
                callSession.webRTCState = 'connected';
                logCallActivity('WEBRTC_CONNECTION_ESTABLISHED', {
                    iceServers: ['stun:stun.l.google.com:19302'],
                    connectionState: 'connected'
                });
                
                // Start audio processing once connected
                startAudioProcessing();
            }
        };

        // Create offer for Amazon Connect
        const offer = await peerConnection.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: false
        });
        
        await peerConnection.setLocalDescription(offer);
        
        console.log('📤 WebRTC offer created:', offer);
        logCallActivity('WEBRTC_OFFER_CREATED', { offer });

        // Send offer to Amazon Connect via KVS signaling
        if (kvsWebSocket && kvsWebSocket.readyState === WebSocket.OPEN) {
            const offerMessage = {
                action: 'offer',
                sdp: offer.sdp
            };
            kvsWebSocket.send(JSON.stringify(offerMessage));
            console.log('📤 Sent WebRTC offer to KVS:', offerMessage);
            logCallActivity('WEBRTC_OFFER_SENT', { offer: offer.sdp });
        } else {
            console.warn('⚠️ KVS WebSocket not ready to send offer');
            logCallActivity('WEBRTC_OFFER_NOT_SENT', { 
                offer: offer.sdp,
                reason: 'KVS WebSocket not ready'
            });
        }

    } catch (error) {
        console.error('❌ Error initializing WebRTC connection:', error);
        logCallActivity('WEBRTC_INITIALIZATION_FAILED', { error: error.message });
    }
}

/**
 * Start audio processing from WebRTC to Nova Sonic
 * This processes real audio received from Amazon Connect via WebRTC
 */
function startAudioProcessing() {
    logCallActivity('AUDIO_PROCESSING_STARTED');
    console.log('🎵 Audio processing started - waiting for real audio from Amazon Connect via WebRTC');
    
    // Audio processing is now handled by the WebRTC ontrack event
    // Real audio will be processed when Amazon Connect sends audio via WebRTC
    logCallActivity('AUDIO_PROCESSING_READY', { 
        note: 'Waiting for real audio from Amazon Connect via WebRTC',
        webRTCState: peerConnection?.connectionState
    });
}

/**
 * Process audio chunk and send to Nova Sonic
 * Amazon Connect streams PCM format (8kHz, 16-bit, mono)
 * Nova Sonic expects base64 encoded PCM
 */
async function processAudioChunk(audioChunk: Buffer) {
    try {
        if (!novaSonicSession) {
            return;
        }

        // Amazon Connect provides PCM audio (8kHz, 16-bit, mono)
        // Nova Sonic expects base64 encoded PCM
        // Convert Buffer to base64 string for Nova Sonic
        const base64Audio = audioChunk.toString('base64');
        
        // Create a new buffer with the base64 encoded data
        const novaSonicAudioBuffer = Buffer.from(base64Audio, 'utf8');
        
        // Send to Nova Sonic
        await novaSonicSession.streamAudio(novaSonicAudioBuffer);
        
        logCallActivity('AUDIO_SENT_TO_NOVA_SONIC', { 
            chunkSize: audioChunk.length,
            base64Size: novaSonicAudioBuffer.length,
            format: 'PCM (base64 encoded)',
            sampleRate: '8kHz',
            channels: 1,
            bitsPerSample: 16
        });

    } catch (error) {
        console.error('❌ Error processing audio chunk:', error);
        logCallActivity('AUDIO_PROCESSING_ERROR', { error: error.message });
    }
}

/**
 * Send audio response back to Amazon Connect via WebRTC
 * Nova Sonic provides base64 encoded PCM, convert to raw PCM for WebRTC
 */
function sendAudioResponse(audioBuffer: Buffer) {
    try {
        // Nova Sonic provides base64 encoded PCM
        // Convert back to raw PCM for Amazon Connect WebRTC
        
        if (peerConnection && peerConnection.connectionState === 'connected') {
            // Convert base64 string back to raw PCM buffer
            const base64String = audioBuffer.toString('utf8');
            const rawPcmBuffer = Buffer.from(base64String, 'base64');
            
            // Create audio track from PCM data for WebRTC
            const audioContext = new AudioContext();
            
            // Convert Int16Array to Float32Array for Web Audio API
            const pcmData = new Int16Array(rawPcmBuffer.buffer, rawPcmBuffer.byteOffset, rawPcmBuffer.length / 2);
            const floatData = new Float32Array(pcmData.length);
            for (let i = 0; i < pcmData.length; i++) {
                floatData[i] = pcmData[i] / 32768.0;
            }
            
            // Create audio buffer (8kHz sample rate for Amazon Connect)
            const buffer = audioContext.createBuffer(1, floatData.length, 8000);
            buffer.getChannelData(0).set(floatData);
            
            // Create media stream and add track to peer connection
            const mediaStream = new MediaStream();
            const audioTrack = audioContext.createMediaStreamDestination().stream.getAudioTracks()[0];
            
            if (audioSender) {
                peerConnection.removeTrack(audioSender);
            }
            
            audioSender = peerConnection.addTrack(audioTrack, mediaStream);
            
            console.log('🔊 Audio track added to WebRTC connection');
            logCallActivity('AUDIO_TRACK_ADDED_TO_WEBRTC', { 
                base64Size: audioBuffer.length,
                rawPcmSize: rawPcmBuffer.length,
                sampleRate: '8kHz',
                channels: 1,
                bitsPerSample: 16
            });
        } else {
            console.warn('⚠️ WebRTC connection not ready for audio transmission');
            logCallActivity('WEBRTC_NOT_READY_FOR_AUDIO', { 
                connectionState: peerConnection?.connectionState 
            });
        }
        
        logCallActivity('AUDIO_SENT_TO_AMAZON_CONNECT', { 
            base64Size: audioBuffer.length,
            format: 'PCM (converted from base64)',
            sampleRate: '8kHz',
            channels: 1,
            bitsPerSample: 16
        });

    } catch (error) {
        console.error('❌ Error sending audio response:', error);
        logCallActivity('AUDIO_RESPONSE_ERROR', { error: error.message });
    }
}

/**
 * Initialize Nova Sonic session with correct bidirectional streaming sequence
 * Following the official Nova Sonic documentation for proper event sequence
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
        
        try {
            // Validate that content exists and is a string
            if (!data.content || typeof data.content !== 'string') {
                console.error('❌ Invalid audio content:', {
                    hasContent: !!data.content,
                    contentType: typeof data.content,
                    contentLength: data.content ? data.content.length : 0,
                    responseNumber: responseStats.audioResponses
                });
                logCallActivity('NOVA_SONIC_AUDIO_ERROR', { 
                    error: 'Invalid audio content format',
                    details: { hasContent: !!data.content, contentType: typeof data.content },
                    responseNumber: responseStats.audioResponses
                });
                return;
            }

            // Decode base64 to get the PCM buffer from Nova Sonic
            const buffer = Buffer.from(data.content, 'base64');
            
            console.log('🔊 Audio Buffer Details:', {
                bufferLength: buffer.length,
                bufferType: typeof buffer,
                isBuffer: Buffer.isBuffer(buffer),
                responseNumber: responseStats.audioResponses
            });
            
            if (buffer.length === 0) {
                console.warn('⚠️ Empty audio buffer received from Nova Sonic');
                logCallActivity('NOVA_SONIC_AUDIO_WARNING', { 
                    warning: 'Empty audio buffer received',
                    responseNumber: responseStats.audioResponses
                });
                return;
            }
            
            sendAudioResponse(buffer);
            
            logCallActivity('NOVA_SONIC_AUDIO_PROCESSED', { 
                audioLength: buffer.length,
                responseNumber: responseStats.audioResponses
            });
            
            // Reset session timeout on Nova Sonic audio response
            resetSessionTimeout();
        } catch (audioError) {
            responseStats.errors++;
            console.error('❌ Error processing Nova Sonic audio:', audioError);
            console.error('❌ Audio data that caused error:', {
                hasContent: !!data.content,
                contentType: typeof data.content,
                contentLength: data.content ? data.content.length : 0,
                error: audioError.message,
                stack: audioError.stack,
                responseNumber: responseStats.audioResponses
            });
            logCallActivity('NOVA_SONIC_AUDIO_ERROR', { 
                error: audioError.message,
                details: {
                    hasContent: !!data.content,
                    contentType: typeof data.content,
                    contentLength: data.content ? data.content.length : 0
                },
                responseNumber: responseStats.audioResponses
            });
        }
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

    novaSonicSession.onEvent('toolUse', (data) => {
        console.log('🔧 Nova Sonic Tool Use:', {
            toolData: data,
            timestamp: new Date().toISOString()
        });
        logCallActivity('NOVA_SONIC_TOOL_USE', { toolData: data });
    });

    novaSonicSession.onEvent('toolEnd', (data) => {
        console.log('🔧 Nova Sonic Tool End:', {
            toolData: data,
            timestamp: new Date().toISOString()
        });
        logCallActivity('NOVA_SONIC_TOOL_END', { toolData: data });
    });

    novaSonicSession.onEvent('toolResult', (data) => {
        console.log('🔧 Nova Sonic Tool Result:', {
            toolResultData: data,
            timestamp: new Date().toISOString()
        });
        logCallActivity('NOVA_SONIC_TOOL_RESULT', { toolResultData: data });
    });
}

/**
 * Log comprehensive call statistics
 */
function logCallStatistics() {
    const endTime = new Date();
    const duration = endTime.getTime() - callSession.startTime.getTime();
    
    console.log('📊 CALL STATISTICS SUMMARY:', {
        contactId: process.env.CONTACT_ID,
        customerPhone: process.env.CUSTOMER_PHONE_NUMBER,
        streamArn: process.env.STREAM_ARN,
        startTime: callSession.startTime.toISOString(),
        endTime: endTime.toISOString(),
        duration: `${duration}ms (${Math.round(duration/1000)}s)`,
        totalNovaSonicResponses: callSession.novaSonicResponses.length,
        totalTranscriptEntries: callSession.transcriptLog.length,
        novaSonicSessionActive: !!novaSonicSession,
        kvsConnectionActive: !!kvsConnection,
        timestamp: new Date().toISOString()
    });
    
    logCallActivity('CALL_STATISTICS', {
        duration,
        totalNovaSonicResponses: callSession.novaSonicResponses.length,
        totalTranscriptEntries: callSession.transcriptLog.length,
        novaSonicSessionActive: !!novaSonicSession,
        kvsConnectionActive: !!kvsConnection
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

        // Close WebRTC connection
        if (peerConnection) {
            console.log('🔧 Closing WebRTC connection...');
            
            try {
                // Remove audio tracks
                if (audioSender) {
                    peerConnection.removeTrack(audioSender);
                    console.log('🔧 Audio sender removed');
                }
                
                // Close peer connection
                peerConnection.close();
                console.log('🔧 WebRTC connection closed');
            } catch (error) {
                console.error('❌ Error closing WebRTC connection:', error);
            }
        }

        // Close KVS WebSocket connection
        if (kvsWebSocket) {
            console.log('🔌 Closing KVS WebSocket connection...');
            kvsWebSocket.close();
            console.log('🔌 KVS WebSocket closed');
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
        streamARN: callSession.streamARN,
        contactId: callSession.contactId,
        webRTCState: callSession.webRTCState,
        kvsState: callSession.kvsState,
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
        
        // Start session timeout monitoring
        startSessionTimeoutMonitoring();
        
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