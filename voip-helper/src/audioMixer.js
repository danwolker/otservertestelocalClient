'use strict';

/**
 * AudioMixer - Gerencia a mixagem de múltiplos fluxos de áudio PCM 16-bit.
 * Resolve o problema de áudio picotado interpondo amostras em vez de tocar sequencialmente.
 */
class AudioMixer {
    constructor(onFrameMixed, options = {}) {
        this.sampleRate = options.sampleRate || 48000;
        this.channels = options.channels || 1;
        this.frameSize = options.frameSize || 960; // 20ms @ 48kHz
        this.frameBytes = this.frameSize * this.channels * 2; // 16-bit = 2 bytes
        this.onFrameMixed = onFrameMixed;
        
        // Map<playerId, Buffer>
        this.playerBuffers = new Map();
        // Map<playerId, lastActivityTime> para limpeza automática
        this.lastActivity = new Map();
        
        this.interval = null;
        this.isRunning = false;
        
        // Jitter Buffer: Mínimo de frames acumulados antes de começar a mixar um player
        // 3 frames = ~60ms de latência extra, mas áudio muito mais estável
        this.jitterFrames = options.jitterFrames || 4; 
        this.playerStarted = new Map(); // playerId -> boolean (se já passou do jitter)
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        console.log(`>> [VoIP Mixer] Mixer iniciado (Intervalo: ${this.frameSize / (this.sampleRate / 1000)}ms)`);
        
        // Usamos um loop de alta frequência ou setInterval estável
        this.interval = setInterval(() => this.tick(), (this.frameSize / this.sampleRate) * 1000);
    }

    stop() {
        this.isRunning = false;
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        this.playerBuffers.clear();
        this.lastActivity.clear();
        this.playerStarted.clear();
        console.log('>> [VoIP Mixer] Mixer parado.');
    }

    /**
     * Adiciona áudio decodificado de um jogador específico ao buffer de mixagem.
     */
    addAudio(playerId, pcmBuffer) {
        if (!this.isRunning) this.start();

        let buf = this.playerBuffers.get(playerId) || Buffer.alloc(0);
        this.playerBuffers.set(playerId, Buffer.concat([buf, pcmBuffer]));
        this.lastActivity.set(playerId, Date.now());

        // Se o buffer atingir o limite do jitter, marcamos como pronto para tocar
        if (!this.playerStarted.get(playerId)) {
            if (this.playerBuffers.get(playerId).length >= this.frameBytes * this.jitterFrames) {
                this.playerStarted.set(playerId, true);
            }
        }
    }

    tick() {
        const activePlayers = [];
        const now = Date.now();

        // 1. Identificar jogadores que têm áudio pronto para tocar
        for (const [playerId, buffer] of this.playerBuffers.entries()) {
            // Limpeza de jogadores inativos há mais de 5 segundos
            if (now - this.lastActivity.get(playerId) > 5000) {
                this.playerBuffers.delete(playerId);
                this.lastActivity.delete(playerId);
                this.playerStarted.delete(playerId);
                continue;
            }

            if (this.playerStarted.get(playerId) && buffer.length >= this.frameBytes) {
                activePlayers.push(playerId);
            }
        }

        // Se ninguém está falando, não enviamos nada para economizar recursos ou enviamos silêncio?
        // Para manter o script PowerShell "quente" e sincronizado, enviamos silêncio se houve atividade recente.
        if (activePlayers.length === 0) {
            if (this.playerBuffers.size > 0) {
                // Opcional: enviar frame de silêncio para manter o fluxo
                // this.onFrameMixed(Buffer.alloc(this.frameBytes));
            }
            return;
        }

        // 2. Mixagem Matemática
        const mixedBuffer = Buffer.alloc(this.frameBytes);
        
        for (let i = 0; i < this.frameSize; i++) {
            let sum = 0;
            const offset = i * 2;

            for (const playerId of activePlayers) {
                const buf = this.playerBuffers.get(playerId);
                const sample = buf.readInt16LE(offset);
                sum += sample;
            }

            // Clamping para evitar distorção (clipping)
            if (sum > 32767) sum = 32767;
            if (sum < -32768) sum = -32768;

            mixedBuffer.writeInt16LE(sum, offset);
        }

        // 3. Consumir os frames dos buffers utilizados
        for (const playerId of activePlayers) {
            const buf = this.playerBuffers.get(playerId);
            this.playerBuffers.set(playerId, buf.slice(this.frameBytes));
        }

        // 4. Enviar áudio mixado para o playback
        if (this.onFrameMixed) {
            this.onFrameMixed(mixedBuffer);
        }
    }
}

module.exports = AudioMixer;
