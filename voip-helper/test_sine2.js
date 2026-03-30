global.window = global;
global.WorkerGlobalScope = global;
async function testSine() {
    const { Rnnoise } = await import('@shiguredo/rnnoise-wasm');
    const rnnoise = await Rnnoise.load();
    const state = rnnoise.createDenoiseState();
    
    let maxOutSmall = 0;
    
    // Simulate 2 seconds of a sine wave + some noise, AMPLITUDE = 1.0
    for(let f=0; f<200; f++) {
        const frameSmall = new Float32Array(480);
        for(let i=0; i<480; i++) {
            const time = (f * 480 + i) / 48000;
            const sine = Math.sin(time * 440 * Math.PI * 2) * 0.5; // 440Hz, amp 0.5
            frameSmall[i] = sine;
        }
        state.processFrame(frameSmall);
        let m = Math.max(...frameSmall.map(Math.abs));
        if (m > maxOutSmall) maxOutSmall = m;
    }
    console.log('Max Output Sine (Amp 1.0):', maxOutSmall);
}
testSine();
