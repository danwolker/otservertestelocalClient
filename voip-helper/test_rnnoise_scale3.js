if (typeof global.window === 'undefined') {
    global.window = global;
    global.WorkerGlobalScope = global;
}
async function check() {
    try {
        const { Rnnoise } = await import('@shiguredo/rnnoise-wasm');
        const rnnoise = await Rnnoise.load();
        const state = rnnoise.createDenoiseState();
        
        // Sine wave is voice-like
        let freq = 440;
        let rate = 48000;
        let arr = new Float32Array(480);
        for(let i=0; i<480; i++) arr[i] = Math.sin(2 * Math.PI * freq * (i / rate)) * 16000;
        
        console.log('Scaled Voice In Max:', Math.max(...arr.map(Math.abs)));
        let vad = state.processFrame(arr);
        console.log('Scaled Voice VAD:', vad);
        console.log('Scaled Voice Out Max:', Math.max(...arr.map(Math.abs)));
        
        let arr2 = new Float32Array(480);
        for(let i=0; i<480; i++) arr2[i] = Math.sin(2 * Math.PI * freq * (i / rate)) * 0.5;
        
        console.log('Norm Voice In Max:', Math.max(...arr2.map(Math.abs)));
        let vad2 = state.processFrame(arr2);
        console.log('Norm Voice VAD:', vad2);
        console.log('Norm Voice Out Max:', Math.max(...arr2.map(Math.abs)));

    } catch(e) { console.error(e); }
}
check();
