'use strict';

const WebSocket = require('ws');
const record = require('node-record-lpcm16');
const OpusScript = require('opusscript');
const Speaker = require('speaker');

const {
    setCaptureMode,
    detectLoopbackDevice,
    listAudioDevices,
    sendPcmChunk,
    startSystemAudio,
    handleClientCommand,
    SAMPLE_RATE,
    CHANNELS,
    FRAME_SIZE,
    _getState,
} = require('./src/audioCapture');

// ────────────────────────────────────────
// Configurações Locais
// ────────────────────────────────────────
const LOCAL_PORT = 3002;
let localWs = null;
let mainVoipWs = null;
let lastPingTime = 0;
let currentLatency = 0;
let statusInterval = null;

const opus = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.VOIP);

// ────────────────────────────────────────
// Speaker (reprodução de áudio recebido)
// ────────────────────────────────────────
const speaker = new Speaker({
    channels: CHANNELS,
    bitDepth: 16,
    sampleRate: SAMPLE_RATE,
});

// ────────────────────────────────────────
// 1. Servidor WebSocket local → OTClient
// ────────────────────────────────────────
const wss = new WebSocket.Server({ port: LOCAL_PORT });
console.log(`>> [VoIP Helper] Escutando OTClient em ws://localhost:${LOCAL_PORT}`);

wss.on('connection', (ws) => {
    console.log('>> [VoIP Helper] OTClient conectado localmente.');
    localWs = ws;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            handleClientCommand(data, {
                connect:      (url, key) => connectToMainVoip(url, key),
                startCapture: () => startCapture(),
                stopCapture:  () => stopCapture(),
                listDevices:  () => sendDeviceList(),
            });
        } catch (e) {
            console.error('>> [VoIP Helper] Erro ao processar comando do Client:', e);
        }
    });

    ws.on('close', () => {
        console.log('>> [VoIP Helper] OTClient desconectado.');
        stopCapture();
        if (mainVoipWs) mainVoipWs.close();
    });
});

// ────────────────────────────────────────
// 2. Dispatcher de captura
// ────────────────────────────────────────
let micStream = null;

function startCapture() {
    const state = _getState();
    if (state.isTalking) return;

    if (state.captureMode === 'system') {
        startSystemAudio(
            (chunk) => sendPcmChunk(chunk, mainVoipWs, opus, WebSocket.OPEN),
            (e) => console.error('>> [VoIP Helper] Erro na captura de sistema:', e)
        );
    } else {
        startMic();
    }
}

function stopCapture() {
    stopMic();
    const state = _getState();
    if (state.systemAudioInput) {
        try { state.systemAudioInput.quit(); } catch (_) {}
        state.systemAudioInput = null;
    }
    state.isTalking = false;
}

// ────────────────────────────────────────
// 3. Captura de Microfone
// ────────────────────────────────────────
function startMic() {
    console.log('>> [VoIP Helper] Iniciando captura de Microfone (naudiodon)...');
    startMicAudio(
        (chunk) => sendPcmChunk(chunk, mainVoipWs, opus, WebSocket.OPEN),
        (e) => console.error('>> [VoIP Helper] Erro no microfone:', e)
    );
}

function stopMic() {
    const state = _getState();
    if (state.micAudioInput) {
        console.log('>> [VoIP Helper] Microfone desativado.');
        try { state.micAudioInput.quit(); } catch (_) {}
        state.micAudioInput = null;
    }
    state.isTalking = false;
}

// ────────────────────────────────────────
// 4. Lista de dispositivos para o OTClient
// ────────────────────────────────────────
function sendDeviceList() {
    const devices = listAudioDevices();
    if (localWs) localWs.send(JSON.stringify({ type: 'DEVICE_LIST', devices }));
    console.log('>> [VoIP Helper] Dispositivos enviados ao OTClient:', devices.length);
}

// ────────────────────────────────────────
// 5. Conexão ao VoIP Server Principal
// ────────────────────────────────────────
function connectToMainVoip(url, sessionKey) {
    if (mainVoipWs) mainVoipWs.close();

    console.log(`>> [VoIP Helper] Conectando ao Servidor Principal: ${url}`);
    mainVoipWs = new WebSocket(url);

    mainVoipWs.on('open', () => {
        console.log('>> [VoIP Helper] Conectado ao Servidor Principal. Autenticando...');
        mainVoipWs.send(JSON.stringify({ type: 'auth', sessionKey }));
    });

    mainVoipWs.on('message', (data) => {
        if (Buffer.isBuffer(data)) {
            handleIncomingAudio(data);
        } else {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'pong') {
                currentLatency = Date.now() - lastPingTime;
            } else if (localWs) {
                localWs.send(data.toString());
            }
        }
    });

    mainVoipWs.on('close', (code) => {
        console.log(`>> [VoIP Helper] Desconectado do Servidor Principal. Código: ${code}`);
        if (statusInterval) clearInterval(statusInterval);
    });

    // Start Ping and Status reporting
    if (statusInterval) clearInterval(statusInterval);
    statusInterval = setInterval(() => {
        if (mainVoipWs && mainVoipWs.readyState === WebSocket.OPEN) {
            lastPingTime = Date.now();
            mainVoipWs.send(JSON.stringify({ type: 'ping' }));
        }

        // Send update to OTClient
        if (localWs) {
            const state = _getState();
            localWs.send(JSON.stringify({
                type: 'STATUS_UPDATE',
                members: [
                    { 
                        name: 'LOCAL_USER', // OTClient will handle mapping to current character
                        latency: currentLatency, 
                        status: (mainVoipWs && mainVoipWs.readyState === WebSocket.OPEN) ? 'online' : 'offline'
                    }
                ]
            }));
        }
    }, 2000);

    mainVoipWs.on('error', (e) => {
        console.error('>> [VoIP Helper] Erro na conexão com o Servidor Principal:', e.message);
    });
}

// ────────────────────────────────────────
// 6. Reprodução de Áudio Recebido
// ────────────────────────────────────────
function handleIncomingAudio(encodedBuffer) {
    try {
        const decoded = opus.decode(encodedBuffer);
        speaker.write(decoded);
    } catch (e) {
        console.error('>> [VoIP Helper] Erro ao decodificar áudio:', e);
    }
}
