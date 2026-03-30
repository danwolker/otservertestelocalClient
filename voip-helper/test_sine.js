global.window = global;
global.WorkerGlobalScope = global;

async function testSine() {
    const { Rnnoise } = await import('@shiguredo/rnnoise-wasm');
    const rnnoise = await Rnnoise.load();
    const state = rnnoise.createDenoiseState();
    
    let maxOutBig = 0;
    
    // Simulate 2 seconds of a sine wave + some noise
    for(let f=0; f<200; f++) {
        const frameBig = new Float32Array(480);
        for(let i=0; i<480; i++) {
            const time = (f * 480 + i) / 48000;
            const sine = Math.sin(time * 440 * Math.PI * 2) * 16383; // 440Hz
            const noise = (Math.random() * 2 - 1) * 2000;
            frameBig[i] = sine + noise;
        }
        state.processFrame(frameBig);
        
        let m = Math.max(...frameBig.map(Math.abs));
        if (m > maxOutBig) maxOutBig = m;
    }
    
    console.log('Max Output Sine:', maxOutBig);
}
testSine();
