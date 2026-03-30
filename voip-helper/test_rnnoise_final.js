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
        
        // Simular chunk NORMALIZADO de voz (sine wave 0.5 amplitude = 16000 int)
        let floatFrame = new Float32Array(480);
        for(let i=0; i<480; i++) {
            floatFrame[i] = (Math.sin(2 * Math.PI * freq * (i / rate)) * 16383) / 32768.0; 
        }
        
        console.log('--- TEST NORMALIZED ---');
        console.log('In [10]:', floatFrame.slice(0, 10));
        let vad = state.processFrame(floatFrame);
        console.log('VAD:', vad);
        console.log('Out [10]:', floatFrame.slice(0, 10)); // <--- Is output normalized?
        
        
        // Simular chunk SCALED de voz 
        let floatFrame2 = new Float32Array(480);
        for(let i=0; i<480; i++) {
            floatFrame2[i] = Math.sin(2 * Math.PI * freq * (i / rate)) * 16383; 
        }
        console.log('\n--- TEST SCALED ---');
        console.log('In [10]:', floatFrame2.slice(0, 10));
        let vad2 = state.processFrame(floatFrame2);
        console.log('VAD:', vad2);
        console.log('Out [10]:', floatFrame2.slice(0, 10));
                
    } catch(e) { console.error('Error:', e); }
}
check();
