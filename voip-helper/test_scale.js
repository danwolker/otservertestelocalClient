global.window = global;
global.WorkerGlobalScope = global;
const fs = require('fs');

async function testScale() {
    const { Rnnoise } = await import('@shiguredo/rnnoise-wasm');
    const rnnoise = await Rnnoise.load();
    const state = rnnoise.createDenoiseState();
    
    // Test 1: Int16 Scale
    const frameBig = new Float32Array(480);
    for(let i=0; i<480; i++) frameBig[i] = (Math.random() * 2 - 1) * 32767;
    const vadBig = state.processFrame(frameBig);
    
    // Test 2: Normalized Scale
    const frameSmall = new Float32Array(480);
    for(let i=0; i<480; i++) frameSmall[i] = (Math.random() * 2 - 1);
    const vadSmall = state.processFrame(frameSmall);
    
    console.log('Big VAD:', vadBig, 'Max Abs Output:', Math.max(...frameBig.map(Math.abs)));
    console.log('Small VAD:', vadSmall, 'Max Abs Output:', Math.max(...frameSmall.map(Math.abs)));
}
testScale();
