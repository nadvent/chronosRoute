import type { WsConnectionStatus, WsInboundEvent } from '../types/chronos';

export interface TelemetryWsCallbacks {
  onStatusChange: (status: WsConnectionStatus) => void;
  onEvent: (event: WsInboundEvent) => void;
}

const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

/**
 * Native WebSocket client for `/ws/telemetry` with full-jitter exponential backoff (`500ms`..`10s`).
 */
export class ChronosTelemetryWsClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private attempt = 0;
  private intentionallyClosed = false;
  private callbacks: TelemetryWsCallbacks;

  constructor(callbacks: TelemetryWsCallbacks) {
    this.callbacks = callbacks;
  }

  public connect(): void {
    this.intentionallyClosed = false;
    this.clearReconnectTimer();
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/telemetry`;
    this.callbacks.onStatusChange(this.attempt > 0 ? 'reconnecting' : 'connecting');

    try {
      const ws = new WebSocket(wsUrl);
      this.socket = ws;

      ws.onopen = () => {
        this.attempt = 0;
        this.callbacks.onStatusChange('connected');
      };

      ws.onmessage = (msg) => {
        if (typeof msg.data !== 'string') {
          return;
        }
        try {
          const parsed = JSON.parse(msg.data) as WsInboundEvent;
          if (parsed && typeof parsed.type === 'string') {
            this.callbacks.onEvent(parsed);
          }
        } catch {
          // Ignore malformed keepalive or non-JSON frames
        }
      };

      ws.onerror = () => {
        // `onclose` always follows `onerror`, which handles scheduling reconnection
      };

      ws.onclose = () => {
        this.socket = null;
        if (this.intentionallyClosed) {
          this.callbacks.onStatusChange('disconnected');
          return;
        }
        this.scheduleReconnect();
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  public disconnect(): void {
    this.intentionallyClosed = true;
    this.attempt = 0;
    this.clearReconnectTimer();
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // Ignore close failures
      }
      this.socket = null;
    }
    this.callbacks.onStatusChange('disconnected');
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.min(this.attempt, 6));
    const jitteredDelay = Math.max(BASE_BACKOFF_MS, Math.round(Math.random() * ceiling));
    this.attempt += 1;
    this.callbacks.onStatusChange('reconnecting');
    this.reconnectTimer = window.setTimeout(() => {
      if (!this.intentionallyClosed) {
        this.connect();
      }
    }, jitteredDelay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
