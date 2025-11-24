// App state
let webrtc = null;
let currentMode = 'sender'; // 'sender' or 'receiver'
let selectedFiles = [];

// DOM elements
const senderView = document.getElementById('sender-view');
const receiverView = document.getElementById('receiver-view');
const senderModeBtn = document.getElementById('sender-mode-btn');
const receiverModeBtn = document.getElementById('receiver-mode-btn');
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const fileList = document.getElementById('file-list');
const shareSection = document.getElementById('share-section');
const roomCodeInput = document.getElementById('room-code');
const copyBtn = document.getElementById('copy-btn');
const cancelBtn = document.getElementById('cancel-btn');
const joinCodeInput = document.getElementById('join-code');
const joinBtn = document.getElementById('join-btn');
const receiverStatus = document.getElementById('receiver-status');
const receiverStatusText = document.getElementById('receiver-status-text');
const incomingFiles = document.getElementById('incoming-files');
const filesList = document.getElementById('files-list');
const connectionStatus = document.getElementById('connection-status');
const statusText = document.getElementById('status-text');
const progressFill = document.getElementById('progress-fill');
const progressPercent = document.getElementById('progress-percent');
const progressSpeed = document.getElementById('progress-speed');
const receiverProgressFill = document.getElementById('receiver-progress-fill');
const receiverProgressPercent = document.getElementById('receiver-progress-percent');
const receiverProgressSpeed = document.getElementById('receiver-progress-speed');
const fileItemsContainer = document.getElementById('file-items-container');
const clearFilesBtn = document.getElementById('clear-files-btn');
const sendFilesBtn = document.getElementById('send-files-btn');

// Initialize
init();

function init() {
    setupEventListeners();
    initializeWebRTC();
    checkForRoomParameter();
}

function checkForRoomParameter() {
    // Check if URL has room parameter for auto-join
    const urlParams = new URLSearchParams(window.location.search);
    const roomId = urlParams.get('room');
    
    if (roomId && roomId.length === 6) {
        console.log(`[App] Room parameter found in URL: ${roomId}`);
        // Switch to receiver mode
        switchMode('receiver');
        // Set the room code
        joinCodeInput.value = roomId.toUpperCase();
        // Auto-join after a short delay to ensure WebRTC is initialized
        setTimeout(() => {
            joinRoom();
        }, 500);
    }
}

function setupEventListeners() {
    // Mode toggle
    senderModeBtn.addEventListener('click', () => switchMode('sender'));
    receiverModeBtn.addEventListener('click', () => switchMode('receiver'));

    // File selection
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', handleDragOver);
    dropZone.addEventListener('dragleave', handleDragLeave);
    dropZone.addEventListener('drop', handleDrop);
    fileInput.addEventListener('change', handleFileSelect);
    
    // Clear files
    if (clearFilesBtn) {
        clearFilesBtn.addEventListener('click', clearAllFiles);
    }

    // Share section
    copyBtn.addEventListener('click', copyRoomCode);
    cancelBtn.addEventListener('click', cancelTransfer);
    if (sendFilesBtn) {
        sendFilesBtn.addEventListener('click', () => {
            if (webrtc && webrtc.dataChannel && webrtc.dataChannel.readyState === 'open') {
                console.log('📤 Manual send triggered');
                sendFilesNow();
            } else {
                alert('Data channel not ready. Please wait for connection.');
            }
        });
    }

    // Receiver section
    joinBtn.addEventListener('click', joinRoom);
    joinCodeInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            joinRoom();
        }
    });
    joinCodeInput.addEventListener('input', (e) => {
        e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });
}

function switchMode(mode) {
    currentMode = mode;
    
    if (mode === 'sender') {
        senderView.classList.remove('hidden');
        receiverView.classList.add('hidden');
        senderModeBtn.classList.add('active');
        receiverModeBtn.classList.remove('active');
        resetSenderView();
    } else {
        senderView.classList.add('hidden');
        receiverView.classList.remove('hidden');
        senderModeBtn.classList.remove('active');
        receiverModeBtn.classList.add('active');
        resetReceiverView();
    }
}

function resetSenderView() {
    selectedFiles = [];
    fileList.classList.add('hidden');
    shareSection.classList.add('hidden');
    dropZone.classList.remove('hidden');
    updateConnectionStatus('', '');
}

function resetReceiverView() {
    receiverStatus.classList.add('hidden');
    incomingFiles.classList.add('hidden');
    filesList.innerHTML = '';
    receiverProgressFill.style.width = '0%';
    receiverProgressPercent.textContent = '0%';
    receiverProgressSpeed.textContent = '';
    updateConnectionStatus('', '');
}

function handleDragOver(e) {
    e.preventDefault();
    dropZone.classList.add('dragover');
}

function handleDragLeave(e) {
    e.preventDefault();
    dropZone.classList.remove('dragover');
}

function handleDrop(e) {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const files = Array.from(e.dataTransfer.files);
    addFiles(files);
}

function handleFileSelect(e) {
    const files = Array.from(e.target.files);
    addFiles(files);
}

function addFiles(files) {
    selectedFiles = [...selectedFiles, ...files];
    displayFiles();
    
    console.log(`[App] Files selected: ${selectedFiles.length} file(s)`);
    selectedFiles.forEach((file, index) => {
        console.log(`[App]   ${index + 1}. ${file.name} - ${formatFileSize(file.size)} (${file.type || 'unknown type'})`);
    });
    
    // If data channel is already open, send files immediately
    if (webrtc && webrtc.dataChannel && webrtc.dataChannel.readyState === 'open' && currentMode === 'sender') {
        console.log(`[App] Data channel already open, sending files immediately`);
        sendFilesNow();
    } else {
        // Otherwise, create room and wait for connection
        startTransfer();
    }
}

function displayFiles() {
    if (!fileItemsContainer) return;
    
    fileItemsContainer.innerHTML = '';
    fileList.classList.remove('hidden');
    
    selectedFiles.forEach((file, index) => {
        const fileItem = document.createElement('div');
        fileItem.className = 'file-item';
        fileItem.innerHTML = `
            <div class="file-info">
                <div class="file-icon">
                    ${getFileIcon(file.type, file.name)}
                </div>
                <div class="file-details">
                    <div class="file-name">${escapeHtml(file.name)}</div>
                    <div class="file-size">${formatFileSize(file.size)}</div>
                </div>
            </div>
        `;
        fileItemsContainer.appendChild(fileItem);
    });
}

function getFileIcon(type, name) {
    const ext = name.split('.').pop().toLowerCase();
    
    if (type.startsWith('image/')) {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>';
    } else if (type.startsWith('video/')) {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>';
    } else if (type.startsWith('audio/')) {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>';
    } else if (type.includes('pdf') || ext === 'pdf') {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>';
    } else if (type.includes('zip') || ext === 'zip' || ext === 'rar' || ext === '7z') {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>';
    } else {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><line x1="10" y1="9" x2="8" y2="9"></line></svg>';
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function clearAllFiles() {
    selectedFiles = [];
    fileList.classList.add('hidden');
    shareSection.classList.add('hidden');
    dropZone.classList.remove('hidden');
    if (webrtc) {
        webrtc.disconnect();
        initializeWebRTC();
    }
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

async function startTransfer() {
    try {
        updateConnectionStatus('Creating room...', 'connecting');
        
        const roomId = await webrtc.createRoom();
        roomCodeInput.value = roomId;
        shareSection.classList.remove('hidden');
        dropZone.classList.add('hidden');
        
        await generateQRCode(roomId);
        updateConnectionStatus('Waiting for receiver...', 'connecting');
    } catch (error) {
        console.error('Error creating room:', error);
        updateConnectionStatus('Error: ' + error.message, 'error');
    }
}

async function generateQRCode(roomId) {
    const qrContainer = document.getElementById('qr-code');
    if (!qrContainer) return;
    
    // Clear any existing QR code
    qrContainer.innerHTML = '';
    
    // Get network IP from server if available
    let networkHost = window.location.hostname;
    let networkPort = window.location.port;
    
    // If using localhost, try to get network IP from server
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        try {
            const response = await fetch('/api/info');
            const info = await response.json();
            if (info.networkIP && info.networkIP !== 'localhost') {
                networkHost = info.networkIP;
                networkPort = info.port || networkPort;
                console.log(`[QR] Using network IP from server: ${networkHost}:${networkPort}`);
            }
        } catch (error) {
            console.warn('[QR] Could not fetch server info, using current hostname');
        }
    }
    
    // Create URL with room code parameter for auto-join
    const protocol = window.location.protocol;
    // Don't include port for HTTPS (default 443) or if port is empty
    // Only include port for HTTP on non-standard ports
    const portPart = (protocol === 'https:' || !networkPort || networkPort === '443' || networkPort === '80') 
        ? '' 
        : `:${networkPort}`;
    const shareUrl = `${protocol}//${networkHost}${portPart}${window.location.pathname}?room=${roomId}`;
    
    console.log(`[QR] Generating QR code for URL: ${shareUrl}`);
    
    // Try using QRCode library (qrcodejs)
    if (typeof QRCode !== 'undefined') {
        try {
            // Create a div for QRCode library
            const qrDiv = document.createElement('div');
            qrDiv.id = 'qrcode';
            qrContainer.appendChild(qrDiv);
            
            // Use QRCode library
            new QRCode(qrDiv, {
                text: shareUrl,
                width: 200,
                height: 200,
                colorDark: '#000000',
                colorLight: '#FFFFFF',
                correctLevel: QRCode.CorrectLevel.M
            });
            
            console.log('[QR] QR code generated successfully');
        } catch (error) {
            console.error('[QR] QR code generation error:', error);
            drawQRCodeFallback(qrContainer, roomId, shareUrl);
        }
    } else {
        // Fallback: Use canvas-based QR code
        console.warn('[QR] QRCode library not available, using canvas fallback');
        drawQRCodeFallback(qrContainer, roomId, shareUrl);
    }
}

function drawQRCodeFallback(container, roomId, shareUrl) {
    // Create canvas for fallback
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 200;
    container.appendChild(canvas);
    
    const ctx = canvas.getContext('2d');
    
    // Draw white background
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, 200, 200);
    
    // Draw border
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.strokeRect(5, 5, 190, 190);
    
    // Draw room code
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 24px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(roomId, 100, 80);
    
    // Draw label
    ctx.font = '14px Arial';
    ctx.fillText('Room Code', 100, 120);
    
    // Draw instruction
    ctx.font = '12px Arial';
    ctx.fillStyle = '#666666';
    ctx.fillText('Scan to join', 100, 150);
    
    // Make it clickable
    canvas.style.cursor = 'pointer';
    canvas.title = `Click to copy: ${shareUrl}`;
    canvas.onclick = () => {
        navigator.clipboard.writeText(shareUrl).then(() => {
            alert('Share URL copied to clipboard!');
        }).catch(() => {
            // Fallback
            const textarea = document.createElement('textarea');
            textarea.value = shareUrl;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            alert('Share URL copied to clipboard!');
        });
    };
}

async function joinRoom() {
    const roomId = joinCodeInput.value.trim().toUpperCase();
    
    if (roomId.length !== 6) {
        alert('Please enter a valid 6-digit code');
        return;
    }

    try {
        joinBtn.disabled = true;
        updateConnectionStatus('Connecting...', 'connecting');
        receiverStatus.classList.remove('hidden');
        receiverStatusText.textContent = 'Connecting to sender...';
        
        await webrtc.joinRoom(roomId);
    } catch (error) {
        console.error('Error joining room:', error);
        updateConnectionStatus('Error: ' + error.message, 'error');
        receiverStatusText.textContent = 'Connection failed: ' + error.message;
        joinBtn.disabled = false;
    }
}

async function copyRoomCode() {
    try {
        await navigator.clipboard.writeText(roomCodeInput.value);
        const originalText = copyBtn.querySelector('span')?.textContent || copyBtn.textContent;
        if (copyBtn.querySelector('span')) {
            copyBtn.querySelector('span').textContent = 'Copied!';
        } else {
            copyBtn.textContent = 'Copied!';
        }
        copyBtn.style.background = 'var(--success)';
        setTimeout(() => {
            if (copyBtn.querySelector('span')) {
                copyBtn.querySelector('span').textContent = originalText;
            } else {
                copyBtn.textContent = originalText;
            }
            copyBtn.style.background = '';
        }, 2000);
    } catch (error) {
        // Fallback for older browsers
        roomCodeInput.select();
        document.execCommand('copy');
        const originalText = copyBtn.querySelector('span')?.textContent || copyBtn.textContent;
        if (copyBtn.querySelector('span')) {
            copyBtn.querySelector('span').textContent = 'Copied!';
        } else {
            copyBtn.textContent = 'Copied!';
        }
        setTimeout(() => {
            if (copyBtn.querySelector('span')) {
                copyBtn.querySelector('span').textContent = originalText;
            } else {
                copyBtn.textContent = originalText;
            }
        }, 2000);
    }
}

function cancelTransfer() {
    webrtc.disconnect();
    resetSenderView();
    initializeWebRTC();
}

function updateConnectionStatus(text, status) {
    if (!text) {
        connectionStatus.classList.add('hidden');
        return;
    }
    
    connectionStatus.classList.remove('hidden');
    statusText.textContent = text;
    connectionStatus.className = 'status-bar ' + status;
}

function initializeWebRTC() {
    webrtc = new WebRTCManager();
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    
    console.log(`[App] Initializing WebRTC - WebSocket URL: ${wsUrl}`);
    updateConnectionStatus('Connecting to server...', 'connecting');
    
    webrtc.connect(wsUrl).then(() => {
        console.log(`[App] WebSocket connection successful`);
        updateConnectionStatus('Connected to server', 'connected');
    }).catch(error => {
        console.error(`[App] Failed to connect to signaling server:`, error);
        const errorMsg = error.message || 'Connection failed';
        updateConnectionStatus(`Connection error: ${errorMsg}`, 'error');
        
        // Show helpful error message
        setTimeout(() => {
            alert(`WebSocket connection failed!\n\n${errorMsg}\n\nTroubleshooting:\n1. Make sure server is running\n2. Check firewall settings\n3. Try refreshing the page\n4. Verify you're using the correct IP address`);
        }, 500);
    });
    
    // Add signaling connection handler
    webrtc.onSignalingConnected = () => {
        updateConnectionStatus('Signaling server connected', 'connected');
    };

    // Set up event handlers
    webrtc.onDataChannelOpen = () => {
        console.log(`[App] Data channel opened - state: ${webrtc.dataChannel?.readyState}, peerConnection: ${webrtc.peerConnection?.connectionState}, ICE: ${webrtc.peerConnection?.iceConnectionState}, files: ${selectedFiles?.length || 0}`);
        
        updateConnectionStatus('Connected! Transferring...', 'connected');
        
        if (currentMode === 'sender') {
            // Double-check data channel is actually open
            if (!webrtc.dataChannel) {
                console.error(`[App] Data channel is null`);
                updateConnectionStatus('Data channel not available', 'error');
                return;
            }
            
            if (webrtc.dataChannel.readyState !== 'open') {
                console.error(`[App] Data channel not open - state: ${webrtc.dataChannel.readyState}, waiting...`);
                // Wait a bit and try again
                setTimeout(() => {
                    if (webrtc.dataChannel && webrtc.dataChannel.readyState === 'open') {
                        console.log(`[App] Data channel opened after wait, retrying`);
                        webrtc.onDataChannelOpen();
                    } else {
                        updateConnectionStatus('Data channel failed to open', 'error');
                    }
                }, 1000);
                return;
            }
            
            // Check if there are files to send
            if (!selectedFiles || selectedFiles.length === 0) {
                console.warn(`[App] No files selected to send`);
                updateConnectionStatus('No files to send - select files first', 'error');
                return;
            }
            
            console.log(`[App] Preparing to send ${selectedFiles.length} file(s) - dataChannel state: ${webrtc.dataChannel.readyState}, buffered: ${webrtc.dataChannel.bufferedAmount} bytes`);
            selectedFiles.forEach((f, i) => {
                console.log(`[App]   ${i + 1}. ${f.name} - ${formatFileSize(f.size)}`);
            });
            
            // Show send button as backup
            if (sendFilesBtn) {
                sendFilesBtn.classList.remove('hidden');
            }
            
            // Send files immediately - data channel is ready
            sendFilesNow();
        } else {
            receiverStatusText.textContent = 'Connected! Waiting for files...';
            console.log(`[App] Receiver ready - dataChannel state: ${webrtc.dataChannel?.readyState}, waiting for files`);
        }
    };
    
    // Function to send files (can be called from multiple places)
    function sendFilesNow() {
        if (!webrtc.dataChannel || webrtc.dataChannel.readyState !== 'open') {
            console.error(`[App] Cannot send files - data channel not open (state: ${webrtc.dataChannel?.readyState})`);
            return;
        }
        
        if (!selectedFiles || selectedFiles.length === 0) {
            console.warn(`[App] No files to send`);
            return;
        }
        
        // Send files sequentially to avoid overwhelming the connection
        let fileIndex = 0;
        
        const sendNextFile = () => {
            if (fileIndex >= selectedFiles.length) {
                console.log(`[App] All ${selectedFiles.length} file(s) sent successfully`);
                updateConnectionStatus('All files sent!', 'connected');
                return;
            }
            
            // Check data channel is still open
            if (!webrtc.dataChannel || webrtc.dataChannel.readyState !== 'open') {
                console.error(`[App] Data channel closed during transfer (state: ${webrtc.dataChannel?.readyState})`);
                updateConnectionStatus('Connection lost during transfer', 'error');
                return;
            }
            
            const file = selectedFiles[fileIndex];
            console.log(`[App] Sending file ${fileIndex + 1}/${selectedFiles.length}: ${file.name} (${formatFileSize(file.size)}) - dataChannel state: ${webrtc.dataChannel.readyState}`);
            
            webrtc.sendFile(file)
                .then(() => {
                    console.log(`[App] File ${fileIndex + 1} sent successfully: ${file.name}`);
                    fileIndex++;
                    // Small delay before sending next file
                    setTimeout(sendNextFile, 100);
                })
                .catch(error => {
                    console.error(`[App] Error sending file ${fileIndex + 1}:`, error);
                    updateConnectionStatus('Transfer error: ' + error.message, 'error');
                    // Continue with next file even if one fails
                    fileIndex++;
                    if (fileIndex < selectedFiles.length) {
                        setTimeout(sendNextFile, 100);
                    }
                });
        };
        
        // Start sending files
        sendNextFile();
    }

    webrtc.onDataChannelClose = () => {
        updateConnectionStatus('Connection closed', 'error');
    };

    webrtc.onConnectionStateChange = (state) => {
        console.log('🔗 WebRTC connection state:', state);
        
        if (currentMode === 'receiver') {
            if (state === 'connecting') {
                receiverStatusText.textContent = 'Establishing peer connection...';
            } else if (state === 'connected') {
                receiverStatusText.textContent = 'Connected! Waiting for files...';
                updateConnectionStatus('Peer connection established', 'connected');
            } else if (state === 'failed') {
                receiverStatusText.textContent = 'Connection failed. ICE may need TURN server.';
                updateConnectionStatus('Connection failed - may need TURN server', 'error');
                // Show helpful message
                setTimeout(() => {
                    alert('Connection failed!\n\nThis usually happens when:\n1. Both devices are behind restrictive NATs\n2. Firewall is blocking WebRTC\n3. Network doesn\'t allow direct P2P\n\nSolution: Try on same Wi-Fi network, or configure a TURN server.');
                }, 1000);
            } else if (state === 'disconnected') {
                receiverStatusText.textContent = 'Connection disconnected.';
                updateConnectionStatus('Connection lost', 'error');
            }
        } else {
            if (state === 'failed') {
                updateConnectionStatus('Connection failed - may need TURN server', 'error');
                setTimeout(() => {
                    alert('Connection failed!\n\nThis usually happens when:\n1. Both devices are behind restrictive NATs\n2. Firewall is blocking WebRTC\n3. Network doesn\'t allow direct P2P\n\nSolution: Try on same Wi-Fi network, or configure a TURN server.');
                }, 1000);
            } else if (state === 'disconnected') {
                updateConnectionStatus('Connection lost', 'error');
            } else if (state === 'connected') {
                updateConnectionStatus('Peer connection established', 'connected');
            }
        }
    };

    webrtc.onProgress = (progress, bytesTransferred, startTime) => {
        const percent = Math.min(progress, 100);
        const elapsed = (Date.now() - startTime) / 1000; // seconds
        const speed = bytesTransferred / elapsed; // bytes per second
        const speedText = formatFileSize(speed) + '/s';
        
        if (currentMode === 'sender') {
            progressFill.style.width = percent + '%';
            progressPercent.textContent = Math.round(percent) + '%';
            progressSpeed.textContent = speedText;
        } else {
            receiverProgressFill.style.width = percent + '%';
            receiverProgressPercent.textContent = Math.round(percent) + '%';
            receiverProgressSpeed.textContent = speedText;
        }
    };

    webrtc.onFileMetadata = (metadata) => {
        if (currentMode === 'receiver') {
            receiverStatus.classList.add('hidden');
            incomingFiles.classList.remove('hidden');
            
            const fileItem = document.createElement('div');
            fileItem.className = 'file-item';
            fileItem.innerHTML = `
                <div class="file-info">
                    <div class="file-name">${metadata.name}</div>
                    <div class="file-size">${formatFileSize(metadata.size)}</div>
                </div>
            `;
            filesList.appendChild(fileItem);
        }
    };

    webrtc.onFileReceived = (file) => {
        if (currentMode === 'receiver') {
            receiverStatusText.textContent = `Received: ${file.name}`;
            updateConnectionStatus('File received!', 'connected');
        }
    };

    webrtc.onError = (error) => {
        console.error('WebRTC error:', error);
        updateConnectionStatus('Error: ' + error.message, 'error');
    };

    webrtc.onPeerDisconnected = () => {
        updateConnectionStatus('Peer disconnected', 'error');
    };

    webrtc.onRoomExpired = () => {
        updateConnectionStatus('Room expired', 'error');
        alert('The room has expired. Please create a new one.');
    };
}

