async function check() {
    try {
        const createRNNoise = require('@jitsi/rnnoise-wasm');
        const wasmModule = await createRNNoise();
        const state = wasmModule.createDenoiseState();
        
        let freq = 440;
        let rate = 48000;
        
        // Simular chunk (sinewave, amplitude 16000)
        let floatFrame = new Float32Array(480);
        let rawFrame = Buffer.alloc(960);
        for(let i=0; i<480; i++) {
            let sample = Math.sin(2 * Math.PI * freq * (i / rate)) * 16000;
            rawFrame.writeInt16LE(Math.round(sample), i*2);
            // normaliza
            floatFrame[i] = sample / 32768.0; 
        }
        
        console.log('Jitsi In Max:', Math.max(...floatFrame.map(Math.abs)));
        let vad = wasmModule.processFrame(state, floatFrame);
        console.log('Jitsi VAD:', vad);
        console.log('Jitsi Out Max:', Math.max(...floatFrame.map(Math.abs)));
        
    } catch(e) { console.error('Error:', e); }
}
check();
