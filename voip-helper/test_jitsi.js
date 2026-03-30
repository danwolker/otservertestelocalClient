(async () => {
    try {
        console.log('Testing @jitsi/rnnoise-wasm...');
        const rnnoise = await import('@jitsi/rnnoise-wasm');
        console.log('Loaded module:', Object.keys(rnnoise));
        
        const createModule = rnnoise.createRNNWasmModule;
        if (createModule) {
             const m = await createModule();
             console.log('Instance created successfully!', Object.keys(m));
        }

    } catch (e) {
        console.error('Failed:', e);
    }
})();
