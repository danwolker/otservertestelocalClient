if (typeof global.window === 'undefined') {
    global.window = global;
    global.WorkerGlobalScope = global;
}
async function check() {
    try {
        const { Rnnoise } = await import('@shiguredo/rnnoise-wasm');
        const rnnoise = await Rnnoise.load();
        const state = rnnoise.createDenoiseState();
        
        let arr = new Float32Array(480);
        for(let i=0; i<480; i++) arr[i] = (Math.random() - 0.5);
        console.log('Before process:', arr[0], arr[1]);
        const vad = state.processFrame(arr);
        console.log('vad prob:', vad);
        console.log('After process:', arr[0], arr[1]);
        
        console.log('Success, state created');
    } catch(e) {
        console.error('Import failed', e);
    }
}
check();
