async function test() {
    console.log('Iniciando teste de Denoise...');
    const { Rnnoise } = await import('@shiguredo/rnnoise-wasm');
    const rnnoise = await Rnnoise.load();
    const state = rnnoise.createDenoiseState();
    
    // Simula 1 segundo de áudio (48000 samples)
    // 100 frames de 480 samples
    const SAMPLE_COUNT = 480;
    const frame = new Float32Array(SAMPLE_COUNT);
    
    // Preenche com ruído branco simulado
    for (let i = 0; i < SAMPLE_COUNT; i++) {
        frame[i] = (Math.random() * 2 - 1) * 0.1;
    }
    
    console.log('Original frame max amplitude:', Math.max(...frame.map(Math.abs)));
    
    // Processa
    state.processFrame(frame);
    
    console.log('Processed frame max amplitude:', Math.max(...frame.map(Math.abs)));
    
    // Um frame de ruído deve ser atenuado significativamente se não houver voz
    assert(Math.max(...frame.map(Math.abs)) < 0.1, 'O ruído não foi atenuado!');
    
    state.destroy();
    console.log('Teste concluído com sucesso!');
}

test().catch(err => {
    console.error('Falha no teste:', err);
    process.exit(1);
});
