# Bhejo - P2P File Transfer

A peer-to-peer file transfer system that allows you to send files directly between browsers using WebRTC. No account required, no file storage, completely private.

## Features

- ✅ **Direct P2P Transfer**: Files are sent directly between browsers using WebRTC
- ✅ **No Storage**: Files never touch a server - only signaling messages go through
- ✅ **No Account Required**: Just share a 6-digit code or scan QR code
- ✅ **Encrypted**: WebRTC automatically encrypts all data (DTLS)
- ✅ **Large Files**: Supports files of any size with chunking
- ✅ **Progress Tracking**: Real-time transfer progress and speed
- ✅ **Robust Transfer**: Chunk sequence numbers, integrity verification, and error detection
- ✅ **Modern UI**: Beautiful dark theme with purple/pink accents and grainy textures
- ✅ **QR Code Sharing**: Scan QR code to automatically join and receive files
- ✅ **Room Expiration**: Automatic cleanup of expired rooms (10 minutes)


## Looks something like this when using 
![First successful transfer](https://github.com/user-attachments/assets/9c4c4ab8-85ca-47ef-b27d-8d03d676749d)

## Requirements

1. **Node.js** (v16 or higher) - [Download](https://nodejs.org/)
2. **npm** (comes with Node.js)
3. **Modern Web Browser** with WebRTC support (Chrome, Firefox, Safari, Edge)

## Quick Start

1. **Install dependencies:**
```bash
npm install
```

2. **Start the server:**
```bash
npm start
```

3. **Open in browser:**
```
http://localhost:3000
```

4. **For network access:**
   - Use the IP address shown in console (e.g., `http://192.168.1.2:3000`)
   - QR codes automatically use the network IP

## How It Works

1. **Sender**: Select files and get a 6-digit room code + QR code
2. **Receiver**: Enter the code or scan the QR code
3. **Connection**: WebRTC establishes a direct peer-to-peer connection
4. **Transfer**: Files are chunked and sent directly over the encrypted data channel
5. **Download**: Receiver automatically downloads the files when complete

## Usage

### Sending Files

1. Click "Send" mode (default)
2. Drag & drop files or click to select
3. Share the 6-digit code or QR code with the receiver
4. Wait for receiver to join
5. Files transfer automatically when connection is established

### Receiving Files

1. Click "Receive" mode
2. Enter the 6-digit room code OR scan the QR code
3. Wait for connection to establish
4. Files download automatically when transfer completes

## Configuration

### Environment Variables (Optional)

Create a `.env` file:
```env
PORT=3000
NODE_ENV=development
ROOM_EXPIRY=600000
MAX_ROOM_SIZE=2
```

### STUN/TURN Servers

Default uses Google's public STUN servers. For different networks, configure TURN server in `public/webrtc.js`:

```javascript
const RTC_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        {
            urls: 'turn:your-turn-server.com:3478',
            username: 'your-username',
            credential: 'your-password'
        }
    ]
};
```

## Troubleshooting

### Server Won't Start
- Port in use: Change `PORT` in `.env` or kill the process using port 3000
- Node.js not found: Install from [nodejs.org](https://nodejs.org/)
- Dependencies missing: Run `npm install`

### Connection Fails
- Ensure both devices are on the same network (for local use)
- Check browser console for errors
- Verify firewall allows WebRTC traffic
- For different networks: Configure TURN server or deploy online

### Files Not Transferring
- Verify data channel is open (check connection status)
- Check browser console for errors
- Ensure room hasn't expired (10 minutes)
- Try refreshing and creating a new room

## Security Features

- ✅ **HTTPS/WSS**: Encrypted signaling channel (when deployed)
- ✅ **DTLS**: WebRTC automatically encrypts data channel
- ✅ **Room Expiration**: Rooms expire after 10 minutes
- ✅ **No File Storage**: Files never stored on server
- ✅ **Ephemeral Rooms**: One-time use room codes
- ✅ **Integrity Verification**: SHA-256 checksum validation (when HTTPS available)

## Browser Support
tested on helium, chrome, safari, mozilla

## Project Structure

```
bhejo/
├── server.js              # Signaling server
├── package.json           # Dependencies
├── public/
│   ├── index.html         # Main UI
│   ├── style.css          # Styles
│   ├── app.js             # Application logic
│   └── webrtc.js          # WebRTC manager
├── README.md
└── DEPLOYMENT_GUIDE.md    # Deployment instructions
```

## License

MIT

## Contributing

Contributions welcome! Please feel free to submit a Pull Request.
