/**
 * VTID-01228: Live Room Session Management Types
 *
 * TypeScript types for the permanent room model, sessions, state machine,
 * join gate, and all related entities.
 */

// =============================================================================
// Room & Session Status
// =============================================================================

/** Status values for live_rooms (permanent room) */
export const ROOM_STATUSES = ['idle', 'scheduled', 'lobby', 'live', 'ended', 'cancelled'] as const;
export type RoomStatus = typeof ROOM_STATUSES[number];

/** Status values for live_room_sessions (per go-live) */
export const SESSION_STATUSES = ['scheduled', 'lobby', 'live', 'ended', 'cancelled'] as const;
export type SessionStatus = typeof SESSION_STATUSES[number];

/** Access level for sessions */
export const ACCESS_LEVELS = ['public', 'group'] as const;
export type AccessLevel = typeof ACCESS_LEVELS[number];

/** Lobby status for attendance */
export const LOBBY_STATUSES = ['waiting', 'admitted', 'rejected'] as const;
export type LobbyStatus = typeof LOBBY_STATUSES[number];

/** Participant role */
export const PARTICIPANT_ROLES = ['host', 'guest'] as const;
export type ParticipantRole = typeof PARTICIPANT_ROLES[number];

/** Refund status for access grants */
export const REFUND_STATUSES = ['pending', 'succeeded', 'failed'] as const;
export type RefundStatus = typeof REFUND_STATUSES[number];

// =============================================================================
// Database Row Types
// =============================================================================

/** live_rooms table row (permanent room) */
export interface LiveRoom {
  id: string;
  tenant_id: string;
  title: string;
  host_user_id: string;
  topic_keys: string[];
  starts_at: string;
  ends_at: string | null;
  status: RoomStatus;
  access_level: AccessLevel;
  metadata: Record<string, unknown>;
  // Permanent room identity
  room_name: string | null;
  room_slug: string | null;
  current_session_id: string | null;
  cover_image_url: string | null;
  description: string | null;
  host_present: boolean;
  created_at: string;
  updated_at: string;
}

/** live_room_sessions table row */
export interface LiveRoomSession {
  id: string;
  tenant_id: string;
  room_id: string;
  session_title: string | null;
  topic_keys: string[];
  status: SessionStatus;
  access_level: AccessLevel;
  starts_at: string;
  ends_at: string | null;
  lobby_open_at: string | null;
  host_present: boolean;
  auto_admit: boolean;
  lobby_buffer_minutes: number;
  max_participants: number;
  metadata: Record<string, unknown>;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

/** live_room_attendance row (extended) */
export interface LiveRoomAttendance {
  id: string;
  tenant_id: string;
  live_room_id: string;
  session_id: string | null;
  user_id: string;
  role: ParticipantRole;
  lobby_status: LobbyStatus | null;
  is_banned: boolean;
  joined_at: string;
  left_at: string | null;
  disconnected_at: string | null;
}

/** live_room_access_grants row (extended) */
export interface LiveRoomAccessGrant {
  id: string;
  tenant_id: string;
  live_room_id: string;
  session_id: string | null;
  user_id: string;
  access_type: string;
  stripe_payment_intent_id: string | null;
  is_valid: boolean;
  refund_status: RefundStatus | null;
  refund_id: string | null;
  created_at: string;
}

// =============================================================================
// State Machine Types
// =============================================================================

/** XState machine context */
export interface RoomMachineContext {
  roomId: string;
  sessionId: string | null;
  hostUserId: string;
  startsAt: string;
  endsAt: string | null;
  maxParticipants: number;
  autoAdmit: boolean;
  lobbyBufferMinutes: number;
  accessLevel: AccessLevel;
}

/** State machine events */
export type RoomMachineEvent =
  | { type: 'GO_LIVE'; userId: string; startsAt: string; endsAt?: string; autoAdmit: boolean; idempotencyKey?: string }
  | { type: 'OPEN_LOBBY'; userId: string }
  | { type: 'START'; userId: string }
  | { type: 'END'; userId: string; idempotencyKey?: string }
  | { type: 'CANCEL'; userId: string; idempotencyKey?: string }
  | { type: 'RESET' }
  | { type: 'TIMEOUT' };

// =============================================================================
// Join Gate Types
// =============================================================================

/** Reasons a join can be rejected */
export const JOIN_REJECTION_REASONS = [
  'ROOM_NOT_ACTIVE',
  'ROOM_ENDED',
  'TOO_EARLY',
  'PAYMENT_REQUIRED',
  'BANNED',
  'ROOM_FULL',
  'HOST_NOT_PRESENT'
] as const;
export type JoinRejectionReason = typeof JOIN_REJECTION_REASONS[number];

/** Result of evaluateJoinGate */
export interface JoinGateResult {
  allowed: boolean;
  /** Role if allowed */
  role?: ParticipantRole;
  /** Lobby status if allowed */
  lobbyStatus?: LobbyStatus;
  /** Whether lobby is bypassed (paid users) */
  bypassLobby?: boolean;
  /** Rejection reason if not allowed */
  reason?: JoinRejectionReason;
  /** Human-readable message */
  message?: string;
}

// =============================================================================
// Session Snapshot (GET /state) Response
// =============================================================================

export interface RoomStateSnapshot {
  room: {
    id: string;
    status: RoomStatus;
    room_name: string | null;
    room_slug: string | null;
    host_user_id: string;
    current_session_id: string | null;
  };
  session: {
    id: string;
    status: SessionStatus;
    session_title: string | null;
    starts_at: string;
    ends_at: string | null;
    lobby_open_at: string | null;
    host_present: boolean;
    access_level: AccessLevel;
    auto_admit: boolean;
    max_participants: number;
  } | null;
  counts: {
    lobby_waiting: number;
    in_room: number;
  };
  viewer: {
    role: ParticipantRole | null;
    lobby_status: LobbyStatus | null;
    is_banned: boolean;
    has_access_grant: boolean;
  } | null;
}

// =============================================================================
// API Request/Response Types
// =============================================================================

/** POST /rooms/:id/sessions — create a new session ("Go Live") */
export interface CreateSessionPayload {
  session_title?: string;
  topic_keys?: string[];
  starts_at: string;
  ends_at?: string;
  access_level?: AccessLevel;
  auto_admit?: boolean;
  lobby_buffer_minutes?: number;
  max_participants?: number;
  metadata?: Record<string, unknown>;
  idempotency_key?: string;
}

/** PATCH /rooms/:id — update permanent room */
export interface UpdateRoomPayload {
  room_name?: string;
  room_slug?: string;
  cover_image_url?: string;
  description?: string;
}

/** Transition event from client */
export interface TransitionPayload {
  idempotency_key?: string;
}

/** Lobby action (admit/reject/kick/ban) */
export interface UserActionPayload {
  user_id: string;
}

/** Room counts from RPC */
export interface RoomCounts {
  lobby_waiting: number;
  in_room: number;
  max_participants: number;
  host_present: boolean;
}
