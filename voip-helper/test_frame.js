global.window = global;
global.WorkerGlobalScope = global;
async function testFrameSize() {
    const { Rnnoise } = await import('@shiguredo/rnnoise-wasm');
    const rnnoise = await Rnnoise.load();
    console.log("RNNoise frameSize:", rnnoise.frameSize);
}
testFrameSize();
