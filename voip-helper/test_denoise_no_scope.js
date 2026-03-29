const rnnoise = require('rnnoise-wasm');

async function test() {
    console.log('Iniciando teste de RNNoise (no-scope)...');
    
    // rnnoise-wasm (no-scope) usually exports a promise or an object with a load function
    // Let's inspect the exports
    console.log('Exported:', Object.keys(rnnoise));
    
    // Usually it requires waiting for the module to be ready
    const Module = await rnnoise();
    console.log('Module ready!');
    
    const sampleRate = 48000;
    const frameSize = 480;
    
    // Create the denoise state
    const st = Module.create();
    console.log('State created!');
    
    const inputPtr = Module._malloc(frameSize * 4); // Float32
    const outputPtr = Module._malloc(frameSize * 4);
    
    const input = new Float32Array(Module.HEAPF32.buffer, inputPtr, frameSize);
    const output = new Float32Array(Module.HEAPF32.buffer, outputPtr, frameSize);
    
    // Fill with simulated signal
    for (let i = 0; i < frameSize; i++) input[i] = Math.random() * 0.1;
    
    // Process
    Module.process(st, inputPtr, outputPtr);
    console.log('Processed! Output start:', output.slice(0, 5));
    
    Module.destroy(st);
    Module._free(inputPtr);
    Module._free(outputPtr);
    console.log('Teste concluído com sucesso!');
}

test().catch(err => {
    console.error('Falha no teste:', err);
});
