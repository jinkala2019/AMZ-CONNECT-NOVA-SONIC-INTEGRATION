# Nova Sonic Integration Guide for Amazon Connect

## Overview
This guide explains the correct implementation of Nova Sonic bidirectional streaming with Amazon Connect, including the proper event sequence and audio format handling.

## Nova Sonic Bidirectional Streaming Sequence

### Correct Event Sequence (as per Nova Sonic documentation):

1. **Session Initialization**
   ```typescript
   // 1. Create session
   novaSonicSession = bedrockClient.createStreamSession(sessionId);
   
   // 2. Set up event handlers BEFORE initiating
   setupNovaSonicEventHandlers();
   
   // 3. Initiate session (sends sessionStart automatically)
   await bedrockClient.initiateSession(sessionId);
   ```

2. **Prompt and Content Setup**
   ```typescript
   // 4. Setup prompt start (sends promptStart event)
   await novaSonicSession.setupPromptStart();
   
   // 5. Setup system prompt (sends contentStart, textInput, contentEnd for text)
   await novaSonicSession.setupSystemPrompt(undefined, SYSTEM_PROMPT);
   
   // 6. Setup audio content start (sends contentStart for audio)
   await novaSonicSession.setupStartAudio();
   ```

3. **Audio Streaming**
   ```typescript
   // 7. Stream audio chunks to Nova Sonic
   await novaSonicSession.streamAudio(audioBuffer);
   ```

## Audio Format Specifications

### Amazon Connect Audio Format:
- **Format**: PCM (Pulse Code Modulation)
- **Sample Rate**: 8,000 Hz (8kHz)
- **Bit Depth**: 16-bit
- **Channels**: 1 (Mono)
- **Encoding**: Raw PCM buffer

### Nova Sonic Audio Format:
- **Input Format**: Base64 encoded PCM
- **Sample Rate**: 8,000 Hz (8kHz)
- **Bit Depth**: 16-bit
- **Channels**: 1 (Mono)
- **Encoding**: Base64 string

### Audio Conversion Flow:

#### Amazon Connect → Nova Sonic:
```
Amazon Connect WebRTC (Float32Array) 
    ↓ (Web Audio API conversion)
Raw PCM Buffer (Int16Array)
    ↓ (Base64 encoding)
Base64 String
    ↓ (Send to Nova Sonic)
Nova Sonic Processing
```

#### Nova Sonic → Amazon Connect:
```
Nova Sonic Audio Output (Base64 PCM)
    ↓ (Base64 decoding)
Raw PCM Buffer (Int16Array)
    ↓ (Web Audio API conversion)
Float32Array for WebRTC
    ↓ (Send via WebRTC)
Amazon Connect Audio
```

## Implementation Details

### 1. Audio Input Processing (Amazon Connect → Nova Sonic)

```typescript
// WebRTC audio track processing
peerConnection.ontrack = (event) => {
    if (event.track.kind === 'audio') {
        const audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(new MediaStream([event.track]));
        const processor = audioContext.createScriptProcessor(4096, 1, 1);
        
        processor.onaudioprocess = async (e) => {
            const inputData = inputBuffer.getChannelData(0);
            
            // Convert Float32Array to Int16Array PCM
            const pcmData = new Int16Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
                pcmData[i] = Math.max(-32768, Math.min(32767, inputData[i] * 32768));
            }
            
            const pcmBuffer = Buffer.from(pcmData.buffer);
            await processAudioChunk(pcmBuffer);
        };
    }
};

// Convert PCM to base64 for Nova Sonic
async function processAudioChunk(audioChunk: Buffer) {
    const base64Audio = audioChunk.toString('base64');
    const novaSonicAudioBuffer = Buffer.from(base64Audio, 'utf8');
    await novaSonicSession.streamAudio(novaSonicAudioBuffer);
}
```

### 2. Audio Output Processing (Nova Sonic → Amazon Connect)

```typescript
// Nova Sonic audio output handler
novaSonicSession.onEvent('audioOutput', (data) => {
    // Nova Sonic provides base64 encoded PCM
    const base64String = data.content;
    const rawPcmBuffer = Buffer.from(base64String, 'base64');
    
    // Convert to WebRTC format
    const pcmData = new Int16Array(rawPcmBuffer.buffer);
    const floatData = new Float32Array(pcmData.length);
    for (let i = 0; i < pcmData.length; i++) {
        floatData[i] = pcmData[i] / 32768.0;
    }
    
    // Create WebRTC audio track
    const audioContext = new AudioContext();
    const buffer = audioContext.createBuffer(1, floatData.length, 8000);
    buffer.getChannelData(0).set(floatData);
    
    // Add to WebRTC connection
    const mediaStream = new MediaStream();
    const audioTrack = audioContext.createMediaStreamDestination().stream.getAudioTracks()[0];
    peerConnection.addTrack(audioTrack, mediaStream);
});
```

## Key Configuration Constants

```typescript
// Nova Sonic Audio Configuration
export const DefaultAudioInputConfiguration = {
    audioType: "SPEECH" as AudioType,
    encoding: "base64",
    mediaType: "audio/lpcm" as AudioMediaType,
    sampleRateHertz: 8000,
    sampleSizeBits: 16,
    channelCount: 1,
};

export const DefaultAudioOutputConfiguration = {
    ...DefaultAudioInputConfiguration,
    sampleRateHertz: 8000,
    voiceId: "matthew",
};
```

## Event Handling

### Required Nova Sonic Events:
- `sessionStart` - Session initialization
- `promptStart` - Prompt setup
- `contentStart` - Content beginning
- `textInput` - System prompt text
- `contentEnd` - Content ending
- `audioOutput` - Audio responses
- `textOutput` - Text responses
- `error` - Error handling
- `streamComplete` - Stream completion

### Event Sequence Logging:
```typescript
novaSonicSession.onEvent('any', (eventData) => {
    console.log('🔍 Nova Sonic Event:', {
        type: eventData.type,
        data: eventData.data,
        timestamp: new Date().toISOString()
    });
});
```

## Troubleshooting

### Common Issues:

1. **"Timed out waiting for input events"**
   - Ensure correct event sequence: `promptStart` → `systemPrompt` → `startAudio`
   - Add delays between events (1 second recommended)
   - Verify event handlers are set up before session initiation

2. **Audio format errors**
   - Ensure PCM is 8kHz, 16-bit, mono
   - Verify base64 encoding for Nova Sonic input
   - Check WebRTC audio track format conversion

3. **No Nova Sonic responses**
   - Check IAM permissions for Bedrock
   - Verify Nova Sonic model access
   - Ensure proper session initialization sequence

### Debug Logging:
```typescript
// Enable comprehensive logging
logCallActivity('AUDIO_FORMAT_DEBUG', {
    inputFormat: 'PCM (8kHz, 16-bit, mono)',
    novaSonicFormat: 'Base64 encoded PCM',
    conversionSteps: ['Float32Array → Int16Array → Base64'],
    sampleRate: 8000,
    channels: 1
});
```

## Best Practices

1. **Event Sequence**: Always follow the documented sequence
2. **Audio Format**: Maintain consistent 8kHz, 16-bit, mono format
3. **Error Handling**: Implement comprehensive error handling
4. **Logging**: Log all events and audio conversions for debugging
5. **Resource Management**: Properly close sessions and connections
6. **Timeout Handling**: Implement session timeout monitoring

## Testing

### Test Audio Flow:
1. Verify Amazon Connect audio input (PCM format)
2. Check Nova Sonic audio output (base64 format)
3. Validate WebRTC audio transmission
4. Monitor event sequence completion
5. Test error scenarios and recovery

This implementation ensures proper Nova Sonic bidirectional streaming with correct audio format handling for Amazon Connect integration.
