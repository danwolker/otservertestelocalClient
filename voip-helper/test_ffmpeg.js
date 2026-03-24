const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');

console.log('Testing ffmpeg audio capture...');
console.log('FFmpeg path:', ffmpegPath);

// List devices
const listProcess = spawn(ffmpegPath, ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);

let stderrData = '';
listProcess.stderr.on('data', (data) => {
    stderrData += data.toString();
});

listProcess.on('close', () => {
    console.log('FFmpeg device list output:');
    
    // Parse the output to find audio devices
    const lines = stderrData.split('\n');
    let isAudioSection = false;
    const audioDevices = [];
    
    for (const line of lines) {
        if (line.includes('DirectShow audio devices')) {
            isAudioSection = true;
            continue;
        } else if (line.includes('DirectShow video devices')) {
            isAudioSection = false;
            continue;
        }
        
        if (isAudioSection && line.includes(']  "')) {
            const match = line.match(/"([^"]+)"/);
            if (match && match[1]) {
                audioDevices.push(match[1]);
            }
        }
    }
    
    console.log(audioDevices);
    
    if (audioDevices.length > 0) {
        console.log(`\nAttempting to record from: ${audioDevices[0]}`);
        
        // Try recording 3 seconds of audio
        const recordProcess = spawn(ffmpegPath, [
            '-f', 'dshow',
            '-i', `audio=${audioDevices[0]}`,
            '-t', '3',
            '-f', 's16le',
            '-ar', '48000',
            '-ac', '1',
            '-'
        ]);
        
        let byteCount = 0;
        recordProcess.stdout.on('data', (chunk) => {
            byteCount += chunk.length;
            process.stdout.write('.');
        });
        
        recordProcess.on('close', (code) => {
            console.log(`\nRecording finished with code ${code}. Captured ${byteCount} bytes of audio data.`);
            process.exit(code);
        });
    } else {
        console.log('No audio devices found.');
    }
});
