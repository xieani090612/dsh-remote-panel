using System.Runtime.InteropServices;
using Microsoft.UI;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;   // VisualTreeHelper：读「真正画出来的卡片宽度」用
using Windows.Graphics;
using WinRT.Interop;

namespace DshWsxPanel;

public sealed partial class MainWindow : Window
{
    private readonly AppOptions _options = App.Options;
    private readonly PanelViewModel _vm = new();
    private readonly WindowPlacement _placement;

    private WsxStateReader? _reader;
    private readonly DispatcherQueueTimer _ticker;

    private AppWindow? _appWindow;
    private IntPtr _hwnd;
    private OverlappedPresenter? _presenter;
    private SystemTheme.Mode _themeMode;

    // ---- 连接状态机的全部输入 ----
    // 状态本身是**算出来**的（见 ComputeStatus），不是靠散落各处的赋值去维护。
    // 这样「文件缺失」「解析失败」「心跳丢失」「宿主已退出」这四种情况不会互相覆盖：
    // 每次心跳/失败只更新这几个字段，下一次 tick 重新推导一遍。
    private HostInfo? _host;
    private string? _lastErrorDetail;
    private ConnectionState _lastErrorState = ConnectionState.Waiting;
    private long _lastFreshAt;
    private bool _everLive;
    private long _notLiveSince;
    private ConnectionState _shownState = ConnectionState.Waiting;

    // ---- 设置面板 ----
    private bool _loadingSettings;
    private DispatcherQueueTimer? _persistDebounce;

    public MainWindow()
    {
        InitializeComponent();
        Title = "DSH 远程目标面板";

        _placement = WindowPlacement.Load();

        // 命令行能覆盖记住的值（插件拉起时按参数来，用户手点开关则按记忆）。
        if (_options.Topmost is bool forcedTopmost) _placement.Topmost = forcedTopmost;
        if (_options.Compact is bool forcedCompact) _placement.Compact = forcedCompact;

        _themeMode = SystemTheme.Parse(_placement.Theme);

        RootGrid.DataContext = _vm;
        _vm.Compact = _placement.Compact;

        // ---- 随窗口大小自适应 ----
        // 由 RootGrid 的 SizeChanged 驱动：内容区一变，字号、留白、条高、
        // 列宽、显示哪些区块一起重算（`Apply` 在没跨过分层边界时是空操作）。
        RootGrid.SizeChanged += (_, e) =>
        {
            _vm.Metrics.Apply(e.NewSize.Width, e.NewSize.Height);
            UpdateTitleBarReserve();
            UpdateContentWidth();
            _vm.RefreshMetrics();
        };
        // 视口宽度单独跟一次：垂直滚动条出现/消失、以及内边距随档位变化时，
        // 它都会变，而 RootGrid 的尺寸可能一点没动。
        TargetsScroll.SizeChanged += (_, _) => UpdateContentWidth();
        // 先把当前尺寸喂一次：首次布局前 SizeChanged 还没触发，
        // 否则窗口会先以 Normal 档画一帧再跳到正确档位。
        _vm.Metrics.Apply(_placement.Width, _placement.Height);
        // 卡片宽度的首帧估值：用持久化的窗口宽度减掉列表内边距，再留 2 DIP 余量。
        // 宁可略窄也不能略宽 —— 横向滚动是关的，略宽会被直接裁掉右边框。
        // 真实的视口宽度由 UpdateContentWidth() 在同一轮布局里精确修正。
        var initialPad = _vm.Metrics.ScrollPadding;
        _vm.Metrics.CardWidth = Math.Max(200, _placement.Width - initialPad.Left - initialPad.Right - 2);

        // ---- 窗口与 Presenter ----
        _hwnd = WindowNative.GetWindowHandle(this);
        _appWindow = AppWindow.GetFromWindowId(Win32Interop.GetWindowIdFromWindow(_hwnd));
        _presenter = _appWindow.Presenter as OverlappedPresenter;
        if (_presenter is not null)
        {
            _presenter.IsResizable = true;
            _presenter.IsMaximizable = true;
            _presenter.IsMinimizable = true;
            _presenter.IsAlwaysOnTop = _placement.Topmost;
            // PreferredMinimum* 也是 DIP，和分层阈值、持久化单位保持一致。
            _presenter.PreferredMinimumWidth = WindowPlacement.MinWidth;
            _presenter.PreferredMinimumHeight = WindowPlacement.MinHeight;
        }

        ApplyPlacement();
        ApplyWindowIcon();

        // 整条标题栏都能拖动窗口；窗口边缘照常拉伸缩放。
        ExtendsContentIntoTitleBar = true;
        SetTitleBar(TitleBarDragRegion);
        UpdateTitleBarReserve();

        TopmostToggle.IsChecked = _placement.Topmost;
        CompactToggle.IsChecked = _placement.Compact;

        TopmostToggle.Checked += (_, _) => SetTopmost(true);
        TopmostToggle.Unchecked += (_, _) => SetTopmost(false);
        CompactToggle.Checked += (_, _) =>
        {
            _vm.Compact = true;
            PersistSettings();
        };
        CompactToggle.Unchecked += (_, _) =>
        {
            _vm.Compact = false;
            PersistSettings();
        };
        ReloadButton.Click += (_, _) => ForceReload();
        SettingsFlyout.Opening += (_, _) => SyncSettingsControls();

        ApplyTheme();

        SystemTheme.SystemThemeChanged += OnSystemThemeChanged;
        _appWindow.Changed += OnAppWindowChanged;
        Closed += OnClosed;

        SingleInstance.StartListening(_hwnd);

        // ---- 状态文件读取 + 秒表 ----
        _reader = new WsxStateReader(_options.StatePath, 1000);
        _reader.SnapshotRead += OnSnapshotRead;
        _reader.ReadFailed += OnReadFailed;

        _ticker = DispatcherQueue.CreateTimer();
        _ticker.Interval = TimeSpan.FromMilliseconds(500);
        _ticker.Tick += (_, _) => OnTick();
        _ticker.Start();

        // 先把状态栏填上（「等待第一份快照…」），别留一行空字符串。
        OnTick();
    }

    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    // ------------------------------------------------------------------
    // 位置 / 大小 / 缩放
    // ------------------------------------------------------------------

    /// <summary>
    /// 当前窗口的缩放比例（物理像素 / DIP）。
    ///
    /// 这两套单位必须分清，参考 HUD 在这里踩过一个真坑：
    ///   * AppWindow.Position / Size / MoveAndResize / DisplayArea.WorkArea → **物理像素**
    ///   * RootGrid.SizeChanged / ActualWidth / 所有 XAML 尺寸 → **DIP**
    /// 125% 缩放下一个 470 物理像素宽的窗口内容区只有约 363 DIP，
    /// 按物理像素去分档会把用户的默认窗口误判成窄窗口。所以持久化和分层判断
    /// 统一用 DIP，只在真正调 AppWindow 时换算。
    /// </summary>
    private double Scale
    {
        get
        {
            // 优先问 Win32：GetDpiForWindow 在 HWND 一建好就能用，而构造函数里
            // RootGrid.XamlRoot 还是 null（元素尚未挂进可视树），那时读
            // RasterizationScale 会拿到 1.0，DIP→物理像素就白换算。
            try
            {
                uint dpi = GetDpiForWindow(_hwnd);
                if (dpi > 0) return dpi / 96.0;
            }
            catch
            {
                // 退回到 XAML 侧的比例。
            }

            double scale = RootGrid.XamlRoot?.RasterizationScale ?? 1.0;
            return scale > 0 ? scale : 1.0;
        }
    }

    private void ApplyPlacement()
    {
        if (_appWindow is null) return;

        double scale = Scale;
        var area = DisplayArea.GetFromWindowId(_appWindow.Id, DisplayAreaFallback.Primary);
        var work = area.WorkArea; // 物理像素

        // 存储值是 DIP，先换算成物理像素再参与工作区裁剪。
        int minW = (int)Math.Round(WindowPlacement.MinWidth * scale);
        int minH = (int)Math.Round(WindowPlacement.MinHeight * scale);
        int width = (int)Math.Round(_placement.Width * scale);
        int height = (int)Math.Round(_placement.Height * scale);
        width = Math.Clamp(width, minW, Math.Max(minW, work.Width));
        height = Math.Clamp(height, minH, Math.Max(minH, work.Height));

        int x, y;
        int px = (int)Math.Round(_placement.X * scale);
        int py = (int)Math.Round(_placement.Y * scale);
        if (_placement.X < 0 || _placement.Y < 0 || !IsOnSomeDisplay(px, py))
        {
            // 首次运行（或上次的位置已经不在任何显示器上）：贴在主屏右上角。
            x = work.X + work.Width - width - 24;
            y = work.Y + 24;
        }
        else
        {
            x = px;
            y = py;
        }

        // 保证标题栏一定在可见区域内，否则窗口就拖不回来了。
        x = Math.Clamp(x, work.X - width + 120, work.X + work.Width - 120);
        y = Math.Clamp(y, work.Y, work.Y + work.Height - 48);

        _appWindow.MoveAndResize(new RectInt32(x, y, width, height));
        Log.Write($"窗口放置 {width}×{height} @ ({x},{y})，scale={scale:0.###}");
    }

    private static bool IsOnSomeDisplay(int x, int y)
    {
        try
        {
            var area = DisplayArea.GetFromPoint(new PointInt32(x + 40, y + 20), DisplayAreaFallback.None);
            return area is not null;
        }
        catch
        {
            return false;
        }
    }

    private void OnAppWindowChanged(AppWindow sender, AppWindowChangedEventArgs args)
    {
        if (!args.DidPositionChange && !args.DidSizeChange) return;

        // 窗口 API 给的是物理像素，存成 DIP：换到不同 DPI 的显示器后，
        // 下次打开还是同样「看起来一样大」。
        double scale = Scale;
        var pos = sender.Position;
        var size = sender.Size;
        _placement.X = (int)Math.Round(pos.X / scale);
        _placement.Y = (int)Math.Round(pos.Y / scale);
        _placement.Width = (int)Math.Round(size.Width / scale);
        _placement.Height = (int)Math.Round(size.Height / scale);

        // 位置/大小也要落盘，否则「拖好窗口 → 进程被结束或闪退 → 下次又从旧位置打开」。
        // 拖动会连续触发本回调，所以用防抖：停手 800ms 后才写。
        SchedulePersist();
    }

    /// <summary>防抖后的持久化。拖动/缩放期间不写盘，停手后才写一次。</summary>
    private void SchedulePersist()
    {
        try
        {
            _persistDebounce ??= CreatePersistDebounce();
            _persistDebounce?.Stop();
            _persistDebounce?.Start();
        }
        catch (Exception ex)
        {
            Log.Error("安排设置持久化失败", ex);
        }
    }

    private DispatcherQueueTimer? CreatePersistDebounce()
    {
        var timer = DispatcherQueue.CreateTimer();
        timer.Interval = TimeSpan.FromMilliseconds(800);
        timer.IsRepeating = false;
        timer.Tick += (_, _) => PersistSettings();
        return timer;
    }

    private void OnClosed(object sender, WindowEventArgs args)
    {
        try
        {
            if (_presenter is not null) _placement.Topmost = _presenter.IsAlwaysOnTop;
            _placement.Compact = CompactToggle.IsChecked == true;
            _placement.Theme = _themeMode.ToString();
            _placement.Save();
            Log.Write("窗口已关闭，位置与设置已保存");
        }
        catch (Exception ex)
        {
            Log.Error("保存窗口位置失败", ex);
        }

        SystemTheme.SystemThemeChanged -= OnSystemThemeChanged;
        _ticker.Stop();
        _reader?.Dispose();
    }

    /// <summary>
    /// 改动设置后**立刻**落盘，而不是只在关窗时存。
    ///
    /// 原先只有 OnClosed 里调 Save()，于是「闪退 / 被任务管理器结束 / 断电」
    /// 这几种收尾都会把这次改的设置丢掉 —— 用户看到的就是「设置无法保存，
    /// 重新打开后又复原」。设置是几百字节，随时写代价可以忽略。
    /// </summary>
    private void PersistSettings()
    {
        try
        {
            if (_presenter is not null) _placement.Topmost = _presenter.IsAlwaysOnTop;
            _placement.Compact = _vm.Compact;
            _placement.Theme = _themeMode.ToString();
            _placement.Save();
        }
        catch (Exception ex)
        {
            Log.Error("立即保存设置失败", ex);
        }
    }

    private void SetTopmost(bool topmost)
    {
        if (_presenter is not null) _presenter.IsAlwaysOnTop = topmost;
        _placement.Topmost = topmost;
        PersistSettings();
    }

    private void ForceReload()
    {
        Log.Write("手动重新读取状态文件");
        _reader?.PollNow();
    }

    /// <summary>一次客户区测量：DIP、客户区物理像素、外框物理像素、DPI、以及是否来自 Win32。</summary>
    private readonly record struct ClientMeasure(double Dip, int Px, int FramePx, uint Dpi, bool FromWin32);

    /// <summary>
    /// 测量窗口客户区，**只从 Win32 取**（GetClientRect / GetWindowRect / GetDpiForWindow）。
    ///
    /// 一次返回物理像素和 DIP 两个单位，是刻意的。这里出过一次很贵的沟通：
    /// 客户区的物理宽度是 757 px，而同一块区域的 DIP 宽度是 605.6 —— 两个数被放在一起比，
    /// 就得出「XAML 比窗口宽 121 DIP」的结论，于是去找一个并不存在的换算 bug。
    ///
    /// 更隐蔽的一层：**DPI 不感知的进程**调用 GetClientRect 会拿到虚拟化后的坐标 ——
    /// 757 px 会被报成 605.6 px，再除一次 1.25 就变成 484，凭空差出 1.5625 倍。
    /// 所以物理像素和 DIP 必须永远并排出现、且各自带单位。
    ///
    /// <see cref="ClientMeasure.FromWin32"/> 为 false 表示 Win32 拿不到值、退回了 XAML
    /// 自己的宽度 —— 那种数**不能**用来证明「布局等于客户区」（同一个变量和自己比必然相等），
    /// 所以日志里会打问号而不是 ✓。
    /// </summary>
    private ClientMeasure MeasureClient()
    {
        uint dpi = 0;
        try { dpi = GetDpiForWindow(_hwnd); } catch { /* 拿不到就用 XAML 的比例 */ }
        double scale = dpi > 0 ? dpi / 96.0 : Scale;
        if (scale <= 0) scale = 1.0;

        try
        {
            if (GetClientRect(_hwnd, out var client) && GetWindowRect(_hwnd, out var frame))
            {
                int clientPx = client.Right - client.Left;
                int framePx = frame.Right - frame.Left;
                if (clientPx > 0)
                {
                    return new ClientMeasure(clientPx / scale, clientPx, framePx, dpi, true);
                }
            }
        }
        catch
        {
            // 落到下面的兜底。
        }

        return new ClientMeasure(RootGrid.ActualWidth, 0, 0, dpi, false);
    }

    private double ClientWidthDip() => MeasureClient().Dip;

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect32
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    private static extern bool GetClientRect(IntPtr hWnd, out Rect32 rect);

    /// <summary>
    /// 第一张**已实例化**卡片的实际宽度（DIP）。
    ///
    /// 这是「卡片有没有铺满视口」唯一没法自欺欺人的数字：`Metrics.CardWidth` 是绑定源，
    /// `TargetsRepeater.ActualWidth` 是承载它的容器，这个是**真正画出来的那个 Border**。
    /// 三者并排就能分辨是「绑定源算错了」还是「算对了但没生效」—— 后者正是这里踩过的坑：
    /// 卡片的 DataContext 上当时**没有** Metrics 属性，`Width="{Binding Metrics.CardWidth}"`
    /// 静默失败，宽度退回内容自然宽度（约 682 DIP ≈ 窗口的 68%）。
    /// ItemsRepeater 会把已实现的 item 容器挂成自己的可视子节点，取第 0 个即可。
    /// </summary>
    private double FirstCardActualWidth()
    {
        try
        {
            int count = VisualTreeHelper.GetChildrenCount(TargetsRepeater);
            for (int i = 0; i < count; i++)
            {
                if (VisualTreeHelper.GetChild(TargetsRepeater, i) is FrameworkElement element && element.ActualWidth > 0)
                {
                    return element.ActualWidth;
                }
            }
        }
        catch
        {
            // 还没实例化就算了。
        }
        return 0;
    }

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out Rect32 rect);

    /// <summary>
    /// 故障注入（**仅用于证明这条自检不是空断言**）：把卡片宽度预算故意放大 N DIP。
    ///
    /// 由来：自检曾被指出「客户区和布局用的是同一个变量，所以永远 ✓」。现在的判据是
    /// 「独立 Win32 测量 vs XAML 布局宽度」，但一个断言只要从没被看到失败过，
    /// 就无法证明它真在检查什么。设 <c>DSH_WSX_SELFTEST_WIDE_BY_DIP=120</c> 再跑一次，
    /// 日志必须打 <c>⚠ 卡片超出客户区</c>；不设时必须是 ✓。
    /// 默认 0（关闭），只读环境变量，不影响正常行为。
    /// </summary>
    private static double SelfTestWideByDip()
    {
        string? raw = Environment.GetEnvironmentVariable("DSH_WSX_SELFTEST_WIDE_BY_DIP");
        return double.TryParse(raw, out double value) && value > 0 ? value : 0;
    }

    /// <summary>
    /// 把滚动视口的宽度量出来，写回 Metrics.CardWidth —— 卡片宽度由它显式决定。
    ///
    /// 这一处是「内容被右边界裁掉」这个 bug 的根治手段：只关掉横向滚动不够，
    /// 因为 ScrollViewer 约束的是它自己，管不到 StackLayout 用什么宽度测量 item。
    /// 量出视口宽度再明确写给卡片，`*` 列和 TextTrimming 才有硬约束。
    ///
    /// 两个来源取**小值**：XAML 量的视口宽度、Win32 量的客户区宽度。
    /// 正常情况下两者相等（425.6 vs 425.6）；取小值是硬保险 ——
    /// 于是 <c>cardWidth + 左右内边距 ≤ 客户区宽度</c> 这条不变式**永远成立**，
    /// 卡片不可能比窗口宽，无论测量在哪一侧出了偏差。
    ///
    /// 只在算出的值 > 0 时赋值：首帧两个宽度都还是 0，这时保持上一次
    /// （或默认）的宽度，绝不能把卡片宽度写成 0 —— 那会让整个列表消失。
    /// </summary>
    private void UpdateContentWidth()
    {
        double viewport = TargetsScroll.ViewportWidth;
        if (viewport <= 0) viewport = TargetsScroll.ActualWidth;

        double clientDip = ClientWidthDip();
        double basis = viewport > 0 ? Math.Min(viewport, clientDip) : clientDip;
        if (basis <= 0) return;

        var pad = _vm.Metrics.ScrollPadding;
        double width = basis - pad.Left - pad.Right + SelfTestWideByDip();
        if (width > 0) _vm.Metrics.CardWidth = width;

        // 设置面板跟着客户区走（原来是写死的 330，见 PanelMetrics.FlyoutWidth）。
        _vm.Metrics.FlyoutWidth = Math.Clamp(basis - 32, 220, 330);
    }

    /// <summary>
    /// 布局自检：把「客户区 vs 布局 vs 卡片」三个宽度记进日志，并给出明确结论。
    ///
    /// 为什么要这三行数：截图里的「右边被裁掉」有三种成因，肉眼看不出区别 ——
    ///   1) 截图工具 DPI 不感知，只截到窗口左上一块（真的没裁，是拍歪了）；
    ///   2) 外框宽度被当成客户区宽度（差的正是那圈可缩放边框，本机约 14.4 DIP）；
    ///   3) 内容真的比客户区宽。
    /// 注意：**不能**用 <c>ScrollViewer.ExtentWidth &gt; ViewportWidth</c> 判断溢出 ——
    /// 横向滚动被禁用时 ExtentWidth 会被夹到视口宽度，这个比较永远是 false（假阴性）。
    /// 所以这里改为直接比较「客户区宽度」与「卡片宽度 + 内边距」，并把结论写成可 grep 的短语。
    /// </summary>
    private void LogLayoutIfChanged()
    {
        double viewport = TargetsScroll.ViewportWidth;
        double extent = TargetsScroll.ExtentWidth;
        var client = MeasureClient();
        double card = _vm.Metrics.CardWidth;
        double flyout = _vm.Metrics.FlyoutWidth;
        var pad = _vm.Metrics.ScrollPadding;

        string signature = $"{client.Dip:0.#}|{viewport:0.#}|{extent:0.#}|{card:0.#}|{flyout:0.#}|{_vm.Metrics.Tier}";
        if (signature == _lastLayoutSignature) return;
        _lastLayoutSignature = signature;

        // 首帧（还没布局）时 RootGrid.ActualWidth 还是 0，而客户区宽度已经能问到了。
        // 这一刻拿两者比较必然「不一致」，是假警报 —— 不做判断，只记原始数据。
        bool laidOut = RootGrid.ActualWidth > 0;
        double delta = client.Dip - RootGrid.ActualWidth;

        // 判据必须用**独立的 Win32 来源**，否则就是自己和自己比，永远 ✓（这一点被指出过，
        // 确实是这个自检最该防的失效模式）。FromWin32=false 时不给结论，直接打问号。
        bool comparable = laidOut && client.FromWin32;
        bool frameAgrees = comparable && Math.Abs(delta) <= 1.0;
        bool cardFits = !laidOut || card + pad.Left + pad.Right <= client.Dip + 0.5;
        bool flyoutFits = flyout + 16 <= client.Dip;
        // 信息性：横向滚动禁用时它会被夹到视口宽度，只能当参考，不能当判据。
        double scrollable = TargetsScroll.ScrollableWidth;
        double repeater = TargetsRepeater.ActualWidth;
        double cardActual = FirstCardActualWidth();

        // 真正要守的不变式：**画出来的卡片 + 左右内边距 ≈ 客户区宽度**。
        // 只看 CardWidth（绑定源）是不够的 —— 绑定失败时它算得再对也没用，
        // 那正是「卡片只占 68%」这个 bug 的形态：源对了，绑定没生效。
        // 所以判据必须落在 cardActual 上，并且用独立的 Win32 客户区宽度做基准。
        bool cardFills = !laidOut || cardActual <= 0
            || Math.Abs(cardActual + pad.Left + pad.Right - client.Dip) <= 2.0;

        string verdict;
        if (!laidOut) verdict = "（尚未布局：布局宽度还是 0，不作判断）";
        else if (!client.FromWin32) verdict = "? Win32 客户区不可得，无法独立比较（退回 XAML 值）";
        else if (frameAgrees) verdict = $"layout=client ✓ (Δ={delta:+0.0;-0.0;0.0}DIP)";
        else verdict = $"✗ layout≠client Δ={delta:+0.0;-0.0;0.0}DIP（布局比客户区宽 {delta:0.#}DIP）";

        // 单位一律写在数字后面，且**物理像素与 DIP 并排出现** —— 见 MeasureClient() 的注释。
        Log.Write(
            $"布局 requested={_placement.Width}DIP | client(Win32)={client.Px}px @dpi{client.Dpi}(×{client.Dpi / 96.0:0.###})"
            + $" = {client.Dip:0.#}DIP | frame={client.FramePx}px | layout={RootGrid.ActualWidth:0.#}DIP"
            + $" viewport={viewport:0.#}DIP extent={extent:0.#} scrollable={scrollable:0.#} | "
            + $"repeater={repeater:0.#}DIP cardActual={cardActual:0.#}DIP cardWidth(bound)={card:0.#}DIP"
            + $" pad={pad.Left:0.#}+{pad.Right:0.#} flyout={flyout:0.#}DIP tier={_vm.Metrics.Tier} | "
            + verdict
            + (cardFills ? " cardActual+pad=client ✓" : " ⚠ 卡片没铺满客户区（绑定没生效？）")
            + (cardFits ? " cardWidth≤client−pad ✓" : " ⚠ 卡片超出客户区")
            + (flyoutFits ? " flyout≤client ✓" : " ⚠ 设置面板过宽")
            + (SelfTestWideByDip() is var inj && inj > 0 ? $" [故障注入 +{inj:0.#}DIP]" : ""));
    }

    private string _lastLayoutSignature = "";

    private void OnSettingsButtonClick(object sender, RoutedEventArgs e)
    {
        // 信息在 Opening 里同步（见 SyncSettingsControls），这里只需要让点击
        // 明确落在一个具名处理函数上 —— 面板打开时控件才进可视树。
    }

    /// <summary>
    /// 再显式设一次窗口图标。exe 里已经通过 csproj 的 &lt;ApplicationIcon&gt; 嵌了图标，
    /// 但非打包的 WinUI 3 应用在任务栏 / Alt+Tab 上有几率回落到默认图标；
    /// ico 就在 exe 旁边（csproj 里 CopyToOutputDirectory 带出来的）。
    /// </summary>
    private void ApplyWindowIcon()
    {
        try
        {
            if (_appWindow is null) return;
            string iconPath = System.IO.Path.Combine(AppContext.BaseDirectory, "app.ico");
            if (System.IO.File.Exists(iconPath))
            {
                _appWindow.SetIcon(iconPath);
            }
            else
            {
                Log.Write("exe 旁边没有 app.ico，任务栏图标会回落到 exe 内嵌图标");
            }
        }
        catch (Exception ex)
        {
            // 设不上图标不该影响窗口开出来。
            Log.Error("AppWindow.SetIcon 失败", ex);
        }
    }

    // ------------------------------------------------------------------
    // 标题栏保留区
    // ------------------------------------------------------------------

    /// <summary>
    /// 实测系统标题栏按钮占用的宽度，让我们的四个按键正好贴在它左边。
    ///
    /// 不能直接信 AppWindow.TitleBar.RightInset：Windows 10 上
    /// AppWindowTitleBar.IsCustomizationSupported() 为 false，RightInset 实测返回
    /// 约 320 物理像素，而系统按钮实际只占约 174 物理像素（125% 缩放），
    /// 照它留白会在按键和系统按钮之间留出上百像素的空洞。
    /// 所以 Win11 用 RightInset，Win10 用系统度量自己算：3 × SM_CXSIZE。
    /// </summary>
    private void UpdateTitleBarReserve()
    {
        double reserve = MeasureCaptionReserve();

        // 再兜一层：不管谁报了什么数，保留区都不该超过窗口的一半，
        // 否则窄窗口下按键会被挤出可视范围。
        double max = Math.Max(90, RootGrid.ActualWidth * 0.45);
        _vm.Metrics.TitleBarReserve = Math.Clamp(reserve, 90, max);
    }

    private double MeasureCaptionReserve()
    {
        const double Fallback = 138;
        try
        {
            if (_appWindow is null) return Fallback;

            // Windows 11：系统会准确告诉我们它占了多少。
            if (AppWindowTitleBar.IsCustomizationSupported())
            {
                double inset = _appWindow.TitleBar.RightInset;
                double scale = Scale;
                if (inset > 0 && scale > 0) return inset / scale;
            }

            // Windows 10：自己按系统度量算。
            uint dpi = GetDpiForWindow(_hwnd);
            if (dpi == 0) dpi = 96;
            int captionButtonWidth = GetSystemMetricsForDpi(SM_CXSIZE, dpi);
            if (captionButtonWidth <= 0) return Fallback;

            // GetSystemMetricsForDpi 给的是物理像素，XAML 布局用 DIP。
            // +8 是安全余量：宁可留一点缝，也不要贴到系统按钮的可点区域上。
            double dipPerPixel = 96.0 / dpi;
            return 3.0 * captionButtonWidth * dipPerPixel + 8;
        }
        catch
        {
            // 老系统上 GetSystemMetricsForDpi 可能不存在，退回兜底值。
            return Fallback;
        }
    }

    private const int SM_CXSIZE = 30;

    [DllImport("user32.dll")]
    private static extern int GetSystemMetricsForDpi(int nIndex, uint dpi);

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hwnd);

    // ------------------------------------------------------------------
    // 设置面板
    // ------------------------------------------------------------------

    /// <summary>
    /// 往设置控件里灌当前值。**在浮出面板打开时调用**，而不是只在启动时调一次：
    /// 面板关着的时候那些控件还没进可视树，启动时赋值不保证反映得出来。
    /// 每次打开都同步一遍也顺便保证面板永远是最新的。
    /// </summary>
    private void SyncSettingsControls()
    {
        _loadingSettings = true;
        try
        {
            ThemeSelector.SelectedIndex = _themeMode switch
            {
                SystemTheme.Mode.Light => 1,
                SystemTheme.Mode.Dark => 2,
                _ => 0,
            };

            SettingsStatePath.Text = _options.StatePath;

            // 设置面板宽度跟着客户区走（原来 XAML 里写死 330）。
            // 在这里赋而不是在构造里：Flyout 的内容只有弹出时才进可视树，
            // 提前赋值不保证反映得出来（NumberBox 踩过同样的坑）。
            double clientDip = ClientWidthDip();
            double flyoutWidth = _vm.Metrics.FlyoutWidth;
            if (clientDip > 0 && flyoutWidth + 16 > clientDip)
            {
                // 兜一层：万一客户区比 FlyoutWidth 还窄（窗口被系统压缩到极小），
                // 宁可让面板跟着变窄，也不要它溢出到窗口外面。
                flyoutWidth = Math.Max(200, clientDip - 32);
            }
            SettingsPanel.Width = flyoutWidth;
            Log.Write($"设置面板宽度 {flyoutWidth:0.#}DIP（客户区 {clientDip:0.#}DIP）");

            var host = _host;
            SettingsHostInfo.Text = host is null
                ? "还没读到快照。"
                : Format.Join(
                    $"pid {host.Pid}",
                    string.IsNullOrWhiteSpace(host.PluginVersion) ? null : $"插件 v{host.PluginVersion}",
                    string.IsNullOrWhiteSpace(host.Platform) ? null : host.Platform,
                    host.Revision is long rev ? $"快照 #{rev}" : null,
                    _everLive ? $"最近心跳 {Format.Age(Now - _lastFreshAt)} 前" : null);
        }
        finally
        {
            _loadingSettings = false;
        }
    }

    private void OnThemeSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_loadingSettings) return;
        _themeMode = ThemeSelector.SelectedIndex switch
        {
            1 => SystemTheme.Mode.Light,
            2 => SystemTheme.Mode.Dark,
            _ => SystemTheme.Mode.System,
        };
        _placement.Theme = _themeMode.ToString();
        Log.Write($"明暗主题 → {_themeMode}");
        ApplyTheme();
        PersistSettings();
    }

    // ------------------------------------------------------------------
    // 明暗主题
    // ------------------------------------------------------------------

    private void OnSystemThemeChanged()
    {
        if (_themeMode != SystemTheme.Mode.System) return;
        // UISettings 的事件在后台线程，切回 UI 线程再改 XAML。
        DispatcherQueue.TryEnqueue(ApplyTheme);
    }

    private void ApplyTheme()
    {
        bool light = SystemTheme.ResolveIsLight(_themeMode);
        RootGrid.RequestedTheme = light ? ElementTheme.Light : ElementTheme.Dark;

        // 设置面板里的下拉要跟着走：跟随系统时系统切换也会走到这里。
        int index = _themeMode switch
        {
            SystemTheme.Mode.Light => 1,
            SystemTheme.Mode.Dark => 2,
            _ => 0,
        };
        if (!_loadingSettings && ThemeSelector.SelectedIndex != index)
        {
            _loadingSettings = true;
            try { ThemeSelector.SelectedIndex = index; }
            finally { _loadingSettings = false; }
        }

        // 让系统标题栏按钮的图标颜色跟着背景走（Win11 生效；Win10 上属无害调用）。
        try
        {
            if (_appWindow is not null && AppWindowTitleBar.IsCustomizationSupported())
            {
                var titleBar = _appWindow.TitleBar;
                titleBar.ButtonBackgroundColor = Microsoft.UI.Colors.Transparent;
                titleBar.ButtonInactiveBackgroundColor = Microsoft.UI.Colors.Transparent;
                titleBar.ButtonForegroundColor = light
                    ? Windows.UI.Color.FromArgb(255, 0x20, 0x20, 0x20)
                    : Windows.UI.Color.FromArgb(255, 0xF0, 0xF0, 0xF0);
                titleBar.ButtonHoverBackgroundColor = light
                    ? Windows.UI.Color.FromArgb(40, 0, 0, 0)
                    : Windows.UI.Color.FromArgb(40, 255, 255, 255);
                titleBar.ButtonHoverForegroundColor = titleBar.ButtonForegroundColor;
            }
        }
        catch
        {
            // 标题栏取色失败不影响内容区主题。
        }
    }

    // ------------------------------------------------------------------
    // 数据
    // ------------------------------------------------------------------

    private void OnSnapshotRead(PanelSnapshot snapshot)
    {
        // 读取在后台线程，切回 UI 线程再碰 XAML。
        DispatcherQueue.TryEnqueue(() =>
        {
            long now = Now;
            _vm.Apply(snapshot, now);

            _host = snapshot.Host;
            // generatedAt 是宿主写快照的时刻 —— 这才是「心跳」的定义。
            // 用文件 mtime 也行，但 generatedAt 是 schema 明确写出来的契约。
            _lastFreshAt = snapshot.GeneratedAt > 0 ? snapshot.GeneratedAt : now;
            _everLive = true;
            _lastErrorDetail = null;
            _notLiveSince = 0;
        });
    }

    private void OnReadFailed(StateReadError error)
    {
        DispatcherQueue.TryEnqueue(() =>
        {
            _lastErrorDetail = error.Message;
            _lastErrorState = error.Kind switch
            {
                StateErrorKind.Missing => ConnectionState.Missing,
                StateErrorKind.Io => ConnectionState.IoError,
                _ => ConnectionState.ParseError,
            };
        });
    }

    /// <summary>
    /// 每次 tick 重新推导一次连接状态。
    ///
    /// 两条刻意的规则：
    ///   * **从没读到过有效快照时，失败立刻上报**，不等 staleSeconds。
    ///     宿主没起来的时候，状态栏应该马上说「文件不存在」，
    ///     而不是先装 15 秒的「等待第一份快照…」（参考 HUD 在这里会让人以为程序卡住了）。
    ///   * 已经有数据、且数据还没过期时，一次瞬时读失败（正好撞上 rename）不翻状态。
    /// </summary>
    private StatusInfo ComputeStatus(long now)
    {
        long staleMs = _options.StaleSeconds * 1000L;
        long ageMs = _everLive ? Math.Max(0, now - _lastFreshAt) : 0;

        ConnectionState state;
        if (_lastErrorDetail is not null && (!_everLive || ageMs > staleMs))
        {
            state = _lastErrorState;
        }
        else if (_host?.Stopped == true)
        {
            // 插件 dispose() 写的最后一帧：宿主是正常收尾的，不要报成超时。
            state = ConnectionState.HostStopped;
        }
        else if (_everLive && ageMs > staleMs)
        {
            state = ConnectionState.Stale;
        }
        else if (_everLive)
        {
            state = ConnectionState.Live;
        }
        else
        {
            state = ConnectionState.Waiting;
        }

        string? detail = state is ConnectionState.Missing or ConnectionState.ParseError or ConnectionState.IoError
            ? _lastErrorDetail
            : null;

        return new StatusInfo(state, _options.StatePath, _options.StaleSeconds, ageMs, detail, _host);
    }

    private void OnTick()
    {
        long now = Now;
        var info = ComputeStatus(now);

        // 「多久以前探测的」「更新于 … 前」这类活文本走轻量刷新，不重建集合。
        _vm.RefreshLive(now);
        _vm.SetStatus(info);
        LogLayoutIfChanged();

        if (info.State != _shownState)
        {
            Log.Write($"状态 {_shownState} → {info.State}：{StatusText.Line(info)}");
            _shownState = info.State;
        }

        // 宿主正常收尾：如果宿主指定了「心跳丢失就自动关窗」，那就立刻收工 ——
        // 面板留着也没有任何东西可显示了。
        if (info.State == ConnectionState.HostStopped && _options.ExitAfterStaleSeconds > 0)
        {
            Log.Write("宿主已退出（stopped=true），按 --exit-after-stale 关闭窗口");
            Close();
            return;
        }

        bool notLive = info.State is ConnectionState.Missing or ConnectionState.ParseError
            or ConnectionState.IoError or ConnectionState.Stale;

        if (notLive)
        {
            if (_notLiveSince == 0) _notLiveSince = now;
            if (_options.ExitAfterStaleSeconds > 0
                && now - _notLiveSince > _options.ExitAfterStaleSeconds * 1000L)
            {
                Log.Write($"已 {_options.ExitAfterStaleSeconds}s 没有宿主心跳，自动关闭窗口");
                Close();
            }
        }
        else
        {
            _notLiveSince = 0;
        }
    }
}
