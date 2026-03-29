'use strict';

const WebSocket = require('ws');
const { OpusEncoder } = require('@discordjs/opus');
const AudioMixer = require('./src/audioMixer');

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
// Remover opus global para evitar corrupção de estado entre encode/decode

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
        statusInterval: null,
        captureEncoder: new OpusEncoder(SAMPLE_RATE, CHANNELS),
        decoders: new Map(), // playerId -> OpusEncoder
        mixer: null
    };

    // Inicializar o Mixer
    clientCtx.mixer = new AudioMixer((mixedFrame) => {
        if (clientCtx.speaker) {
            clientCtx.speaker.write(mixedFrame);
        }
    }, {
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
        frameSize: FRAME_SIZE
    });

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log(`>> [VoIP Helper] Comando recebido: ${data.type}`);

            // ─── Comandos de controle de sala: repassar direto ao VoIP server ───
            if (data.type === 'MUTE_MEMBER') {
                // Mute local: instruir o servidor a não repassar áudio de targetId para este cliente
                if (clientCtx.mainVoipWs && clientCtx.mainVoipWs.readyState === WebSocket.OPEN) {
                    clientCtx.mainVoipWs.send(JSON.stringify({
                        type: 'mute_member',
                        targetPlayerId: data.targetId,
                        muted: data.muted
                    }));
                    console.log(`>> [VoIP Helper] Mute local enviado ao servidor: ID ${data.targetId} -> ${data.muted}`);
                } else {
                    console.warn('>> [VoIP Helper] MUTE_MEMBER ignorado: sem conexão com servidor principal');
                }
                return;
            }

            if (data.type === 'GLOBAL_MUTE' || data.type === 'REPORT' || data.type === 'REPORT_GENERAL') {
                if (clientCtx.mainVoipWs && clientCtx.mainVoipWs.readyState === WebSocket.OPEN) {
                    clientCtx.mainVoipWs.send(JSON.stringify(data));
                    console.log(`>> [VoIP Helper] Comando ${data.type} repassado ao servidor.`);
                } else {
                    console.warn(`>> [VoIP Helper] ${data.type} ignorado: sem conexão com servidor principal`);
                }
                return;
            }

            // ─── Outros comandos: delegar ao audioCapture ───
            handleClientCommand(data, {
                connect:      (url, key) => connectToMainVoip(clientCtx, url, key),
                startCapture: () => startCapture(clientCtx),
                stopCapture:  () => stopCapture(clientCtx),
                listDevices:  async () => await sendDeviceList(clientCtx),
                listDevicesOut: async () => await sendDeviceListOut(clientCtx),
                setDevice: (deviceId) => {
                    console.log(`>> [VoIP Helper] Novo microfone selecionado: ${deviceId}`);
                    const state = _getState();
                    if (state.isTalking) {
                        console.log('>> [VoIP Helper] Reiniciando captura com novo dispositivo...');
                        stopCapture(clientCtx);
                        startCapture(clientCtx);
                    }
                },
                setDeviceOut: (deviceId) => {
                    console.log(`>> [VoIP Helper] EVENTO: Troca de saída de áudio para ID: ${deviceId}`);
                    if (clientCtx.speaker) {
                        console.log('>> [VoIP Helper] Encerrando speaker atual...');
                        try {
                            clientCtx.speaker.end();
                        } catch (e) {
                            console.error('>> [VoIP Helper] Erro ao encerrar speaker:', e);
                        }
                        clientCtx.speaker = null;
                        console.log('>> [VoIP Helper] Speaker limpo. Aguardando novo áudio para reiniciar...');
                    } else {
                        console.log('>> [VoIP Helper] Nenhum speaker ativo para encerrar.');
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
        if (clientCtx.mixer) {
            clientCtx.mixer.stop();
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

    if (!ctx.mainVoipWs || ctx.mainVoipWs.readyState !== WebSocket.OPEN) {
        console.warn('>> [VoIP Helper] startCapture: WebSocket principal não está conectado! Aguardando CONNECT do servidor...');
    }

    if (state.captureMode === 'system') {
        startSystemAudio(
            (chunk) => sendPcmChunk(chunk, ctx.mainVoipWs, ctx.captureEncoder, WebSocket.OPEN),
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
        (chunk) => {
            // Acessa ctx.mainVoipWs em tempo de execução (não captura o valor antigo no closure)
            if (!ctx.mainVoipWs || ctx.mainVoipWs.readyState !== WebSocket.OPEN) {
                if (!ctx._lastWsWarnTime || Date.now() - ctx._lastWsWarnTime > 2000) {
                    console.warn('>> [VoIP Helper] sendPcmChunk ignorado: WebSocket principal não está OPEN (state:', ctx.mainVoipWs?.readyState, ')');
                    ctx._lastWsWarnTime = Date.now();
                }
                return;
            }
            sendPcmChunk(chunk, ctx.mainVoipWs, ctx.captureEncoder, WebSocket.OPEN);
        },
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
// Nota: O teste usa PCM direto no Speaker, sem passar pelo Opus.

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

    ctx.mainVoipWs.on('message', (data, isBinary) => {
        if (isBinary) {
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
        if (ctx.localWs && ctx.localWs.readyState === WebSocket.OPEN) {
            ctx.localWs.send(JSON.stringify({ 
                type: 'STATUS_UPDATE', 
                status: 'offline', 
                members: [{ name: 'LOCAL_USER', status: 'offline' }] 
            }));
        }
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
function handleIncomingAudio(ctx, rawData) {
    try {
        if (!ctx.speaker) ctx.speaker = startPlayback();
        
        if (rawData.length < 8) return;
        
        const hex = rawData.slice(0, 8).toString('hex');
        const playerId = rawData.readUInt32LE(0);
        const encodedBuffer = rawData.slice(4);

        if (!ctx.lastAudioLog || Date.now() - ctx.lastAudioLog > 3000) {
            console.log(`>> [VoIP Helper] Audio received: [Hex: ${hex}] [PlayerID: ${playerId}] [Size: ${rawData.length}]`);
            ctx.lastAudioLog = Date.now();
        }

        let decoder = ctx.decoders.get(playerId);
        if (!decoder) {
            console.log(`>> [VoIP Helper] Criando novo Decoder para player ID: ${playerId}`);
            decoder = new OpusEncoder(SAMPLE_RATE, CHANNELS);
            ctx.decoders.set(playerId, decoder);
        }

        const decoded = decoder.decode(encodedBuffer);
        
        // Em vez de escrever direto, enviamos para o Mixer
        ctx.mixer.addAudio(playerId, decoded);
    } catch (e) {
        console.error('>> [VoIP Helper] Erro ao decodificar áudio:', e);
    }
}
