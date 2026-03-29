const { spawn, execSync, exec } = require('child_process');
const path = require('path');
const { Rnnoise } = require('@shiguredo/rnnoise-wasm');

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
    sensitivity: 10,
    denoiseEnabled: true,       // Filtro Inteligente (RNNoise)
    rnnoise: null,              // Módulo RNNoise carregado
    denoiseState: null,         // Estado da RNN para o microfone
    denoiseBuffer: Buffer.alloc(0), // Buffer para alinhar frames de 480 samples
    micGain: 100,               // 100 = real (1.0x), 200 = 2.0x, etc.
    speakerVolume: 100,         // Master volume para o que ouvimos
    inputProfile: 'studio',     // 'studio' | 'isolation'
};

/**
 * Aplica ganho digital em um buffer PCM 16-bit Mono.
 */
function applyGain(buffer, gainPercent) {
    if (gainPercent === 100 || buffer.length === 0) return buffer;
    const factor = gainPercent / 100;

    for (let i = 0; i < buffer.length; i += 2) {
        let sample = buffer.readInt16LE(i);
        sample = Math.max(-32768, Math.min(32767, Math.floor(sample * factor)));
        buffer.writeInt16LE(sample, i);
    }
    return buffer;
}

function calculateVolume(buffer) {
    let sum = 0;
    const samples = buffer.length / 2;
    for (let i = 0; i < buffer.length; i += 2) {
        let sample = buffer.readInt16LE(i);
        sum += sample * sample;
    }
    const rms = Math.sqrt(sum / samples);
    // Sensibilidade aumentada: 500 é muito mais sensível para garantir detecção
    let level = Math.floor((rms / 500) * 100);
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

            // Log transmission once every 2 seconds to confirm it's working
            if (!_state.lastSendLogTime || Date.now() - _state.lastSendLogTime > 2000) {
                console.log(`>> [VoIP Helper] Opus frame sent to main server (${encoded.length} bytes)`);
                _state.lastSendLogTime = Date.now();
            }
        } catch (e) {
            console.error('>> [VoIP Helper] Opus encoding error:', e);
        }
    }

    return framesSent;
}

/**
 * Inicializa o módulo de supressão de ruído RNNoise.
 */
async function initDenoise() {
    if (_state.rnnoise) return;
    try {
        console.log('>> [VoIP Helper] Carregando módulo RNNoise (Machine Learning)...');
        _state.rnnoise = await Rnnoise.load();
        _state.denoiseState = _state.rnnoise.createDenoiseState();
        console.log('>> [VoIP Helper] RNNoise carregado com sucesso.');
    } catch (e) {
        console.error('>> [VoIP Helper] Erro ao carregar RNNoise:', e);
    }
}

/**
 * Processa um chunk de áudio através do supressor de ruído RNNoise.
 * Requer frames de exatamente 480 samples (@48kHz).
 */
function processDenoise(inputBuffer) {
    if (!_state.denoiseEnabled || !_state.denoiseState) return inputBuffer;

    // Acumula no buffer de denoise
    _state.denoiseBuffer = Buffer.concat([_state.denoiseBuffer, inputBuffer]);

    const SAMPLE_COUNT = 480;
    const BYTE_COUNT = SAMPLE_COUNT * 2; // Int16
    const processedFrames = [];

    while (_state.denoiseBuffer.length >= BYTE_COUNT) {
        const rawFrame = _state.denoiseBuffer.slice(0, BYTE_COUNT);
        _state.denoiseBuffer = _state.denoiseBuffer.slice(BYTE_COUNT);

        const floatFrame = new Float32Array(SAMPLE_COUNT);
        for (let i = 0; i < SAMPLE_COUNT; i++) {
            floatFrame[i] = rawFrame.readInt16LE(i * 2) / 32768.0;
        }

        // RNNoise processa o Float32Array in-place
        _state.denoiseState.processFrame(floatFrame);

        const outFrame = Buffer.allocUnsafe(BYTE_COUNT);
        for (let i = 0; i < SAMPLE_COUNT; i++) {
            let s = Math.round(floatFrame[i] * 32768.0);
            if (s > 32767) s = 32767;
            if (s < -32768) s = -32768;
            outFrame.writeInt16LE(s, i * 2);
        }
        processedFrames.push(outFrame);
    }

    return processedFrames.length > 0 ? Buffer.concat(processedFrames) : Buffer.alloc(0);
}

// ────────────────────────────────────────
// startMicAudio
// ────────────────────────────────────────
/**
 * Inicia captura de microfone via script PowerShell.
 */
async function startMicAudio(onChunk, onError, bypassGate = false) {
    if (_state.denoiseEnabled) {
        await initDenoise();
    }

    const scriptPath = path.join(__dirname, '..', 'capture_audio.ps1');
    const deviceId = _state.preferredDeviceId !== null ? _state.preferredDeviceId : -1;

    // Create a wrapper object that looks like an EventEmitter
    const audioInput = {
        process: null,
        on: function (event, callback) {
            if (event === 'data') this.onData = callback;
            if (event === 'error') this.onError = callback;
        },
        start: function () {
            // Wait for compilation (Add-Type) warning
            console.log(`>> [VoIP Helper] Iniciando captura de áudio (Pode levar alguns segundos para compilar o script PS)...`);

            console.log(`>> [VoIP Helper] Spawning PowerShell for deviceId: ${deviceId} using ${scriptPath}`);
            this.process = spawn('powershell', [
                '-NoProfile',
                '-NonInteractive',
                '-ExecutionPolicy', 'Bypass',
                '-File', scriptPath,
                deviceId.toString()
            ], {
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let firstData = true;
            this.process.stdout.on('data', (rawChunk) => {
                // Se o denoise estiver ativo, processamos o chunk antes de calcular o volume e enviar
                const data = processDenoise(rawChunk);

                // Se o buffer do denoise ainda não encheu um frame de 480 samples, data será vazio
                if (data.length === 0) return;

                if (firstData) {
                    console.log(`>> [VoIP Helper] Recebendo frames de áudio do microfone com sucesso.`);
                    firstData = false;
                }
                // 1. Aplicar Ganho do Microfone (Mic Volume)
                applyGain(data, _state.micGain);

                _state.voiceLevel = calculateVolume(data);

                // Debug log to confirm data is coming in (max once per second to avoid spam)
                if (!_state.lastLogTime || Date.now() - _state.lastLogTime > 1000) {
                    const status = _state.denoiseEnabled ? 'AI Denoise ON' : 'Denoise OFF';
                    console.log(`>> [VoIP Helper] Audio chunk processed [${status}]: ${data.length} bytes (Level: ${_state.voiceLevel}, Gate: ${_state.sensitivity})`);
                    _state.lastLogTime = Date.now();
                    // Debug log fundamental para rastreio
                    if (Date.now() % 500 < 50) { // Log a cada ~500ms
                        console.log(`>> [VoIP Debug] Vol: ${_state.voiceLevel}% | Gate: ${_state.sensitivity}%`);
                    }

                    // 2. Lógica de Perfil (Isolamento vs Estúdio)
                    let currentSensitivity = _state.sensitivity;
                    if (_state.inputProfile === 'isolation') {
                        // Perfil de isolamento torna o noise gate mais "técnico" / agressivo
                        currentSensitivity = Math.max(currentSensitivity, 15);
                    }

                    // Noise Gate: only pass data if it's above sensitivity (or bypass requested)
                    if (bypassGate || _state.voiceLevel >= currentSensitivity) {
                        if (this.onData) this.onData(data);
                    }
                });

            this.process.stderr.on('data', (data) => {
                const msg = data.toString();
                console.error(`>> [VoIP Helper] Mic PS Stderr: ${msg}`);
                if (msg.includes('Failed')) {
                    if (this.onError) this.onError(new Error(msg));
                }
            });

            this.process.on('close', (code) => {
                console.log(`>> [VoIP Helper] Mic PS process exited with code: ${code}`);
                _state.isTalking = false;
                _state.voiceLevel = 0;
            });

            this.process.on('error', (err) => {
                console.error(`>> [VoIP Helper] Mic PS process spawn error:`, err);
                if (this.onError) this.onError(err);
            });
        },
        quit: function () {
            if (this.process) {
                const pid = this.process.pid;
                this.onData = null; // Trava lógica imediata
                _state.voiceLevel = 0;

                console.log(`>> [VoIP Helper] DETONADOR: Encerrando grupo de processos (PID: ${pid})...`);

                try {
                    // Remover listeners e DESTRUIR os pipes para garantir silêncio absoluto
                    // Esse destroy() causa 'Broken pipe' no PowerShell, forçando-o a morrer graciosamente!
                    if (this.process.stdout) {
                        this.process.stdout.removeAllListeners('data');
                        this.process.stdout.destroy();
                    }
                    if (this.process.stderr) {
                        this.process.stderr.removeAllListeners('data');
                        this.process.stderr.destroy();
                    }
                    if (this.process.stdin) this.process.stdin.destroy();
                    this.process.removeAllListeners('close');
                    this.process.removeAllListeners('error');

                    if (process.platform === 'win32') {
                        // FORÇA BRUTA: Tentar kill direto e via taskkill
                        try { process.kill(pid, 'SIGKILL'); } catch (e) { }
                        exec(`taskkill /F /T /PID ${pid}`, (err) => {
                            if (err) console.error(`>> [VoIP Helper] Erro taskkill ${pid}:`, err.message);
                            else console.log(`>> [VoIP Helper] Processo ${pid} (PowerShell) finalizado.`);
                        });
                    } else {
                        process.kill(pid, 'SIGKILL');
                    }
                } catch (e) {
                    console.error(`>> [VoIP Helper] Aviso ao encerrar grupo ${pid}: ${e.message}`);
                    try { process.kill(pid, 'SIGKILL'); } catch (_) { }
                }
                this.process = null;
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
function startSystemAudio(onChunk, onError, bypassGate = false) {
    return startMicAudio(onChunk, onError, bypassGate); // PS script does default device if no loopback logic yet
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

    console.log(`>> [VoIP Helper] Spawning Playback PS for deviceId: ${deviceId} using ${scriptPath}`);
    const playbackProcess = spawn('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
        deviceId.toString()
    ]);

    playbackProcess.stderr.on('data', (data) => {
        const msg = data.toString();
        console.error(`>> [VoIP Helper] ERRO DE REPRODUÇÃO (PS stderr): ${msg}`);
    });

    playbackProcess.on('spawn', () => {
        console.log(`>> [VoIP Helper] Processo PowerShell de áudio iniciado (PID: ${playbackProcess.pid}) para DeviceID: ${deviceId}`);
    });

    playbackProcess.on('close', (code) => {
        console.log(`>> [VoIP Helper] Processo PowerShell de áudio encerrado (Código: ${code})`);
    });

    let audioOutput = {
        process: playbackProcess,
        write: function (data) {
            if (this.process && this.process.stdin.writable) {
                try {
                    // Aplicar Volume Master de Saída (Speaker Volume)
                    applyGain(data, _state.speakerVolume);
                    this.process.stdin.write(data);
                } catch (e) {
                    console.error('>> [VoIP Helper] Erro ao escrever no playback:', e.message);
                }
            }
        },
        end: function () {
            if (this.process) {
                try { this.process.kill(); } catch (e) { }
            }
        }
    };

    return audioOutput;
}

// ────────────────────────────────────────
// handleClientCommand
// ────────────────────────────────────────
function handleClientCommand(data, handlers) {
    console.log(`>> [VoIP Helper] COMANDO RECEBIDO: ${data.type}`);
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
            console.log(`>> [VoIP Helper] SET_DEVICE received: ${data.deviceId} (type: ${typeof data.deviceId})`);
            if (typeof data.deviceId === 'number' || typeof data.deviceId === 'string') {
                _state.preferredDeviceId = parseInt(data.deviceId);
                if (handlers.setDevice) handlers.setDevice(data.deviceId);
            }
            return 'SET_DEVICE';
        case 'LIST_DEVICES_OUT':
            if (handlers.listDevicesOut) handlers.listDevicesOut();
            return 'LIST_DEVICES_OUT';
        case 'SET_DEVICE_OUT':
            console.log(`>> [VoIP Helper] SET_DEVICE_OUT received: ${data.deviceId} (type: ${typeof data.deviceId})`);
            if (typeof data.deviceId === 'number' || typeof data.deviceId === 'string') {
                _state.preferredSpeakerId = parseInt(data.deviceId);
                if (handlers.setDeviceOut) handlers.setDeviceOut(data.deviceId);
            }
            return 'SET_DEVICE_OUT';
        case 'START_TALK':
            if (handlers.startCapture) handlers.startCapture();
            return 'START_TALK';
        case 'STOP_TALK':
            if (handlers.stopCapture) handlers.stopCapture();
            return 'STOP_TALK';
        case 'TEST_START':
            if (handlers.testStart) handlers.testStart();
            return 'TEST_START';
        case 'TEST_STOP':
            if (handlers.testStop) handlers.testStop();
            return 'TEST_STOP';
        case 'SET_SENSITIVITY':
            console.log(`>> [VoIP Helper] SET_SENSITIVITY received: ${data.value}`);
            _state.sensitivity = parseInt(data.value) || 0;
            return 'SET_SENSITIVITY';
        case 'SET_DENOISE':
            console.log(`>> [VoIP Helper] SET_DENOISE received: ${data.value}`);
            _state.denoiseEnabled = (data.value === true || data.value === 1 || data.value === 'true');
            if (!_state.denoiseEnabled && _state.denoiseState) {
                // Limpa o buffer se desligar para evitar resíduos de áudio
                _state.denoiseBuffer = Buffer.alloc(0);
            }
            return 'SET_DENOISE';
        case 'REPORT':
            console.log(`>> [VoIP Helper] REPORT received for: ${data.targetName} (${data.targetId})`);
            return 'REPORT';
        case 'REPORT_GENERAL':
            console.log(`>> [VoIP Helper] REPORT_GENERAL received.`);
            return 'REPORT_GENERAL';
        case 'SET_MIC_GAIN':
            console.log(`>> [VoIP Helper] SET_MIC_GAIN: ${data.value}%`);
            _state.micGain = parseInt(data.value) || 100;
            return 'SET_MIC_GAIN';
        case 'SET_SPEAKER_VOLUME':
            console.log(`>> [VoIP Helper] SET_SPEAKER_VOLUME: ${data.value}%`);
            _state.speakerVolume = parseInt(data.value) || 100;
            return 'SET_SPEAKER_VOLUME';
        case 'SET_INPUT_PROFILE':
            console.log(`>> [VoIP Helper] SET_INPUT_PROFILE: ${data.value}`);
            _state.inputProfile = data.value || 'studio';
            return 'SET_INPUT_PROFILE';
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
