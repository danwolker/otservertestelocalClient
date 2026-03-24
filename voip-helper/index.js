'use strict';

const WebSocket = require('ws');
const { OpusEncoder } = require('@discordjs/opus');

const {
    setCaptureMode,
    detectLoopbackDevice,
    listAudioDevices,
    sendPcmChunk,
    startSystemAudio,
    startMicAudio,
    startPlayback,
    handleClientCommand,
    listAudioOutputDevices,
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

const opus = new OpusEncoder(SAMPLE_RATE, CHANNELS);

// ────────────────────────────────────────
// Speaker (reprodução de áudio recebido via naudiodon)
// ────────────────────────────────────────
let speaker = null;
let testAudioInput = null;

// ────────────────────────────────────────
// 1. Servidor WebSocket local → OTClient
// ────────────────────────────────────────
const wss = new WebSocket.Server({ host: '127.0.0.1', port: LOCAL_PORT });
console.log(`>> [VoIP Helper] Escutando OTClient em ws://localhost:${LOCAL_PORT}`);

wss.on('connection', (ws) => {
    console.log('>> [VoIP Helper] OTClient conectado localmente.');
    localWs = ws;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log(`>> [VoIP Helper] Comando recebido: ${data.type}`);
            handleClientCommand(data, {
                connect:      (url, key) => connectToMainVoip(url, key),
                startCapture: () => startCapture(),
                stopCapture:  () => stopCapture(),
                listDevices:  async () => await sendDeviceList(),
                listDevicesOut: async () => await sendDeviceListOut(),
                setDeviceOut: (deviceId) => {
                    console.log(`>> [VoIP Helper] Selecionando Speaker ID: ${deviceId}`);
                    if (speaker) {
                        speaker.end();
                        speaker = null;
                    }
                },
                testStart:    () => startAudioTest(),
                testStop:     () => stopAudioTest(),
            });
        } catch (e) {
            console.error('>> [VoIP Helper] Erro ao processar comando do Client:', e);
        }
    });

    ws.on('close', () => {
        console.log('>> [VoIP Helper] OTClient desconectado.');
        stopCapture();
        if (mainVoipWs) mainVoipWs.close();
        if (statusInterval) {
            clearInterval(statusInterval);
            statusInterval = null;
        }
    });

    startStatusHeartbeat();
});

// ────────────────────────────────────────
// 2. Dispatcher de captura
// ────────────────────────────────────────

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
// 3. Captura de Microfone (PowerShell)
// ────────────────────────────────────────
function startMic() {
    console.log('>> [VoIP Helper] Iniciando captura de Microfone (PowerShell)...');
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
async function sendDeviceList() {
    const devices = await listAudioDevices();
    console.log('>> [VoIP Helper] Enviando lista de microfones:', devices.map(d => d.name));
    if (localWs) localWs.send(JSON.stringify({ type: 'DEVICE_LIST', devices }));
}

async function sendDeviceListOut() {
    const devices = await listAudioOutputDevices();
    console.log('>> [VoIP Helper] Enviando lista de saídas:', devices.map(d => d.name));
    if (localWs) localWs.send(JSON.stringify({ type: 'DEVICE_LIST_OUT', devices }));
}

// ────────────────────────────────────────
// 4b. Teste de Áudio (Loopback)
// ────────────────────────────────────────
function startAudioTest() {
    console.log('>> [VoIP Helper] Iniciando Teste de Áudio (Loopback)...');
    if (testAudioInput) stopAudioTest();
    
    // Garantir que temos um speaker ativo para o teste
    if (!speaker) speaker = startPlayback();

    testAudioInput = startMicAudio(
        (chunk) => {
            if (speaker) speaker.write(chunk);
        },
        (e) => console.error('>> [VoIP Helper] Erro no teste de áudio:', e)
    );
}

function stopAudioTest() {
    console.log('>> [VoIP Helper] Parando Teste de Áudio.');
    if (testAudioInput) {
        try { testAudioInput.quit(); } catch (_) {}
        testAudioInput = null;
    }
}

// ────────────────────────────────────────
// 5. Conexão ao VoIP Server Principal
// ────────────────────────────────────────
function connectToMainVoip(url, sessionKey) {
    if (mainVoipWs) mainVoipWs.close();
    
    // Garantir speaker para áudio remoto
    if (!speaker) speaker = startPlayback();

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
    });

    mainVoipWs.on('error', (e) => {
        console.error('>> [VoIP Helper] Erro na conexão com o Servidor Principal:', e.message);
    });
}

function startStatusHeartbeat() {
    if (statusInterval) clearInterval(statusInterval);
    
    statusInterval = setInterval(() => {
        // Ping ao server principal se estiver conectado
        if (mainVoipWs && mainVoipWs.readyState === WebSocket.OPEN) {
            lastPingTime = Date.now();
            mainVoipWs.send(JSON.stringify({ type: 'ping' }));
        }

        // Heartbeat para o OTClient
        if (localWs && localWs.readyState === WebSocket.OPEN) {
            let status = 'offline';
            if (mainVoipWs && mainVoipWs.readyState === WebSocket.OPEN) {
                status = currentLatency < 150 ? 'stable' : 'unstable';
            }

            const state = _getState();
            localWs.send(JSON.stringify({
                type: 'STATUS_UPDATE',
                voiceLevel: state.voiceLevel,
                members: [
                    { 
                        name: 'LOCAL_USER', 
                        latency: currentLatency, 
                        status: status
                    }
                ]
            }));
        }
    }, 2000); // 2s é suficiente para manter a conexão ativa e não pesar
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
