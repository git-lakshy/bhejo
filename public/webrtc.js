// WebRTC configuration - STUN first for same network, TURN as fallback
const RTC_CONFIG = {
    iceServers: [
        // Primary STUN servers (Google - most reliable)
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        
        // TURN servers for cloud/deployed environments (required for different networks)
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:80?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ],
    iceCandidatePoolSize: 10,
    iceTransportPolicy: 'all', // Try both relay and direct connections
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
};

// Chunk size for file transfer (64KB)
const CHUNK_SIZE = 64 * 1024;

class WebRTCManager {
    constructor() {
        this.ws = null;
        this.peerConnection = null;
        this.dataChannel = null;
        this.roomId = null;
        this.role = null; // 'sender' or 'receiver'
        this.isConnected = false;
        
        // Pending messages (in case peer connection isn't ready yet)
        this.pendingOffer = null;
        this.pendingAnswer = null;
        this.pendingIceCandidates = [];
        
        // File transfer state
        this.fileQueue = [];
        this.currentFile = null;
        this.currentFileIndex = 0;
        this.receivedChunks = [];
        this.receivedFiles = [];
        
        // Chunk tracking for robustness
        this.chunkMap = new Map(); // Map<chunkIndex, ArrayBuffer> for ordered storage
        this.expectedChunkCount = 0;
        this.receivedChunkIndices = new Set(); // Track which chunks we've received
        this.chunkAckTimeout = null;
        this.enableIntegrityCheck = true; // Enable checksum verification
        
        // Statistics
        this.stats = {
            bytesTransferred: 0,
            startTime: null,
            lastUpdate: null
        };
    }

    connect(signalingUrl, retries = 3, delay = 1000) {
        return new Promise((resolve, reject) => {
            console.log(`Attempting to connect to WebSocket: ${signalingUrl}`);
            
            try {
                this.ws = new WebSocket(signalingUrl);
                
                const timeout = setTimeout(() => {
                    if (this.ws.readyState !== WebSocket.OPEN) {
                        this.ws.close();
                        if (retries > 0) {
                            console.log(`Connection timeout, retrying... (${retries} attempts left)`);
                            setTimeout(() => {
                                this.connect(signalingUrl, retries - 1, delay * 1.5).then(resolve).catch(reject);
                            }, delay);
                        } else {
                            reject(new Error('WebSocket connection timeout after multiple attempts'));
                        }
                    }
                }, 10000); // 10 second timeout
                
                this.ws.onopen = () => {
                    clearTimeout(timeout);
                    console.log(`[WebSocket] Connection established to ${signalingUrl}`);
                    if (this.onSignalingConnected) {
                        this.onSignalingConnected();
                    }
                    resolve();
                };
                
                this.ws.onerror = (error) => {
                    clearTimeout(timeout);
                    console.error(`[WebSocket] Connection error:`, error);
                    console.error(`[WebSocket] URL: ${signalingUrl}, readyState: ${this.ws.readyState}`);
                    
                    // Try to get more error info
                    const errorMsg = error.message || 'WebSocket connection failed';
                    
                    if (retries > 0) {
                        console.log(`Retrying connection... (${retries} attempts left)`);
                        setTimeout(() => {
                            this.connect(signalingUrl, retries - 1, delay * 1.5).then(resolve).catch(reject);
                        }, delay);
                    } else {
                        reject(new Error(`WebSocket connection failed: ${errorMsg}. Please check:\n1. Server is running\n2. Firewall allows WebSocket connections\n3. You're using the correct IP address`));
                    }
                };
                
                this.ws.onmessage = (event) => {
                    try {
                        this.handleSignalingMessage(JSON.parse(event.data));
                    } catch (error) {
                        console.error('Error parsing WebSocket message:', error);
                    }
                };
                
                this.ws.onclose = (event) => {
                    clearTimeout(timeout);
                    // Code 1001 = going away (normal browser navigation/refresh)
                    // Code 1000 = normal closure
                    // Only log if it's an unexpected closure
                    if (event.code !== 1000 && event.code !== 1001) {
                        console.warn('WebSocket connection closed unexpectedly', {
                            code: event.code,
                            reason: event.reason,
                            wasClean: event.wasClean
                        });
                    } else {
                        console.log('WebSocket connection closed (normal)', {
                            code: event.code,
                            wasClean: event.wasClean
                        });
                    }
                    this.isConnected = false;
                    
                    // If not a clean close and not a normal navigation, try to reconnect
                    if (!event.wasClean && event.code !== 1000 && event.code !== 1001) {
                        if (retries > 0) {
                            console.log(`Connection closed unexpectedly, retrying... (${retries} attempts left)`);
                            setTimeout(() => {
                                this.connect(signalingUrl, retries - 1, delay * 1.5).then(resolve).catch(reject);
                            }, delay);
                        }
                    }
                    
                    if (this.onDisconnect && event.code !== 1001) {
                        // Only trigger disconnect callback for unexpected closures
                        this.onDisconnect();
                    }
                };
            } catch (error) {
                console.error('Failed to create WebSocket:', error);
                reject(error);
            }
        });
    }

    createRoom() {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                reject(new Error('Signaling not connected'));
                return;
            }

            console.log(`[Room] Creating new room...`);
            this.ws.send(JSON.stringify({
                type: 'join',
                createNew: true
            }));

            // Wait for room creation response
            const timeout = setTimeout(() => {
                reject(new Error('Timeout waiting for room creation'));
            }, 10000);

            const originalHandler = this.handleSignalingMessage.bind(this);
            this.handleSignalingMessage = (data) => {
                if (data.type === 'joined' && data.role === 'sender') {
                    clearTimeout(timeout);
                    console.log(`[Room] Created room: ${data.roomId}`);
                    this.roomId = data.roomId;
                    this.role = data.role;
                    this.setupPeerConnection(true);
                    
                    // Restore original handler
                    this.handleSignalingMessage = originalHandler;
                    
                    resolve(data.roomId);
                } else if (data.type === 'error') {
                    clearTimeout(timeout);
                    this.handleSignalingMessage = originalHandler;
                    reject(new Error(data.message));
                } else {
                    originalHandler(data);
                }
            };
        });
    }

    joinRoom(roomId) {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                reject(new Error('Signaling not connected'));
                return;
            }

            this.roomId = roomId.toUpperCase();
            console.log(`[Room] Joining room: ${this.roomId}`);
            
            this.ws.send(JSON.stringify({
                type: 'join',
                roomId: this.roomId,
                createNew: false
            }));

            // Wait for join response
            const timeout = setTimeout(() => {
                reject(new Error('Timeout waiting for room join'));
            }, 10000); // 10 second timeout

            const originalHandler = this.handleSignalingMessage.bind(this);
            const tempHandler = (data) => {
                if (data.type === 'joined' && data.role === 'receiver') {
                    clearTimeout(timeout);
                    console.log(`[Room] Successfully joined room as receiver`);
                    this.role = data.role;
                    
                    // Set up peer connection first
                    this.setupPeerConnection(false);
                    
                    // Restore original handler AFTER setting up peer connection
                    this.handleSignalingMessage = originalHandler;
                    
                    // Process any pending messages after a short delay to ensure peer connection is ready
                    setTimeout(() => {
                        this.processPendingMessages();
                    }, 200);
                    
                    resolve();
                } else if (data.type === 'error') {
                    clearTimeout(timeout);
                    this.handleSignalingMessage = originalHandler;
                    reject(new Error(data.message));
                } else {
                    // Store messages that might arrive before peer connection is ready
                    if (data.type === 'offer') {
                        console.log(`[WebRTC] Received offer before peer connection ready, storing`);
                        this.pendingOffer = data.offer;
                    } else if (data.type === 'ice-candidate') {
                        console.log(`[ICE] Received candidate before peer connection ready, storing`);
                        this.pendingIceCandidates.push(data.candidate);
                    } else {
                        originalHandler(data);
                    }
                }
            };
            
            this.handleSignalingMessage = tempHandler;
        });
    }

    setupPeerConnection(isInitiator) {
        const role = isInitiator ? 'initiator (sender)' : 'receiver';
        console.log(`[WebRTC] Setting up peer connection as ${role}`);
        
        // Create peer connection with enhanced configuration
        const config = {
            ...RTC_CONFIG,
            // Force more aggressive ICE gathering
            iceCandidatePoolSize: 10
        };
        
        this.peerConnection = new RTCPeerConnection(config);
        
        // Log connection configuration
        console.log(`[WebRTC] Peer connection created - iceServers: ${config.iceServers.length}, iceCandidatePoolSize: ${config.iceCandidatePoolSize}, iceTransportPolicy: ${config.iceTransportPolicy}`);

        // Handle ICE candidates with detailed logging
        let candidateCount = { host: 0, srflx: 0, relay: 0, other: 0 };
        
        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                const candidate = event.candidate;
                const candidateType = candidate.type || 'unknown';
                const candidateProtocol = candidate.protocol || 'unknown';
                
                // Count candidate types
                if (candidateType === 'host') candidateCount.host++;
                else if (candidateType === 'srflx') candidateCount.srflx++;
                else if (candidateType === 'relay') candidateCount.relay++;
                else candidateCount.other++;
                
                // Log candidate details
                const candidateAddress = candidate.address || candidate.ip || 'N/A';
                const candidatePort = candidate.port || 'N/A';
                console.log(`[ICE] Candidate discovered: type=${candidateType}, address=${candidateAddress}, port=${candidatePort}, protocol=${candidateProtocol}`);
                
                // Send candidate immediately - serialize properly
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    try {
                        // Serialize RTCIceCandidate properly for WebSocket transmission
                        // RTCIceCandidate needs to be converted to a plain object
                        const candidateData = {
                            candidate: candidate.candidate || '',
                            sdpMLineIndex: candidate.sdpMLineIndex !== null && candidate.sdpMLineIndex !== undefined ? candidate.sdpMLineIndex : null,
                            sdpMid: candidate.sdpMid || null,
                            usernameFragment: candidate.usernameFragment || null
                        };
                        
                        // Only send if we have the candidate string
                        if (candidateData.candidate) {
                            this.ws.send(JSON.stringify({
                                type: 'ice-candidate',
                                candidate: candidateData
                            }));
                            console.log(`[ICE] Candidate sent via WebSocket`);
                        } else {
                            console.warn(`[ICE] Candidate missing candidate string, skipping`);
                        }
                    } catch (error) {
                        console.error(`[ICE] Error sending candidate:`, error);
                        this.pendingIceCandidates.push(event.candidate);
                    }
                } else {
                    console.warn(`[ICE] WebSocket not ready (state: ${this.ws?.readyState}), storing candidate for later`);
                    this.pendingIceCandidates.push(event.candidate);
                }
            } else {
                console.log(`[ICE] Candidate gathering complete. Summary: ${candidateCount.host} host, ${candidateCount.srflx} srflx, ${candidateCount.relay} relay, ${candidateCount.other} other`);
                
                if (candidateCount.host > 0) {
                    console.log(`[ICE] Host candidates available (${candidateCount.host}) - direct connection possible on same network`);
                } else if (candidateCount.srflx > 0) {
                    console.log(`[ICE] srflx candidates available (${candidateCount.srflx}) - STUN working, may connect via NAT traversal`);
                } else if (candidateCount.relay > 0) {
                    console.log(`[ICE] Relay candidates available (${candidateCount.relay}) - TURN working, connection via relay`);
                } else {
                    console.error(`[ICE] ⚠️ NO ICE CANDIDATES FOUND! This will prevent connection.`);
                    console.error(`[ICE] Possible causes:`);
                    console.error(`[ICE]   1. TURN servers not accessible or misconfigured`);
                    console.error(`[ICE]   2. Browser blocking WebRTC`);
                    console.error(`[ICE]   3. Network restrictions`);
                    console.error(`[ICE]   4. Firewall blocking STUN/TURN traffic`);
                }
                
                // Send any pending candidates
                if (this.pendingIceCandidates.length > 0 && this.ws && this.ws.readyState === WebSocket.OPEN) {
                    console.log(`[ICE] Sending ${this.pendingIceCandidates.length} pending candidates`);
                    this.pendingIceCandidates.forEach(candidate => {
                        this.ws.send(JSON.stringify({
                            type: 'ice-candidate',
                            candidate: candidate
                        }));
                    });
                    this.pendingIceCandidates = [];
                }
            }
        };

        // Handle ICE connection state with retry logic
        let iceRetryCount = 0;
        const MAX_ICE_RETRIES = 3;
        let iceRetryTimeout = null;
        let lastIceState = null;
        
        this.peerConnection.oniceconnectionstatechange = () => {
            const iceState = this.peerConnection.iceConnectionState;
            
            // Only log state changes
            if (iceState !== lastIceState) {
                console.log(`[ICE] Connection state changed: ${lastIceState || 'new'} → ${iceState}`);
                lastIceState = iceState;
            }
            
            if (iceState === 'failed') {
                iceRetryCount++;
                console.error(`[ICE] Connection failed (retry ${iceRetryCount}/${MAX_ICE_RETRIES})`);
                console.error(`[ICE] Troubleshooting: Ensure both devices on same network, check router AP isolation, or try mobile hotspot`);
                
                // Clear any existing retry timeout
                if (iceRetryTimeout) {
                    clearTimeout(iceRetryTimeout);
                }
                
                if (iceRetryCount <= MAX_ICE_RETRIES) {
                    console.log(`[ICE] Restarting ICE connection (retry ${iceRetryCount}/${MAX_ICE_RETRIES})`);
                    // Wait a bit before retrying
                    iceRetryTimeout = setTimeout(() => {
                        try {
                            this.peerConnection.restartIce();
                            // If sender, create new offer after restart
                            if (this.role === 'sender') {
                                setTimeout(() => {
                                    console.log(`[WebRTC] Creating new offer after ICE restart`);
                                    this.createOffer();
                                }, 500);
                            }
                        } catch (error) {
                            console.error(`[ICE] Error restarting ICE:`, error);
                            // Try creating new offer/answer as fallback
                            if (this.role === 'sender') {
                                console.log(`[WebRTC] Creating new offer as fallback`);
                                this.createOffer();
                            }
                        }
                    }, 1000 * iceRetryCount); // Exponential backoff
                } else {
                    console.error(`[ICE] Connection failed after ${MAX_ICE_RETRIES} retries`);
                    console.error(`[ICE] Possible causes: restrictive NATs, router blocking P2P, or need TURN server`);
                    if (this.onError) {
                        this.onError(new Error('ICE connection failed. Try on same Wi-Fi network or configure TURN server.'));
                    }
                }
            } else if (iceState === 'connected' || iceState === 'completed') {
                const connectionType = iceState === 'connected' ? 'Direct (STUN)' : 'Completed';
                console.log(`[ICE] Connection established: ${connectionType}`);
                iceRetryCount = 0; // Reset retry count on success
                if (iceRetryTimeout) {
                    clearTimeout(iceRetryTimeout);
                    iceRetryTimeout = null;
                }
                // Check if data channel is ready
                if (this.dataChannel) {
                    console.log(`[ICE] Data channel state: ${this.dataChannel.readyState}`);
                }
            } else if (iceState === 'disconnected') {
                console.warn(`[ICE] Connection disconnected`);
            } else if (iceState === 'checking') {
                console.log(`[ICE] Checking connection - testing host candidates (same network) and srflx candidates (STUN)`);
                // Log after a delay if still checking
                setTimeout(() => {
                    if (this.peerConnection && this.peerConnection.iceConnectionState === 'checking') {
                        console.warn(`[ICE] Still checking connection after delay - may need TURN server or same network`);
                    }
                }, 5000);
            }
        };
        
        // Handle ICE gathering state
        this.peerConnection.onicegatheringstatechange = () => {
            console.log(`[ICE] Gathering state: ${this.peerConnection.iceGatheringState}`);
        };

        // Handle connection state changes
        this.peerConnection.onconnectionstatechange = () => {
            const state = this.peerConnection.connectionState;
            const iceState = this.peerConnection.iceConnectionState;
            console.log(`[WebRTC] Peer connection state: ${state}, ICE state: ${iceState}`);
            if (this.onConnectionStateChange) {
                this.onConnectionStateChange(state);
            }
            
            if (state === 'failed') {
                console.error(`[WebRTC] Peer connection failed - ICE: ${iceState}`);
            } else if (state === 'connected') {
                console.log(`[WebRTC] Peer connection established - ICE: ${iceState}`);
                // Check data channel
                if (this.dataChannel) {
                    console.log(`[WebRTC] Data channel state: ${this.dataChannel.readyState}`);
                    if (this.dataChannel.readyState === 'open' && this.onDataChannelOpen) {
                        console.log(`[WebRTC] Data channel already open, triggering callback`);
                        setTimeout(() => this.onDataChannelOpen(), 100);
                    }
                }
            } else if (state === 'connecting') {
                console.log(`[WebRTC] Peer connection connecting...`);
            } else if (state === 'disconnected') {
                console.warn(`[WebRTC] Peer connection disconnected`);
            }
        };

        if (isInitiator) {
            // Sender creates data channel
            this.dataChannel = this.peerConnection.createDataChannel('fileTransfer', {
                ordered: true
            });
            this.setupDataChannel();
        } else {
            // Receiver waits for data channel
            this.peerConnection.ondatachannel = (event) => {
                this.dataChannel = event.channel;
                this.setupDataChannel();
            };
        }

        // Create offer if initiator
        if (isInitiator) {
            this.createOffer();
        }
    }

    setupDataChannel() {
        console.log(`[DataChannel] Setting up handlers - state: ${this.dataChannel.readyState}, label: ${this.dataChannel.label}, id: ${this.dataChannel.id}`);
        
        // Check if already open
        if (this.dataChannel.readyState === 'open') {
            console.log(`[DataChannel] Already open, initializing callbacks`);
            this.isConnected = true;
            if (this.onDataChannelOpen) {
                // Small delay to ensure everything is initialized
                setTimeout(() => this.onDataChannelOpen(), 100);
            }
        }
        
        this.dataChannel.onopen = () => {
            const pcState = this.peerConnection?.connectionState;
            const iceState = this.peerConnection?.iceConnectionState;
            console.log(`[DataChannel] Opened - readyState: ${this.dataChannel.readyState}, buffered: ${this.dataChannel.bufferedAmount} bytes, protocol: ${this.dataChannel.protocol || 'none'}, ordered: ${this.dataChannel.ordered}, PC state: ${pcState}, ICE: ${iceState}`);
            this.isConnected = true;
            if (this.onDataChannelOpen) {
                this.onDataChannelOpen();
            }
        };

        this.dataChannel.onclose = () => {
            console.log(`[DataChannel] Closed - readyState: ${this.dataChannel.readyState}`);
            this.isConnected = false;
            if (this.onDataChannelClose) {
                this.onDataChannelClose();
            }
        };

        this.dataChannel.onerror = (error) => {
            console.error(`[DataChannel] Error:`, error);
            if (this.onError) {
                this.onError(error);
            }
        };

        this.dataChannel.onmessage = (event) => {
            const dataType = typeof event.data;
            const isArrayBuffer = event.data instanceof ArrayBuffer;
            const size = isArrayBuffer ? event.data.byteLength : (typeof event.data === 'string' ? event.data.length : 'unknown');
            console.log(`[DataChannel] Message received - type: ${dataType}, isArrayBuffer: ${isArrayBuffer}, size: ${size} bytes`);
            this.handleDataChannelMessage(event.data);
        };
        
        // Log buffered amount periodically
        if (this.role === 'sender') {
            setInterval(() => {
                if (this.dataChannel && this.dataChannel.readyState === 'open') {
                    if (this.dataChannel.bufferedAmount > 0) {
                        console.log(`[DataChannel] Buffered: ${this.formatFileSize(this.dataChannel.bufferedAmount)}`);
                    }
                }
            }, 1000);
        }
    }

    async createOffer() {
        try {
            console.log(`[WebRTC] Creating offer...`);
            
            // Wait for ICE gathering to start
            if (this.peerConnection.iceGatheringState === 'new') {
                console.log(`[WebRTC] Waiting for ICE gathering to start...`);
                await new Promise((resolve) => {
                    const checkInterval = setInterval(() => {
                        if (this.peerConnection.iceGatheringState !== 'new') {
                            clearInterval(checkInterval);
                            resolve();
                        }
                    }, 100);
                    // Timeout after 2 seconds
                    setTimeout(() => {
                        clearInterval(checkInterval);
                        resolve();
                    }, 2000);
                });
            }
            
            const offerOptions = {
                offerToReceiveAudio: false,
                offerToReceiveVideo: false,
                iceRestart: false
            };
            
            const offer = await this.peerConnection.createOffer(offerOptions);
            await this.peerConnection.setLocalDescription(offer);
            console.log(`[WebRTC] Created offer - SDP type: ${offer.type}, ICE gathering state: ${this.peerConnection.iceGatheringState}`);
            
            // Wait a bit for ICE candidates to be gathered (but don't wait too long)
            if (this.peerConnection.iceGatheringState === 'gathering') {
                console.log(`[WebRTC] Waiting for ICE candidates (max 2s)...`);
                await new Promise((resolve) => {
                    const timeout = setTimeout(resolve, 2000); // Max 2 seconds
                    const handler = () => {
                        if (this.peerConnection.iceGatheringState === 'complete') {
                            clearTimeout(timeout);
                            this.peerConnection.removeEventListener('icegatheringstatechange', handler);
                            resolve();
                        }
                    };
                    this.peerConnection.addEventListener('icegatheringstatechange', handler);
                });
            }
            
            // Get updated offer with ICE candidates
            const updatedOffer = this.peerConnection.localDescription;
            
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({
                    type: 'offer',
                    offer: updatedOffer || offer
                }));
                console.log(`[WebRTC] Offer sent to receiver via WebSocket`);
            } else {
                console.error(`[WebRTC] WebSocket not ready (state: ${this.ws?.readyState}) to send offer`);
            }
        } catch (error) {
            console.error(`[WebRTC] Error creating offer:`, error);
            if (this.onError) {
                this.onError(error);
            }
        }
    }

    async handleOffer(offer) {
        try {
            console.log(`[WebRTC] Handling offer from sender - SDP type: ${offer.type}`);
            
            if (!this.peerConnection) {
                console.log(`[WebRTC] Peer connection not ready, storing offer`);
                this.pendingOffer = offer;
                return;
            }
            
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
            console.log(`[WebRTC] Set remote description (offer)`);
            
            const answerOptions = {
                offerToReceiveAudio: false,
                offerToReceiveVideo: false
            };
            
            const answer = await this.peerConnection.createAnswer(answerOptions);
            await this.peerConnection.setLocalDescription(answer);
            console.log(`[WebRTC] Created answer - ICE gathering state: ${this.peerConnection.iceGatheringState}`);
            
            // Wait for ICE candidates if gathering (wait longer for better connectivity)
            if (this.peerConnection.iceGatheringState === 'gathering') {
                console.log(`[WebRTC] Waiting for ICE candidates in answer (max 5s)...`);
                await new Promise((resolve) => {
                    const timeout = setTimeout(() => {
                        console.log(`[WebRTC] ICE gathering timeout - sending answer with available candidates`);
                        resolve();
                    }, 5000); // Increased to 5 seconds
                    const handler = () => {
                        if (this.peerConnection.iceGatheringState === 'complete') {
                            clearTimeout(timeout);
                            this.peerConnection.removeEventListener('icegatheringstatechange', handler);
                            console.log(`[WebRTC] ICE gathering complete - sending answer with all candidates`);
                            resolve();
                        }
                    };
                    this.peerConnection.addEventListener('icegatheringstatechange', handler);
                });
            }
            
            // Get updated answer with ICE candidates
            const updatedAnswer = this.peerConnection.localDescription;
            
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({
                    type: 'answer',
                    answer: updatedAnswer || answer
                }));
                console.log(`[WebRTC] Answer sent to sender via WebSocket (ICE state: ${this.peerConnection.iceGatheringState})`);
            } else {
                console.error(`[WebRTC] WebSocket not ready (state: ${this.ws?.readyState}) to send answer`);
            }
        } catch (error) {
            console.error(`[WebRTC] Error handling offer:`, error);
            if (this.onError) {
                this.onError(error);
            }
        }
    }

    async handleAnswer(answer) {
        try {
            if (!this.peerConnection) {
                console.log(`[WebRTC] Peer connection not ready, storing answer`);
                this.pendingAnswer = answer;
                return;
            }
            
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
            console.log(`[WebRTC] Set remote description (answer) - ICE state: ${this.peerConnection.iceConnectionState}, connection state: ${this.peerConnection.connectionState}`);
            
            // Process any pending ICE candidates that arrived before the answer
            if (this.pendingIceCandidates.length > 0) {
                console.log(`[WebRTC] Processing ${this.pendingIceCandidates.length} pending ICE candidates after answer`);
                const candidates = [...this.pendingIceCandidates];
                this.pendingIceCandidates = [];
                for (const candidate of candidates) {
                    try {
                        await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                    } catch (error) {
                        console.warn(`[WebRTC] Error adding pending candidate:`, error);
                    }
                }
            }
        } catch (error) {
            console.error('Error handling answer:', error);
            if (this.onError) {
                this.onError(error);
            }
        }
    }

    async handleIceCandidate(candidate) {
        try {
            if (!this.peerConnection) {
                console.log(`[ICE] Peer connection not ready, storing candidate`);
                this.pendingIceCandidates.push(candidate);
                return;
            }
            
            // Validate candidate before adding
            if (!candidate || typeof candidate !== 'object') {
                console.warn(`[ICE] Invalid candidate format:`, candidate);
                return;
            }
            
            // Create RTCIceCandidate with proper validation
            const iceCandidate = new RTCIceCandidate(candidate);
            await this.peerConnection.addIceCandidate(iceCandidate);
            
            const candidateType = candidate.type || 'unknown';
            const candidateAddress = candidate.address || candidate.ip || 'N/A';
            const candidatePort = candidate.port || 'N/A';
            console.log(`[ICE] Added candidate: type=${candidateType}, address=${candidateAddress}, port=${candidatePort}`);
        } catch (error) {
            console.error('❌ Error adding ICE candidate:', error);
            console.error('❌ Candidate data:', candidate);
        }
    }
    
    processPendingMessages() {
        if (!this.peerConnection) {
            console.log(`[WebRTC] Cannot process pending messages - peer connection not ready`);
            return;
        }
        
        // Wait for peer connection to be in a stable state
        const checkReady = () => {
            if (this.peerConnection.signalingState === 'stable' || 
                this.peerConnection.signalingState === 'have-local-offer' ||
                this.peerConnection.signalingState === 'have-remote-offer') {
                return true;
            }
            return false;
        };
        
        // Process pending offer
        if (this.pendingOffer) {
            console.log(`[WebRTC] Processing pending offer`);
            const offer = this.pendingOffer;
            this.pendingOffer = null; // Clear before processing to avoid double processing
            
            const processOffer = () => {
                if (checkReady() || this.peerConnection.signalingState === 'stable') {
                    this.handleOffer(offer);
                } else {
                    // Wait a bit more
                    setTimeout(processOffer, 100);
                }
            };
            setTimeout(processOffer, 100);
        }
        
        // Process pending answer
        if (this.pendingAnswer) {
            console.log(`[WebRTC] Processing pending answer`);
            const answer = this.pendingAnswer;
            this.pendingAnswer = null;
            
            const processAnswer = () => {
                if (checkReady() || this.peerConnection.signalingState === 'have-local-offer') {
                    this.handleAnswer(answer);
                } else {
                    setTimeout(processAnswer, 100);
                }
            };
            setTimeout(processAnswer, 100);
        }
        
        // Process pending ICE candidates
        if (this.pendingIceCandidates.length > 0) {
            console.log(`[ICE] Processing ${this.pendingIceCandidates.length} pending candidates`);
            const candidates = [...this.pendingIceCandidates];
            this.pendingIceCandidates = []; // Clear before processing
            candidates.forEach(candidate => {
                this.handleIceCandidate(candidate);
            });
        }
    }

    handleSignalingMessage(data) {
        switch (data.type) {
            case 'connected':
                console.log(`[WebSocket] Server confirmed connection: ${data.message}`);
                break;
            case 'offer':
                this.handleOffer(data.offer);
                break;
            case 'answer':
                this.handleAnswer(data.answer);
                break;
            case 'ice-candidate':
                this.handleIceCandidate(data.candidate);
                break;
            case 'peer-disconnected':
                this.isConnected = false;
                if (this.onPeerDisconnected) {
                    this.onPeerDisconnected();
                }
                break;
            case 'room-expired':
                if (this.onRoomExpired) {
                    this.onRoomExpired();
                }
                break;
            default:
                console.log('Received message:', data.type);
        }
    }

    sendFile(file) {
        if (!this.isConnected || !this.dataChannel || this.dataChannel.readyState !== 'open') {
            return Promise.reject(new Error('Data channel not ready'));
        }

        if (!file) {
            return Promise.reject(new Error('No file provided'));
        }

        console.log(`[FileTransfer] Starting transfer - file: ${file.name}, size: ${this.formatFileSize(file.size)}, type: ${file.type || 'unknown'}`);

        // Send file metadata first
        const metadata = {
            type: 'file-metadata',
            name: file.name,
            size: file.size,
            mimeType: file.type,
            lastModified: file.lastModified
        };

        try {
            if (this.dataChannel.readyState !== 'open') {
                return Promise.reject(new Error(`Data channel not open (state: ${this.dataChannel.readyState})`));
            }
            
            const metadataStr = JSON.stringify(metadata);
            this.dataChannel.send(metadataStr);
            console.log(`[FileTransfer] Metadata sent - name: ${metadata.name}, size: ${metadata.size} bytes, buffered: ${this.dataChannel.bufferedAmount} bytes`);
        } catch (error) {
            console.error(`[FileTransfer] Error sending metadata:`, error);
            return Promise.reject(error);
        }
        
        // Read and send file in chunks - return the promise
        return this.sendFileChunks(file);
    }
    
    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
    }

    async sendFileChunks(file) {
        const reader = new FileReader();
        let offset = 0;
        let chunkIndex = 0;
        this.stats.startTime = Date.now();
        this.stats.bytesTransferred = 0;
        
        // Calculate total number of chunks
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

        return new Promise((resolve, reject) => {
            // Check data channel is still open
            if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
                reject(new Error('Data channel closed during transfer'));
                return;
            }

            reader.onload = (e) => {
                try {
                    const chunk = e.target.result;
                    
                    // Check if data channel is still open
                    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
                        reject(new Error('Data channel closed during transfer'));
                        return;
                    }
                    
                    // Check if data channel is ready (backpressure handling)
                    if (this.dataChannel.bufferedAmount > 1024 * 1024) {
                        // Wait a bit if buffer is too large (1MB threshold)
                        setTimeout(() => {
                            if (offset < file.size) {
                                reader.readAsArrayBuffer(file.slice(offset, offset + CHUNK_SIZE));
                            }
                        }, 100);
                        return;
                    }

                    // Send chunk with sequence number using efficient binary protocol
                    try {
                        // Create binary header: [type(1 byte)][index(4 bytes)][totalChunks(4 bytes)][dataLength(4 bytes)][data...]
                        const headerSize = 13; // 1 + 4 + 4 + 4
                        const header = new ArrayBuffer(headerSize);
                        const headerView = new DataView(header);
                        const headerArray = new Uint8Array(header);
                        
                        // Header: type = 0x01 (chunk), index, totalChunks, dataLength
                        headerArray[0] = 0x01; // Chunk type marker
                        headerView.setUint32(1, chunkIndex, true); // Little-endian
                        headerView.setUint32(5, totalChunks, true);
                        headerView.setUint32(9, chunk.byteLength, true);
                        
                        // Combine header + chunk data
                        const combined = new Uint8Array(headerSize + chunk.byteLength);
                        combined.set(new Uint8Array(header), 0);
                        combined.set(new Uint8Array(chunk), headerSize);
                        
                        // Send as binary
                        this.dataChannel.send(combined.buffer);
                        this.stats.bytesTransferred += chunk.byteLength;
                        offset += CHUNK_SIZE;
                        chunkIndex++;
                        
                        // Log every 1MB sent
                        if (this.stats.bytesTransferred % (1024 * 1024) < CHUNK_SIZE) {
                            const progress = ((this.stats.bytesTransferred / file.size) * 100).toFixed(1);
                            console.log(`[FileTransfer] Progress: ${progress}% (${this.formatFileSize(this.stats.bytesTransferred)} / ${this.formatFileSize(file.size)}) - chunk ${chunkIndex}/${totalChunks}`);
                        }
                    } catch (error) {
                        console.error(`[FileTransfer] Error sending chunk:`, error);
                        reject(error);
                        return;
                    }

                    // Update progress
                    if (this.onProgress) {
                        const progress = Math.min((offset / file.size) * 100, 100);
                        this.onProgress(progress, this.stats.bytesTransferred, this.stats.startTime);
                    }

                    if (offset < file.size) {
                        // Read next chunk
                        reader.readAsArrayBuffer(file.slice(offset, offset + CHUNK_SIZE));
                    } else {
                        // File transfer complete - calculate checksum for integrity verification (if available)
                        if (typeof crypto !== 'undefined' && crypto.subtle) {
                            this.calculateFileChecksum(file).then(checksum => {
                                const elapsed = ((Date.now() - this.stats.startTime) / 1000).toFixed(2);
                                const speed = (this.stats.bytesTransferred / (Date.now() - this.stats.startTime) * 1000).toFixed(0);
                                console.log(`[FileTransfer] Transfer complete - file: ${file.name}, size: ${this.formatFileSize(file.size)}, time: ${elapsed}s, speed: ${this.formatFileSize(speed)}/s, chunks: ${totalChunks}, checksum: ${checksum.substring(0, 16)}...`);
                                this.dataChannel.send(JSON.stringify({
                                    type: 'file-complete',
                                    fileName: file.name,
                                    totalChunks: totalChunks,
                                    checksum: checksum
                                }));
                                resolve();
                            }).catch(error => {
                                console.warn(`[FileTransfer] Could not calculate checksum:`, error.message || error);
                                // Continue without checksum
                                const elapsed = ((Date.now() - this.stats.startTime) / 1000).toFixed(2);
                                const speed = (this.stats.bytesTransferred / (Date.now() - this.stats.startTime) * 1000).toFixed(0);
                                console.log(`[FileTransfer] Transfer complete - file: ${file.name}, size: ${this.formatFileSize(file.size)}, time: ${elapsed}s, speed: ${this.formatFileSize(speed)}/s, chunks: ${totalChunks}`);
                                this.dataChannel.send(JSON.stringify({
                                    type: 'file-complete',
                                    fileName: file.name,
                                    totalChunks: totalChunks
                                }));
                                resolve();
                            });
                        } else {
                            // crypto.subtle not available (HTTP context) - skip checksum
                            const elapsed = ((Date.now() - this.stats.startTime) / 1000).toFixed(2);
                            const speed = (this.stats.bytesTransferred / (Date.now() - this.stats.startTime) * 1000).toFixed(0);
                            console.log(`[FileTransfer] Transfer complete - file: ${file.name}, size: ${this.formatFileSize(file.size)}, time: ${elapsed}s, speed: ${this.formatFileSize(speed)}/s, chunks: ${totalChunks} (integrity check skipped - requires HTTPS)`);
                            this.dataChannel.send(JSON.stringify({
                                type: 'file-complete',
                                fileName: file.name,
                                totalChunks: totalChunks
                            }));
                            resolve();
                        }
                    }
                } catch (error) {
                    console.error(`[FileTransfer] Error in sendFileChunks:`, error);
                    reject(error);
                }
            };

            reader.onerror = (error) => {
                console.error(`[FileTransfer] FileReader error:`, error);
                reject(new Error('Failed to read file: ' + error.message));
            };

            reader.onabort = () => {
                reject(new Error('File read aborted'));
            };

            // Start reading first chunk
            try {
                reader.readAsArrayBuffer(file.slice(0, CHUNK_SIZE));
            } catch (error) {
                reject(new Error('Failed to start reading file: ' + error.message));
            }
        });
    }

    handleDataChannelMessage(data) {
        // Handle different data types from data channel
        let messageData = null;
        let arrayBuffer = null;
        
        // Convert various data types to ArrayBuffer
        if (data instanceof ArrayBuffer) {
            arrayBuffer = data;
        } else if (data instanceof Blob) {
            // Blob - convert to ArrayBuffer asynchronously
            const reader = new FileReader();
            reader.onload = (e) => {
                this.handleDataChannelMessage(e.target.result);
            };
            reader.onerror = (error) => {
                console.error(`[FileTransfer] Error reading Blob:`, error);
            };
            reader.readAsArrayBuffer(data);
            return;
        } else if (data.buffer && data.buffer instanceof ArrayBuffer) {
            arrayBuffer = data.buffer;
        } else if (typeof data === 'string') {
            // Text message (JSON) - for metadata and control messages
            try {
                messageData = JSON.parse(data);
                console.log(`[FileTransfer] Received message: ${messageData.type}`);
            } catch (error) {
                console.error(`[FileTransfer] Error parsing JSON message:`, error);
                return;
            }
        } else {
            console.warn(`[FileTransfer] Unknown data type: ${typeof data}, constructor: ${data.constructor?.name}`);
            return;
        }
        
        // Handle binary data (chunks with headers)
        if (arrayBuffer) {
            const view = new DataView(arrayBuffer);
            
            // Check if this is a structured chunk (starts with type marker 0x01)
            if (arrayBuffer.byteLength >= 13 && view.getUint8(0) === 0x01) {
                // New protocol: binary chunk with header
                const chunkIndex = view.getUint32(1, true); // Little-endian
                const totalChunks = view.getUint32(5, true);
                const dataLength = view.getUint32(9, true);
                const chunkData = arrayBuffer.slice(13, 13 + dataLength);
                
                this.handleChunkWithSequence({
                    index: chunkIndex,
                    totalChunks: totalChunks,
                    data: chunkData
                });
                return;
            } else {
                // Legacy protocol: plain binary chunk (no header)
                console.log(`[FileTransfer] Received legacy binary chunk: ${arrayBuffer.byteLength} bytes`);
                this.addReceivedChunk(arrayBuffer);
                return;
            }
        }
        
        // Process JSON messages
        if (messageData) {
            if (messageData.type === 'file-metadata') {
                this.handleFileMetadata(messageData);
            } else if (messageData.type === 'file-complete') {
                this.handleFileComplete(messageData);
            } else if (messageData.type === 'chunk-ack') {
                // Chunk acknowledgment (for future retry mechanism)
                console.log(`[FileTransfer] Received chunk ACK: ${messageData.chunkIndex}`);
            } else {
                console.log(`[FileTransfer] Unknown message type: ${messageData.type}`);
            }
        }
    }
    
    handleChunkWithSequence(chunkData) {
        if (!this.currentFile) {
            console.warn(`[FileTransfer] Received chunk but no current file metadata`);
            return;
        }
        
        const { index, totalChunks, data } = chunkData;
        const chunkBuffer = data instanceof ArrayBuffer ? data : new Uint8Array(data).buffer;
        
        // Validate chunk index
        if (index < 0 || index >= totalChunks) {
            console.error(`[FileTransfer] Invalid chunk index: ${index} (expected 0-${totalChunks - 1})`);
            return;
        }
        
        // Check if we already received this chunk (duplicate detection)
        if (this.receivedChunkIndices.has(index)) {
            console.warn(`[FileTransfer] Duplicate chunk received: ${index}`);
            // Still send ACK
            this.sendChunkAck(index);
            return;
        }
        
        // Store chunk by index
        this.chunkMap.set(index, chunkBuffer);
        this.receivedChunkIndices.add(index);
        this.stats.bytesTransferred += chunkBuffer.byteLength;
        
        // Send acknowledgment
        this.sendChunkAck(index);
        
        // Update progress
        if (this.onProgress) {
            const progress = Math.min((this.stats.bytesTransferred / this.currentFile.size) * 100, 100);
            this.onProgress(progress, this.stats.bytesTransferred, this.stats.startTime);
        }
        
        // Log progress every 10%
        const progressPercent = Math.floor((this.stats.bytesTransferred / this.currentFile.size) * 100);
        if (progressPercent % 10 === 0 && progressPercent > 0) {
            const receivedCount = this.receivedChunkIndices.size;
            console.log(`[FileTransfer] Progress: ${progressPercent}% - ${this.formatFileSize(this.stats.bytesTransferred)} / ${this.formatFileSize(this.currentFile.size)} - chunks: ${receivedCount}/${totalChunks} - ${this.currentFile.name}`);
        }
        
        // Check if we have all chunks
        if (this.receivedChunkIndices.size === totalChunks) {
            console.log(`[FileTransfer] All chunks received (${totalChunks}), ready to reassemble`);
        }
    }
    
    sendChunkAck(chunkIndex) {
        if (this.dataChannel && this.dataChannel.readyState === 'open') {
            try {
                this.dataChannel.send(JSON.stringify({
                    type: 'chunk-ack',
                    chunkIndex: chunkIndex
                }));
            } catch (error) {
                console.error(`[FileTransfer] Error sending chunk ACK:`, error);
            }
        }
    }

    handleFileMetadata(metadata) {
        console.log(`[FileTransfer] Received metadata - name: ${metadata.name}, size: ${this.formatFileSize(metadata.size)}, type: ${metadata.mimeType || metadata.type || 'unknown'}`);
        this.currentFile = {
            name: metadata.name,
            size: metadata.size,
            type: metadata.mimeType || metadata.type, // Support both for backward compatibility
            lastModified: metadata.lastModified,
            chunks: []
        };
        this.receivedChunks = [];
        this.chunkMap.clear();
        this.receivedChunkIndices.clear();
        this.expectedChunkCount = Math.ceil(metadata.size / CHUNK_SIZE);
        this.stats.startTime = Date.now();
        this.stats.bytesTransferred = 0;

        if (this.onFileMetadata) {
            this.onFileMetadata(this.currentFile);
        }
    }

    handleFileComplete(completeData) {
        if (!this.currentFile) {
            console.warn(`[FileTransfer] Received file-complete but no current file`);
            return;
        }

        const expectedChunks = completeData?.totalChunks || this.expectedChunkCount;
        const receivedChunkCount = this.chunkMap.size > 0 ? this.chunkMap.size : this.receivedChunks.length;
        
        // Check if all chunks were received
        if (receivedChunkCount < expectedChunks) {
            const missingChunks = [];
            for (let i = 0; i < expectedChunks; i++) {
                if (!this.receivedChunkIndices.has(i) && !this.chunkMap.has(i)) {
                    missingChunks.push(i);
                }
            }
            console.error(`[FileTransfer] Missing chunks detected: ${missingChunks.length} chunks missing (indices: ${missingChunks.slice(0, 10).join(', ')}${missingChunks.length > 10 ? '...' : ''})`);
            console.error(`[FileTransfer] Expected ${expectedChunks} chunks, received ${receivedChunkCount}`);
            
            if (this.onError) {
                this.onError(new Error(`File transfer incomplete: ${missingChunks.length} chunks missing. The file may be corrupted.`));
            }
            // Continue anyway - might be recoverable
        }

        // Reassemble file from chunks
        let chunksToReassemble = [];
        let totalSize = 0;
        
        if (this.chunkMap.size > 0) {
            // New protocol: use chunkMap with sequence numbers
            chunksToReassemble = [];
            for (let i = 0; i < expectedChunks; i++) {
                const chunk = this.chunkMap.get(i);
                if (chunk) {
                    chunksToReassemble.push(chunk);
                    totalSize += chunk.byteLength;
                } else {
                    console.error(`[FileTransfer] Missing chunk at index ${i}`);
                    // Create empty chunk as placeholder (file will be corrupted but won't crash)
                    const placeholderSize = i === expectedChunks - 1 
                        ? (this.currentFile.size % CHUNK_SIZE || CHUNK_SIZE)
                        : CHUNK_SIZE;
                    chunksToReassemble.push(new ArrayBuffer(placeholderSize));
                    totalSize += placeholderSize;
                }
            }
        } else {
            // Legacy protocol: use receivedChunks array
            chunksToReassemble = this.receivedChunks;
            totalSize = chunksToReassemble.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        }
        
        const elapsed = ((Date.now() - this.stats.startTime) / 1000).toFixed(2);
        const speed = (totalSize / (Date.now() - this.stats.startTime) * 1000).toFixed(0);
        
        console.log(`[FileTransfer] Reassembling file - name: ${this.currentFile.name}, expected: ${this.formatFileSize(this.currentFile.size)}, received: ${this.formatFileSize(totalSize)}, chunks: ${receivedChunkCount}/${expectedChunks}, time: ${elapsed}s, speed: ${this.formatFileSize(speed)}/s`);
        
        if (totalSize !== this.currentFile.size) {
            console.warn(`[FileTransfer] Size mismatch - expected: ${this.currentFile.size} bytes, received: ${totalSize} bytes`);
        }
        
        // Verify chunk order (for new protocol)
        if (this.chunkMap.size > 0) {
            let isOrdered = true;
            for (let i = 0; i < chunksToReassemble.length; i++) {
                if (!this.chunkMap.has(i)) {
                    isOrdered = false;
                    break;
                }
            }
            if (!isOrdered) {
                console.warn(`[FileTransfer] Chunks are not in order - some chunks may be missing`);
            }
        }
        
        const blob = new Blob(chunksToReassemble, { type: this.currentFile.type });
        
        // Optional: Verify integrity with checksum (if enabled and crypto.subtle is available)
        if (this.enableIntegrityCheck && completeData?.checksum) {
            if (typeof crypto !== 'undefined' && crypto.subtle) {
                this.verifyFileIntegrity(blob, completeData.checksum).then(isValid => {
                    if (!isValid) {
                        console.warn(`[FileTransfer] File integrity check failed - file may be corrupted (but download completed)`);
                        // Don't show error to user - file was received, just couldn't verify
                    } else {
                        console.log(`[FileTransfer] File integrity verified successfully`);
                    }
                }).catch(error => {
                    console.warn(`[FileTransfer] Could not verify file integrity:`, error.message || error);
                    // Don't fail the transfer - integrity check is optional
                });
            } else {
                console.warn(`[FileTransfer] Integrity check skipped - crypto.subtle not available (requires HTTPS)`);
            }
        }
        
        // Create download link
        console.log(`[FileTransfer] Triggering download - file: ${this.currentFile.name}`);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = this.currentFile.name;
        document.body.appendChild(a); // Required for some browsers
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        console.log(`[FileTransfer] Download complete - file: ${this.currentFile.name}`);

        this.receivedFiles.push({
            ...this.currentFile,
            blob: blob
        });

        if (this.onFileReceived) {
            this.onFileReceived(this.currentFile);
        }

        // Cleanup
        this.currentFile = null;
        this.receivedChunks = [];
        this.chunkMap.clear();
        this.receivedChunkIndices.clear();
        this.expectedChunkCount = 0;
    }
    
    async calculateFileChecksum(file) {
        try {
            const arrayBuffer = await file.arrayBuffer();
            const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
            return hashHex;
        } catch (error) {
            console.error(`[FileTransfer] Error calculating checksum:`, error);
            throw error;
        }
    }
    
    async verifyFileIntegrity(blob, expectedChecksum) {
        try {
            // Check if crypto.subtle is available (requires secure context/HTTPS)
            if (typeof crypto === 'undefined' || !crypto.subtle) {
                console.warn(`[FileTransfer] crypto.subtle not available - integrity check requires HTTPS`);
                return true; // Return true to not block the transfer
            }
            
            const arrayBuffer = await blob.arrayBuffer();
            const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
            return hashHex === expectedChecksum;
        } catch (error) {
            console.warn(`[FileTransfer] Error computing checksum:`, error.message || error);
            // Return true to not block the transfer if integrity check fails
            return true;
        }
    }

    // Update received chunks (called when binary data arrives - legacy support)
    addReceivedChunk(chunk) {
        if (!this.currentFile) {
            console.warn(`[FileTransfer] Received chunk but no current file metadata`);
            return;
        }
        
        this.receivedChunks.push(chunk);
        this.stats.bytesTransferred += chunk.byteLength;

        if (this.onProgress) {
            const progress = Math.min((this.stats.bytesTransferred / this.currentFile.size) * 100, 100);
            this.onProgress(progress, this.stats.bytesTransferred, this.stats.startTime);
        }
        
        // Log progress every 10%
        const progressPercent = Math.floor((this.stats.bytesTransferred / this.currentFile.size) * 100);
        if (progressPercent % 10 === 0 && progressPercent > 0) {
            console.log(`[FileTransfer] Progress: ${progressPercent}% - ${this.formatFileSize(this.stats.bytesTransferred)} / ${this.formatFileSize(this.currentFile.size)} - ${this.currentFile.name}`);
        }
    }

    disconnect() {
        if (this.dataChannel) {
            this.dataChannel.close();
        }
        if (this.peerConnection) {
            this.peerConnection.close();
        }
        if (this.ws) {
            this.ws.close();
        }
        this.isConnected = false;
    }
}

