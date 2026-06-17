import type { WebSocket } from '@fastify/websocket';
import type { WsEvent } from '@tractus/shared';

const clients = new Set<WebSocket>();

export function addClient(socket: WebSocket): void {
  clients.add(socket);
  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
}

/** Broadcast a typed event to every connected dashboard client. */
export function broadcast(event: WsEvent): void {
  const payload = JSON.stringify(event);
  for (const socket of clients) {
    if (socket.readyState === socket.OPEN) {
      socket.send(payload);
    }
  }
}
