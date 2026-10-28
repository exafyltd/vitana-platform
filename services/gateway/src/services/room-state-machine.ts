/**
 * VTID-01228: Room State Machine (XState v5)
 *
 * Defines the cyclical state machine for live room sessions.
 * Gateway is stateless on Cloud Run — this machine is "rehydrated" from DB
 * on each request: load current status → create actor from snapshot →
 * evaluate transition → persist new status.
 *
 * IMPORTANT: Host authorization (isHost) is NOT enforced in this machine.
 * It is enforced at the Gateway layer (RoomSessionManager) before events
 * are sent to the machine. The machine only handles path-selection logic
 * (which state to go to based on event data).
 *
 * State flow:
 *   idle → scheduled → lobby → live → ended → idle (full cycle)
 *   idle → live (instant go-live with auto_admit)
 *   idle → lobby → live (instant go-live without auto_admit)
 *   scheduled/lobby → cancelled → idle
 */

import { setup, createActor, type SnapshotFrom } from 'xstate';
import type { RoomMachineContext, RoomMachineEvent, RoomStatus } from '../types/live-room';

// =============================================================================
// Machine Definition
// =============================================================================

export const roomMachine = setup({
  types: {
    context: {} as RoomMachineContext,
    events: {} as RoomMachineEvent,
  },
  guards: {
    /**
     * Path-selection guards for GO_LIVE event.
     * NOTE: isHost check is NOT in the machine — it's enforced at the
     * Gateway layer (RoomSessionManager) before sending events.
     * The machine only decides WHICH state to transition to.
     */
    isInstantWithAutoAdmit: ({ event }) => {
      if (event.type === 'GO_LIVE') {
        const startsAt = new Date(event.startsAt).getTime();
        return startsAt <= Date.now() && event.autoAdmit;
      }
      return false;
    },
    isInstantWithLobby: ({ event }) => {
      if (event.type === 'GO_LIVE') {
        const startsAt = new Date(event.startsAt).getTime();
        return startsAt <= Date.now() && !event.autoAdmit;
      }
      return false;
    },
    isScheduled: ({ event }) => {
      if (event.type === 'GO_LIVE') {
        const startsAt = new Date(event.startsAt).getTime();
        return startsAt > Date.now();
      }
      return false;
    },
  },
}).createMachine({
  id: 'liveRoom',
  initial: 'idle',
  context: {
    roomId: '',
    sessionId: null,
    hostUserId: '',
    startsAt: '',
    endsAt: null,
    maxParticipants: 100,
    autoAdmit: true,
    lobbyBufferMinutes: 15,
    accessLevel: 'public',
  },
  states: {
    idle: {
      on: {
        GO_LIVE: [
          {
            guard: { type: 'isInstantWithAutoAdmit' },
            target: 'live',
          },
          {
            guard: { type: 'isInstantWithLobby' },
            target: 'lobby',
          },
          {
            guard: { type: 'isScheduled' },
            target: 'scheduled',
          },
        ],
      },
    },
    scheduled: {
      on: {
        OPEN_LOBBY: {
          target: 'lobby',
        },
        CANCEL: {
          target: 'cancelled',
        },
      },
    },
    lobby: {
      on: {
        START: {
          target: 'live',
        },
        CANCEL: {
          target: 'cancelled',
        },
      },
    },
    live: {
      on: {
        END: {
          target: 'ended',
        },
        TIMEOUT: {
          target: 'ended',
        },
      },
    },
    ended: {
      on: {
        RESET: {
          target: 'idle',
        },
      },
    },
    cancelled: {
      on: {
        RESET: {
          target: 'idle',
        },
      },
    },
  },
});

// =============================================================================
// Transition Helper
// =============================================================================

/**
 * Evaluate a state transition without persisting.
 * Used by RoomSessionManager to determine new state before calling DB RPCs.
 *
 * @param currentStatus - Current room status from DB
 * @param event - The event to send
 * @param context - Machine context (room details)
 * @returns New status if transition is valid, null if rejected
 */
export function evaluateTransition(
  currentStatus: RoomStatus,
  event: RoomMachineEvent,
  context: RoomMachineContext
): RoomStatus | null {
  // Create a snapshot at the current state
  const actor = createActor(roomMachine, {
    snapshot: roomMachine.resolveState({
      value: currentStatus,
      context,
    }),
  });

  actor.start();
  actor.send(event);

  const newSnapshot = actor.getSnapshot();
  const newStatus = newSnapshot.value as RoomStatus;
  actor.stop();

  // If state didn't change, the event was rejected
  if (newStatus === currentStatus) {
    return null;
  }

  return newStatus;
}

/**
 * Check if a transition would be valid without executing it.
 */
export function canTransition(
  currentStatus: RoomStatus,
  event: RoomMachineEvent,
  context: RoomMachineContext
): boolean {
  return evaluateTransition(currentStatus, event, context) !== null;
}

export type RoomMachineSnapshot = SnapshotFrom<typeof roomMachine>;
