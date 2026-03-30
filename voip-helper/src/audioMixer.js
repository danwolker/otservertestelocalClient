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
        
        // 6 frames = ~120ms de latência extra, ideal para resilência em VPNs e conexões variáveis.
        // O valor pode ser menor (ex: 3) em servidores AWS diretos.
        this.jitterFrames = options.jitterFrames || 6; 
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
        
        const frameDurationMs = (this.frameSize / this.sampleRate) * 1000;
        const now = Date.now();
        
        // Se estamos atrasados demais (mais de 100ms), "zeramos" o tempo base p/ evitar avalanche de ticks
        if (now - this.expectedTickTime > 100) {
            this.expectedTickTime = now;
        }

        this.expectedTickTime += frameDurationMs;
        const delay = Math.max(0, this.expectedTickTime - now);
        
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
     * Limpa a fila de áudio de um jogador específico.
     * Útil para parar o teste de áudio instantaneamente (sem eco residual).
     */
    clearQueue(playerId) {
        if (this.playerQueues.has(playerId)) {
            this.playerQueues.delete(playerId);
            this.playerStarted.delete(playerId);
            console.log(`>> [VoIP Mixer] Fila de áudio limpa para player ID: ${playerId}`);
        }
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

        // Controle de Jitter Buffer (Catch-up inteligente)
        // Se a fila passar de 5 frames (~100ms), descartamos o frame MAIS ANTIGO para manter o tempo real.
        // É melhor perder 20ms de áudio do que ficar com lag acumulado para sempre.
        const MAX_QUEUE = Math.max(15, this.jitterFrames * 2.5);
        if (queue.length > MAX_QUEUE) {
            queue.shift(); // Descarta o frame que já passou
        }

        if (!this.playerStarted.get(playerId)) {
            if (queue.length >= this.jitterFrames) {
                this.playerStarted.set(playerId, true);
            }
        }
    }

    /**
     * Loop principal de mixagem matemática.
     * Implementa lógica Anti-Drift: processa múltiplos frames se houver atraso.
     */
    tick() {
        if (!this.isRunning) return;

        const now = Date.now();
        const frameDurationMs = (this.frameSize / this.sampleRate) * 1000;
        let processedCount = 0;

        // Se o atraso for crítico (mais de 500ms), fazemos um resync para evitar "metralhadora" de áudio
        if (now - this.expectedTickTime > 500) {
            console.warn(`>> [VoIP Mixer] Drifting detectado (${now - this.expectedTickTime}ms). Fazendo resync...`);
            this.expectedTickTime = now;
        }

        // Loop de Catch-up: Enquanto o tempo real estiver à frente do esperado, processamos o áudio.
        // Limitamos a 5 frames por tick para não causar picos de CPU se o sistema travar muito.
        while (now >= this.expectedTickTime && processedCount < 5) {
            this.processSingleFrame();
            this.expectedTickTime += frameDurationMs;
            processedCount++;
        }

        // Agenda o próximo tick com base no tempo corrigido (Anti-Drift)
        const nextDelay = Math.max(0, this.expectedTickTime - Date.now());
        this.nextTickTimeout = setTimeout(() => this.tick(), nextDelay);
    }

    /**
     * Mixagem de um único frame de 20ms.
     */
    processSingleFrame() {
        const now = Date.now();
        const activePlayers = [];

        // 1. Identificar jogadores ativos
        for (const [playerId, queue] of this.playerQueues.entries()) {
            const lastActive = this.lastActivity.get(playerId) || 0;
            
            // Cleanup: Remover jogadores inativos por mais de 5 segundos
            if (now - lastActive > 5000) {
                this.playerQueues.delete(playerId);
                this.lastActivity.delete(playerId);
                this.playerStarted.delete(playerId);
                continue;
            }

            const isStarted = this.playerStarted.get(playerId) || false;
            
            // RE-BUFFERING: Se o áudio acabar de repente, pausamos e esperamos o colchão encher
            if (isStarted && queue.length === 0) {
                this.playerStarted.set(playerId, false);
            }

            // Se o jogador acumulou frames suficientes ou já estava tocando
            if (this.playerStarted.get(playerId) && queue.length > 0) {
                activePlayers.push(playerId);
            }
        }

        if (activePlayers.length === 0) return;

        // 2. Mixagem Matemática
        this.mixBuffer.fill(0);
        
        for (const playerId of activePlayers) {
            const queue = this.playerQueues.get(playerId);
            const playerFrame = queue.shift();
            
            if (playerFrame && playerFrame.length === this.mixBuffer.length) {
                for (let i = 0; i < this.mixBuffer.length; i++) {
                    this.mixBuffer[i] += playerFrame[i];
                }
            }
        }

        // 3. Ganho Logarítmico (Balanceado para múltiplos speakers)
        const numSpeakers = activePlayers.length;
        const scale = numSpeakers > 1 ? (1 / Math.log2(numSpeakers + 1)) : 1;

        for (let i = 0; i < this.mixBuffer.length; i++) {
            let sample = this.mixBuffer[i] * scale;
            
            if (sample > 32767) sample = 32767;
            else if (sample < -32768) sample = -32768;
            
            this.outputBuffer.writeInt16LE(sample, i * 2);
        }

        // 4. Output (Usa Buffer.from para criar cópia por valor, evitando duplicação em loops)
        if (this.onFrameMixed) {
            this.onFrameMixed(Buffer.from(this.outputBuffer));
        }
    }
}

module.exports = AudioMixer;
