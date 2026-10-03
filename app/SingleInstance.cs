using System.Runtime.InteropServices;
using System.Threading;

namespace DshWsxPanel;

/// <summary>
/// 单实例协调。宿主插件会按需拉起面板（可能在每次 Host 重连、每次点按钮时都拉一次），
/// 用户也可能自己双击 exe。第二个实例不该开出第二个窗口 ——
/// 它唤醒已经在跑的那个，然后安静退出。
/// </summary>
public static class SingleInstance
{
    private const string EventName = @"Local\DshWsxPanel.Activate";
    private static EventWaitHandle? _activateSignal;

    /// <summary>由「后启动的实例」调用：唤醒已经在跑的面板。</summary>
    public static void SignalExisting()
    {
        try
        {
            if (EventWaitHandle.TryOpenExisting(EventName, out var handle))
            {
                using (handle)
                {
                    handle.Set();
                }
            }
        }
        catch
        {
            // 拿不到就算了，安静退出即可 —— 单实例是尽力而为的优化，不是正确性依赖。
        }
    }

    /// <summary>由「首个实例」调用：起一条后台线程等唤醒信号。</summary>
    public static void StartListening(IntPtr windowHandle)
    {
        try
        {
            _activateSignal = new EventWaitHandle(false, EventResetMode.AutoReset, EventName);
            var thread = new Thread(() =>
            {
                while (true)
                {
                    try
                    {
                        _activateSignal.WaitOne();
                        BringToFront(windowHandle);
                    }
                    catch
                    {
                        return;
                    }
                }
            })
            {
                IsBackground = true,
                Name = "DshWsxPanel.Activate",
            };
            thread.Start();
        }
        catch
        {
            // 监听失败不影响主功能。
        }
    }

    private const int SW_RESTORE = 9;

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    private static void BringToFront(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return;
        try
        {
            Log.Write("收到唤醒信号 → 前置窗口");
            ShowWindow(hwnd, SW_RESTORE);
            SetForegroundWindow(hwnd);
        }
        catch
        {
            // ignore
        }
    }
}
