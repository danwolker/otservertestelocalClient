'use strict';

const naudiodon = require('naudiodon');

// ────────────────────────────────────────
// Configurações de Áudio
// ────────────────────────────────────────
const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const FRAME_SIZE = 960; // 20ms @ 48kHz
const BYTES_PER_SAMPLE = 2; // 16-bit PCM
const FRAME_BYTES = FRAME_SIZE * CHANNELS * BYTES_PER_SAMPLE;

const LOOPBACK_KEYWORDS = [
    'stereo mix',
    'loopback',
    'wave out',
    'what u hear',
    'mistura estéreo',
    'mapeador de som',
];

// ────────────────────────────────────────
// Estado interno (mutável via funções)
// ────────────────────────────────────────
let _state = {
    captureMode: 'mic',         // 'mic' | 'system'
    isTalking: false,
    preferredDeviceId: null,    // null = determiado automaticamente
    systemAudioInput: null,
    pcmBuffer: Buffer.alloc(0),
};

// Permite substituição de estado em testes
function _getState() { return _state; }
function _resetState() {
    _state = {
        captureMode: 'mic',
        isTalking: false,
        preferredDeviceId: null,
        systemAudioInput: null,
        pcmBuffer: Buffer.alloc(0),
    };
}

// ────────────────────────────────────────
// setCaptureMode
// ────────────────────────────────────────
/**
 * Define o modo de captura de áudio.
 * @param {'mic'|'system'} mode
 * @returns {boolean} true se o modo foi alterado, false se inválido
 */
function setCaptureMode(mode) {
    if (mode !== 'mic' && mode !== 'system') {
        return false;
    }
    _state.captureMode = mode;
    return true;
}

// ────────────────────────────────────────
// detectLoopbackDevice
// ────────────────────────────────────────
/**
 * Detecta automaticamente um dispositivo loopback disponível via naudiodon.
 * @returns {number} ID do dispositivo loopback, ou -1 se nenhum encontrado
 */
function detectLoopbackDevice() {
    let devices;
    try {
        devices = naudiodon.getDevices();
    } catch (_) {
        return -1;
    }

    const found = devices.find(d =>
        d.maxInputChannels > 0 &&
        LOOPBACK_KEYWORDS.some(kw => d.name.toLowerCase().includes(kw))
    );

    return found ? found.id : -1;
}

// ────────────────────────────────────────
// listAudioDevices
// ────────────────────────────────────────
/**
 * Retorna lista de dispositivos de entrada de áudio mapeados.
 * @returns {Array<{id, name, hostAPI, isLoopback}>}
 */
function listAudioDevices() {
    let devices;
    try {
        devices = naudiodon.getDevices();
    } catch (_) {
        return [];
    }

    return devices
        .filter(d => d.maxInputChannels > 0)
        .map(d => ({
            id: d.id,
            name: d.name,
            hostAPI: d.hostAPIName,
            isLoopback: LOOPBACK_KEYWORDS.some(kw => d.name.toLowerCase().includes(kw)),
        }));
}

// ────────────────────────────────────────
// sendPcmChunk
// ────────────────────────────────────────
/**
 * Acumula chunks de PCM e envia frames Opus completos via WebSocket.
 * @param {Buffer} chunk - Dados PCM brutos
 * @param {object} ws - Instância WebSocket (deve ter readyState e send())
 * @param {object} opus - Instância OpusScript
 * @param {number} wsOpen - Valor que indica WS aberto (WebSocket.OPEN)
 * @returns {number} Quantidade de frames Opus enviados
 */
function sendPcmChunk(chunk, ws, opus, wsOpen) {
    if (!ws || ws.readyState !== wsOpen) return 0;

    _state.pcmBuffer = Buffer.concat([_state.pcmBuffer, chunk]);

    let framesSent = 0;
    while (_state.pcmBuffer.length >= FRAME_BYTES) {
        const frame = _state.pcmBuffer.slice(0, FRAME_BYTES);
        _state.pcmBuffer = _state.pcmBuffer.slice(FRAME_BYTES);

        try {
            const encoded = opus.encode(frame, FRAME_SIZE);
            ws.send(encoded);
            framesSent++;
        } catch (e) {
            // erro de encoding: descarta frame
        }
    }

    return framesSent;
}

// ────────────────────────────────────────
// startMicAudio
// ────────────────────────────────────────
/**
 * Inicia captura de microfone via naudiodon.
 * @param {Function} onChunk - Callback para chunks PCM
 * @param {Function} onError - Callback para erros
 */
function startMicAudio(onChunk, onError) {
    const options = {
        inOptions: {
            channelCount: CHANNELS,
            sampleFormat: naudiodon.SampleFormat16Bit,
            sampleRate: SAMPLE_RATE,
            // deviceId: null usa o default
            closeOnError: false,
        }
    };

    let audioInput;
    try {
        audioInput = new naudiodon.AudioIO(options);
    } catch (e) {
        if (onError) onError(e);
        return null;
    }

    audioInput.on('data', onChunk);
    audioInput.on('error', (e) => { if (onError) onError(e); });
    audioInput.start();

    _state.isTalking = true;
    _state.micAudioInput = audioInput;
    _state.pcmBuffer = Buffer.alloc(0);

    return audioInput;
}

// ────────────────────────────────────────
// startSystemAudio
// ────────────────────────────────────────
/**
 * Inicia captura de áudio do sistema via WASAPI loopback.
 * @param {Function} onChunk - Callback chamado a cada chunk PCM recebido
 * @param {Function} onError - Callback chamado em caso de erro
 * @returns {object|null} instância AudioIO ou null em caso de falha
 */
function startSystemAudio(onChunk, onError) {
    const deviceId = _state.preferredDeviceId !== null
        ? _state.preferredDeviceId
        : detectLoopbackDevice();

    const options = {
        inOptions: {
            channelCount: CHANNELS,
            sampleFormat: naudiodon.SampleFormat16Bit,
            sampleRate: SAMPLE_RATE,
            deviceId,
            closeOnError: false,
        }
    };

    let audioInput;
    try {
        audioInput = new naudiodon.AudioIO(options);
    } catch (e) {
        if (onError) onError(e);
        return null;
    }

    audioInput.on('data', onChunk);
    audioInput.on('error', (e) => { if (onError) onError(e); });
    audioInput.start();

    _state.isTalking = true;
    _state.systemAudioInput = audioInput;
    _state.pcmBuffer = Buffer.alloc(0);

    return audioInput;
}

// ────────────────────────────────────────
// handleClientCommand
// ────────────────────────────────────────
/**
 * Processa um comando JSON vindo do OTClient.
 * @param {object} data - Objeto com campo `type` e dados do comando
 * @param {object} handlers - Implementações das ações { connect, startCapture, stopCapture, listDevices }
 * @returns {string|null} O tipo do comando processado, ou null se desconhecido
 */
function handleClientCommand(data, handlers) {
    switch (data.type) {
        case 'CONNECT':
            if (handlers.connect) handlers.connect(data.wsUrl, data.sessionKey);
            return 'CONNECT';

        case 'SET_CAPTURE_MODE':
            setCaptureMode(data.mode);
            return 'SET_CAPTURE_MODE';

        case 'LIST_DEVICES':
            if (handlers.listDevices) handlers.listDevices();
            return 'LIST_DEVICES';

        case 'SET_DEVICE':
            if (typeof data.deviceId === 'number') {
                _state.preferredDeviceId = data.deviceId;
            }
            return 'SET_DEVICE';

        case 'START_TALK':
            if (handlers.startCapture) handlers.startCapture();
            return 'START_TALK';

        case 'STOP_TALK':
            if (handlers.stopCapture) handlers.stopCapture();
            return 'STOP_TALK';

        default:
            return null;
    }
}

// ────────────────────────────────────────
// Exports
// ────────────────────────────────────────
module.exports = {
    // Funções principais
    setCaptureMode,
    detectLoopbackDevice,
    listAudioDevices,
    sendPcmChunk,
    startSystemAudio,
    startMicAudio,
    handleClientCommand,

    // Constantes
    SAMPLE_RATE,
    CHANNELS,
    FRAME_SIZE,
    FRAME_BYTES,
    LOOPBACK_KEYWORDS,

    // Estado (para testes)
    _getState,
    _resetState,
};
