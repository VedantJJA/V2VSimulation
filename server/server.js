import { WebSocketServer, WebSocket } from 'ws';
import os from 'os';

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

/** @type {Map<WebSocket, { id: string, name: string, color: number|string, slot: number, state: object|null }>} */
const clients = new Map();
let nextPlayerIndex = 1;
const availableSlots = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

function getNextSlot() {
  for (let i = 0; i < 16; i++) {
    if (availableSlots.has(i)) {
      availableSlots.delete(i);
      return i;
    }
  }
  return 0;
}

function releaseSlot(slot) {
  if (slot >= 0) availableSlots.add(slot);
}

function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push(net.address);
      }
    }
  }
  return addresses;
}

console.log('='.repeat(65));
console.log(`🏎️  V2V MULTIPLAYER WEBSOCKET SERVER ACTIVE`);
console.log(`📡  Local URL : ws://localhost:${PORT}`);
const ips = getLocalIpAddresses();
if (ips.length > 0) {
  for (const ip of ips) {
    console.log(`🌐  LAN URL   : ws://${ip}:${PORT}  (share with friends on same Wi-Fi)`);
  }
} else {
  console.log(`🌐  LAN URL   : Check 'ipconfig' for your IPv4 address`);
}
console.log('='.repeat(65));

wss.on('connection', (ws, req) => {
  const playerId = `player_${nextPlayerIndex++}`;
  const slot = getNextSlot();
  const clientInfo = {
    id: playerId,
    name: `Driver ${playerId.split('_')[1]}`,
    color: 0xc23b2e,
    slot,
    state: null,
  };
  clients.set(ws, clientInfo);

  console.log(`[+] Player connected: ${clientInfo.name} (${playerId}) | Assigned Grid Slot: P${slot + 1} | Online: ${clients.size}`);

  // Send welcome message to newly connected client with current players list
  const existingPlayers = [];
  for (const [clientWs, player] of clients.entries()) {
    if (clientWs !== ws) {
      existingPlayers.push({
        id: player.id,
        name: player.name,
        color: player.color,
        slot: player.slot,
        state: player.state,
      });
    }
  }

  ws.send(
    JSON.stringify({
      type: 'welcome',
      id: playerId,
      slot,
      players: existingPlayers,
    })
  );

  // Notify other clients about the new player
  broadcastExcept(ws, {
    type: 'player_joined',
    player: {
      id: playerId,
      name: clientInfo.name,
      color: clientInfo.color,
      slot: clientInfo.slot,
    },
  });

  // Handle incoming messages
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'init') {
        if (msg.name) clientInfo.name = String(msg.name).slice(0, 24);
        if (msg.color) clientInfo.color = msg.color;
        // Broadcast profile update
        broadcastExcept(ws, {
          type: 'player_updated',
          player: {
            id: playerId,
            name: clientInfo.name,
            color: clientInfo.color,
            slot: clientInfo.slot,
          },
        });
      } else if (msg.type === 'state') {
        clientInfo.state = msg.state;
        // Broadcast high-frequency telemetry update to all other connected peers
        broadcastExcept(ws, {
          type: 'player_state',
          id: playerId,
          state: msg.state,
        });
      } else if (msg.type === 'chat') {
        broadcastAll({
          type: 'chat',
          id: playerId,
          name: clientInfo.name,
          text: String(msg.text).slice(0, 140),
          time: Date.now(),
        });
      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', time: msg.time }));
      }
    } catch (err) {
      console.error(`[!] Error parsing message from ${playerId}:`, err.message);
    }
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    if (info) {
      releaseSlot(info.slot);
      clients.delete(ws);
      console.log(`[-] Player disconnected: ${info.name} (${info.id}) | Online: ${clients.size}`);
      broadcastAll({
        type: 'player_left',
        id: info.id,
      });
    }
  });

  ws.on('error', (err) => {
    console.error(`[!] WebSocket error for ${playerId}:`, err.message);
  });
});

function broadcastExcept(excludeWs, payload) {
  const json = JSON.stringify(payload);
  for (const [ws] of clients.entries()) {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
      ws.send(json);
    }
  }
}

function broadcastAll(payload) {
  const json = JSON.stringify(payload);
  for (const [ws] of clients.entries()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(json);
    }
  }
}
