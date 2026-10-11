import { io, Socket } from 'socket.io-client';
import type { MessageRole } from './api/conversations';

export interface RealtimeMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  clientMessageId: string | null;
  createdAt: string;
  senderId?: string | null;
}

export interface RealtimeConversationEvent {
  conversationId: string;
  status: 'ACTIVE' | 'WAITING_FOR_HUMAN' | 'HUMAN_ACTIVE' | 'RESOLVED';
  assignedAgentId: string | null;
  version?: number;
  actorId?: string | null;
  occurredAt: string;
}

export interface RealtimeEscalation extends RealtimeConversationEvent {
  escalatedAt: string;
  escalationReason: string | null;
  escalatedOffHours: boolean;
}

export interface RealtimeQueueUpdate {
  workspaceId: string;
  conversationId: string;
  status: 'ACTIVE' | 'WAITING_FOR_HUMAN' | 'HUMAN_ACTIVE' | 'RESOLVED';
}

export interface JoinAck {
  ok: boolean;
  error?: string;
  room?: string;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api/v1';
const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || API_BASE.replace(/\/api\/v1\/?$/, '');

let socketInstance: Socket | null = null;
let currentToken: string | null = null;

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('assistiq_token');
}

/** Get or initialize the Socket.IO client singleton. */
export function getSocket(overrideToken?: string): Socket {
  const token = overrideToken || getToken();

  if (socketInstance) {
    if (token && token !== currentToken) {
      currentToken = token;
      socketInstance.auth = { token };
      if (!socketInstance.connected) {
        socketInstance.connect();
      }
    }
    return socketInstance;
  }

  currentToken = token;
  socketInstance = io(SOCKET_URL, {
    autoConnect: false,
    transports: ['websocket', 'polling'],
    auth: {
      token: token || '',
    },
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
  });

  return socketInstance;
}

/** Room format helpers (§15.2). */
export const workspaceQueueRoom = (workspaceId: string): string =>
  `workspace:${workspaceId}:queue`;

export const conversationRoom = (conversationId: string): string =>
  `conversation:${conversationId}`;

/** Join a realtime room with acknowledgement. */
export function joinRoom(socket: Socket, room: string): Promise<JoinAck> {
  return new Promise((resolve) => {
    if (!socket.connected) {
      socket.connect();
    }
    socket.emit('room:join', { room }, (response: JoinAck) => {
      resolve(response || { ok: false, error: 'NO_RESPONSE' });
    });
  });
}

/** Leave a realtime room with acknowledgement. */
export function leaveRoom(socket: Socket, room: string): Promise<JoinAck> {
  return new Promise((resolve) => {
    if (!socket.connected) {
      resolve({ ok: true, room });
      return;
    }
    socket.emit('room:leave', { room }, (response: JoinAck) => {
      resolve(response || { ok: true, room });
    });
  });
}

/** Disconnect the singleton socket (e.g. on logout). */
export function disconnectSocket(): void {
  if (socketInstance) {
    socketInstance.disconnect();
    socketInstance = null;
    currentToken = null;
  }
}
