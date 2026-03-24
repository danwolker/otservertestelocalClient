const portAudio = require('naudiodon');

console.log('Audio Engine: naudiodon loaded successfully.');

console.log('Available Devices:');
const devices = portAudio.getDevices();
devices.forEach(d => {
    console.log(`[${d.id}] ${d.name} (Max Inputs: ${d.maxInputChannels}, Max Outputs: ${d.maxOutputChannels}, Default Sample Rate: ${d.defaultSampleRate})`);
});
