'use strict';

const { spawn, execSync, exec } = require('child_process');
const path = require('path');

// ────────────────────────────────────────
// Configurações de Áudio
// ────────────────────────────────────────
const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const FRAME_SIZE = 960; // 20ms @ 48kHz
const BYTES_PER_SAMPLE = 2; // 16-bit PCM
const FRAME_BYTES = FRAME_SIZE * CHANNELS * BYTES_PER_SAMPLE;

// ────────────────────────────────────────
// Estado interno (mutável via funções)
// ────────────────────────────────────────
let _state = {
    captureMode: 'mic',         // 'mic' | 'system'
    isTalking: false,
    preferredDeviceId: null,    // null = determiado automaticamente
    preferredSpeakerId: null,   // null = default
    systemAudioInput: null,
    micAudioInput: null,
    pcmBuffer: Buffer.alloc(0),
    voiceLevel: 0,
};

function calculateVolume(buffer) {
    let sum = 0;
    const samples = buffer.length / 2;
    for (let i = 0; i < buffer.length; i += 2) {
        let sample = buffer.readInt16LE(i);
        sum += sample * sample;
    }
    const rms = Math.sqrt(sum / samples);
    // Normalizar: 0 a 100 (ajustando sensitividade para 0-2000 RMS -> 0-100)
    let level = Math.floor((rms / 2000) * 100);
    return Math.min(100, level);
}

// Permite substituição de estado em testes
function _getState() { return _state; }
function _resetState() {
    _state = {
        captureMode: 'mic',
        isTalking: false,
        preferredDeviceId: null,
        preferredSpeakerId: null,
        systemAudioInput: null,
        micAudioInput: null,
        pcmBuffer: Buffer.alloc(0),
    };
}

// ────────────────────────────────────────
// setCaptureMode
// ────────────────────────────────────────
function setCaptureMode(mode) {
    if (mode !== 'mic' && mode !== 'system') return false;
    _state.captureMode = mode;
    return true;
}

// ────────────────────────────────────────
// detectLoopbackDevice
// ────────────────────────────────────────
function detectLoopbackDevice() {
    return -1; // Não suportado nativamente pelo script PS atualmente
}

// ────────────────────────────────────────
// listAudioDevices
// ────────────────────────────────────────
/**
 * Retorna lista de dispositivos de entrada de áudio mapeados usando PowerShell.
 * @returns {Array<{id, name, hostAPI, isLoopback}>}
 */
function listAudioDevices() {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(__dirname, '..', 'list_audio.ps1');
        exec(`powershell -ExecutionPolicy Bypass -File "${scriptPath}"`, { encoding: 'utf8' }, (error, stdout, stderr) => {
            if (error) {
                console.error(`>> [VoIP Helper] Erro ao listar microfones (PowerShell): ${error.message}`);
                return resolve([]);
            }
            
            const devices = [];
            const lines = stdout.split('\n');
            
            for (const line of lines) {
                const match = line.match(/Device (\d+): (.+)/);
                if (match) {
                    devices.push({
                        id: parseInt(match[1]),
                        name: match[2].trim().replace(/\r/g, ''),
                        hostAPI: 'Windows API',
                        isLoopback: false
                    });
                }
            }
            resolve(devices);
        });
    });
}

// ────────────────────────────────────────
// sendPcmChunk
// ────────────────────────────────────────
function sendPcmChunk(chunk, ws, opus, wsOpen) {
    if (!ws || ws.readyState !== wsOpen) return 0;

    _state.pcmBuffer = Buffer.concat([_state.pcmBuffer, chunk]);

    let framesSent = 0;
    while (_state.pcmBuffer.length >= FRAME_BYTES) {
        const frame = _state.pcmBuffer.slice(0, FRAME_BYTES);
        _state.pcmBuffer = _state.pcmBuffer.slice(FRAME_BYTES);

        try {
            const encoded = opus.encode(frame);
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
 * Inicia captura de microfone via script PowerShell.
 */
function startMicAudio(onChunk, onError) {
    const scriptPath = path.join(__dirname, '..', 'capture_audio.ps1');
    const deviceId = _state.preferredDeviceId !== null ? _state.preferredDeviceId : -1;
    
    // Create a wrapper object that looks like an EventEmitter
    const audioInput = {
        process: null,
        on: function(event, callback) {
            if (event === 'data') this.onData = callback;
            if (event === 'error') this.onError = callback;
        },
        start: function() {
            this.process = spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-File', scriptPath, deviceId.toString()]);
            
            this.process.stdout.on('data', (data) => {
                _state.voiceLevel = calculateVolume(data);
                if (this.onData) this.onData(data);
            });
            
            this.process.stderr.on('data', (data) => {
                const msg = data.toString();
                if (msg.includes('Failed')) {
                    if (this.onError) this.onError(new Error(msg));
                }
            });
        },
        quit: function() {
            if (this.process) {
                try {
                    _state.voiceLevel = 0;
                    this.process.stdin.write('q\n');
                    this.process.kill();
                } catch (e) {}
            }
        }
    };

    audioInput.on('data', onChunk);
    if (onError) audioInput.on('error', onError);
    
    audioInput.start();

    _state.isTalking = true;
    _state.micAudioInput = audioInput;
    _state.pcmBuffer = Buffer.alloc(0);

    return audioInput;
}

// ────────────────────────────────────────
// startSystemAudio
// ────────────────────────────────────────
function startSystemAudio(onChunk, onError) {
    return startMicAudio(onChunk, onError); // PS script does default device if no loopback logic yet
}

/**
 * Retorna lista de dispositivos de saída de áudio mapeados usando PowerShell.
 * @returns {Promise<Array<{id, name}>>}
 */
function listAudioOutputDevices() {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(__dirname, '..', 'list_audio_out.ps1');
        exec(`powershell -ExecutionPolicy Bypass -File "${scriptPath}"`, { encoding: 'utf8' }, (error, stdout, stderr) => {
            if (error) {
                console.error(`>> [VoIP Helper] Erro ao listar saídas (PowerShell): ${error.message}`);
                // Log stderr for more details if available
                if (stderr) console.error(`>> [VoIP Helper] PowerShell stderr: ${stderr}`);
                return resolve([]); // Resolve with empty array on error
            }
            
            const devices = [];
            const lines = stdout.split('\n');
            
            for (const line of lines) {
                const match = line.match(/Device (\d+): (.+)/);
                if (match) {
                    devices.push({
                        id: parseInt(match[1]),
                        name: match[2].trim().replace(/\r/g, ''),
                    });
                }
            }
            resolve(devices);
        });
    });
}

// ────────────────────────────────────────
// startPlayback
// ────────────────────────────────────────
/**
 * Inicia reprodução de áudio via script PowerShell.
 */
function startPlayback() {
    const scriptPath = path.join(__dirname, '..', 'play_audio.ps1');
    const deviceId = _state.preferredSpeakerId !== null ? _state.preferredSpeakerId : -1;
    
    let audioOutput = {
        process: spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-File', scriptPath, deviceId.toString()]),
        write: function(data) {
            if (this.process && this.process.stdin.writable) {
                try {
                    this.process.stdin.write(data);
                } catch (e) {
                    console.error('>> [VoIP Helper] Erro ao escrever no playback:', e.message);
                }
            }
        },
        end: function() {
            if (this.process) {
                try { this.process.kill(); } catch (e) {}
            }
        }
    };

    return audioOutput;
}

// ────────────────────────────────────────
// handleClientCommand
// ────────────────────────────────────────
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
        case 'LIST_DEVICES_OUT':
            if (handlers.listDevicesOut) handlers.listDevicesOut();
            return 'LIST_DEVICES_OUT';
        case 'SET_DEVICE_OUT':
            if (typeof data.deviceId === 'number') {
                _state.preferredSpeakerId = data.deviceId;
            }
            return 'SET_DEVICE_OUT';
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
    setCaptureMode,
    detectLoopbackDevice,
    listAudioDevices,
    listAudioOutputDevices,
    sendPcmChunk,
    startSystemAudio,
    startMicAudio,
    startPlayback,
    handleClientCommand,

    SAMPLE_RATE,
    CHANNELS,
    FRAME_SIZE,
    FRAME_BYTES,

    _getState,
    _resetState,
};
