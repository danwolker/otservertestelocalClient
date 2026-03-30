if (typeof global.window === 'undefined') {
    global.window = global;
    global.WorkerGlobalScope = global;
}
async function check() {
    try {
        const { Rnnoise } = await import('@shiguredo/rnnoise-wasm');
        const rnnoise = await Rnnoise.load();
        const state = rnnoise.createDenoiseState();
        
        console.log('Testing Normal Float (-1 to 1)');
        const norm = new Float32Array(480);
        for(let i=0; i<480; i++) norm[i] = (Math.random()*2-1)*0.1;
        state.processFrame(norm);
        console.log('Norm out max:', Math.max(...norm.map(Math.abs)));
        
        console.log('Testing Scaled Float (-32768 to +32767)');
        const scaled = new Float32Array(480);
        for(let i=0; i<480; i++) scaled[i] = ((Math.random()*2-1)*0.1) * 32768;
        state.processFrame(scaled);
        console.log('Scaled out max:', Math.max(...scaled.map(Math.abs)));
    } catch(e) { console.error(e); }
}
check();
