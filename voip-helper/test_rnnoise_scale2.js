if (typeof global.window === 'undefined') {
    global.window = global;
    global.WorkerGlobalScope = global;
}
async function check() {
    try {
        const { Rnnoise } = await import('@shiguredo/rnnoise-wasm');
        const rnnoise = await Rnnoise.load();
        const state = rnnoise.createDenoiseState();
        
        // Simular ruído de nível alto (voz na teoria)
        let countScaled = 0;
        for (let frame=0; frame<100; frame++) {
            let arr = new Float32Array(480);
            for(let i=0; i<480; i++) arr[i] = (Math.random() - 0.5) * 16000; // SCALED VOICE NOISE
            let vad = state.processFrame(arr);
            if (vad > 0) countScaled++;
        }
        console.log('Scaled passed VAD frames:', countScaled);
        
        let countNorm = 0;
        for (let frame=0; frame<100; frame++) {
            let arr2 = new Float32Array(480);
            for(let i=0; i<480; i++) arr2[i] = (Math.random() - 0.5) * 0.5; // NORMALIZED VOICE NOISE
            let vad2 = state.processFrame(arr2);
            if (vad2 > 0) countNorm++;
        }
        console.log('Normalized passed VAD frames:', countNorm);
    } catch(e) { console.error(e); }
}
check();
