global.window = global;
global.WorkerGlobalScope = global;

async function checkLoad() {
    try {
        const { Rnnoise } = await import('@shiguredo/rnnoise-wasm');
        const rnnoise = await Rnnoise.load();
        const state = rnnoise.createDenoiseState();
        
        const floatFrame = new Float32Array(480);
        // Preenche com 100
        for (let i = 0; i < 480; i++) floatFrame[i] = 100;
        
        console.log('Before processFrame:', floatFrame[0]);
        state.processFrame(floatFrame);
        console.log('After processFrame:', floatFrame[0]);
        
        state.destroy();
    } catch (e) {
        console.error('ERROR:', e);
    }
}
checkLoad();
