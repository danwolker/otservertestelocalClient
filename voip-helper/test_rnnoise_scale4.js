if (typeof global.window === 'undefined') {
    global.window = global;
    global.WorkerGlobalScope = global;
}
async function check() {
    try {
        const { Rnnoise } = await import('@shiguredo/rnnoise-wasm');
        const rnnoise = await Rnnoise.load();
        const state = rnnoise.createDenoiseState();
        
        let freq = 440;
        let rate = 48000;
        
        // Simular o que o audioCapture.js faz
        let floatFrame = new Float32Array(480);
        
        // rawChunk mock (sinewave, max amplitude 16000)
        let rawFrame = Buffer.alloc(960);
        for(let i=0; i<480; i++) {
            let sample = Math.sin(2 * Math.PI * freq * (i / rate)) * 16000;
            rawFrame.writeInt16LE(Math.round(sample), i*2);
            // audioCapture step 1: converte pra float normalizado
            floatFrame[i] = sample / 32768.0; 
        }
        
        // audioCapture step 2: processa in-place
        state.processFrame(floatFrame);
        
        // audioCapture step 3: converte de volta *multiplicando*
        let clipped = 0;
        let outFrame = Buffer.alloc(960);
        for (let i = 0; i < 480; i++) {
            let s = Math.round(floatFrame[i] * 32768.0); 
            if (s > 32767) { s = 32767; clipped++; }
            if (s < -32768) { s = -32768; clipped++; }
            outFrame.writeInt16LE(s, i * 2);
        }
        console.log('Clipping issue? Clipped samples:', clipped);
    } catch(e) { console.error(e); }
}
check();
