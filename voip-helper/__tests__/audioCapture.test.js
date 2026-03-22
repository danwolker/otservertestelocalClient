'use strict';

// Mock do naudiodon antes de qualquer require do módulo
jest.mock('naudiodon', () => ({
    SampleFormat16Bit: 8,
    getDevices: jest.fn(),
    AudioIO: jest.fn(),
}));

const naudiodon = require('naudiodon');
const {
    setCaptureMode,
    detectLoopbackDevice,
    listAudioDevices,
    sendPcmChunk,
    startSystemAudio,
    handleClientCommand,
    FRAME_SIZE,
    FRAME_BYTES,
    LOOPBACK_KEYWORDS,
    _getState,
    _resetState,
} = require('../src/audioCapture');

// ────────────────────────────────────────
// Helpers
// ────────────────────────────────────────

/** Cria um mock de WebSocket com readyState configurável */
function makeMockWs(readyState = 1 /* OPEN */) {
    return { readyState, send: jest.fn() };
}

/** Cria um mock de OpusScript com encode que retorna Buffer */
function makeMockOpus() {
    return {
        encode: jest.fn((buf) => Buffer.from([0x01, 0x02])),
        decode: jest.fn((buf) => Buffer.from([0x03, 0x04])),
    };
}

/** Retorna um buffer PCM exatamente de N frames completos */
function pcmFrames(n) {
    return Buffer.alloc(FRAME_BYTES * n, 0x10);
}

// ────────────────────────────────────────
// Setup / Teardown
// ────────────────────────────────────────
beforeEach(() => {
    _resetState();
    jest.clearAllMocks();
});

// ────────────────────────────────────────
// setCaptureMode
// ────────────────────────────────────────
describe('setCaptureMode()', () => {
    test('aceita "mic" e atualiza o estado', () => {
        _getState().captureMode = 'system'; // pré-condição
        const result = setCaptureMode('mic');
        expect(result).toBe(true);
        expect(_getState().captureMode).toBe('mic');
    });

    test('aceita "system" e atualiza o estado', () => {
        const result = setCaptureMode('system');
        expect(result).toBe(true);
        expect(_getState().captureMode).toBe('system');
    });

    test('rejeita modo inválido e não muda o estado', () => {
        _getState().captureMode = 'mic';
        const result = setCaptureMode('bluetooth');
        expect(result).toBe(false);
        expect(_getState().captureMode).toBe('mic');
    });

    test('rejeita undefined e não muda o estado', () => {
        expect(setCaptureMode(undefined)).toBe(false);
        expect(_getState().captureMode).toBe('mic');
    });
});

// ────────────────────────────────────────
// detectLoopbackDevice
// ────────────────────────────────────────
describe('detectLoopbackDevice()', () => {
    test('retorna o id do dispositivo quando encontra "stereo mix"', () => {
        naudiodon.getDevices.mockReturnValue([
            { id: 2, name: 'Stereo Mix (Realtek)', maxInputChannels: 2, hostAPIName: 'Windows WASAPI' },
            { id: 5, name: 'Microfone (HD Audio)', maxInputChannels: 1, hostAPIName: 'MME' },
        ]);
        expect(detectLoopbackDevice()).toBe(2);
    });

    test('retorna o id do dispositivo quando o nome contém "loopback"', () => {
        naudiodon.getDevices.mockReturnValue([
            { id: 7, name: 'CABLE Output (VB-Audio Loopback)', maxInputChannels: 2, hostAPIName: 'Windows WASAPI' },
        ]);
        expect(detectLoopbackDevice()).toBe(7);
    });

    test('retorna o id do "Mapeador de Som" (dispositivo do Windows PT-BR)', () => {
        naudiodon.getDevices.mockReturnValue([
            { id: 0, name: 'Mapeador de Som da Microsoft - Input', maxInputChannels: 2, hostAPIName: 'Windows WASAPI' },
        ]);
        expect(detectLoopbackDevice()).toBe(0);
    });

    test('retorna -1 quando nenhum dispositivo loopback é encontrado', () => {
        naudiodon.getDevices.mockReturnValue([
            { id: 1, name: 'Microfone USB', maxInputChannels: 1, hostAPIName: 'MME' },
        ]);
        expect(detectLoopbackDevice()).toBe(-1);
    });

    test('retorna -1 quando a lista está vazia', () => {
        naudiodon.getDevices.mockReturnValue([]);
        expect(detectLoopbackDevice()).toBe(-1);
    });

    test('retorna -1 quando getDevices lança exceção', () => {
        naudiodon.getDevices.mockImplementation(() => { throw new Error('Driver error'); });
        expect(detectLoopbackDevice()).toBe(-1);
    });

    test('ignora dispositivos sem canais de entrada (maxInputChannels === 0)', () => {
        naudiodon.getDevices.mockReturnValue([
            { id: 3, name: 'Stereo Mix - Output Only', maxInputChannels: 0, hostAPIName: 'Windows WASAPI' },
        ]);
        expect(detectLoopbackDevice()).toBe(-1);
    });
});

// ────────────────────────────────────────
// listAudioDevices
// ────────────────────────────────────────
describe('listAudioDevices()', () => {
    test('retorna apenas dispositivos com canais de entrada', () => {
        naudiodon.getDevices.mockReturnValue([
            { id: 0, name: 'Speakers', maxInputChannels: 0, hostAPIName: 'MME' },
            { id: 1, name: 'Microfone', maxInputChannels: 1, hostAPIName: 'MME' },
        ]);
        const result = listAudioDevices();
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('Microfone');
    });

    test('marca isLoopback=true para dispositivo com keyword loopback', () => {
        naudiodon.getDevices.mockReturnValue([
            { id: 2, name: 'Stereo Mix', maxInputChannels: 2, hostAPIName: 'Windows WASAPI' },
        ]);
        const [device] = listAudioDevices();
        expect(device.isLoopback).toBe(true);
    });

    test('marca isLoopback=false para microfone comum', () => {
        naudiodon.getDevices.mockReturnValue([
            { id: 3, name: 'HD Audio Microphone', maxInputChannels: 1, hostAPIName: 'MME' },
        ]);
        const [device] = listAudioDevices();
        expect(device.isLoopback).toBe(false);
    });

    test('retorna [] quando getDevices lança exceção', () => {
        naudiodon.getDevices.mockImplementation(() => { throw new Error('no driver'); });
        expect(listAudioDevices()).toEqual([]);
    });

    test('mapeia campos corretamente (id, name, hostAPI, isLoopback)', () => {
        naudiodon.getDevices.mockReturnValue([
            { id: 9, name: 'Loopback Device', maxInputChannels: 2, hostAPIName: 'Windows WASAPI' },
        ]);
        const [d] = listAudioDevices();
        expect(d).toMatchObject({ id: 9, name: 'Loopback Device', hostAPI: 'Windows WASAPI', isLoopback: true });
    });
});

// ────────────────────────────────────────
// sendPcmChunk
// ────────────────────────────────────────
describe('sendPcmChunk()', () => {
    const WS_OPEN = 1;

    test('envia 1 frame quando recebe exatamente FRAME_BYTES', () => {
        const ws = makeMockWs(WS_OPEN);
        const opus = makeMockOpus();
        const frames = sendPcmChunk(pcmFrames(1), ws, opus, WS_OPEN);
        expect(frames).toBe(1);
        expect(ws.send).toHaveBeenCalledTimes(1);
        expect(opus.encode).toHaveBeenCalledTimes(1);
    });

    test('envia 3 frames quando recebe 3 × FRAME_BYTES', () => {
        const ws = makeMockWs(WS_OPEN);
        const opus = makeMockOpus();
        const frames = sendPcmChunk(pcmFrames(3), ws, opus, WS_OPEN);
        expect(frames).toBe(3);
        expect(ws.send).toHaveBeenCalledTimes(3);
    });

    test('não envia nada se o chunk for menor que FRAME_BYTES', () => {
        const ws = makeMockWs(WS_OPEN);
        const opus = makeMockOpus();
        const frames = sendPcmChunk(Buffer.alloc(FRAME_BYTES - 1), ws, opus, WS_OPEN);
        expect(frames).toBe(0);
        expect(ws.send).not.toHaveBeenCalled();
    });

    test('acumula chunks pequenos e envia quando atinge FRAME_BYTES', () => {
        const ws = makeMockWs(WS_OPEN);
        const opus = makeMockOpus();
        const half = Buffer.alloc(FRAME_BYTES / 2, 0x01);
        sendPcmChunk(half, ws, opus, WS_OPEN);        // sem frame ainda
        expect(ws.send).not.toHaveBeenCalled();
        const frames = sendPcmChunk(half, ws, opus, WS_OPEN); // agora completa
        expect(frames).toBe(1);
        expect(ws.send).toHaveBeenCalledTimes(1);
    });

    test('não envia quando WebSocket está fechado (readyState !== WS_OPEN)', () => {
        const ws = makeMockWs(3 /* CLOSED */);
        const opus = makeMockOpus();
        const frames = sendPcmChunk(pcmFrames(2), ws, opus, WS_OPEN);
        expect(frames).toBe(0);
        expect(ws.send).not.toHaveBeenCalled();
    });

    test('não envia quando ws é null', () => {
        const opus = makeMockOpus();
        const frames = sendPcmChunk(pcmFrames(1), null, opus, WS_OPEN);
        expect(frames).toBe(0);
    });

    test('o dado enviado ao WS é o retorno do opus.encode (buffer binário)', () => {
        const ws = makeMockWs(WS_OPEN);
        const encodedMock = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]);
        const opus = { encode: jest.fn().mockReturnValue(encodedMock) };
        sendPcmChunk(pcmFrames(1), ws, opus, WS_OPEN);
        expect(ws.send).toHaveBeenCalledWith(encodedMock);
    });
});

// ────────────────────────────────────────
// startSystemAudio
// ────────────────────────────────────────
describe('startSystemAudio()', () => {
    function setupMockAudioIO() {
        const mockInstance = {
            on: jest.fn(),
            start: jest.fn(),
            quit: jest.fn(),
        };
        naudiodon.AudioIO.mockImplementation(() => mockInstance);
        naudiodon.getDevices.mockReturnValue([
            { id: 0, name: 'Mapeador de Som da Microsoft', maxInputChannels: 2, hostAPIName: 'Windows WASAPI' },
        ]);
        return mockInstance;
    }

    test('cria AudioIO e chama start()', () => {
        const mock = setupMockAudioIO();
        startSystemAudio(jest.fn(), jest.fn());
        expect(naudiodon.AudioIO).toHaveBeenCalledTimes(1);
        expect(mock.start).toHaveBeenCalledTimes(1);
    });

    test('registra listener "data" e "error" no AudioIO', () => {
        const mock = setupMockAudioIO();
        const onChunk = jest.fn();
        const onError = jest.fn();
        startSystemAudio(onChunk, onError);
        const dataCalls = mock.on.mock.calls.filter(([event]) => event === 'data');
        const errorCalls = mock.on.mock.calls.filter(([event]) => event === 'error');
        expect(dataCalls).toHaveLength(1);
        expect(errorCalls).toHaveLength(1);
    });

    test('usa preferredDeviceId quando definido', () => {
        const mock = setupMockAudioIO();
        _getState().preferredDeviceId = 42;
        startSystemAudio(jest.fn(), jest.fn());
        const callArgs = naudiodon.AudioIO.mock.calls[0][0];
        expect(callArgs.inOptions.deviceId).toBe(42);
    });

    test('usa detectLoopbackDevice quando preferredDeviceId é null', () => {
        const mock = setupMockAudioIO();
        _getState().preferredDeviceId = null;
        startSystemAudio(jest.fn(), jest.fn());
        const callArgs = naudiodon.AudioIO.mock.calls[0][0];
        // detectLoopbackDevice retorna 0 (o "Mapeador de Som")
        expect(callArgs.inOptions.deviceId).toBe(0);
    });

    test('usa sampleRate e channelCount corretos', () => {
        const mock = setupMockAudioIO();
        startSystemAudio(jest.fn(), jest.fn());
        const { inOptions } = naudiodon.AudioIO.mock.calls[0][0];
        expect(inOptions.sampleRate).toBe(48000);
        expect(inOptions.channelCount).toBe(1);
    });

    test('marca isTalking=true e salva audioInput no estado', () => {
        const mock = setupMockAudioIO();
        startSystemAudio(jest.fn(), jest.fn());
        expect(_getState().isTalking).toBe(true);
        expect(_getState().systemAudioInput).toBe(mock);
    });

    test('retorna null e chama onError quando AudioIO lança exceção', () => {
        naudiodon.AudioIO.mockImplementation(() => { throw new Error('device busy'); });
        naudiodon.getDevices.mockReturnValue([]);
        const onError = jest.fn();
        const result = startSystemAudio(jest.fn(), onError);
        expect(result).toBeNull();
        expect(onError).toHaveBeenCalledWith(expect.any(Error));
        expect(_getState().isTalking).toBe(false);
    });
});

// ────────────────────────────────────────
// handleClientCommand
// ────────────────────────────────────────
describe('handleClientCommand()', () => {
    let handlers;

    beforeEach(() => {
        handlers = {
            connect: jest.fn(),
            startCapture: jest.fn(),
            stopCapture: jest.fn(),
            listDevices: jest.fn(),
        };
    });

    test('CONNECT chama handlers.connect com url e sessionKey', () => {
        const result = handleClientCommand(
            { type: 'CONNECT', wsUrl: 'ws://localhost:3001', sessionKey: 'abc123' },
            handlers
        );
        expect(result).toBe('CONNECT');
        expect(handlers.connect).toHaveBeenCalledWith('ws://localhost:3001', 'abc123');
    });

    test('START_TALK chama handlers.startCapture', () => {
        expect(handleClientCommand({ type: 'START_TALK' }, handlers)).toBe('START_TALK');
        expect(handlers.startCapture).toHaveBeenCalledTimes(1);
    });

    test('STOP_TALK chama handlers.stopCapture', () => {
        expect(handleClientCommand({ type: 'STOP_TALK' }, handlers)).toBe('STOP_TALK');
        expect(handlers.stopCapture).toHaveBeenCalledTimes(1);
    });

    test('LIST_DEVICES chama handlers.listDevices', () => {
        expect(handleClientCommand({ type: 'LIST_DEVICES' }, handlers)).toBe('LIST_DEVICES');
        expect(handlers.listDevices).toHaveBeenCalledTimes(1);
    });

    test('SET_CAPTURE_MODE "system" altera o estado', () => {
        handleClientCommand({ type: 'SET_CAPTURE_MODE', mode: 'system' }, handlers);
        expect(_getState().captureMode).toBe('system');
    });

    test('SET_CAPTURE_MODE "mic" altera o estado', () => {
        _getState().captureMode = 'system';
        handleClientCommand({ type: 'SET_CAPTURE_MODE', mode: 'mic' }, handlers);
        expect(_getState().captureMode).toBe('mic');
    });

    test('SET_DEVICE define preferredDeviceId', () => {
        handleClientCommand({ type: 'SET_DEVICE', deviceId: 5 }, handlers);
        expect(_getState().preferredDeviceId).toBe(5);
    });

    test('SET_DEVICE ignora valor não-numérico', () => {
        _getState().preferredDeviceId = null;
        handleClientCommand({ type: 'SET_DEVICE', deviceId: 'abc' }, handlers);
        expect(_getState().preferredDeviceId).toBeNull();
    });

    test('comando desconhecido retorna null e não chama handlers', () => {
        const result = handleClientCommand({ type: 'UNKNOWN_CMD' }, handlers);
        expect(result).toBeNull();
        Object.values(handlers).forEach(h => expect(h).not.toHaveBeenCalled());
    });
});
