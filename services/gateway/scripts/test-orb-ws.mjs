#!/usr/bin/env node
/**
 * VTID-01222: Test script for ORB WebSocket endpoint
 *
 * This script tests the WebSocket connection to /api/v1/orb/live/ws
 *
 * Usage:
 *   node scripts/test-orb-ws.mjs [options]
 *
 * Options:
 *   --host      Gateway host (default: localhost:8080)
 *   --lang      Language code (default: en)
 *   --send-audio  Send a dummy audio chunk after session starts
 *   --verbose   Show all messages
 *
 * Example:
 *   node scripts/test-orb-ws.mjs
 *   node scripts/test-orb-ws.mjs --host gateway-q74ibpv6ia-uc.a.run.app --lang de
 */

import WebSocket from 'ws';

// Parse command line arguments
const args = process.argv.slice(2);
const getArg = (name, defaultValue) => {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1];
  }
  return defaultValue;
};
const hasFlag = (name) => args.includes(`--${name}`);

const host = getArg('host', 'localhost:8080');
const lang = getArg('lang', 'en');
const sendAudio = hasFlag('send-audio');
const verbose = hasFlag('verbose');

// Determine protocol
const isSecure = host.includes('run.app') || host.includes('https');
const wsProtocol = isSecure ? 'wss' : 'ws';
const wsUrl = `${wsProtocol}://${host}/api/v1/orb/live/ws`;

console.log('='.repeat(60));
console.log('VTID-01222: ORB WebSocket Test');
console.log('='.repeat(60));
console.log(`URL: ${wsUrl}`);
console.log(`Language: ${lang}`);
console.log(`Send Audio: ${sendAudio}`);
console.log('='.repeat(60));
console.log();

// Track test state
let sessionId = null;
let connected = false;
let sessionStarted = false;
let receivedMessages = 0;
let testPassed = false;

// Create WebSocket connection
console.log('[TEST] Connecting to WebSocket...');
const ws = new WebSocket(wsUrl);

// Connection timeout
const connectionTimeout = setTimeout(() => {
  if (!connected) {
    console.error('[TEST] Connection timeout after 10 seconds');
    process.exit(1);
  }
}, 10000);

// Test timeout
const testTimeout = setTimeout(() => {
  console.log('\n[TEST] Test duration exceeded, closing...');
  cleanup();
}, 30000);

ws.on('open', () => {
  connected = true;
  clearTimeout(connectionTimeout);
  console.log('[TEST] WebSocket connected!');
  console.log();

  // Send ping to test basic communication
  console.log('[TEST] Sending ping message...');
  ws.send(JSON.stringify({ type: 'ping' }));
});

ws.on('message', (data) => {
  receivedMessages++;
  try {
    const message = JSON.parse(data.toString());

    if (verbose) {
      console.log('[RECV]', JSON.stringify(message, null, 2));
    }

    // Handle different message types
    switch (message.type) {
      case 'connected':
        sessionId = message.session_id;
        console.log(`[TEST] Received connected message: session_id=${sessionId}`);
        break;

      case 'pong':
        console.log(`[TEST] Received pong: timestamp=${message.timestamp}`);

        // After ping/pong, send start message
        console.log();
        console.log('[TEST] Sending start message...');
        ws.send(JSON.stringify({
          type: 'start',
          lang: lang,
          response_modalities: ['audio', 'text']
        }));
        break;

      case 'session_started':
        sessionStarted = true;
        console.log(`[TEST] Session started: live_api_connected=${message.live_api_connected}`);
        if (message.meta) {
          console.log(`[TEST]   Model: ${message.meta.model}`);
          console.log(`[TEST]   Voice: ${message.meta.voice}`);
          console.log(`[TEST]   Audio In Rate: ${message.meta.audio_in_rate || 'N/A'}`);
          console.log(`[TEST]   Audio Out Rate: ${message.meta.audio_out_rate || 'N/A'}`);
        }
        if (message.error) {
          console.log(`[TEST]   Error: ${message.error}`);
        }

        // Test passed if we got session_started
        testPassed = true;
        console.log();
        console.log('[TEST] ✓ Basic WebSocket communication verified!');

        // Optionally send audio
        if (sendAudio) {
          console.log();
          console.log('[TEST] Sending dummy audio chunk...');
          // Create a small silent PCM audio chunk (16kHz, 16-bit, mono)
          // 100ms of silence = 1600 samples = 3200 bytes
          const silentPcm = Buffer.alloc(3200, 0);
          ws.send(JSON.stringify({
            type: 'audio',
            data_b64: silentPcm.toString('base64'),
            mime: 'audio/pcm;rate=16000'
          }));

          // Send end_turn after audio
          setTimeout(() => {
            console.log('[TEST] Sending end_turn...');
            ws.send(JSON.stringify({ type: 'end_turn' }));
          }, 100);
        } else {
          // Close connection after a short delay
          setTimeout(() => {
            console.log();
            console.log('[TEST] Sending stop message...');
            ws.send(JSON.stringify({ type: 'stop' }));
          }, 1000);
        }
        break;

      case 'audio':
        console.log(`[TEST] Received audio chunk: mime=${message.mime}, chunk=${message.chunk_number}`);
        break;

      case 'transcript':
        console.log(`[TEST] Received transcript: "${message.text}"`);
        break;

      case 'audio_ack':
        console.log(`[TEST] Audio acknowledged: chunk=${message.chunk_number}, live_api=${message.live_api}`);
        break;

      case 'end_turn_ack':
        console.log(`[TEST] End turn acknowledged: live_api=${message.live_api}`);

        // Stop session after end_turn
        setTimeout(() => {
          console.log('[TEST] Sending stop message...');
          ws.send(JSON.stringify({ type: 'stop' }));
        }, 2000);
        break;

      case 'turn_complete':
        console.log('[TEST] Turn complete - model finished responding');
        break;

      case 'input_transcript':
        console.log(`[TEST] Input transcription: "${message.text}"`);
        break;

      case 'output_transcript':
        console.log(`[TEST] Output transcription: "${message.text}"`);
        break;

      case 'session_stopped':
        console.log(`[TEST] Session stopped: ${message.session_id}`);
        cleanup();
        break;

      case 'live_api_disconnected':
        console.log(`[TEST] Live API disconnected: code=${message.code}`);
        break;

      case 'error':
        console.error(`[TEST] Error: ${message.message}`);
        if (message.details) {
          console.error(`[TEST]   Details: ${message.details}`);
        }
        break;

      default:
        console.log(`[TEST] Unknown message type: ${message.type}`);
    }
  } catch (err) {
    console.error('[TEST] Error parsing message:', err.message);
    console.log('[TEST] Raw data:', data.toString());
  }
});

ws.on('error', (error) => {
  console.error('[TEST] WebSocket error:', error.message);
});

ws.on('close', (code, reason) => {
  console.log(`[TEST] WebSocket closed: code=${code}, reason=${reason || 'none'}`);
  console.log();

  // Print summary
  console.log('='.repeat(60));
  console.log('Test Summary');
  console.log('='.repeat(60));
  console.log(`Connected: ${connected ? '✓' : '✗'}`);
  console.log(`Session Started: ${sessionStarted ? '✓' : '✗'}`);
  console.log(`Messages Received: ${receivedMessages}`);
  console.log(`Test Result: ${testPassed ? '✓ PASSED' : '✗ FAILED'}`);
  console.log('='.repeat(60));

  clearTimeout(testTimeout);
  process.exit(testPassed ? 0 : 1);
});

function cleanup() {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1000, 'Test complete');
    }
  } catch (e) {
    // Ignore
  }
  clearTimeout(testTimeout);
  clearTimeout(connectionTimeout);
}

// Handle SIGINT
process.on('SIGINT', () => {
  console.log('\n[TEST] Interrupted, cleaning up...');
  cleanup();
  process.exit(1);
});
