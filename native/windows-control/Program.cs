using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Windows.Forms;

var input = Console.In.ReadToEnd();
var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
try
{
    var request = JsonSerializer.Deserialize<Request>(input, options) ?? throw new InvalidOperationException("Missing request.");
    var result = request.Command switch
    {
        "list-windows" => Result.Success(Native.ListWindows()),
        "capture" => Result.Success(Native.Capture(Native.ParseHandle(request.Handle))),
        "execute" => Result.Success(Native.Execute(Native.ParseHandle(request.Handle), request.Action ?? throw new InvalidOperationException("Missing action."))),
        _ => throw new InvalidOperationException("Unsupported desktop-control command.")
    };
    Console.Out.Write(JsonSerializer.Serialize(result, options));
}
catch (Exception error)
{
    Console.Out.Write(JsonSerializer.Serialize(Result.Fail(error.Message), options));
}

sealed class Request
{
    [JsonPropertyName("command")] public string Command { get; set; } = "";
    [JsonPropertyName("handle")] public string? Handle { get; set; }
    [JsonPropertyName("action")] public JsonElement? Action { get; set; }
}

sealed record WindowInfo(string Handle, int ProcessId, string ProcessPath, string Title, Bounds Bounds);
sealed record Bounds(int X, int Y, int Width, int Height);
sealed record CaptureResult(string MimeType, string DataBase64, int Width, int Height);
sealed record Result(bool Ok, object? Value, string? Error)
{
    public static Result Success(object value) => new(true, value, null);
    public static Result Fail(string error) => new(false, null, error);
}

static class Native
{
    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;
    private const uint MOUSEEVENTF_MOVE = 0x0001;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;
    private const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    private const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;
    private const int SM_XVIRTUALSCREEN = 76;
    private const int SM_YVIRTUALSCREEN = 77;
    private const int SM_CXVIRTUALSCREEN = 78;
    private const int SM_CYVIRTUALSCREEN = 79;

    public static List<WindowInfo> ListWindows()
    {
        var windows = new List<WindowInfo>();
        EnumWindows((handle, _) =>
        {
            if (!IsWindowVisible(handle) || IsIconic(handle) || GetWindowTextLength(handle) == 0) return true;
            if (!GetWindowRect(handle, out var rect)) return true;
            GetWindowThreadProcessId(handle, out var processId);
            var title = GetTitle(handle);
            var path = ProcessPath((int)processId);
            if (string.IsNullOrWhiteSpace(path)) return true;
            windows.Add(new WindowInfo(HandleText(handle), (int)processId, path, title,
                new Bounds(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top)));
            return true;
        }, IntPtr.Zero);
        return windows;
    }

    public static CaptureResult Capture(IntPtr handle)
    {
        var bounds = WindowBounds(handle);
        using var bitmap = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb);
        using (var graphics = Graphics.FromImage(bitmap))
            graphics.CopyFromScreen(bounds.X, bounds.Y, 0, 0, new Size(bounds.Width, bounds.Height), CopyPixelOperation.SourceCopy);
        using var stream = new MemoryStream();
        bitmap.Save(stream, ImageFormat.Png);
        return new CaptureResult("image/png", Convert.ToBase64String(stream.ToArray()), bounds.Width, bounds.Height);
    }

    public static object Execute(IntPtr handle, JsonElement action)
    {
        Focus(handle);
        var bounds = WindowBounds(handle);
        var type = RequiredString(action, "type");
        switch (type)
        {
            case "click": Click(PointInBounds(action, "x", "y", bounds), 1); break;
            case "double_click": Click(PointInBounds(action, "x", "y", bounds), 2); break;
            case "drag": Drag(PointInBounds(action.GetProperty("from"), "x", "y", bounds), PointInBounds(action.GetProperty("to"), "x", "y", bounds), OptionalInt(action, "durationMs", 120, 1, 2000)); break;
            case "scroll": Scroll(OptionalInt(action, "deltaX", 0, -2000, 2000), RequiredInt(action, "deltaY", -2000, 2000)); break;
            case "keypress": Keypress(action.GetProperty("keys")); break;
            case "type": Type(RequiredString(action, "text")); break;
            case "wait": Thread.Sleep(RequiredInt(action, "durationMs", 1, 5000)); break;
            case "screenshot": break;
            default: throw new InvalidOperationException("Unsupported typed action.");
        }
        return new { };
    }

    private static void Focus(IntPtr handle)
    {
        if (!IsWindow(handle)) throw new InvalidOperationException("The approved desktop window is no longer available.");
        if (IsIconic(handle)) ShowWindow(handle, 9);
        SetForegroundWindow(handle);
        Thread.Sleep(120);
        if (GetForegroundWindow() != handle) throw new InvalidOperationException("The approved desktop window could not be focused.");
    }

    private static Bounds WindowBounds(IntPtr handle)
    {
        if (!IsWindow(handle) || !GetWindowRect(handle, out var rect)) throw new InvalidOperationException("The approved desktop window is no longer available.");
        var width = rect.Right - rect.Left;
        var height = rect.Bottom - rect.Top;
        if (width < 1 || height < 1) throw new InvalidOperationException("The approved desktop window has no visible bounds.");
        return new Bounds(rect.Left, rect.Top, width, height);
    }

    private static void Click(Point point, int count)
    {
        for (var index = 0; index < count; index++)
        {
            Move(point);
            Send(Mouse(MOUSEEVENTF_LEFTDOWN));
            Send(Mouse(MOUSEEVENTF_LEFTUP));
        }
    }

    private static void Drag(Point from, Point to, int durationMs)
    {
        Move(from);
        Send(Mouse(MOUSEEVENTF_LEFTDOWN));
        Thread.Sleep(Math.Min(durationMs, 200));
        Move(to);
        Thread.Sleep(Math.Max(1, durationMs - Math.Min(durationMs, 200)));
        Send(Mouse(MOUSEEVENTF_LEFTUP));
    }

    private static void Scroll(int deltaX, int deltaY)
    {
        if (deltaY != 0) Send(Mouse(MOUSEEVENTF_WHEEL, unchecked((uint)deltaY)));
        // Windows has no consistently reliable horizontal-wheel injection for every target.
        if (deltaX != 0) throw new InvalidOperationException("Horizontal desktop scrolling is not supported.");
    }

    private static void Type(string text)
    {
        if (text.Length is < 1 or > 2000) throw new InvalidOperationException("Desktop typing must contain 1-2000 characters.");
        foreach (var character in text)
        {
            Send(KeyUnicode(character, false));
            Send(KeyUnicode(character, true));
        }
    }

    private static void Keypress(JsonElement keys)
    {
        if (keys.ValueKind != JsonValueKind.Array || keys.GetArrayLength() is < 1 or > 4) throw new InvalidOperationException("Desktop keypress requires one to four keys.");
        var values = keys.EnumerateArray().Select(key => KeyCode(key.GetString() ?? "")).ToArray();
        foreach (var value in values) Send(Key(value, false));
        for (var index = values.Length - 1; index >= 0; index--) Send(Key(values[index], true));
    }

    private static ushort KeyCode(string key)
    {
        var normalized = key.Replace("-", "", StringComparison.Ordinal).Replace("_", "", StringComparison.Ordinal).ToUpperInvariant();
        return normalized switch
        {
            "CTRL" or "CONTROL" => 0x11,
            "SHIFT" => 0x10,
            "ALT" => 0x12,
            "ENTER" => 0x0D,
            "ESC" or "ESCAPE" => 0x1B,
            "TAB" => 0x09,
            "SPACE" => 0x20,
            "BACKSPACE" => 0x08,
            "DELETE" => 0x2E,
            "UP" => 0x26,
            "DOWN" => 0x28,
            "LEFT" => 0x25,
            "RIGHT" => 0x27,
            _ when normalized.Length == 1 && char.IsLetterOrDigit(normalized[0]) => (ushort)char.ToUpperInvariant(normalized[0]),
            _ => throw new InvalidOperationException($"Unsupported desktop key: {key}.")
        };
    }

    private static Point PointInBounds(JsonElement action, string xName, string yName, Bounds bounds)
    {
        var point = new Point(RequiredInt(action, xName, int.MinValue, int.MaxValue), RequiredInt(action, yName, int.MinValue, int.MaxValue));
        if (point.X < bounds.X || point.X >= bounds.X + bounds.Width || point.Y < bounds.Y || point.Y >= bounds.Y + bounds.Height)
            throw new InvalidOperationException("Desktop pointer action falls outside the approved window.");
        return point;
    }
    private static string RequiredString(JsonElement element, string name) => element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : throw new InvalidOperationException($"Missing {name}.");
    private static int RequiredInt(JsonElement element, string name, int min, int max) => element.TryGetProperty(name, out var value) && value.TryGetInt32(out var number) && number >= min && number <= max ? number : throw new InvalidOperationException($"Invalid {name}.");
    private static int OptionalInt(JsonElement element, string name, int fallback, int min, int max) => element.TryGetProperty(name, out _) ? RequiredInt(element, name, min, max) : fallback;

    public static IntPtr ParseHandle(string? value) => long.TryParse(value, out var handle) && handle != 0 ? new IntPtr(handle) : throw new InvalidOperationException("Invalid desktop window handle.");
    private static string HandleText(IntPtr handle) => handle.ToInt64().ToString();
    private static string GetTitle(IntPtr handle) { var text = new System.Text.StringBuilder(GetWindowTextLength(handle) + 1); GetWindowText(handle, text, text.Capacity); return text.ToString(); }
    private static string ProcessPath(int id) { try { return Process.GetProcessById(id).MainModule?.FileName ?? ""; } catch { return ""; } }
    private static void Move(Point point) { var x = GetSystemMetrics(SM_XVIRTUALSCREEN); var y = GetSystemMetrics(SM_YVIRTUALSCREEN); var width = GetSystemMetrics(SM_CXVIRTUALSCREEN); var height = GetSystemMetrics(SM_CYVIRTUALSCREEN); Send(Mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, 0, (uint)Math.Clamp((point.X - x) * 65535 / Math.Max(1, width - 1), 0, 65535), (uint)Math.Clamp((point.Y - y) * 65535 / Math.Max(1, height - 1), 0, 65535))); }
    private static INPUT Mouse(uint flags, uint data = 0, uint dx = 0, uint dy = 0) => new() { Type = INPUT_MOUSE, Union = new InputUnion { Mouse = new MOUSEINPUT { Dx = (int)dx, Dy = (int)dy, MouseData = data, DwFlags = flags } } };
    private static INPUT Key(ushort key, bool up) => new() { Type = INPUT_KEYBOARD, Union = new InputUnion { Keyboard = new KEYBDINPUT { WVk = key, DwFlags = up ? KEYEVENTF_KEYUP : 0 } } };
    private static INPUT KeyUnicode(char character, bool up) => new() { Type = INPUT_KEYBOARD, Union = new InputUnion { Keyboard = new KEYBDINPUT { WScan = character, DwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0) } } };
    private static void Send(INPUT input) { if (SendInput(1, new[] { input }, Marshal.SizeOf<INPUT>()) != 1) throw new InvalidOperationException("Windows rejected the desktop input."); }

    [StructLayout(LayoutKind.Sequential)] private struct INPUT { public uint Type; public InputUnion Union; }
    [StructLayout(LayoutKind.Explicit)] private struct InputUnion { [FieldOffset(0)] public MOUSEINPUT Mouse; [FieldOffset(0)] public KEYBDINPUT Keyboard; }
    [StructLayout(LayoutKind.Sequential)] private struct MOUSEINPUT { public int Dx; public int Dy; public uint MouseData; public uint DwFlags; public uint Time; public IntPtr DwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct KEYBDINPUT { public ushort WVk; public ushort WScan; public uint DwFlags; public uint Time; public IntPtr DwExtraInfo; }
    private delegate bool EnumWindowsProc(IntPtr handle, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr handle);
    [DllImport("user32.dll")] private static extern int GetWindowTextLength(IntPtr handle);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr handle, System.Text.StringBuilder text, int maxCount);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr handle, out RECT rect);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr handle, int command);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
