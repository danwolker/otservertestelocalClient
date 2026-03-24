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
    public static extern uint waveOutPrepareHeader(IntPtr hwo, IntPtr pwh, uint cbwh);

    [DllImport("winmm.dll", SetLastError = true)]
    public static extern uint waveOutWrite(IntPtr hwo, IntPtr pwh, uint cbwh);

    [DllImport("winmm.dll", SetLastError = true)]
    public static extern uint waveOutUnprepareHeader(IntPtr hwo, IntPtr pwh, uint cbwh);

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

        int BUFFER_COUNT = 3;
        IntPtr[] buffers = new IntPtr[BUFFER_COUNT];
        IntPtr[] headerPtrs = new IntPtr[BUFFER_COUNT];

        for (int i = 0; i < BUFFER_COUNT; i++) {
            buffers[i] = Marshal.AllocHGlobal(1920);
            headerPtrs[i] = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WAVEHDR)));
            WAVEHDR h = new WAVEHDR();
            h.lpData = buffers[i];
            h.dwBufferLength = 1920;
            h.dwFlags = 1; // Start as WHDR_DONE so it's immediately available
            Marshal.StructureToPtr(h, headerPtrs[i], false);
        }

        Stream stdin = Console.OpenStandardInput();
        byte[] buffer = new byte[1920]; // 20ms chunks

        while (true) {
            int bytesRead = 0;
            try {
                int offset = 0;
                while (offset < buffer.Length) {
                    int read = stdin.Read(buffer, offset, buffer.Length - offset);
                    if (read == 0) break;
                    offset += read;
                }
                bytesRead = offset;
            } catch {
                break;
            }

            if (bytesRead == 0) break;

            int idx = -1;
            WAVEHDR currentHdr = new WAVEHDR();
            while (idx == -1) {
                for (int i = 0; i < BUFFER_COUNT; i++) {
                    currentHdr = (WAVEHDR)Marshal.PtrToStructure(headerPtrs[i], typeof(WAVEHDR));
                    if ((currentHdr.dwFlags & 1) == 1) { // WHDR_DONE
                        idx = i;
                        break;
                    }
                }
                if (idx == -1) Thread.Sleep(1);
            }

            if ((currentHdr.dwFlags & 2) != 0) { // WHDR_PREPARED
                waveOutUnprepareHeader(hWaveOut, headerPtrs[idx], (uint)Marshal.SizeOf(typeof(WAVEHDR)));
            }

            Marshal.Copy(buffer, 0, currentHdr.lpData, bytesRead);
            currentHdr.dwBufferLength = (uint)bytesRead;
            currentHdr.dwFlags = 0;
            Marshal.StructureToPtr(currentHdr, headerPtrs[idx], false);

            waveOutPrepareHeader(hWaveOut, headerPtrs[idx], (uint)Marshal.SizeOf(typeof(WAVEHDR)));
            waveOutWrite(hWaveOut, headerPtrs[idx], (uint)Marshal.SizeOf(typeof(WAVEHDR)));
        }

        // Cleanup
        for (int i = 0; i < BUFFER_COUNT; i++) {
            WAVEHDR h = (WAVEHDR)Marshal.PtrToStructure(headerPtrs[i], typeof(WAVEHDR));
            if ((h.dwFlags & 2) != 0) {
                waveOutUnprepareHeader(hWaveOut, headerPtrs[i], (uint)Marshal.SizeOf(typeof(WAVEHDR)));
            }
            Marshal.FreeHGlobal(buffers[i]);
            Marshal.FreeHGlobal(headerPtrs[i]);
        }
        waveOutClose(hWaveOut);
    }
}
"@
Add-Type -TypeDefinition $source
$deviceId = if ($args.Length -gt 0) { [int]$args[0] } else { -1 }
[AudioPlay]::PlayStream($deviceId)
