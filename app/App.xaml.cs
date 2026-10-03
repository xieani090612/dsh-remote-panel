using Microsoft.UI.Xaml;

namespace DshWsxPanel;

public partial class App : Application
{
    /// <summary>在 Application.Start 之前由 Program 填好。</summary>
    public static AppOptions Options { get; set; } = AppOptions.Default;

    public App()
    {
        // 在 InitializeComponent 之前挂：XAML 加载本身失败时也要能留下日志，
        // 否则现象只是「双击了，什么都没发生」。
        // 三条通道（UI 线程 / 非 UI 线程 / 未观察 Task）都接，且 UI 线程那条会保活 ——
        // 见 CrashGuard 的注释：原先只写日志不置 Handled，是「闪退」的直接原因。
        CrashGuard.Install(this);

        InitializeComponent();
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        try
        {
            var window = new MainWindow();
            window.Activate();
            Log.Write("窗口已激活");
        }
        catch (Exception ex)
        {
            Log.Error("创建 MainWindow 失败", ex);
            // 窗口起不来就没有任何东西可交互了，直接退出，让宿主看到非零退出码。
            Environment.Exit(13);
        }
    }
}
