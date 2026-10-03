using System.Threading;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;

namespace DshWsxPanel;

/// <summary>
/// 显式入口点（csproj 里定义了 DISABLE_XAML_GENERATED_MAIN）。
/// 必须在窗口出现之前完成三件事：
///   1. 解析命令行/环境变量（--state 等）；
///   2. headless 的 --dump-status 分支（完全不起 UI 线程）；
///   3. 单实例互斥体 —— 宿主插件可以放心地反复拉起本程序，重复实例会唤醒已有窗口后立刻退出。
/// </summary>
public static class Program
{
    private static Mutex? _instanceMutex;

    [STAThread]
    public static int Main(string[] args)
    {
        AppOptions options;
        try
        {
            options = AppOptions.Parse(args);
        }
        catch (Exception ex)
        {
            Log.Error("解析命令行参数失败", ex);
            return 10;
        }

        if (options.Help)
        {
            // 和 --dump-status 一样：显式写 UTF-8 字节，别依赖 Console.OutputEncoding
            // （WinExe 进程没有控制台时它取到的不是 UTF-8）。
            try
            {
                using var stdout = new System.IO.StreamWriter(
                    Console.OpenStandardOutput(), new System.Text.UTF8Encoding(false));
                stdout.Write(AppOptions.Usage);
                stdout.Write(Environment.NewLine);
                stdout.Flush();
            }
            catch
            {
                // 没有 stdout 就算了。
            }
            return 0;
        }

        // headless 路径：走完就退出，绝不初始化 WinUI。
        if (options.DumpStatus)
        {
            try
            {
                return StatusDump.Run(options);
            }
            catch (Exception ex)
            {
                Log.Error("--dump-status 失败", ex);
                return 12;
            }
        }

        Log.Write(Format.Join(
            "启动",
            $"state={options.StatePath}",
            $"stale={options.StaleSeconds}s",
            $"exitAfterStale={options.ExitAfterStaleSeconds}s",
            $"topmost={Describe(options.Topmost)}",
            $"compact={Describe(options.Compact)}",
            $"args=[{string.Join(' ', args)}]"));

        _instanceMutex = new Mutex(initiallyOwned: true, @"Local\DshWsxPanel.SingleInstance", out bool createdNew);
        if (!createdNew)
        {
            Log.Write("已有实例在运行 → 唤醒它，本进程退出");
            SingleInstance.SignalExisting();
            return 0;
        }

        App.Options = options;

        try
        {
            WinRT.ComWrappersSupport.InitializeComWrappers();
            Application.Start(_ =>
            {
                var context = new DispatcherQueueSynchronizationContext(DispatcherQueue.GetForCurrentThread());
                SynchronizationContext.SetSynchronizationContext(context);
                // 注意：这里不能写 `_ = new App();` —— 那个 `_` 会被解析成上面
                // lambda 的参数（ApplicationInitializationCallbackParams），
                // 赋值就变成「把 App 塞进 callback 参数」的类型错误。
                new App();
            });
        }
        catch (Exception ex)
        {
            // 最常见的原因就是某个 {ThemeResource} 键不存在：XAML 加载会在这里抛。
            Log.Error("Application.Start 失败", ex);
            return 11;
        }
        finally
        {
            GC.KeepAlive(_instanceMutex);
        }

        Log.Write("正常退出");
        return 0;
    }

    private static string Describe(bool? value) => value switch
    {
        true => "on",
        false => "off",
        _ => "(记住的值)",
    };
}
