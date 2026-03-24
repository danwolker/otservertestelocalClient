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
const opus = new OpusEncoder(SAMPLE_RATE, CHANNELS);

// ────────────────────────────────────────
// 1. Servidor WebSocket local → OTClient
// ────────────────────────────────────────
const wss = new WebSocket.Server({ host: '127.0.0.1', port: LOCAL_PORT });
console.log(`>> [VoIP Helper] Escutando OTClient em ws://localhost:${LOCAL_PORT}`);

wss.on('connection', (ws) => {
    console.log('>> [VoIP Helper] Novo OTClient conectado localmente.');
    
    // Contexto único para esta conexão
    const clientCtx = {
        localWs: ws,
        mainVoipWs: null,
        speaker: null,
        testAudioInput: null,
        currentLatency: 0,
        lastPingTime: 0,
        statusInterval: null
    };

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log(`>> [VoIP Helper] Comando recebido: ${data.type}`);
            handleClientCommand(data, {
                connect:      (url, key) => connectToMainVoip(clientCtx, url, key),
                startCapture: () => startCapture(clientCtx),
                stopCapture:  () => stopCapture(clientCtx),
                listDevices:  async () => await sendDeviceList(clientCtx),
                listDevicesOut: async () => await sendDeviceListOut(clientCtx),
                setDeviceOut: (deviceId) => {
                    console.log(`>> [VoIP Helper] Selecionando Speaker ID: ${deviceId}`);
                    if (clientCtx.speaker) {
                        clientCtx.speaker.end();
                        clientCtx.speaker = null;
                        // O proximo audio recebido reativará o speaker
                    }
                },
                testStart:    () => startAudioTest(clientCtx),
                testStop:     () => stopAudioTest(clientCtx),
                ping:         () => {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'PONG' }));
                    }
                }
            });
        } catch (e) {
            console.error('>> [VoIP Helper] Erro ao processar comando do Client:', e);
        }
    });

    ws.on('close', () => {
        console.log('>> [VoIP Helper] OTClient desconectado.');
        stopCapture(clientCtx);
        if (clientCtx.mainVoipWs) clientCtx.mainVoipWs.close();
        if (clientCtx.statusInterval) {
            clearInterval(clientCtx.statusInterval);
            clientCtx.statusInterval = null;
        }
        if (clientCtx.speaker) {
            clientCtx.speaker.end();
            clientCtx.speaker = null;
        }
    });

    startStatusHeartbeat(clientCtx);
});

// ────────────────────────────────────────
// 2. Dispatcher de captura
// ────────────────────────────────────────

function startCapture(ctx) {
    const state = _getState();
    if (state.isTalking) return;

    if (state.captureMode === 'system') {
        startSystemAudio(
            (chunk) => sendPcmChunk(chunk, ctx.mainVoipWs, opus, WebSocket.OPEN),
            (e) => console.error('>> [VoIP Helper] Erro na captura de sistema:', e)
        );
    } else {
        startMic(ctx);
    }
}

function stopCapture(ctx) {
    stopMic(ctx);
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
function startMic(ctx) {
    console.log('>> [VoIP Helper] Iniciando captura de Microfone (PowerShell)...');
    startMicAudio(
        (chunk) => sendPcmChunk(chunk, ctx.mainVoipWs, opus, WebSocket.OPEN),
        (e) => console.error('>> [VoIP Helper] Erro no microfone:', e)
    );
}

function stopMic(ctx) {
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
async function sendDeviceList(ctx) {
    const devices = await listAudioDevices();
    console.log('>> [VoIP Helper] Enviando lista de microfones:', devices.map(d => d.name));
    if (ctx.localWs && ctx.localWs.readyState === WebSocket.OPEN) {
        ctx.localWs.send(JSON.stringify({ type: 'DEVICE_LIST', devices }));
    }
}

async function sendDeviceListOut(ctx) {
    const devices = await listAudioOutputDevices();
    console.log('>> [VoIP Helper] Enviando lista de saídas:', devices.map(d => d.name));
    if (ctx.localWs && ctx.localWs.readyState === WebSocket.OPEN) {
        ctx.localWs.send(JSON.stringify({ type: 'DEVICE_LIST_OUT', devices }));
    }
}

// ────────────────────────────────────────
// 4b. Teste de Áudio (Loopback)
// ────────────────────────────────────────
function startAudioTest(ctx) {
    console.log('>> [VoIP Helper] Iniciando Teste de Áudio (Loopback)...');
    if (ctx.testAudioInput) stopAudioTest(ctx);
    
    // Garantir que temos um speaker ativo para o teste
    if (!ctx.speaker) ctx.speaker = startPlayback();

    ctx.testAudioInput = startMicAudio(
        (chunk) => {
            if (ctx.speaker) ctx.speaker.write(chunk);
        },
        (e) => console.error('>> [VoIP Helper] Erro no teste de áudio:', e)
    );
}

function stopAudioTest(ctx) {
    console.log('>> [VoIP Helper] Parando Teste de Áudio.');
    if (ctx.testAudioInput) {
        try { ctx.testAudioInput.quit(); } catch (_) {}
        ctx.testAudioInput = null;
    }
}

// ────────────────────────────────────────
// 5. Conexão ao VoIP Server Principal
// ────────────────────────────────────────
function connectToMainVoip(ctx, url, sessionKey) {
    if (ctx.mainVoipWs) ctx.mainVoipWs.close();
    
    // Garantir speaker para áudio remoto
    if (!ctx.speaker) ctx.speaker = startPlayback();

    console.log(`>> [VoIP Helper] Conectando ao Servidor Principal: ${url}`);
    ctx.mainVoipWs = new WebSocket(url);

    ctx.mainVoipWs.on('open', () => {
        console.log(`>> [VoIP Helper] Conectado ao Servidor Principal. Autenticando com chave: ${sessionKey.substring(0, 8)}...`);
        ctx.mainVoipWs.send(JSON.stringify({ type: 'auth', sessionKey }));
    });

    ctx.mainVoipWs.on('message', (data) => {
        if (Buffer.isBuffer(data)) {
            handleIncomingAudio(ctx, data);
        } else {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'pong') {
                    ctx.currentLatency = Date.now() - ctx.lastPingTime;
                } else if (msg.type === 'welcome') {
                    console.log(`>> [VoIP Helper] Autenticado com sucesso! Recebido: ${msg.charName}`);
                } else if (msg.type === 'member_joined') {
                    console.log(`>> [VoIP Helper] Novo membro na sala: ${msg.charName}`);
                } else if (ctx.localWs && ctx.localWs.readyState === WebSocket.OPEN) {
                    ctx.localWs.send(data.toString());
                }
            } catch (e) {
                console.error('>> [VoIP Helper] Erro ao processar mensagem JSON do servidor:', e);
            }
        }
    });

    ctx.mainVoipWs.on('close', (code, reason) => {
        console.log(`>> [VoIP Helper] Desconectado do Servidor Principal. Código: ${code}, Razão: ${reason.toString()}`);
    });

    ctx.mainVoipWs.on('error', (e) => {
        console.error('>> [VoIP Helper] Erro na conexão com o Servidor Principal:', e.message);
    });
}

function startStatusHeartbeat(ctx) {
    if (ctx.statusInterval) clearInterval(ctx.statusInterval);
    
    ctx.statusInterval = setInterval(() => {
        // Ping ao server principal se estiver conectado
        if (ctx.mainVoipWs && ctx.mainVoipWs.readyState === WebSocket.OPEN) {
            ctx.lastPingTime = Date.now();
            ctx.mainVoipWs.send(JSON.stringify({ type: 'ping' }));
        }

        // Heartbeat para o OTClient
        if (ctx.localWs && ctx.localWs.readyState === WebSocket.OPEN) {
            let status = 'offline';
            if (ctx.mainVoipWs && ctx.mainVoipWs.readyState === WebSocket.OPEN) {
                status = ctx.currentLatency < 150 ? 'stable' : 'unstable';
            }

            const state = _getState();
            ctx.localWs.send(JSON.stringify({
                type: 'STATUS_UPDATE',
                voiceLevel: state.voiceLevel,
                members: [
                    { 
                        name: 'LOCAL_USER', 
                        latency: ctx.currentLatency, 
                        status: status
                    }
                ]
            }));
        }
    }, 200);
}

// ────────────────────────────────────────
// 6. Reprodução de Áudio Recebido
// ────────────────────────────────────────
function handleIncomingAudio(ctx, encodedBuffer) {
    try {
        if (!ctx.speaker) ctx.speaker = startPlayback();
        const decoded = opus.decode(encodedBuffer);
        ctx.speaker.write(decoded);
    } catch (e) {
        console.error('>> [VoIP Helper] Erro ao decodificar áudio:', e);
    }
}
