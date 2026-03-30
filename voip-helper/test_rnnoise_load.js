const { Rnnoise } = require('@shiguredo/rnnoise-wasm');

async function checkLoad() {
    try {
        console.log('Loading RNNoise...');
        const rnnoise = await Rnnoise.load();
        console.log('Successfully loaded!');
        const state = rnnoise.createDenoiseState();
        if (state) console.log('State created successfully!');
        
        // Let's test providing normalized vs scaled
        console.log('Testing Normal Float (-1 to 1)');
        const norm = new Float32Array(480);
        for(let i=0; i<480; i++) norm[i] = (Math.random()*2-1)*0.1;
        state.processFrame(norm);
        console.log('Norm out max:', Math.max(...norm.map(Math.abs)));
        
        console.log('Testing Scaled Int (-32768 to 32767)');
        const scaled = new Float32Array(480);
        for(let i=0; i<480; i++) scaled[i] = ((Math.random()*2-1)*0.1) * 32768;
        state.processFrame(scaled);
        console.log('Scaled out max:', Math.max(...scaled.map(Math.abs)));

        state.destroy();
    } catch (e) {
        console.error('ERROR LOADING RNNOISE:', e);
    }
}

checkLoad();
