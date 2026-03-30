const { Rnnoise } = require('@shiguredo/rnnoise-wasm');

async function testRange() {
    console.log('Testing RNNoise range (Normalized vs 16-bit)...');
    const rnnoise = await Rnnoise.load();
    const state = rnnoise.createDenoiseState();
    
    const count = 480;
    const normFrame = new Float32Array(count);
    const scaledFrame = new Float32Array(count);
    
    // Fill both with noise + a small "pulse" (voice simulation)
    for (let i = 0; i < count; i++) {
        const noise = (Math.random() * 2 - 1) * 0.05; // 5% noise
        const pulse = (i > 200 && i < 280) ? 0.5 : 0; // "Voice" at 50%
        normFrame[i] = noise + pulse;
        scaledFrame[i] = (noise + pulse) * 32768;
    }

    // Process Normalized
    const normData = new Float32Array(normFrame);
    state.processFrame(normData);
    
    // Process Scaled
    const scaledData = new Float32Array(scaledFrame);
    state.processFrame(scaledData);
    
    console.log('Normalized frame max abs (output):', Math.max(...normData.map(Math.abs)));
    console.log('Scaled frame max abs (output):', Math.max(...scaledData.map(Math.abs)));
    
    // Check attenuation of "voice" part (200-280) vs "noise" part (0-100)
    const normNoiseMax = Math.max(...normData.slice(0, 100).map(Math.abs));
    const scaledNoiseMax = Math.max(...scaledData.slice(0, 100).map(Math.abs));
    
    console.log('Normalized Noise Part Max:', normNoiseMax);
    console.log('Scaled Noise Part Max:', scaledNoiseMax / 32768);

    state.destroy();
}

testRange().catch(console.error);
