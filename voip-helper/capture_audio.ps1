Add-Type -AssemblyName System.Windows.Forms
$source = @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.IO;

public class AudioCapture {
    // Defines
    private const int WAVE_FORMAT_PCM = 1;
    private const int WAVE_MAPPER = -1;
    private const int CALLBACK_FUNCTION = 0x30000;
    private const int WHDR_DONE = 0x00000001;
    private const int MM_WIM_DATA = 0x3C0;

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

    public delegate void waveInProc(IntPtr hwi, uint uMsg, IntPtr dwInstance, IntPtr dwParam1, IntPtr dwParam2);

    [DllImport("winmm.dll", SetLastError = true)]
    public static extern uint waveInOpen(out IntPtr phwi, int uDeviceID, ref WAVEFORMATEX lpFormat, waveInProc dwCallback, IntPtr dwInstance, uint fdwOpen);

    [DllImport("winmm.dll", SetLastError = true)]
    public static extern uint waveInStart(IntPtr hwi);

    [DllImport("winmm.dll", SetLastError = true)]
    public static extern uint waveInStop(IntPtr hwi);

    [DllImport("winmm.dll", SetLastError = true)]
    public static extern uint waveInClose(IntPtr hwi);

    [DllImport("winmm.dll", SetLastError = true)]
    public static extern uint waveInPrepareHeader(IntPtr hwi, ref WAVEHDR pwh, uint cbwh);

    [DllImport("winmm.dll", SetLastError = true)]
    public static extern uint waveInUnprepareHeader(IntPtr hwi, ref WAVEHDR pwh, uint cbwh);

    [DllImport("winmm.dll", SetLastError = true)]
    public static extern uint waveInAddBuffer(IntPtr hwi, ref WAVEHDR pwh, uint cbwh);

    private static IntPtr hWaveIn;
    private static WAVEFORMATEX format;
    private static waveInProc callback;
    private static bool isRecording = false;

    // Buffers setup
    private const int BUFFER_COUNT = 10;
    private const int BUFFER_SIZE = 1920; // 20ms of 48kHz 16-bit mono
    private static IntPtr[] buffers = new IntPtr[BUFFER_COUNT];
    private static WAVEHDR[] headers = new WAVEHDR[BUFFER_COUNT];

    private static Stream stdout = Console.OpenStandardOutput();

    public static void Callback(IntPtr hwi, uint uMsg, IntPtr dwInstance, IntPtr dwParam1, IntPtr dwParam2) {
        if (uMsg == MM_WIM_DATA && isRecording) {
            WAVEHDR hdr = (WAVEHDR)Marshal.PtrToStructure(dwParam1, typeof(WAVEHDR));
            if (hdr.dwBytesRecorded > 0) {
                byte[] data = new byte[hdr.dwBytesRecorded];
                Marshal.Copy(hdr.lpData, data, 0, (int)hdr.dwBytesRecorded);
                try {
                    stdout.Write(data, 0, data.Length);
                    stdout.Flush();
                } catch {
                    // Stop on broken pipe
                    isRecording = false;
                }
            }
            
            if (isRecording) {
                waveInAddBuffer(hwi, ref headers[FindHeaderIndex(dwParam1)], (uint)Marshal.SizeOf(typeof(WAVEHDR)));
            }
        }
    }

    private static int FindHeaderIndex(IntPtr ptr) {
        for (int i = 0; i < BUFFER_COUNT; i++) {
            if (headers[i].lpData == ((WAVEHDR)Marshal.PtrToStructure(ptr, typeof(WAVEHDR))).lpData)
                return i;
        }
        return 0;
    }

    public static void StartCapture(int deviceId) {
        format = new WAVEFORMATEX();
        format.wFormatTag = WAVE_FORMAT_PCM;
        format.nChannels = 1; // Mono
        format.nSamplesPerSec = 48000; // 48kHz
        format.wBitsPerSample = 16;
        format.nBlockAlign = (ushort)(format.nChannels * (format.wBitsPerSample / 8));
        format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
        format.cbSize = 0;

        format.cbSize = 0;

        Console.Error.WriteLine("INFO: Starting waveInOpen for device: " + deviceId);
        callback = new waveInProc(Callback);
        uint result = waveInOpen(out hWaveIn, deviceId, ref format, callback, IntPtr.Zero, CALLBACK_FUNCTION);
        
        if (result != 0) {
            Console.Error.WriteLine("Failed to open audio device. Error code: " + result);
            return;
        }

        Console.Error.WriteLine("INFO: waveInOpen successful.");
        for (int i = 0; i < BUFFER_COUNT; i++) {
            buffers[i] = Marshal.AllocHGlobal(BUFFER_SIZE);
            headers[i] = new WAVEHDR();
            headers[i].lpData = buffers[i];
            headers[i].dwBufferLength = BUFFER_SIZE;
            headers[i].dwFlags = 0;
            
            waveInPrepareHeader(hWaveIn, ref headers[i], (uint)Marshal.SizeOf(typeof(WAVEHDR)));
            waveInAddBuffer(hWaveIn, ref headers[i], (uint)Marshal.SizeOf(typeof(WAVEHDR)));
        }

        isRecording = true;
        Console.Error.WriteLine("INFO: Calling waveInStart.");
        waveInStart(hWaveIn);
        Console.Error.WriteLine("INFO: Capture loop started.");

        // Keep alive until process is killed
        while (isRecording) {
            Thread.Sleep(500);
        }

        Console.Error.WriteLine("INFO: Stopping capture...");
        StopCapture();
    }

    public static void StopCapture() {
        if (!isRecording) return;
        isRecording = false;
        waveInStop(hWaveIn);

        for (int i = 0; i < BUFFER_COUNT; i++) {
            waveInUnprepareHeader(hWaveIn, ref headers[i], (uint)Marshal.SizeOf(typeof(WAVEHDR)));
            Marshal.FreeHGlobal(buffers[i]);
        }
        waveInClose(hWaveIn);
    }
}
"@
Add-Type -TypeDefinition $source

$deviceId = if ($args.Length -gt 0) { [int]$args[0] } else { -1 }
[AudioCapture]::StartCapture($deviceId)
