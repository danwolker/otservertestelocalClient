const { spawn } = require('child_process');
const path = require('path');

const scriptPath = path.join(__dirname, 'play_audio.ps1');
const deviceId = '-1';

console.log(`Testing play_audio.ps1 with deviceId: ${deviceId}`);

const ps = spawn('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
    deviceId
]);

ps.stderr.on('data', (data) => {
    console.error(`STDERR: ${data.toString()}`);
});

ps.on('close', (code) => {
    console.log(`Process exited with code ${code}`);
});

let chunksWritten = 0;
const interval = setInterval(() => {
    const chunk = Buffer.alloc(1920);
    // Fill with sine wave or random noise (just 0s is fine to test if it runs)
    ps.stdin.write(chunk);
    chunksWritten++;
    if (chunksWritten >= 50) { // 1 second
        clearInterval(interval);
        ps.stdin.end();
    }
}, 20);
