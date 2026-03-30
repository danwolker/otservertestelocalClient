// Shimming window to trick emscripten
global.window = global;
global.WorkerGlobalScope = global;

const { Rnnoise } = require('@shiguredo/rnnoise-wasm');

async function checkLoad() {
    try {
        console.log('Loading RNNoise...');
        const rnnoise = await Rnnoise.load();
        console.log('Successfully loaded!');
        const state = rnnoise.createDenoiseState();
        if (state) console.log('State created successfully!');
        state.destroy();
    } catch (e) {
        console.error('ERROR LOADING RNNOISE:', e);
    }
}

checkLoad();
