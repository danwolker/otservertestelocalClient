Add-Type -AssemblyName System.Windows.Forms
$source = @"
using System;
using System.Runtime.InteropServices;

public class AudioDevice {
    [DllImport("winmm.dll", SetLastError = true)]
    public static extern uint waveInGetNumDevs();

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    public struct WAVEINCAPS {
        public ushort wMid;
        public ushort wPid;
        public uint vDriverVersion;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string szPname;
        public uint dwFormats;
        public ushort wChannels;
        public ushort wReserved1;
    }

    [DllImport("winmm.dll", SetLastError = true)]
    public static extern uint waveInGetDevCaps(uint hwo, ref WAVEINCAPS pwic, uint cbwic);

    public static void ListDevices() {
        uint devs = waveInGetNumDevs();
        Console.WriteLine(devs + " devices found.");
        for (uint i = 0; i < devs; i++) {
            WAVEINCAPS caps = new WAVEINCAPS();
            if (waveInGetDevCaps(i, ref caps, (uint)Marshal.SizeOf(typeof(WAVEINCAPS))) == 0) {
                Console.WriteLine("Device " + i + ": " + caps.szPname);
            }
        }
    }
}
"@
Add-Type -TypeDefinition $source
[AudioDevice]::ListDevices()
