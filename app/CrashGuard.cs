using System;
using System.Text;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;

namespace DshWsxPanel;

/// <summary>
/// 未处理异常的收口。
///
/// 存在的理由：面板原先只订阅了 <see cref="Application.UnhandledException"/> 并且
/// **只写日志、没有把 <c>e.Handled</c> 置位** —— 于是 UI 线程上任何一个未处理异常
/// 都会让进程直接以 <c>-1</c> 结束。现象就是用户报的「经常闪退」：窗口突然消失，
/// 日志里往往什么都没有，Windows 事件日志里也查不到（不是崩溃，是异常终止）。
///
/// 三条通道都要接，缺一条就有一类异常漏网：
///   * <see cref="Application.UnhandledException"/> —— XAML/UI 线程；
///   * <see cref="AppDomain.UnhandledException"/> —— 其它线程（这个**无法**阻止进程结束，
///     但至少能把栈留下来）；
///   * <see cref="TaskScheduler.UnobservedTaskException"/> —— 被丢弃的 Task 异常。
///
/// 对 UI 线程那条 **标记为已处理**：面板是个只读观察器，一次布局/绑定异常不该
/// 让用户丢掉整个窗口。日志里留下完整栈，行为上优先保活。
/// </summary>
public static class CrashGuard
{
    private static bool _installed;

    /// <summary>幂等安装。在 <see cref="App"/> 构造里、InitializeComponent 之前调用。</summary>
    public static void Install(Application app)
    {
        if (_installed) return;
        _installed = true;

        app.UnhandledException += (_, e) =>
        {
            LogCrash("UI 线程未处理异常（已标记 Handled，进程保活）", e.Exception);
            // 保活优先：不置位的话进程会立刻以 -1 退出，用户看到的就是「闪退」。
            e.Handled = true;
        };

        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
        {
            // IsTerminating 基本总是 true —— 这条通道救不回来，只求留下证据。
            LogCrash("非 UI 线程未处理异常（进程即将结束）", e.ExceptionObject as Exception);
        };

        TaskScheduler.UnobservedTaskException += (_, e) =>
        {
            LogCrash("未观察的 Task 异常（已标记 Observed）", e.Exception);
            e.SetObserved();
        };
    }

    private static void LogCrash(string context, Exception? ex)
    {
        var builder = new StringBuilder();
        builder.Append(context);

        if (ex is null)
        {
            builder.AppendLine();
            builder.Append("  （没有异常对象）");
        }
        else
        {
            // 把 InnerException 链全部展开 —— 真正的原因通常在里层。
            int depth = 0;
            for (Exception? current = ex; current is not null && depth < 8; current = current.InnerException, depth++)
            {
                builder.AppendLine();
                builder.Append(depth == 0 ? "  " : $"  [{depth}] ");
                builder.Append($"{current.GetType().FullName}: {current.Message}");
                if (!string.IsNullOrWhiteSpace(current.StackTrace))
                {
                    builder.AppendLine();
                    builder.Append(current.StackTrace);
                }
            }
        }

        // 含 HResult：0x8000xxxx 这类值能直接指出是 COM/WinRT 还是普通托管异常。
        if (ex is not null) builder.AppendLine().Append($"  HResult=0x{ex.HResult:X8}");

        try
        {
            Log.Write(builder.ToString());
        }
        catch
        {
            // Log 自己已经吞异常了；这里再兜一层，绝不让记录崩溃这件事引发崩溃。
        }
    }
}
