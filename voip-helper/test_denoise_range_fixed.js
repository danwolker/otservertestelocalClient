// Correct way to import @shiguredo/rnnoise-wasm in Node.js (CJS)
async function run() {
    console.log('Testing RNNoise range (Normalized vs 16-bit)...');
    
    // Import using dynamic import for ESM package
    const { Rnnoise } = await import('@shiguredo/rnnoise-wasm');
    const rnnoise = await Rnnoise.load();
    const state = rnnoise.createDenoiseState();
    
    const count = 480;
    
    // Test 1: Normalized Range [-1.0, 1.0]
    const normFrame = new Float32Array(count);
    for (let i = 0; i < count; i++) {
        normFrame[i] = (Math.random() * 2 - 1) * 0.1; // 10% white noise
    }
    const normIn = new Float32Array(normFrame);
    state.processFrame(normIn);
    
    // Test 2: 16-bit Scale [-32768, 32767]
    const scaledFrame = new Float32Array(count);
    for (let i = 0; i < count; i++) {
        scaledFrame[i] = ((Math.random() * 2 - 1) * 0.1) * 32768;
    }
    const scaledIn = new Float32Array(scaledFrame);
    state.processFrame(scaledIn);

    console.log('--- Results ---');
    console.log('Norm Max (Input): 0.1');
    console.log('Norm Max (Output):', Math.max(...normIn.map(Math.abs)).toFixed(6));
    
    console.log('Scaled Max (Input):', (0.1 * 32768).toFixed(2));
    console.log('Scaled Max (Output):', Math.max(...scaledIn.map(Math.abs)).toFixed(2));
    
    // If RNNoise expects 16-bit scale, it should attenuate "Scaled" more effectively 
    // or at least handle the "Norm" as if it were silence (which it often does).
    
    state.destroy();
}

run().catch(console.error);
