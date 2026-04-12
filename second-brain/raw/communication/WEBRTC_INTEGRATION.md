# WebRTC Integration Guide

Complete infrastructure for human-to-human video/audio calling in Live Rooms and Messenger.

## Architecture Overview

### Core Components

1. **useWebRTC Hook** (`hooks/useWebRTC.ts`)
   - Manages peer-to-peer connections
   - Handles media streams (audio/video/screen)
   - Uses Supabase Realtime for signaling
   - Supports multi-peer connections

2. **useCallState Hook** (`hooks/useCallState.ts`)
   - Manages call states (idle, calling, ringing, active, ended)
   - Handles call initiation and acceptance
   - Uses Supabase Realtime for call notifications

3. **LiveRoom Component** (`components/LiveRoom.tsx`)
   - Multi-user video conferencing
   - For community events, coaching sessions, meetups
   - Supports up to N participants (tested with 6)

4. **MessengerCall Component** (`components/MessengerCall.tsx`)
   - 1-on-1 audio/video calls in message threads
   - Picture-in-picture local video
   - Call duration tracking

5. **CallManager Component** (`components/CallManager.tsx`)
   - Global call state management
   - Handles incoming call notifications
   - Shows active calls

## Integration Guide

### 1. Messenger Integration

Add call buttons to message threads:

```tsx
import { MessageThreadCallButtons } from '@/components/MessageThreadCallButtons';
import { CallManager } from '@/components/CallManager';

// In your messaging component
function MessageThread({ userId, recipientId }) {
  return (
    <>
      <CallManager userId={userId} userName="Your Name" />
      
      <div className="message-thread-header">
        <MessageThreadCallButtons
          userId={userId}
          recipientId={recipientId}
          recipientName="Recipient Name"
        />
      </div>
      
      {/* Rest of message thread */}
    </>
  );
}
```

### 2. Community Live Rooms

Create live rooms for events:

```tsx
import { CreateLiveRoomDialog } from '@/components/CreateLiveRoomDialog';
import { LiveRoom } from '@/components/LiveRoom';

function CommunityEvents({ userId }) {
  const [activeRoom, setActiveRoom] = useState(null);

  const handleRoomCreated = (roomId, roomName) => {
    setActiveRoom({ roomId, roomName });
  };

  if (activeRoom) {
    return (
      <LiveRoom
        roomId={activeRoom.roomId}
        userId={userId}
        userName="Your Name"
        onLeave={() => setActiveRoom(null)}
      />
    );
  }

  return (
    <div>
      <CreateLiveRoomDialog
        userId={userId}
        onRoomCreated={handleRoomCreated}
      />
    </div>
  );
}
```

### 3. Call Manager Setup

Add CallManager to your root layout to handle incoming calls globally:

```tsx
import { CallManager } from '@/components/CallManager';

function Layout({ userId, userName }) {
  return (
    <>
      <CallManager userId={userId} userName={userName} />
      {/* Rest of your app */}
    </>
  );
}
```

## Features

### Live Rooms
- ✅ Multi-participant video conferencing
- ✅ Audio/video controls (mute/unmute)
- ✅ Screen sharing capability
- ✅ Participant count display
- ✅ Auto-cleanup on leave

### Messenger Calls
- ✅ 1-on-1 audio calls
- ✅ 1-on-1 video calls
- ✅ Picture-in-picture local video
- ✅ Call duration tracking
- ✅ Incoming call notifications
- ✅ Accept/reject incoming calls

### Technical Features
- ✅ WebRTC peer-to-peer connections
- ✅ STUN servers for NAT traversal
- ✅ Supabase Realtime for signaling
- ✅ Automatic reconnection handling
- ✅ Clean resource cleanup
- ✅ ICE candidate handling

## How It Works

### Signaling Flow
1. User A initiates call/joins room
2. Supabase Realtime broadcasts presence
3. User B receives notification via Supabase channel
4. WebRTC peer connection established
5. Media streams exchanged

### Room Management
- Each room has unique ID
- Supabase Realtime channel per room
- Presence tracking for participants
- Automatic peer discovery

### Call States
- **idle**: No active call
- **calling**: Outgoing call, waiting for answer
- **ringing**: Incoming call notification
- **active**: Call connected
- **ended**: Call terminated

## Database Schema (Optional Enhancement)

For persistent room/call history, add these tables:

```sql
-- Live rooms for events
CREATE TABLE live_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_by UUID REFERENCES auth.users NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  max_participants INTEGER DEFAULT 10,
  is_active BOOLEAN DEFAULT true
);

-- Call history
CREATE TABLE call_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id TEXT NOT NULL,
  caller_id UUID REFERENCES auth.users NOT NULL,
  recipient_id UUID REFERENCES auth.users NOT NULL,
  call_type TEXT NOT NULL, -- 'audio' | 'video'
  duration_seconds INTEGER,
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  ended_at TIMESTAMP WITH TIME ZONE
);
```

## Usage Examples

### Starting an Audio Call
```tsx
const { startCall } = useCallState(userId);
await startCall(recipientId, false); // false = audio only
```

### Starting a Video Call
```tsx
const { startCall } = useCallState(userId);
await startCall(recipientId, true); // true = video call
```

### Creating a Live Room
```tsx
<CreateLiveRoomDialog
  userId={currentUserId}
  onRoomCreated={(roomId, roomName) => {
    // Navigate to live room or show room component
    console.log('Room created:', roomId, roomName);
  }}
/>
```

### Joining an Existing Room
```tsx
<LiveRoom
  roomId="existing_room_id"
  userId={currentUserId}
  userName="User Name"
  onLeave={() => {
    // Handle room exit
    console.log('Left room');
  }}
/>
```

## Browser Compatibility

Requires browsers with WebRTC support:
- Chrome 56+
- Firefox 44+
- Safari 11+
- Edge 79+

## Mobile Support

Works on mobile browsers with getUserMedia support:
- iOS Safari 11+
- Chrome Mobile
- Firefox Mobile

For native mobile apps, integrate with Capacitor camera plugin.

## Future Enhancements

- [ ] Screen sharing in messenger calls
- [ ] Recording functionality
- [ ] Chat during live rooms
- [ ] Virtual backgrounds
- [ ] Noise cancellation
- [ ] Hand raise feature
- [ ] Breakout rooms
- [ ] TURN server for firewall traversal
- [ ] End-to-end encryption

## Troubleshooting

### No video/audio
- Check browser permissions for camera/microphone
- Ensure HTTPS connection (required for getUserMedia)
- Check browser compatibility

### Connection fails
- Verify Supabase Realtime is enabled
- Check network firewall settings
- STUN servers may need TURN fallback for restrictive networks

### Poor quality
- Check network bandwidth
- Reduce video resolution in constraints
- Limit number of participants in rooms

## Performance Optimization

- Use lower resolution for mobile: 640x480
- Limit frame rate to 24fps for bandwidth
- Disable video when audio-only is sufficient
- Clean up streams properly on unmount
