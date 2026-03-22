local ffi_ok, ffi = pcall(require, 'ffi')
if ffi_ok then
    print(">> [VoIP Test] FFI is AVAILABLE! We can use DLLs directly!")
else
    print(">> [VoIP Test] FFI is NOT available. We need the Helper or C++ source.")
end
