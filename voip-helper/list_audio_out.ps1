Add-Type -AssemblyName System.Windows.Forms
$source = @"
using System;
using System.Runtime.InteropServices;

public class AudioDeviceOut {
    [DllImport("winmm.dll", SetLastError = true)]
    public static extern uint waveOutGetNumDevs();

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    public struct WAVEOUTCAPS {
        public ushort wMid;
        public ushort wPid;
        public uint vDriverVersion;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string szPname;
        public uint dwFormats;
        public ushort wChannels;
        public ushort wReserved1;
        public uint dwSupport;
    }

    [DllImport("winmm.dll", SetLastError = true)]
    public static extern uint waveOutGetDevCaps(uint hwo, ref WAVEOUTCAPS pwoc, uint cbwoc);

    public static void ListDevices() {
        uint devs = waveOutGetNumDevs();
        for (uint i = 0; i < devs; i++) {
            WAVEOUTCAPS caps = new WAVEOUTCAPS();
            if (waveOutGetDevCaps(i, ref caps, (uint)Marshal.SizeOf(typeof(WAVEOUTCAPS))) == 0) {
                Console.WriteLine("Device " + i + ": " + caps.szPname);
            }
        }
    }
}
"@
Add-Type -TypeDefinition $source
[AudioDeviceOut]::ListDevices()
