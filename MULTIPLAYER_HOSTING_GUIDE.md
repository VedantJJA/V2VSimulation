# 🏎️ V2V Simulation — Multiplayer Hosting & Controller Guide

This guide explains how to host, join, and play real-time multiplayer sessions on the Silverstone Circuit (or any custom map), as well as gamepad controller setup.

---

## 1. How to Host the Multiplayer Server

### Step 1: Start the WebSocket Server
Open your terminal in the project directory:
```bash
npm run server
```
*(Or directly with Node: `node server/server.js`)*

You will see the startup banner:
```
=================================================================
🏎️  V2V MULTIPLAYER WEBSOCKET SERVER ACTIVE
📡  Local URL : ws://localhost:8080
🌐  LAN URL   : ws://192.168.1.xxx:8080  (share with friends on same Wi-Fi)
=================================================================
```

### Step 2: Launch the Game in Browser
1. Start the Vite dev server (if not already running):
   ```bash
   npm run dev
   ```
2. Open `http://localhost:5173/` in your browser.
3. On the startup screen, click **🌐 Create / Host Server**.
4. Confirm your Driver Name and Car Paint Color, then click **🚀 Launch as Host**.
5. You are now in the Silverstone Circuit waiting on the starting grid!

---

## 2. How Friends Can Join

### Option A: Multiple Players on the Same Computer (Testing)
1. Open a **second browser tab or window** at `http://localhost:5173/`.
2. Click **🔗 Join Multiplayer Server**.
3. Keep `ws://localhost:8080` as the Server URL, choose a different Driver Name (e.g., *Racer 2*) and Car Color.
4. Click **🏎️ Connect & Join**.
5. Both cars will spawn side-by-side on the Hamilton Straight, with real-time synchronized movement, steering, wheel spinning, brake lights, overhead name tags, and radar blips!

---

### Option B: Friends on the Same Wi-Fi / LAN
1. On the host computer, run `ipconfig` in PowerShell / Command Prompt and find your **IPv4 Address** (e.g. `192.168.1.150`).
2. Ensure your Vite dev server is exposed to the local network:
   ```bash
   npx vite --host
   ```
3. Your friend opens `http://192.168.1.150:5173/` in their web browser (PC, Mac, laptop, or mobile).
4. They click **🔗 Join Multiplayer Server**, enter:
   `ws://192.168.1.150:8080`
5. Click **🏎️ Connect & Join** to hit the track together!

---

### Option C: Friends Over the Internet
To play over the internet without configuring router port forwarding, you can use [Ngrok](https://ngrok.com/):
1. In a terminal, run:
   ```bash
   ngrok tcp 8080
   ```
2. Ngrok will output a forwarding address like: `tcp://4.tcp.ngrok.io:12345`.
3. In the game, replace `tcp://` with `ws://`:
   `ws://4.tcp.ngrok.io:12345`
4. Friends can join using this URL!

---

## 3. Gamepad & Controller Support

The simulation features native plug-and-play support for Xbox, PlayStation (DualShock/DualSense), and generic USB/Bluetooth gamepads:

| Action | Controller Mapping | Keyboard Equivalent |
|---|---|---|
| **Steering** | Left Thumbstick X (or D-Pad Left/Right) | `A` / `D` or `←` / `→` |
| **Throttle / Accelerate** | Right Trigger (`RT` / `R2`) or `Button A` (`✕`) | `W` or `↑` |
| **Brake / Reverse** | Left Trigger (`LT` / `L2`) or `Button B` (`◯`) | `S` or `↓` |
| **Handbrake** | `Button X` (`□`) or `RB` (`R1`) | `Space` |
| **Toggle Auto-Drive** | `Button Y` (`△`) or `RB` | `Control Panel` toggle |
| **Cycle Camera (Cockpit / Chase)** | `Button LB` (`L1`) | `V` |
| **Track Reset / Respawn** | `Back / View / Select` or `Start` | Reload |

*Haptic vibration (dual-rumble) is automatically triggered on acceleration, hard braking, and crashes.*

---

## 4. Map Editor Canvas Expansion

When creating or editing large tracks:
- Use the **Canvas: [ 500m | 1000m | 2000m | 3000m | 5000m ]** selector on the editor toolbar to dynamically expand the ground plane and grid.
- Click **⛶ Auto-Fit** to instantly resize the ground canvas to perfectly encircle your track boundaries.
