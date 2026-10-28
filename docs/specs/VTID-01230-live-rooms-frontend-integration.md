# VTID-01230: Live Rooms Frontend Integration Spec

**Status:** Draft
**Dependencies:** VTID-01228 (Backend Complete ✅)
**Target:** Lovable Vitana v1 Frontend (`temp_vitana_v1/`)
**Date:** 2026-02-09

---

## 1. Overview

This spec defines the frontend integration for the Daily.co Live Rooms feature (VTID-01228 backend). The frontend will enable users to:

**Host Flow:**
1. Create a paid or free live room
2. Start the room and initiate Daily.co video
3. Manage room settings, participants, and access
4. End the room and view session summary

**Viewer Flow:**
1. Browse live and upcoming rooms
2. Purchase access to paid rooms (Stripe)
3. Join rooms (free or after purchase)
4. Participate in video/chat
5. Leave room

---

## 2. Architecture & Technology Stack

### Frontend Tech (Current)
- **Framework:** React 18.3.1 + TypeScript + Vite
- **UI Library:** Shadcn UI (Radix UI + Tailwind CSS)
- **State Management:**
  - React Query (TanStack Query) for server state
  - Zustand for UI state
  - React Context for auth/profile
- **Auth:** Supabase Auth with JWT
- **API Clients:**
  - Supabase JS SDK for direct DB access
  - Gateway API via fetch for live features
- **Payment:** Stripe (NOT YET INTEGRATED)
- **Video:** Daily.co (NOT YET INTEGRATED)

### New Dependencies Required

```json
{
  "dependencies": {
    "@stripe/react-stripe-js": "^2.10.0",
    "@stripe/stripe-js": "^5.6.0",
    "@daily-co/daily-js": "^0.65.0",
    "@daily-co/daily-react": "^0.65.0"
  }
}
```

---

## 3. Backend API Reference

All endpoints are deployed on Gateway:
```
Base URL: https://gateway-q74ibpv6ia-uc.a.run.app/api/v1
```

### 3.1 Live Room Endpoints

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| POST | `/live/rooms` | Create new live room | JWT Required |
| POST | `/live/rooms/:id/start` | Start a live room | JWT Required |
| POST | `/live/rooms/:id/end` | End a live room | JWT Required |
| POST | `/live/rooms/:id/join` | Join a live room | JWT Required |
| POST | `/live/rooms/:id/leave` | Leave a live room | JWT Required |
| GET | `/live/rooms/:id/summary` | Get room summary | JWT Required |
| POST | `/live/rooms/:id/daily` | Create Daily.co room | JWT Required (Host only) |
| DELETE | `/live/rooms/:id/daily` | Delete Daily.co room | JWT Required (Host only) |
| POST | `/live/rooms/:id/purchase` | Purchase room access | JWT Required |
| POST | `/live/stripe/webhook` | Stripe webhook (backend only) | Stripe signature |

### 3.2 Request/Response Examples

**Create Room:**
```typescript
POST /api/v1/live/rooms
Headers: { Authorization: Bearer <JWT> }
Body: {
  title: "My Live Session",
  topic_keys: ["health", "wellness"],
  access_level: "public" | "group", // free or paid
  metadata: {
    price?: 9.99,  // Only for "group" (paid) rooms
    description?: "Session description",
    cover_image_url?: "https://..."
  }
}

Response: {
  ok: true,
  room_id: "uuid-here",
  room: { id, title, status: "scheduled", ... }
}
```

**Start Room:**
```typescript
POST /api/v1/live/rooms/:id/start
Headers: { Authorization: Bearer <JWT> }

Response: {
  ok: true,
  started_at: "2026-02-09T18:00:00Z"
}
```

**Create Daily.co Video Room:**
```typescript
POST /api/v1/live/rooms/:id/daily
Headers: { Authorization: Bearer <JWT> }

Response: {
  ok: true,
  daily_room_url: "https://vitana.daily.co/vitana-abc123",
  daily_room_name: "vitana-abc123",
  already_existed: false
}
```

**Purchase Access:**
```typescript
POST /api/v1/live/rooms/:id/purchase
Headers: { Authorization: Bearer <JWT> }
Body: {
  user_id: "uuid-here"
}

Response: {
  ok: true,
  client_secret: "pi_...secret...",  // Stripe Payment Intent client secret
  amount: 9.99,
  currency: "usd"
}
```

**Join Room:**
```typescript
POST /api/v1/live/rooms/:id/join
Headers: { Authorization: Bearer <JWT> }
Body: {
  user_id: "uuid-here"
}

Response: {
  ok: true,
  joined_at: "2026-02-09T18:05:00Z"
}

// Error (Paid room, no access):
Response: {
  ok: false,
  error: "ACCESS_DENIED",
  message: "You must purchase access to join this room"
}
```

---

## 4. Frontend File Structure

### New Files to Create

```
temp_vitana_v1/src/
├── services/
│   └── liveRoomService.ts              # API client for Live Rooms
│
├── hooks/
│   ├── useLiveRoom.ts                  # Manage single live room state
│   ├── useLiveRoomList.ts              # Fetch & cache live room list
│   ├── useLiveRoomAccess.ts            # Check & purchase access
│   ├── useDailyRoom.ts                 # Daily.co video integration
│   └── useStripePayment.ts             # Stripe payment flow
│
├── components/
│   ├── liverooms/
│   │   ├── LiveRoomCard.tsx            # Room preview card
│   │   ├── LiveRoomGrid.tsx            # Grid of live/upcoming rooms
│   │   ├── CreateLiveRoomDialog.tsx    # Create room modal (ENHANCE EXISTING)
│   │   ├── LiveRoomViewer.tsx          # Room viewer page (ENHANCE EXISTING)
│   │   ├── LiveRoomHostControls.tsx    # Host control panel
│   │   ├── LiveRoomParticipantsList.tsx # Participant list
│   │   ├── PurchaseRoomAccessDialog.tsx # Stripe checkout dialog
│   │   ├── DailyVideoRoom.tsx          # Daily.co video component
│   │   └── LiveRoomSummary.tsx         # Post-session summary
│   │
│   └── billing/
│       └── StripePaymentForm.tsx       # Stripe Elements payment form
│
├── stores/
│   └── liveRoomStore.ts                # Zustand store for UI state
│
└── types/
    └── liveRoom.ts                     # TypeScript types
```

---

## 5. API Service Layer

**File:** `temp_vitana_v1/src/services/liveRoomService.ts`

```typescript
/**
 * Live Room API Client
 *
 * Wraps Gateway Live Room endpoints with typed interfaces.
 */

import { supabase } from '@/integrations/supabase/client';

const GATEWAY_BASE = import.meta.env.VITE_GATEWAY_BASE || 'https://gateway-q74ibpv6ia-uc.a.run.app';
const API_BASE = `${GATEWAY_BASE}/api/v1`;

// ============================================================================
// Types
// ============================================================================

export type AccessLevel = 'public' | 'group';
export type RoomStatus = 'scheduled' | 'live' | 'ended';

export interface LiveRoom {
  id: string;
  tenant_id: string;
  title: string;
  topic_keys: string[];
  host_user_id: string;
  starts_at: string | null;
  ends_at: string | null;
  status: RoomStatus;
  access_level: AccessLevel;
  metadata: {
    price?: number;
    description?: string;
    cover_image_url?: string;
    daily_room_url?: string;
    daily_room_name?: string;
    video_provider?: 'daily_co';
  };
  created_at: string;
  updated_at: string;
}

export interface CreateRoomRequest {
  title: string;
  topic_keys?: string[];
  access_level: AccessLevel;
  metadata?: {
    price?: number;
    description?: string;
    cover_image_url?: string;
  };
}

export interface DailyRoomResponse {
  ok: boolean;
  daily_room_url: string;
  daily_room_name: string;
  already_existed: boolean;
}

export interface PurchaseResponse {
  ok: boolean;
  client_secret: string;
  amount: number;
  currency: string;
}

// ============================================================================
// Helper: Get JWT Token
// ============================================================================

async function getToken(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new Error('Not authenticated');
  }
  return session.access_token;
}

// ============================================================================
// API Methods
// ============================================================================

export const liveRoomService = {
  /**
   * Create a new live room
   */
  async createRoom(request: CreateRoomRequest): Promise<LiveRoom> {
    const token = await getToken();
    const response = await fetch(`${API_BASE}/live/rooms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to create room');
    }

    const { room } = await response.json();
    return room;
  },

  /**
   * Start a live room
   */
  async startRoom(roomId: string): Promise<void> {
    const token = await getToken();
    const response = await fetch(`${API_BASE}/live/rooms/${roomId}/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to start room');
    }
  },

  /**
   * End a live room
   */
  async endRoom(roomId: string): Promise<void> {
    const token = await getToken();
    const response = await fetch(`${API_BASE}/live/rooms/${roomId}/end`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to end room');
    }
  },

  /**
   * Join a live room
   */
  async joinRoom(roomId: string, userId: string): Promise<void> {
    const token = await getToken();
    const response = await fetch(`${API_BASE}/live/rooms/${roomId}/join`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ user_id: userId }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || error.error || 'Failed to join room');
    }
  },

  /**
   * Leave a live room
   */
  async leaveRoom(roomId: string): Promise<void> {
    const token = await getToken();
    const response = await fetch(`${API_BASE}/live/rooms/${roomId}/leave`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to leave room');
    }
  },

  /**
   * Create Daily.co video room
   */
  async createDailyRoom(roomId: string): Promise<DailyRoomResponse> {
    const token = await getToken();
    const response = await fetch(`${API_BASE}/live/rooms/${roomId}/daily`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || error.error || 'Failed to create Daily.co room');
    }

    return response.json();
  },

  /**
   * Delete Daily.co video room
   */
  async deleteDailyRoom(roomId: string): Promise<void> {
    const token = await getToken();
    const response = await fetch(`${API_BASE}/live/rooms/${roomId}/daily`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to delete Daily.co room');
    }
  },

  /**
   * Purchase access to a paid room
   */
  async purchaseAccess(roomId: string, userId: string): Promise<PurchaseResponse> {
    const token = await getToken();
    const response = await fetch(`${API_BASE}/live/rooms/${roomId}/purchase`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ user_id: userId }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || error.error || 'Failed to purchase access');
    }

    return response.json();
  },

  /**
   * Fetch room summary
   */
  async getRoomSummary(roomId: string): Promise<any> {
    const token = await getToken();
    const response = await fetch(`${API_BASE}/live/rooms/${roomId}/summary`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to fetch summary');
    }

    return response.json();
  },
};
```

---

## 6. React Query Hooks

### 6.1 useLiveRoomList Hook

**File:** `temp_vitana_v1/src/hooks/useLiveRoomList.ts`

```typescript
/**
 * Fetch and cache list of live rooms
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { LiveRoom } from '@/services/liveRoomService';

export function useLiveRoomList() {
  return useQuery({
    queryKey: ['live-rooms'],
    queryFn: async (): Promise<LiveRoom[]> => {
      const { data, error } = await supabase
        .from('live_rooms')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;
      return data as LiveRoom[];
    },
    staleTime: 30 * 1000, // 30 seconds
    refetchInterval: 60 * 1000, // Refetch every minute
  });
}

export function useLiveRoomsByStatus(status: 'scheduled' | 'live' | 'ended') {
  return useQuery({
    queryKey: ['live-rooms', status],
    queryFn: async (): Promise<LiveRoom[]> => {
      const { data, error } = await supabase
        .from('live_rooms')
        .select('*')
        .eq('status', status)
        .order('created_at', { ascending: false });

      if (error) throw error;
      return data as LiveRoom[];
    },
    staleTime: 30 * 1000,
  });
}
```

### 6.2 useLiveRoom Hook

**File:** `temp_vitana_v1/src/hooks/useLiveRoom.ts`

```typescript
/**
 * Manage single live room state with mutations
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { liveRoomService, LiveRoom, CreateRoomRequest } from '@/services/liveRoomService';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

export function useLiveRoom(roomId: string) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Fetch room details
  const { data: room, isLoading } = useQuery({
    queryKey: ['live-room', roomId],
    queryFn: async (): Promise<LiveRoom> => {
      const { data, error } = await supabase
        .from('live_rooms')
        .select('*')
        .eq('id', roomId)
        .single();

      if (error) throw error;
      return data as LiveRoom;
    },
    enabled: !!roomId,
  });

  // Start room mutation
  const startRoomMutation = useMutation({
    mutationFn: () => liveRoomService.startRoom(roomId),
    onSuccess: () => {
      toast({ title: 'Room started!' });
      queryClient.invalidateQueries({ queryKey: ['live-room', roomId] });
      queryClient.invalidateQueries({ queryKey: ['live-rooms'] });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to start room', description: error.message, variant: 'destructive' });
    },
  });

  // End room mutation
  const endRoomMutation = useMutation({
    mutationFn: () => liveRoomService.endRoom(roomId),
    onSuccess: () => {
      toast({ title: 'Room ended' });
      queryClient.invalidateQueries({ queryKey: ['live-room', roomId] });
      queryClient.invalidateQueries({ queryKey: ['live-rooms'] });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to end room', description: error.message, variant: 'destructive' });
    },
  });

  // Join room mutation
  const joinRoomMutation = useMutation({
    mutationFn: (userId: string) => liveRoomService.joinRoom(roomId, userId),
    onSuccess: () => {
      toast({ title: 'Joined room!' });
      queryClient.invalidateQueries({ queryKey: ['live-room', roomId] });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to join room', description: error.message, variant: 'destructive' });
    },
  });

  // Leave room mutation
  const leaveRoomMutation = useMutation({
    mutationFn: () => liveRoomService.leaveRoom(roomId),
    onSuccess: () => {
      toast({ title: 'Left room' });
      queryClient.invalidateQueries({ queryKey: ['live-room', roomId] });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to leave room', description: error.message, variant: 'destructive' });
    },
  });

  return {
    room,
    isLoading,
    startRoom: startRoomMutation.mutate,
    endRoom: endRoomMutation.mutate,
    joinRoom: joinRoomMutation.mutate,
    leaveRoom: leaveRoomMutation.mutate,
    isStarting: startRoomMutation.isPending,
    isEnding: endRoomMutation.isPending,
    isJoining: joinRoomMutation.isPending,
    isLeaving: leaveRoomMutation.isPending,
  };
}

export function useCreateLiveRoom() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: CreateRoomRequest) => liveRoomService.createRoom(request),
    onSuccess: (room) => {
      toast({ title: 'Room created!', description: `"${room.title}" is ready` });
      queryClient.invalidateQueries({ queryKey: ['live-rooms'] });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to create room', description: error.message, variant: 'destructive' });
    },
  });
}
```

### 6.3 useDailyRoom Hook

**File:** `temp_vitana_v1/src/hooks/useDailyRoom.ts`

```typescript
/**
 * Daily.co video integration hook
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { liveRoomService } from '@/services/liveRoomService';
import { useToast } from '@/hooks/use-toast';

export function useDailyRoom(roomId: string) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const createDailyRoomMutation = useMutation({
    mutationFn: () => liveRoomService.createDailyRoom(roomId),
    onSuccess: (data) => {
      toast({
        title: 'Video room ready!',
        description: data.already_existed ? 'Using existing room' : 'Created new video room',
      });
      queryClient.invalidateQueries({ queryKey: ['live-room', roomId] });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to create video room', description: error.message, variant: 'destructive' });
    },
  });

  const deleteDailyRoomMutation = useMutation({
    mutationFn: () => liveRoomService.deleteDailyRoom(roomId),
    onSuccess: () => {
      toast({ title: 'Video room deleted' });
      queryClient.invalidateQueries({ queryKey: ['live-room', roomId] });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to delete video room', description: error.message, variant: 'destructive' });
    },
  });

  return {
    createDailyRoom: createDailyRoomMutation.mutate,
    deleteDailyRoom: deleteDailyRoomMutation.mutate,
    isCreatingDaily: createDailyRoomMutation.isPending,
    isDeletingDaily: deleteDailyRoomMutation.isPending,
  };
}
```

### 6.4 useStripePayment Hook

**File:** `temp_vitana_v1/src/hooks/useStripePayment.ts`

```typescript
/**
 * Stripe payment flow hook
 */

import { useMutation } from '@tanstack/react-query';
import { liveRoomService } from '@/services/liveRoomService';
import { useToast } from '@/hooks/use-toast';

export function useStripePayment(roomId: string, userId: string) {
  const { toast } = useToast();

  const purchaseMutation = useMutation({
    mutationFn: () => liveRoomService.purchaseAccess(roomId, userId),
    onError: (error: Error) => {
      toast({ title: 'Payment failed', description: error.message, variant: 'destructive' });
    },
  });

  return {
    initiatePurchase: purchaseMutation.mutate,
    clientSecret: purchaseMutation.data?.client_secret,
    amount: purchaseMutation.data?.amount,
    isPending: purchaseMutation.isPending,
    error: purchaseMutation.error,
  };
}
```

---

## 7. UI Components

### 7.1 LiveRoomCard Component

**File:** `temp_vitana_v1/src/components/liverooms/LiveRoomCard.tsx`

```typescript
/**
 * Card component for displaying a single live room in grid/list
 */

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Users, Clock, DollarSign } from 'lucide-react';
import { LiveRoom } from '@/services/liveRoomService';
import { format } from 'date-fns';

interface LiveRoomCardProps {
  room: LiveRoom;
  onJoin: (roomId: string) => void;
}

export function LiveRoomCard({ room, onJoin }: LiveRoomCardProps) {
  const isPaid = room.access_level === 'group';
  const isLive = room.status === 'live';

  return (
    <Card className="hover:shadow-lg transition-shadow">
      {room.metadata.cover_image_url && (
        <img
          src={room.metadata.cover_image_url}
          alt={room.title}
          className="w-full h-48 object-cover rounded-t-lg"
        />
      )}

      <CardHeader>
        <div className="flex items-start justify-between">
          <CardTitle className="text-lg">{room.title}</CardTitle>
          <Badge variant={isLive ? 'destructive' : 'secondary'}>
            {room.status.toUpperCase()}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {room.metadata.description && (
          <p className="text-sm text-muted-foreground line-clamp-2">
            {room.metadata.description}
          </p>
        )}

        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          {room.starts_at && (
            <div className="flex items-center gap-1">
              <Clock className="w-4 h-4" />
              {format(new Date(room.starts_at), 'MMM d, h:mm a')}
            </div>
          )}

          {isPaid && room.metadata.price && (
            <div className="flex items-center gap-1">
              <DollarSign className="w-4 h-4" />
              ${room.metadata.price.toFixed(2)}
            </div>
          )}
        </div>

        <Button
          className="w-full"
          onClick={() => onJoin(room.id)}
          variant={isLive ? 'default' : 'secondary'}
        >
          {isLive ? 'Join Now' : 'View Details'}
        </Button>
      </CardContent>
    </Card>
  );
}
```

### 7.2 Enhanced CreateLiveRoomDialog

**File:** `temp_vitana_v1/src/components/liverooms/CreateLiveRoomDialog.tsx`

```typescript
/**
 * Dialog for creating a new live room
 * ENHANCES EXISTING FILE with backend integration
 */

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useCreateLiveRoom } from '@/hooks/useLiveRoom';
import { useState } from 'react';
import { Plus } from 'lucide-react';

export function CreateLiveRoomDialog() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [accessLevel, setAccessLevel] = useState<'public' | 'group'>('public');
  const [price, setPrice] = useState('');

  const { mutate: createRoom, isPending } = useCreateLiveRoom();

  const handleSubmit = () => {
    createRoom({
      title,
      access_level: accessLevel,
      metadata: {
        description: description || undefined,
        price: accessLevel === 'group' && price ? parseFloat(price) : undefined,
      },
    }, {
      onSuccess: () => {
        setOpen(false);
        // Reset form
        setTitle('');
        setDescription('');
        setAccessLevel('public');
        setPrice('');
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="w-4 h-4 mr-2" />
          Create Live Room
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create Live Room</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label htmlFor="title">Title *</Label>
            <Input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="My Live Session"
            />
          </div>

          <div>
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What's this session about?"
              rows={3}
            />
          </div>

          <div>
            <Label>Access Level *</Label>
            <RadioGroup value={accessLevel} onValueChange={(v) => setAccessLevel(v as any)}>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="public" id="public" />
                <Label htmlFor="public">Free (Public)</Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="group" id="group" />
                <Label htmlFor="group">Paid (Group)</Label>
              </div>
            </RadioGroup>
          </div>

          {accessLevel === 'group' && (
            <div>
              <Label htmlFor="price">Price (USD) *</Label>
              <Input
                id="price"
                type="number"
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="9.99"
              />
            </div>
          )}

          <Button
            onClick={handleSubmit}
            disabled={isPending || !title || (accessLevel === 'group' && !price)}
            className="w-full"
          >
            {isPending ? 'Creating...' : 'Create Room'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

### 7.3 DailyVideoRoom Component

**File:** `temp_vitana_v1/src/components/liverooms/DailyVideoRoom.tsx`

```typescript
/**
 * Daily.co video room component
 * Renders embedded video player
 */

import { useEffect, useRef } from 'react';
import DailyIframe, { DailyCall } from '@daily-co/daily-js';

interface DailyVideoRoomProps {
  roomUrl: string;
  onJoined?: () => void;
  onLeft?: () => void;
  onError?: (error: string) => void;
}

export function DailyVideoRoom({ roomUrl, onJoined, onLeft, onError }: DailyVideoRoomProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const callRef = useRef<DailyCall | null>(null);

  useEffect(() => {
    if (!containerRef.current || !roomUrl) return;

    // Create Daily call object
    const call = DailyIframe.createFrame(containerRef.current, {
      showLeaveButton: true,
      iframeStyle: {
        width: '100%',
        height: '100%',
        border: '0',
        borderRadius: '8px',
      },
    });

    callRef.current = call;

    // Event listeners
    call.on('joined-meeting', () => {
      console.log('[Daily] Joined meeting');
      onJoined?.();
    });

    call.on('left-meeting', () => {
      console.log('[Daily] Left meeting');
      onLeft?.();
    });

    call.on('error', (error) => {
      console.error('[Daily] Error:', error);
      onError?.(error.errorMsg || 'Unknown error');
    });

    // Join the room
    call.join({ url: roomUrl }).catch((err) => {
      console.error('[Daily] Failed to join:', err);
      onError?.('Failed to join video room');
    });

    // Cleanup
    return () => {
      if (callRef.current) {
        callRef.current.destroy();
        callRef.current = null;
      }
    };
  }, [roomUrl, onJoined, onLeft, onError]);

  return (
    <div ref={containerRef} className="w-full h-full min-h-[600px] bg-black rounded-lg" />
  );
}
```

### 7.4 PurchaseRoomAccessDialog Component

**File:** `temp_vitana_v1/src/components/liverooms/PurchaseRoomAccessDialog.tsx`

```typescript
/**
 * Stripe payment dialog for purchasing room access
 */

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useStripePayment } from '@/hooks/useStripePayment';
import { LiveRoom } from '@/services/liveRoomService';
import { Elements } from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js';
import { StripePaymentForm } from '@/components/billing/StripePaymentForm';

// Load Stripe publishable key from env
const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY);

interface PurchaseRoomAccessDialogProps {
  room: LiveRoom;
  userId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function PurchaseRoomAccessDialog({
  room,
  userId,
  open,
  onOpenChange,
  onSuccess,
}: PurchaseRoomAccessDialogProps) {
  const { initiatePurchase, clientSecret, amount, isPending } = useStripePayment(room.id, userId);

  const handlePurchase = () => {
    initiatePurchase();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Purchase Access: {room.title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="text-center">
            <div className="text-3xl font-bold">${amount?.toFixed(2) || room.metadata.price?.toFixed(2)}</div>
            <p className="text-sm text-muted-foreground">One-time access fee</p>
          </div>

          {!clientSecret && (
            <Button onClick={handlePurchase} disabled={isPending} className="w-full">
              {isPending ? 'Processing...' : 'Continue to Payment'}
            </Button>
          )}

          {clientSecret && (
            <Elements stripe={stripePromise} options={{ clientSecret }}>
              <StripePaymentForm
                onSuccess={() => {
                  onOpenChange(false);
                  onSuccess();
                }}
              />
            </Elements>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

### 7.5 StripePaymentForm Component

**File:** `temp_vitana_v1/src/components/billing/StripePaymentForm.tsx`

```typescript
/**
 * Stripe Elements payment form
 */

import { useState } from 'react';
import { useStripe, useElements, PaymentElement } from '@stripe/react-stripe-js';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';

interface StripePaymentFormProps {
  onSuccess: () => void;
}

export function StripePaymentForm({ onSuccess }: StripePaymentFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const { toast } = useToast();
  const [isProcessing, setIsProcessing] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!stripe || !elements) {
      return;
    }

    setIsProcessing(true);

    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: window.location.origin + '/checkout/success',
      },
      redirect: 'if_required', // Handle success in-app
    });

    if (error) {
      toast({
        title: 'Payment failed',
        description: error.message,
        variant: 'destructive',
      });
      setIsProcessing(false);
    } else {
      toast({ title: 'Payment successful!' });
      onSuccess();
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <PaymentElement />
      <Button type="submit" disabled={!stripe || isProcessing} className="w-full">
        {isProcessing ? 'Processing...' : 'Pay Now'}
      </Button>
    </form>
  );
}
```

---

## 8. Environment Variables

Add to `temp_vitana_v1/.env`:

```env
# Gateway API Base URL
VITE_GATEWAY_BASE=https://gateway-q74ibpv6ia-uc.a.run.app

# Stripe Publishable Key (NOT secret key!)
VITE_STRIPE_PUBLISHABLE_KEY=pk_live_xxxxx  # Get from Stripe dashboard
```

---

## 9. Implementation Steps (Phased Rollout)

### Phase 1: Setup & API Integration (Day 1)
1. ✅ Install dependencies:
   ```bash
   cd temp_vitana_v1
   npm install @stripe/react-stripe-js @stripe/stripe-js @daily-co/daily-js @daily-co/daily-react
   ```

2. ✅ Create service layer (`liveRoomService.ts`)

3. ✅ Create React Query hooks (`useLiveRoom.ts`, `useLiveRoomList.ts`, etc.)

4. ✅ Add environment variables to `.env`

5. ✅ Test API integration with console logs

### Phase 2: UI Components - Browse & Create (Day 2)
1. ✅ Build `LiveRoomCard` component

2. ✅ Build `LiveRoomGrid` component

3. ✅ Enhance `CreateLiveRoomDialog` with backend integration

4. ✅ Update `/community/live-rooms` page to use new components

5. ✅ Test: Create free room → See in grid

### Phase 3: Host Flow - Start & Video (Day 3)
1. ✅ Build `LiveRoomHostControls` component

2. ✅ Build `DailyVideoRoom` component

3. ✅ Integrate Daily.co video into room viewer

4. ✅ Test: Create room → Start → Video appears

### Phase 4: Payment Flow (Day 4)
1. ✅ Build `PurchaseRoomAccessDialog` component

2. ✅ Build `StripePaymentForm` component

3. ✅ Wire Stripe Elements to purchase flow

4. ✅ Test: Create paid room → Purchase → Join

5. ✅ Test webhook (use Stripe CLI for local testing):
   ```bash
   stripe listen --forward-to https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/live/stripe/webhook
   ```

### Phase 5: Viewer Flow & Polish (Day 5)
1. ✅ Add access control checks before joining

2. ✅ Build participant list component

3. ✅ Build post-session summary component

4. ✅ Add loading states, error handling

5. ✅ Test full flows end-to-end

### Phase 6: Testing & Launch (Day 6)
1. ✅ Manual QA testing

2. ✅ Cross-browser testing

3. ✅ Mobile responsive testing

4. ✅ Load testing with multiple participants

5. ✅ Production deployment

---

## 10. Testing Checklist

### Host Flow
- [ ] Create free public room
- [ ] Create paid group room
- [ ] Start room → Status changes to "live"
- [ ] Daily.co video loads correctly
- [ ] End room → Status changes to "ended"
- [ ] Room summary displays correctly

### Viewer Flow (Free Room)
- [ ] Browse live rooms
- [ ] Join free room without payment
- [ ] Video loads correctly
- [ ] Leave room

### Viewer Flow (Paid Room)
- [ ] Browse paid rooms → Price displayed
- [ ] Click join → Payment dialog opens
- [ ] Complete Stripe payment
- [ ] Webhook grants access
- [ ] Automatically join room after payment
- [ ] Video loads correctly

### Error Cases
- [ ] Join paid room without payment → Access denied
- [ ] Payment fails → Error message displayed
- [ ] Network error → Retry option
- [ ] Daily.co room creation fails → Fallback message

### Edge Cases
- [ ] Multiple users in same room
- [ ] Host leaves room (room continues)
- [ ] Participant leaves and rejoins
- [ ] Payment refund → Access revoked (manual test via Stripe dashboard)

---

## 11. Future Enhancements (Post-VTID-01230)

- **Recording:** Record sessions and make replays available
- **Chat:** In-room text chat
- **Reactions:** Emoji reactions during live sessions
- **Screen Share:** Host screen sharing
- **Breakout Rooms:** Smaller discussion groups
- **Scheduled Reminders:** Email/push notifications before room starts
- **Analytics:** Track views, engagement, revenue per room

---

## 12. Success Criteria

VTID-01230 is complete when:

✅ **1. Users can create free and paid live rooms**
✅ **2. Hosts can start rooms and initiate Daily.co video**
✅ **3. Viewers can browse and join free rooms instantly**
✅ **4. Viewers can purchase access to paid rooms via Stripe**
✅ **5. Stripe webhook grants access after successful payment**
✅ **6. Daily.co video works smoothly for all participants**
✅ **7. Rate limiting prevents abuse (5 room creations/15min, 10 purchases/15min)**
✅ **8. UI is responsive on desktop and mobile**
✅ **9. All error states have user-friendly messages**
✅ **10. End-to-end flow tested with real payments (Stripe test mode)**

---

**END OF SPEC**
