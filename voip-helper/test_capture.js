const { spawn } = require('child_process');
const path = require('path');

const scriptPath = path.join(__dirname, 'capture_audio.ps1');
const deviceId = process.argv[2] || '-1';

console.log(`Testing capture_audio.ps1 with deviceId: ${deviceId}`);

const ps = spawn('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
    deviceId
]);

ps.stdout.on('data', (data) => {
    console.log(`Received ${data.length} bytes of audio data.`);
});

ps.stderr.on('data', (data) => {
    console.error(`STDERR: ${data.toString()}`);
});

ps.on('close', (code) => {
    console.log(`Process exited with code ${code}`);
});

setTimeout(() => {
    console.log("Stopping after 5 seconds...");
    ps.stdin.write('q\n');
    ps.kill();
}, 5000);
