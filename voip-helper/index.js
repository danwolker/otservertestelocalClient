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
    const state = _getState();
    state.isTalking = true;
    console.log('>> [VoIP Helper] Microfone ativado.');

    micStream = record.record({
        sampleRate: SAMPLE_RATE,
        threshold: 0,
        verbose: false,
    }).stream();

    micStream.on('data', (chunk) => {
        sendPcmChunk(chunk, mainVoipWs, opus, WebSocket.OPEN);
    });

    micStream.on('error', (e) => {
        console.error('>> [VoIP Helper] Erro no microfone:', e);
    });
}

function stopMic() {
    if (micStream) {
        console.log('>> [VoIP Helper] Microfone desativado.');
        micStream.destroy();
        micStream = null;
    }
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
            if (localWs) localWs.send(data);
        }
    });

    mainVoipWs.on('close', (code) => {
        console.log(`>> [VoIP Helper] Desconectado do Servidor Principal. Código: ${code}`);
    });

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
