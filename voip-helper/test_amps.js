global.window = global;
global.WorkerGlobalScope = global;
async function testAmps() {
    const { Rnnoise } = await import('@shiguredo/rnnoise-wasm');
    const rnnoise = await Rnnoise.load();
    const state = rnnoise.createDenoiseState();
    
    // We will pass 3 amplitudes: 0.1, 1.0, and 10000.
    for(let amp of [0.1, 1.0, 10000.0]) {
        let maxOut = 0;
        let lastVAD = 0;
        for(let f=0; f<50; f++) { // process 50 frames
            const buf = new Float32Array(480);
            for(let i=0; i<480; i++) buf[i] = Math.sin((f*480+i)*440*Math.PI*2/48000) * amp;
            lastVAD = state.processFrame(buf);
            let m = Math.max(...buf.map(Math.abs));
            if(m > maxOut) maxOut = m;
        }
        console.log(`Amp ${amp} -> MaxOut: ${maxOut.toFixed(4)} | Ratio: ${(maxOut/amp).toFixed(4)} | VAD: ${lastVAD.toFixed(4)}`);
    }
}
testAmps();
