Add-Type -AssemblyName System.Windows.Forms
$source = @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.IO;

public class AudioPlay {
    private const int WAVE_FORMAT_PCM = 1;

    [StructLayout(LayoutKind.Sequential)]
    public struct WAVEFORMATEX {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct WAVEHDR {
        public IntPtr lpData;
        public uint dwBufferLength;
        public uint dwBytesRecorded;
        public IntPtr dwUser;
        public uint dwFlags;
        public uint dwLoops;
        public IntPtr lpNext;
        public IntPtr reserved;
    }

    [DllImport("winmm.dll", SetLastError = true)]
    public static extern uint waveOutOpen(out IntPtr phwo, int uDeviceID, ref WAVEFORMATEX lpFormat, IntPtr dwCallback, IntPtr dwInstance, uint fdwOpen);

    [DllImport("winmm.dll", SetLastError = true)]
    public static extern uint waveOutPrepareHeader(IntPtr hwo, ref WAVEHDR pwh, uint cbwh);

    [DllImport("winmm.dll", SetLastError = true)]
    public static extern uint waveOutWrite(IntPtr hwo, ref WAVEHDR pwh, uint cbwh);

    [DllImport("winmm.dll", SetLastError = true)]
    public static extern uint waveOutUnprepareHeader(IntPtr hwo, ref WAVEHDR pwh, uint cbwh);

    [DllImport("winmm.dll", SetLastError = true)]
    public static extern uint waveOutClose(IntPtr hwo);

    public static void PlayStream(int deviceId) {
        WAVEFORMATEX format = new WAVEFORMATEX();
        format.wFormatTag = WAVE_FORMAT_PCM;
        format.nChannels = 1; // Mono
        format.nSamplesPerSec = 48000; // 48kHz
        format.wBitsPerSample = 16;
        format.nBlockAlign = (ushort)(format.nChannels * (format.wBitsPerSample / 8));
        format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
        format.cbSize = 0;

        IntPtr hWaveOut;
        uint result = waveOutOpen(out hWaveOut, deviceId, ref format, IntPtr.Zero, IntPtr.Zero, 0);
        
        if (result != 0) {
            Console.Error.WriteLine("Failed to open output audio device.");
            return;
        }

        Stream stdin = Console.OpenStandardInput();
        byte[] buffer = new byte[1920]; // 20ms chunks

        while (true) {
            int bytesRead = 0;
            try {
                // Read EXACTLY a full chunk if possible
                int offset = 0;
                while (offset < buffer.Length) {
                    int read = stdin.Read(buffer, offset, buffer.Length - offset);
                    if (read == 0) break; // EOF
                    offset += read;
                }
                bytesRead = offset;
            } catch {
                break;
            }

            if (bytesRead == 0) break;

            IntPtr unmanagedPointer = Marshal.AllocHGlobal(bytesRead);
            Marshal.Copy(buffer, 0, unmanagedPointer, bytesRead);

            WAVEHDR header = new WAVEHDR();
            header.lpData = unmanagedPointer;
            header.dwBufferLength = (uint)bytesRead;
            header.dwFlags = 0;

            waveOutPrepareHeader(hWaveOut, ref header, (uint)Marshal.SizeOf(typeof(WAVEHDR)));
            waveOutWrite(hWaveOut, ref header, (uint)Marshal.SizeOf(typeof(WAVEHDR)));

            // Let it play (dirty polling, but works for streaming)
            while ((header.dwFlags & 1) == 0) { // WHDR_DONE = 1
                Thread.Sleep(1);
            }

            waveOutUnprepareHeader(hWaveOut, ref header, (uint)Marshal.SizeOf(typeof(WAVEHDR)));
            Marshal.FreeHGlobal(unmanagedPointer);
        }

        waveOutClose(hWaveOut);
    }
}
"@
Add-Type -TypeDefinition $source
$deviceId = if ($args.Length -gt 0) { [int]$args[0] } else { -1 }
[AudioPlay]::PlayStream($deviceId)
