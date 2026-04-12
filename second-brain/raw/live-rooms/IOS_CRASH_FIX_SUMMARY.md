# iOS Crash Fixes for Vitana Platform

**Issue**: iOS mobile app crashes when activating ORB communication or Live Room
**Platforms Affected**: iOS Safari (iPhone/iPad)
**Platforms Working**: Android, Web Desktop

---

## Root Causes Identified

### 1. ORB Voice: AudioWorklet Not Supported on iOS ⚠️ **CRITICAL**

**Location**: `temp_vitana_v1/src/lib/OrbVoiceClient.ts:279`

**Problem**:
```typescript
await this.inputContext.audioWorklet.addModule('/audio-processor.js');
this.workletNode = new AudioWorkletNode(this.inputContext, 'audio-processor');
```

- iOS Safari **does NOT support** `AudioWorklet` (modern Web Audio API feature)
- iOS Safari only supports the deprecated `ScriptProcessorNode`
- When OrbVoiceClient tries to load AudioWorklet, it throws an error and crashes

**Impact**: Complete crash when starting ORB voice session on iOS

---

### 2. ORB Voice: Sample Rate Constraints Rejected by iOS

**Location**: `temp_vitana_v1/src/lib/OrbVoiceClient.ts:258-266`

**Problem**:
```typescript
this.mediaStream = await navigator.mediaDevices.getUserMedia({
  audio: {
    sampleRate: this.SAMPLE_RATE_IN, // 16000
    // iOS Safari ignores or rejects this
  }
});
```

- iOS Safari **ignores** `sampleRate` constraints in getUserMedia
- iOS Safari defaults to 48000 Hz, not 16000 Hz
- The app expects 16kHz audio but receives 48kHz, causing mismatched buffers

**Impact**: Audio distortion, potential crashes when processing audio chunks

---

### 3. Live Room: Daily.co Iframe Missing iOS Permissions

**Location**: `temp_vitana_v1/src/components/liverooms/DailyVideoRoom.tsx:24`

**Problem**:
```typescript
const call = DailyIframe.createFrame(containerRef.current, {
  showLeaveButton: true,
  iframeStyle: { ... }
  // Missing: iOS requires explicit iframe permissions
});
```

- iOS **requires** explicit `allow` attribute on iframes for camera/microphone
- Without `allow="camera; microphone; autoplay"`, iOS blocks media access
- Daily.co iframe cannot access camera/microphone, causing crash

**Impact**: Complete crash when trying to join Live Room on iOS

---

### 4. AudioContext Autoplay Policy (Both Features)

**Problem**:
- iOS **suspends** all AudioContext instances by default (autoplay policy)
- Both ORB and Live Room create AudioContext without user interaction
- iOS blocks audio playback unless AudioContext is resumed after user gesture

**Impact**: Audio doesn't play, or app hangs waiting for audio to start

---

### 5. EventSource (SSE) Instability on iOS

**Location**: `temp_vitana_v1/src/lib/OrbVoiceClient.ts:160`

**Problem**:
```typescript
this.eventSource = new EventSource(sseUrl);
```

- iOS Safari's EventSource implementation has known connection issues
- Long-running SSE connections can timeout or drop on iOS
- Authentication via query param may not work reliably

**Impact**: ORB loses connection to server, transcripts don't arrive

---

## Fixes Applied

### ✅ Fix 1: iOS Audio Polyfill with ScriptProcessorNode Fallback

**File**: `temp_vitana_v1/src/lib/ios-audio-polyfill.ts` (NEW)

**What it does**:
1. Detects iOS Safari vs other browsers
2. Uses `AudioWorklet` on modern browsers
3. Falls back to `ScriptProcessorNode` on iOS Safari
4. Handles sample rate differences

**Key features**:
- Automatic iOS detection
- Zero-gain connection to prevent feedback
- 4096 sample buffer size (optimal for iOS)
- Float32Array copying to avoid buffer reuse issues

---

### ✅ Fix 2: Daily.co Iframe Permissions for iOS

**File**: `temp_vitana_v1/src/components/liverooms/DailyVideoRoom.tsx`

**Change**:
```typescript
const call = DailyIframe.createFrame(containerRef.current, {
  showLeaveButton: true,
  iframeStyle: { ... },
  // ADDED for iOS:
  allow: 'camera; microphone; autoplay; display-capture',
});
```

**What it does**:
- Explicitly grants iframe permission to access camera/microphone
- Allows autoplay audio (required for Daily.co)
- Enables screen sharing (display-capture)

---

### ⚠️ Fix 3: OrbVoiceClient Must Use iOS Polyfill (TO BE APPLIED)

**File**: `temp_vitana_v1/src/lib/OrbVoiceClient.ts`

**Required changes**:

1. **Import the polyfill**:
```typescript
import { CrossPlatformAudioRecorder } from './ios-audio-polyfill';
```

2. **Replace AudioWorklet code** (lines 256-298):

**REMOVE**:
```typescript
private async startRecording(): Promise<void> {
  try {
    this.mediaStream = await navigator.mediaDevices.getUserMedia({ ... });
    this.inputContext = new AudioContext({ sampleRate: this.SAMPLE_RATE_IN });
    const source = this.inputContext.createMediaStreamSource(this.mediaStream);

    // Load AudioWorklet
    await this.inputContext.audioWorklet.addModule('/audio-processor.js');
    this.workletNode = new AudioWorkletNode(this.inputContext, 'audio-processor');

    this.workletNode.port.onmessage = async (event) => {
      const pcmData = event.data as Float32Array;
      await this.sendAudio(pcmData);
    };

    source.connect(this.workletNode);
    this.workletNode.connect(this.inputContext.destination);
  } catch (e) { ... }
}
```

**REPLACE WITH**:
```typescript
private recorder: CrossPlatformAudioRecorder | null = null;

private async startRecording(): Promise<void> {
  try {
    this.recorder = new CrossPlatformAudioRecorder(
      async (pcmData) => {
        await this.sendAudio(pcmData);
      },
      this.SAMPLE_RATE_IN
    );

    await this.recorder.start();
    this.callbacks.onListeningChange?.(true);
    console.log('[OrbVoiceClient] Recording started');
  } catch (e: any) {
    console.error('[OrbVoiceClient] Microphone access denied or error', e);
    this.callbacks.onError?.('Microphone access denied');
    throw e;
  }
}
```

3. **Update stopListening()**:
```typescript
stopListening(): void {
  // Clear silence detection timer
  if (this.silenceTimer) {
    clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
  }
  this.hasSpeechStarted = false;

  // Stop recorder
  if (this.recorder) {
    this.recorder.stop();
    this.recorder = null;
  }

  if (this.volumeAnimationFrame) {
    cancelAnimationFrame(this.volumeAnimationFrame);
    this.volumeAnimationFrame = null;
  }

  this.callbacks.onListeningChange?.(false);
  this.callbacks.onVolumeChange?.(0);
}
```

---

### ⚠️ Fix 4: AudioContext Resume on User Interaction (TO BE APPLIED)

**File**: `temp_vitana_v1/src/lib/OrbVoiceClient.ts`

**Add to `start()` method** (after line 107):

```typescript
async start(): Promise<void> {
  try {
    this.callbacks.onConnectionStateChange?.('connecting');

    // ... existing session creation code ...

    // 3. Initialize audio output context
    await this.initAudioOutput();

    // iOS FIX: Resume AudioContext (required by iOS autoplay policy)
    if (this.audioContext && this.audioContext.state === 'suspended') {
      console.log('[OrbVoiceClient] Resuming AudioContext for iOS...');
      await this.audioContext.resume();
    }

    // 4. Start recording
    await this.startRecording();

    // ... rest of code ...
  }
}
```

---

### ⚠️ Fix 5: EventSource Timeout Handling (RECOMMENDED)

**File**: `temp_vitana_v1/src/lib/OrbVoiceClient.ts`

**Add to `connectSSE()` method**:

```typescript
private connectSSE(): void {
  if (!this.sessionId) return;

  const token = encodeURIComponent(this.config.accessToken);
  const sseUrl = `${this.GATEWAY_URL}/api/v1/orb/live/stream?session_id=${this.sessionId}&token=${token}`;
  console.log('[OrbVoiceClient] Connecting SSE:', sseUrl.replace(token, '[REDACTED]'));

  this.eventSource = new EventSource(sseUrl);

  this.eventSource.onopen = () => {
    console.log('[OrbVoiceClient] SSE connected');
  };

  this.eventSource.onmessage = (event) => {
    // ... existing message handling ...
  };

  // ADDED: Better error handling for iOS
  this.eventSource.onerror = (error) => {
    console.warn('[OrbVoiceClient] SSE connection issue', error);

    // iOS EventSource may close unexpectedly - auto-reconnect once
    if (this.eventSource?.readyState === EventSource.CLOSED) {
      console.log('[OrbVoiceClient] SSE closed, attempting reconnect...');
      setTimeout(() => {
        if (this.sessionId) {
          this.connectSSE();
        }
      }, 1000);
    }
  };
}
```

---

## Testing Checklist

After applying all fixes, test on **real iOS device** (not simulator):

### ORB Voice Tests:
- [ ] ORB button activates without crash
- [ ] Microphone permission prompt appears
- [ ] Audio recording starts (check console logs)
- [ ] User can speak and audio is sent to server
- [ ] AI response audio plays back correctly
- [ ] SSE connection stays alive for >60 seconds
- [ ] End session works cleanly

### Live Room Tests:
- [ ] "Go Live" creates session without crash
- [ ] Daily.co iframe loads
- [ ] Camera/microphone permission prompts appear
- [ ] User can join video room
- [ ] Video/audio streams work
- [ ] Can leave room cleanly
- [ ] Rejoining works

### Edge Cases:
- [ ] Switching between ORB and Live Room multiple times
- [ ] Backgrounding app during session
- [ ] Low battery mode enabled
- [ ] Poor network connection (3G)
- [ ] Denying camera/microphone permissions
- [ ] Revoking permissions mid-session

---

## iOS Safari Limitations (Known Issues)

1. **Sample Rate**: iOS Safari will always use 48kHz internally, even if you request 16kHz. The polyfill handles resampling.

2. **ScriptProcessorNode Deprecation**: ScriptProcessorNode is deprecated but still required for iOS. It will eventually be removed from iOS Safari when they add AudioWorklet support.

3. **Background Audio**: iOS will suspend audio when app goes to background. This is OS-level behavior and cannot be overridden.

4. **EventSource Reliability**: iOS Safari's EventSource is less reliable than WebSocket. Consider migrating to WebSocket for iOS if SSE issues persist.

5. **Memory Limits**: iOS has strict memory limits. Large audio buffers or long sessions may trigger memory warnings.

---

## Debugging on iOS

### Enable iOS Safari Web Inspector:
1. On iPhone: Settings → Safari → Advanced → Web Inspector (ON)
2. On Mac: Safari → Develop → [Your iPhone] → [Page]

### Key Console Logs to Check:
```
[AudioRecorder] Using ScriptProcessorNode (iOS fallback)  // Should see this on iOS
[OrbVoiceClient] Recording started                         // Audio capture working
[Daily] Joined meeting                                      // Video room working
```

### Common Error Messages:
- `"audioWorklet is not defined"` → iOS detected, fallback should trigger
- `"NotAllowedError: Permission denied"` → User denied mic/camera
- `"NotSupportedError"` → Browser feature not available
- `"InvalidStateError"` → AudioContext suspended (needs resume)

---

## Next Steps

1. **Apply Fix 3** (update OrbVoiceClient.ts to use polyfill)
2. **Apply Fix 4** (add AudioContext resume logic)
3. **Apply Fix 5** (add EventSource reconnect logic)
4. **Test on real iOS device** (iPhone 12+ recommended)
5. **Monitor Sentry/error logs** for iOS-specific errors
6. **Consider WebSocket migration** if SSE issues persist on iOS

---

## References

- [iOS Safari Audio Restrictions](https://developer.apple.com/documentation/webkit/delivering_video_content_for_safari)
- [Daily.co iOS Guide](https://docs.daily.co/guides/products/mobile/ios)
- [Web Audio API on iOS](https://webkit.org/blog/6784/new-video-policies-for-ios/)
- [ScriptProcessorNode MDN](https://developer.mozilla.org/en-US/docs/Web/API/ScriptProcessorNode)
