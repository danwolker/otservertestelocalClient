global.window = global;
global.WorkerGlobalScope = global;
const cp = require('child_process');
const fs = require('fs');

async function debugAudio() {
    const { Rnnoise } = await import('@shiguredo/rnnoise-wasm');
    const rnnoise = await Rnnoise.load();
    const state = rnnoise.createDenoiseState();
    
    // Create a 1-second sine wave
    const sampleRate = 48000;
    const len = sampleRate * 1;
    const buffer = Buffer.alloc(len * 2);
    
    let denoiseBuffer = Buffer.alloc(0);
    const processed = [];
    
    for(let i=0; i<len; i++) {
        // sine wave + noise
        const sine = Math.sin((i / sampleRate) * 440 * Math.PI * 2) * 16000;
        const noise = (Math.random() - 0.5) * 5000;
        buffer.writeInt16LE(Math.max(-32768, Math.min(32767, sine + noise)), i * 2);
    }
    
    // Process through RNNoise
    for(let i=0; i<buffer.length; i+=1920) {
        const chunk = buffer.slice(i, i+1920);
        denoiseBuffer = Buffer.concat([denoiseBuffer, chunk]);
        while(denoiseBuffer.length >= 960) {
            const raw = denoiseBuffer.slice(0, 960);
            denoiseBuffer = denoiseBuffer.slice(960);
            
            const floatArr = new Float32Array(480);
            for(let j=0; j<480; j++) floatArr[j] = raw.readInt16LE(j*2);
            
            state.processFrame(floatArr);
            
            const out = Buffer.alloc(960);
            for(let j=0; j<480; j++) {
                let s = Math.round(floatArr[j]);
                s = Math.max(-32768, Math.min(32767, s));
                out.writeInt16LE(s, j*2);
            }
            processed.push(out);
        }
    }
    
    const finalBuf = Buffer.concat(processed);
    
    // Check for weird values
    let clipped = 0;
    for(let i=0; i<finalBuf.length; i+=2) {
        let v = finalBuf.readInt16LE(i);
        if (Math.abs(v) > 30000) clipped++;
    }
    console.log("Clipped samples:", clipped, "Final length:", finalBuf.length);
}
debugAudio();
