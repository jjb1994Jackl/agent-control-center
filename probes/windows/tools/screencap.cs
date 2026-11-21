// One-off test tool: what visibly changes on screen while a test runs.
//   screencap <dir> [--every 16] [--preroll 1500] [--max 120000] [--threshold 24] [--gdi 1]
// Records what the screen shows until the file <dir>\stop appears or <max> ms pass, and compares each
// frame with the first one (the baseline).
// - By default through DXGI Desktop Duplication: every frame the compositor (DWM) presents, with the
//   time it was presented (LastPresentTime, on the performance counter). A change shown for one
//   refresh is therefore seen, and how long it stayed is the time to the next frame without it.
//   The screen is polled at least every <every> ms; when nothing is presented, nothing changed.
// - With --gdi 1, or when duplication cannot start, a GDI BitBlt of the whole screen every <every> ms
//   (about 22 ms per capture at 2560×1440, so a one-frame change can be missed).
// During the preroll, 16×16 cells that change on their own (a blinking caret, a clock) are learnt as
// noise; afterwards changes are counted inside and outside the noise cells.
// Writes <dir>\baseline.png and the first frame of each run of changed frames (up to 40) as PNG, and
// prints one JSON line. The frames show the person's screen: keep them under probes\windows\out\ only.
// Times are milliseconds on the machine-wide performance counter (qpcMs), as corner and uia-probe use.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;

public static unsafe class ScreenCap
{
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
    [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr d, int x, int y, int w, int h, IntPtr s, int sx, int sy, uint rop);
    [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BITMAPINFOHEADER bi, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint p);
    [DllImport("d3d11.dll")] static extern int D3D11CreateDevice(IntPtr adapter, int driverType, IntPtr software, uint flags, IntPtr levels, uint nLevels, uint sdk, out IntPtr device, out int level, out IntPtr context);
    [StructLayout(LayoutKind.Sequential)] struct BITMAPINFOHEADER { public int biSize, biWidth, biHeight; public short biPlanes, biBitCount; public int biCompression, biSizeImage, biXPelsPerMeter, biYPelsPerMeter, biClrUsed, biClrImportant; }
    [StructLayout(LayoutKind.Sequential)] struct FRAME_INFO { public long LastPresentTime, LastMouseUpdateTime; public uint AccumulatedFrames; public int RectsCoalesced, ProtectedMasked, PointerX, PointerY, PointerVisible; public uint MetadataSize, PointerShapeSize; }
    [StructLayout(LayoutKind.Sequential)] struct TEX2D_DESC { public uint Width, Height, MipLevels, ArraySize, Format, SampleCount, SampleQuality, Usage, BindFlags, CPUAccessFlags, MiscFlags; }
    [StructLayout(LayoutKind.Sequential)] struct MAPPED { public IntPtr pData; public uint RowPitch, DepthPitch; }

    // COM calls by vtable slot (slots counted from the Windows SDK 10.0.22621 headers).
    delegate int D_Out(IntPtr self, out IntPtr result);
    delegate int D_UintOut(IntPtr self, uint i, out IntPtr result);
    delegate int D_PtrOut(IntPtr self, IntPtr p, out IntPtr result);
    delegate int D_Acquire(IntPtr self, uint timeout, out FRAME_INFO info, out IntPtr resource);
    delegate int D_Dirty(IntPtr self, uint size, IntPtr buffer, out uint required);
    delegate int D_Self(IntPtr self);
    delegate int D_CreateTex(IntPtr self, ref TEX2D_DESC desc, IntPtr init, out IntPtr tex);
    delegate void D_Copy(IntPtr self, IntPtr dst, IntPtr src);
    delegate int D_Map(IntPtr self, IntPtr res, uint sub, int type, uint flags, out MAPPED m);
    delegate void D_Unmap(IntPtr self, IntPtr res, uint sub);
    static T Slot<T>(IntPtr com, int slot) where T : class { IntPtr vt = Marshal.ReadIntPtr(com); return Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vt, slot * IntPtr.Size), typeof(T)) as T; }
    static IntPtr QI(IntPtr com, string iid) { Guid g = new Guid(iid); IntPtr r; int hr = Marshal.QueryInterface(com, ref g, out r); if (hr != 0) throw new Exception("QueryInterface " + iid + " 0x" + hr.ToString("x")); return r; }
    static void Check(int hr, string what) { if (hr != 0) throw new Exception(what + " 0x" + hr.ToString("x8")); }

    static double Qpc() { return Stopwatch.GetTimestamp() * 1000.0 / Stopwatch.Frequency; }
    static void Save(uint[] px, int w, int h, string path)
    {
        using (Bitmap b = new Bitmap(w, h, PixelFormat.Format32bppRgb))
        {
            BitmapData d = b.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppRgb);
            fixed (uint* src = px) { for (int y = 0; y < h; y++) Buffer.MemoryCopy(src + y * w, (byte*)d.Scan0 + y * d.Stride, w * 4, w * 4); }
            b.UnlockBits(d); b.Save(path, ImageFormat.Png);
        }
    }

    // ---- what the comparison keeps ----
    static int W, H, VX, VY, CW, Thr, Preroll;
    static uint[] baseline; static bool[] noise; static double start;
    static readonly List<object> rows = new List<object>();
    static readonly List<Dictionary<string, object>> runs = new List<Dictionary<string, object>>();
    static Dictionary<string, object> run; static int saved; static string Dir;
    static int presented, compared, accessLost, maxAccumulated;
    // Compares one frame (rows of <pitch> pixels) with the baseline, at time <t> (when it was shown).
    static void Compare(uint* cur, int pitch, double t)
    {
        bool learning = t - start < Preroll;
        int changed = 0, noiseChanged = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
        fixed (uint* b0 = baseline)
        {
            for (int y = 0; y < H; y++)
            {
                uint* a = cur + y * pitch, b = b0 + y * W; int cy = y >> 4;
                for (int x = 0; x < W; x++)
                {
                    uint pa = a[x] | 0xff000000u, pb = b[x];
                    if (pa == pb) continue;
                    int dr = (int)((pa >> 16) & 255) - (int)((pb >> 16) & 255), dg = (int)((pa >> 8) & 255) - (int)((pb >> 8) & 255), db = (int)(pa & 255) - (int)(pb & 255);
                    if (Math.Abs(dr) <= Thr && Math.Abs(dg) <= Thr && Math.Abs(db) <= Thr) continue;
                    int cell = cy * CW + (x >> 4);
                    if (learning) { noise[cell] = true; continue; }
                    if (noise[cell]) { noiseChanged++; continue; }
                    changed++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
                }
            }
        }
        compared++;
        if (learning) return;
        if (run != null && changed == 0) { run["untilQpcMs"] = Math.Round(t, 1); run["shownMs"] = Math.Round(t - (double)run["fromQpcMs"], 1); run = null; }
        if (changed == 0) return;
        rows.Add(new object[] { Math.Round(t, 1), changed, x0 + VX, y0 + VY, x1 + VX, y1 + VY, noiseChanged });
        if (run == null)
        {
            run = new Dictionary<string, object> { { "fromQpcMs", Math.Round(t, 1) }, { "frames", 0 }, { "maxPixels", 0 }, { "bbox", new[] { x0 + VX, y0 + VY, x1 + VX, y1 + VY } } };
            runs.Add(run);
            if (saved < 40)
            {
                uint[] copy = new uint[W * H];
                fixed (uint* c = copy) for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) c[y * W + x] = cur[y * pitch + x] | 0xff000000u;
                Save(copy, W, H, Path.Combine(Dir, "run" + runs.Count.ToString("00") + ".png")); saved++;
            }
        }
        run["frames"] = (int)run["frames"] + 1; run["lastQpcMs"] = Math.Round(t, 1);
        run["maxPixels"] = Math.Max((int)run["maxPixels"], changed);
        int[] bb = (int[])run["bbox"]; bb[0] = Math.Min(bb[0], x0 + VX); bb[1] = Math.Min(bb[1], y0 + VY); bb[2] = Math.Max(bb[2], x1 + VX); bb[3] = Math.Max(bb[3], y1 + VY);
    }
    static void TakeBaseline(uint* cur, int pitch)
    {
        baseline = new uint[W * H];
        fixed (uint* b = baseline) for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) b[y * W + x] = cur[y * pitch + x] | 0xff000000u;
        Save(baseline, W, H, Path.Combine(Dir, "baseline.png"));
    }

    // ---- DXGI Desktop Duplication ----
    static IntPtr device, context, output1, dup, staging;
    static void StartDuplication()
    {
        int level;
        Check(D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero, 0, IntPtr.Zero, 0, 7, out device, out level, out context), "D3D11CreateDevice");
        IntPtr dxgiDevice = QI(device, "54ec77fa-1377-44e6-8c32-88fd5f44c84c"), adapter, output;
        Check(Slot<D_Out>(dxgiDevice, 7)(dxgiDevice, out adapter), "GetAdapter");
        Check(Slot<D_UintOut>(adapter, 7)(adapter, 0, out output), "EnumOutputs");
        output1 = QI(output, "00cddea8-939b-4b83-a340-a685226666cc");
        Duplicate();
        TEX2D_DESC d = new TEX2D_DESC { Width = (uint)W, Height = (uint)H, MipLevels = 1, ArraySize = 1, Format = 87, SampleCount = 1, Usage = 3, CPUAccessFlags = 0x20000 };
        Check(Slot<D_CreateTex>(device, 5)(device, ref d, IntPtr.Zero, out staging), "CreateTexture2D");
    }
    static void Duplicate() { Check(Slot<D_PtrOut>(output1, 22)(output1, device, out dup), "DuplicateOutput"); }
    static void RunDuplication(int every, int max, string stop)
    {
        double ticksToMs = 1000.0 / Stopwatch.Frequency;
        bool haveBaseline = false;
        while (Qpc() - start < max && !File.Exists(stop))
        {
            FRAME_INFO info; IntPtr res;
            int hr = Slot<D_Acquire>(dup, 8)(dup, (uint)every, out info, out res);
            if (hr == unchecked((int)0x887A0027)) continue;                       // DXGI_ERROR_WAIT_TIMEOUT: nothing new on screen
            if (hr == unchecked((int)0x887A0026)) { accessLost++; Marshal.Release(dup); Thread.Sleep(50); try { Duplicate(); } catch { } continue; }
            Check(hr, "AcquireNextFrame");
            try
            {
                if (info.LastPresentTime == 0) continue;                              // only the pointer moved
                presented++; maxAccumulated = Math.Max(maxAccumulated, (int)info.AccumulatedFrames);
                double t = info.LastPresentTime * ticksToMs;
                IntPtr tex = QI(res, "6f15aaf2-d208-4e89-9ab4-489535d34f9c");
                Slot<D_Copy>(context, 47)(context, staging, tex);
                Marshal.Release(tex);
                MAPPED m; Check(Slot<D_Map>(context, 14)(context, staging, 0, 1, 0, out m), "Map");
                try
                {
                    uint* px = (uint*)m.pData.ToPointer(); int pitch = (int)m.RowPitch / 4;
                    if (!haveBaseline) { TakeBaseline(px, pitch); haveBaseline = true; start = t; }
                    else Compare(px, pitch, t);
                }
                finally { Slot<D_Unmap>(context, 15)(context, staging, 0); }
            }
            finally { Marshal.Release(res); Slot<D_Self>(dup, 14)(dup); }
        }
    }

    // ---- GDI fallback ----
    static void RunGdi(int every, int max, string stop)
    {
        IntPtr screen = GetDC(IntPtr.Zero), mem = CreateCompatibleDC(screen);
        BITMAPINFOHEADER bi = new BITMAPINFOHEADER(); bi.biSize = 40; bi.biWidth = W; bi.biHeight = -H; bi.biPlanes = 1; bi.biBitCount = 32;
        IntPtr bits; IntPtr dib = CreateDIBSection(screen, ref bi, 0, out bits, IntPtr.Zero, 0);
        SelectObject(mem, dib);
        uint* cur = (uint*)bits.ToPointer();
        BitBlt(mem, 0, 0, W, H, screen, VX, VY, 0x00CC0020); start = Qpc(); TakeBaseline(cur, W);
        double next = Qpc();
        while (Qpc() - start < max && !File.Exists(stop))
        {
            next += every; double wait = next - Qpc(); if (wait > 1) Thread.Sleep((int)wait);
            double t0 = Qpc(); BitBlt(mem, 0, 0, W, H, screen, VX, VY, 0x00CC0020); presented++;
            Compare(cur, W, t0);
        }
        ReleaseDC(IntPtr.Zero, screen);
    }

    public static int Main(string[] args)
    {
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        timeBeginPeriod(1);
        Dir = args[0]; Directory.CreateDirectory(Dir);
        var o = new Dictionary<string, string>();
        for (int i = 1; i + 1 < args.Length; i += 2) o[args[i].TrimStart('-')] = args[i + 1];
        Func<string, int, int> opt = (k, d) => o.ContainsKey(k) ? int.Parse(o[k]) : d;
        int every = opt("every", 16), max = opt("max", 120000); Preroll = opt("preroll", 1500); Thr = opt("threshold", 24);
        string stop = Path.Combine(Dir, "stop");
        VX = GetSystemMetrics(76); VY = GetSystemMetrics(77); W = GetSystemMetrics(78); H = GetSystemMetrics(79);
        CW = (W + 15) / 16; noise = new bool[CW * ((H + 15) / 16)];
        start = Qpc();
        string mode = "dxgi", why = null;
        if (opt("gdi", 0) == 1) mode = "gdi";
        else { try { StartDuplication(); } catch (Exception e) { mode = "gdi"; why = e.Message; } }
        try { if (mode == "dxgi") RunDuplication(every, max, stop); else RunGdi(every, max, stop); }
        catch (Exception e) { why = (why == null ? "" : why + "; ") + e.Message; }
        if (run != null) run["stillShownAtEnd"] = true;
        int noiseCells = 0; foreach (bool b in noise) if (b) noiseCells++;
        var json = new JavaScriptSerializer(); json.MaxJsonLength = int.MaxValue;
        Console.WriteLine(json.Serialize(new Dictionary<string, object> {
            { "mode", mode }, { "error", why }, { "screen", new[] { VX, VY, W, H } }, { "startQpcMs", Math.Round(start, 1) }, { "prerollMs", Preroll },
            { "framesPresented", presented }, { "framesCompared", compared }, { "maxAccumulatedFrames", maxAccumulated }, { "accessLost", accessLost },
            { "noiseCells", noiseCells }, { "changedFrames", rows.Count }, { "runs", runs },
            { "rowsNote", "rows: [qpcMs shown, changed pixels outside noise cells, bbox x0,y0,x1,y1, changed pixels inside noise cells]; a run lasts from fromQpcMs to untilQpcMs, the first frame shown without it" },
            { "rows", rows.Count > 2000 ? rows.GetRange(0, 2000) : rows } }));
        return 0;
    }
}
