'use strict';

/**
 * AudioMixer - Gerencia a mixagem de múltiplos fluxos de áudio PCM 16-bit.
 * Otimizado para alta performance e suporte a 30+ jogadores simultâneos.
 */
class AudioMixer {
    constructor(onFrameMixed, options = {}) {
        this.sampleRate = options.sampleRate || 48000;
        this.channels = options.channels || 1;
        this.frameSize = options.frameSize || 960; // 20ms @ 48kHz
        this.frameBytes = this.frameSize * this.channels * 2; // 16-bit = 2 bytes
        this.onFrameMixed = onFrameMixed;
        
        // Map<playerId, Int16Array[]> - Fila de buffers para cada jogador
        // Usamos uma array de frames para evitar o custo de concatenação de Buffers.
        this.playerQueues = new Map();
        
        // Map<playerId, lastActivityTime> para limpeza automática de quem parou de falar
        this.lastActivity = new Map();
        
        this.isRunning = false;
        this.nextTickTimeout = null;
        this.expectedTickTime = 0;
        
        // Jitter Buffer: Mínimo de frames acumulados antes de começar a mixar um player
        // 4 frames = ~80ms de latência extra, ideal para internet brasileira estável
        this.jitterFrames = options.jitterFrames || 4; 
        this.playerStarted = new Map(); // playerId -> boolean

        // Buffer de mixagem intermediário pré-alocado usando Int32 para evitar overflow durante a soma
        this.mixBuffer = new Int32Array(this.frameSize * this.channels);
        
        // Buffer de saída final compatível com .write() do Node.js
        this.outputBuffer = Buffer.allocUnsafe(this.frameBytes);
    }

    /**
     * Inicia o loop de processamento do áudio com precisão de tempo corrigida.
     */
    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.expectedTickTime = Date.now();
        this.scheduleNextTick();
        console.log(`>> [VoIP Mixer] Mixer de Alta Performance iniciado (Frame: 20ms | 48kHz)`);
    }

    /**
     * Agenda o próximo processamento compensando atrasos do event loop.
     */
    scheduleNextTick() {
        if (!this.isRunning) return;
        
        const frameDuration = (this.frameSize / this.sampleRate) * 1000;
        this.expectedTickTime += frameDuration;
        
        const delay = Math.max(0, this.expectedTickTime - Date.now());
        this.nextTickTimeout = setTimeout(() => this.tick(), delay);
    }

    stop() {
        this.isRunning = false;
        if (this.nextTickTimeout) {
            clearTimeout(this.nextTickTimeout);
            this.nextTickTimeout = null;
        }
        this.playerQueues.clear();
        this.lastActivity.clear();
        this.playerStarted.clear();
        console.log('>> [VoIP Mixer] Mixer parado.');
    }

    /**
     * Adiciona áudio decodificado de um jogador.
     * Converte o Buffer em TypedArray imediatamente para acesso rápido.
     */
    addAudio(playerId, pcmBuffer) {
        if (!this.isRunning) this.start();

        // Mapeia o Buffer p/ Int16Array sem copiar dados se possível
        const samples = new Int16Array(
            pcmBuffer.buffer, 
            pcmBuffer.byteOffset, 
            pcmBuffer.length / 2
        );
        
        let queue = this.playerQueues.get(playerId);
        if (!queue) {
            queue = [];
            this.playerQueues.set(playerId, queue);
        }
        
        // Adiciona à fila do jogador específico
        queue.push(samples);
        this.lastActivity.set(playerId, Date.now());

        // Controle de Jitter Buffer
        if (!this.playerStarted.get(playerId)) {
            if (queue.length >= this.jitterFrames) {
                this.playerStarted.set(playerId, true);
            }
        }
    }

    /**
     * Loop principal de mixagem matemática.
     */
    tick() {
        if (!this.isRunning) return;

        const now = Date.now();
        const activePlayers = [];

        // 1. Identificar jogadores ativos e descartar quem expirou (silencioso por > 5s)
        for (const [playerId, queue] of this.playerQueues.entries()) {
            if (now - this.lastActivity.get(playerId) > 5000) {
                this.playerQueues.delete(playerId);
                this.lastActivity.delete(playerId);
                this.playerStarted.delete(playerId);
                continue;
            }

            if (this.playerStarted.get(playerId) && queue.length > 0) {
                activePlayers.push(playerId);
            }
        }

        // Se ninguém está transmitindo áudio, agendamos o próximo tick e saímos
        if (activePlayers.length === 0) {
            this.scheduleNextTick();
            return;
        }

        // 2. Mixagem Matemática usando Int32Array (V8 otimiza este loop)
        this.mixBuffer.fill(0);
        
        for (const playerId of activePlayers) {
            const queue = this.playerQueues.get(playerId);
            const playerFrame = queue.shift(); // Extrai o frame mais antigo
            
            for (let i = 0; i < this.mixBuffer.length; i++) {
                this.mixBuffer[i] += playerFrame[i];
            }
        }

        // 3. Ganho Adaptativo e Conversão de Volta para 16-bit
        // numSpeakers > 1 ? reduzimos o ganho p/ evitar clipping agressivo
        const numSpeakers = activePlayers.length;
        const scale = numSpeakers > 1 ? 1 / Math.sqrt(numSpeakers) : 1;

        for (let i = 0; i < this.mixBuffer.length; i++) {
            let sample = this.mixBuffer[i] * scale;
            
            // Limitador (Clamping)
            if (sample > 32767) sample = 32767;
            else if (sample < -32768) sample = -32768;
            
            this.outputBuffer.writeInt16LE(sample, i * 2);
        }

        // 4. Despacha o áudio mixado para o sistema de som via stdout/stdin
        if (this.onFrameMixed) {
            this.onFrameMixed(this.outputBuffer);
        }

        // Agenda o próximo frame considerando o drift
        this.scheduleNextTick();
    }
}

module.exports = AudioMixer;
