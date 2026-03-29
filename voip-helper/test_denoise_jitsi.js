const rnnoise = require('@jitsi/rnnoise-wasm');

async function test() {
    console.log('Iniciando teste de RNNoise (Jitsi)...');
    
    // @jitsi/rnnoise-wasm usually exports a promise or a load function
    console.log('Exported type:', typeof rnnoise);
    
    // Wait for instantiation
    const p = await rnnoise();
    console.log('Module ready!');
    
    // Check if it's the expected interface
    if (typeof p.create === 'function') {
        const denoiseState = p.create();
        console.log('DenoiseState created!');
        p.destroy(denoiseState);
        console.log('DenoiseState destroyed.');
    } else {
        console.log('Unexpected interface:', Object.keys(p));
    }
}

test().catch(err => {
    console.error('Falha no teste:', err);
});
