using Microsoft.UI.Xaml;

namespace DshWsxPanel;

public enum LayoutTier
{
    /// <summary>很窄的窗口：缩字号、收紧留白、砍掉次要区块。</summary>
    Narrow,
    Normal,
    /// <summary>宽窗口：放大字号与行高，多显示几行明细。</summary>
    Wide,
}

/// <summary>
/// 随窗口大小浮动的尺寸表。
///
/// 为什么做成一个共享对象而不是用 VisualStateManager：
/// 目标卡片在 DataTemplate 里，VSM 的 Setter 够不到模板内部的具名元素，
/// 而明细行（挂载点、进程、GPU）又是嵌套 DataTemplate。
/// 所以统一改成「所有尺寸都来自一个 INotifyPropertyChanged 对象」，
/// 模板里逐项绑定，窗口一变全体一起更新。
///
/// 只按**分层**重算（Narrow / Normal / Wide + 矮窗口降级），
/// 不做随像素连续插值——连续变字号会让文字落在半像素上发虚、行高抖动。
///
/// 单位一律是 **DIP（有效像素）**：和 RootGrid.SizeChanged 报的、以及所有
/// XAML 尺寸是同一套单位。只有 MainWindow 调 AppWindow 的那一处才换算成物理像素。
/// </summary>
public sealed class PanelMetrics : ObservableObject
{
    /// <summary>
    /// 分层阈值，单位 DIP。窗口最小宽 380 DIP，扣掉边框后内容区约 377 DIP，
    /// 正好落在 Narrow 档 —— 所以「窄」这一档在真机上够得着，不是死代码。
    /// 默认窗口 440 DIP，内容区约 437，落在 Normal 档。
    /// </summary>
    public const double NarrowThreshold = 400;
    public const double WideThreshold = 560;

    /// <summary>高度低于这个值算矮窗口：先丢进程/容器/服务这些「明细」。</summary>
    public const double ShortThreshold = 430;

    /// <summary>再矮一层：丢掉磁盘与 GPU，只留 CPU / 内存这两个最有判断价值的数字。</summary>
    public const double TinyThreshold = 340;

    /// <summary>矮到这一步就整块指标收起，只留状态行。</summary>
    public const double MetricsHiddenThreshold = 280;

    private bool _initialized;

    public LayoutTier Tier { get; private set; } = LayoutTier.Normal;
    public bool IsShort { get; private set; }

    /// <summary>
    /// 系统的最小化/最大化/关闭按钮占掉的宽度（DIP）。由 MainWindow 实测填入，不要写死：
    /// 不同 DPI、不同 Windows 版本下这个值差别很大（见 MainWindow.MeasureCaptionReserve）。
    /// </summary>
    public double TitleBarReserve { get => _titleBarReserve; set => Set(ref _titleBarReserve, value); }
    private double _titleBarReserve = 140;

    // ---- 标题栏 ----
    private double _titleBarHeight = 40;
    private double _buttonWidth = 30;
    private double _buttonHeight = 28;
    private double _buttonIconSize = 12;
    private double _buttonSpacing = 2;
    private Visibility _appTitleVisibility = Visibility.Visible;
    private string _titleText = "远程目标面板";

    public double TitleBarHeight { get => _titleBarHeight; private set => Set(ref _titleBarHeight, value); }
    public double ButtonWidth { get => _buttonWidth; private set => Set(ref _buttonWidth, value); }
    public double ButtonHeight { get => _buttonHeight; private set => Set(ref _buttonHeight, value); }
    public double ButtonIconSize { get => _buttonIconSize; private set => Set(ref _buttonIconSize, value); }
    public double ButtonSpacing { get => _buttonSpacing; private set => Set(ref _buttonSpacing, value); }
    public Visibility AppTitleVisibility { get => _appTitleVisibility; private set => Set(ref _appTitleVisibility, value); }

    /// <summary>
    /// 标题栏文字。右边要站三个按键 + 系统按钮保留区，窄档下标题那一列几乎没有宽度，
    /// 所以按档位换长短不同的文案，宁可换个短名字也不要留一串省略号。
    /// </summary>
    public string TitleText { get => _titleText; private set => Set(ref _titleText, value); }

    // ---- 字号 ----
    private double _titleFontSize = 12.5;
    private double _bodyFontSize = 11;
    private double _smallFontSize = 10.5;
    private double _monoFontSize = 11;
    private double _badgeFontSize = 10;

    public double TitleFontSize { get => _titleFontSize; private set => Set(ref _titleFontSize, value); }
    public double BodyFontSize { get => _bodyFontSize; private set => Set(ref _bodyFontSize, value); }
    public double SmallFontSize { get => _smallFontSize; private set => Set(ref _smallFontSize, value); }
    /// <summary>等宽（主机名、挂载点、进程命令行）用的字号。</summary>
    public double MonoFontSize { get => _monoFontSize; private set => Set(ref _monoFontSize, value); }
    public double BadgeFontSize { get => _badgeFontSize; private set => Set(ref _badgeFontSize, value); }

    // ---- 卡片与留白 ----
    private Thickness _cardPadding = new(10, 10, 10, 10);
    private Thickness _cardMargin = new(0, 0, 0, 8);
    private Thickness _innerPadding = new(9, 7, 9, 7);
    private Thickness _scrollPadding = new(10, 0, 10, 10);
    private double _cardSpacing = 9;
    private double _sectionSpacing = 5;

    public Thickness CardPadding { get => _cardPadding; private set => Set(ref _cardPadding, value); }
    public Thickness CardMargin { get => _cardMargin; private set => Set(ref _cardMargin, value); }
    /// <summary>卡片内部小块（错误条、指标块）的内边距，比卡片本身再小一档。</summary>
    public Thickness InnerPadding { get => _innerPadding; private set => Set(ref _innerPadding, value); }
    public Thickness ScrollPadding { get => _scrollPadding; private set => Set(ref _scrollPadding, value); }
    public double CardSpacing { get => _cardSpacing; private set => Set(ref _cardSpacing, value); }
    public double SectionSpacing { get => _sectionSpacing; private set => Set(ref _sectionSpacing, value); }

    // ---- 进度条 ----
    private double _barHeight = 5;
    public double BarHeight { get => _barHeight; private set => Set(ref _barHeight, value); }

    // ---- 明细行 ----
    // 进程行的列宽写在 TextBlock 上而不是 ColumnDefinition 上：
    // ColumnDefinition 不是 FrameworkElement，拿不到 DataContext，绑不了。
    // 配合 Auto 列 + TextTrimming，长命令行只会被截断，不会串列。
    private double _procPidWidth = 46;
    private double _procCpuWidth = 46;
    private double _procUserWidth = 56;
    private double _rowHeight = 18;

    public double ProcPidWidth { get => _procPidWidth; private set => Set(ref _procPidWidth, value); }
    public double ProcCpuWidth { get => _procCpuWidth; private set => Set(ref _procCpuWidth, value); }
    public double ProcUserWidth { get => _procUserWidth; private set => Set(ref _procUserWidth, value); }
    public double RowHeight { get => _rowHeight; private set => Set(ref _rowHeight, value); }

    /// <summary>头部摘要区的外边距。和卡片的 ScrollPadding 分开，因为它的下边距要另算。</summary>
    private Thickness _headerMargin = new(10, 0, 10, 8);
    public Thickness HeaderMargin { get => _headerMargin; private set => Set(ref _headerMargin, value); }

    /// <summary>
    /// 卡片的显式宽度（DIP）= 滚动视口宽度 − 列表左右内边距。
    ///
    /// 为什么要显式给宽度，而不是让它自己撑满：
    /// <c>ItemsRepeater</c> + <c>StackLayout</c> 有可能以**无界宽度**测量每个 item
    /// （StackLayout 只保证「堆叠方向」的约束）。一旦测量宽度是无限，
    /// 卡片里 <c>ColumnDefinition Width="*"</c> 就失去意义、<c>TextTrimming</c> 永远不触发、
    /// <c>Auto</c> 列会把卡片一路顶出右边界 —— 磁盘用量这种右对齐的关键数字就看不见了。
    /// 所以这里把视口宽度量出来，明确写回卡片，测量约束就是硬的。
    ///
    /// 默认值只是「第一帧还没量到」时的占位；MainWindow 在 SizeChanged 里立刻覆盖它。
    /// </summary>
    public double CardWidth { get => _cardWidth; set => Set(ref _cardWidth, value); }
    private double _cardWidth = 400;

    /// <summary>
    /// 设置面板的宽度（DIP）。由 MainWindow 按**客户区宽度**算出来：<c>clamp(客户区 − 32, 220, 330)</c>。
    ///
    /// 原来是写死的 330 —— 在正常窗口下放得下，但写死的宽度在窗口被压到最小、
    /// 或者以后有人调小 MinWidth 时就会溢出到窗口外面去。跟着客户区走就没有这个问题。
    /// 不绑 XAML 而由代码显式赋值：Flyout 的内容在弹出层里，DataContext 不保证传得进来，
    /// 绑定失败会安静地退回「按内容撑开」，那反而可能更宽。
    /// </summary>
    public double FlyoutWidth { get => _flyoutWidth; set => Set(ref _flyoutWidth, value); }
    private double _flyoutWidth = 330;

    /// <summary>
    /// 磁盘行里「用量文字」的最小宽度（DIP）。
    ///
    /// 这一行左边是挂载点、右边是用量，两者抢同一行的宽度。挂载点可能很长
    /// （<c>/usr/lib/wsl/drivers</c>），而用量串也不短（<c>208.4 GB / 238.2 GB · 87.5%</c>）。
    /// 谁让步必须写死：**用量数字是操作上真正要看的东西，绝不能被挤掉**。
    /// 所以用量这一列给一个最小宽度（Auto 列 + MinWidth），挂载点那列是 <c>*</c> 且开裁剪，
    /// 空间不够时被截断的永远是挂载点。给 MinWidth 而不是 TextTrimming，
    /// 是因为给用量加裁剪只会把关键数字变成省略号 —— 那正是要避免的结果。
    /// </summary>
    public double DiskValueMinWidth { get => _diskValueMinWidth; private set => Set(ref _diskValueMinWidth, value); }
    private double _diskValueMinWidth = 150;

    /// <summary>
    /// 指标行里「标签」列的固定宽度（DIP）。
    ///
    /// 为什么给固定宽度而不是 Auto：Auto 列是每行各自按内容量的，`CPU`（拉丁）
    /// 和 `内存`（中日韩）的自然宽度差挺多，于是各行的数值列起始 x 就对不齐 ——
    /// 看起来就是「文字位置有点偏」。给标签一个跨行一致的硬宽度，所有数值就从同一个 x 开始。
    /// （和参考 HUD 里工具行列宽同一个道理：ColumnDefinition 绑不了，所以宽度写在 TextBlock 上。）
    /// </summary>
    public double MetricLabelWidth { get => _metricLabelWidth; private set => Set(ref _metricLabelWidth, value); }
    private double _metricLabelWidth = 46;

    /// <summary>标题栏应用图标的左边距/右边距（DIP）。</summary>
    private Thickness _titleGlyphMargin = new(12, 0, 8, 0);
    public Thickness TitleGlyphMargin { get => _titleGlyphMargin; private set => Set(ref _titleGlyphMargin, value); }

    /// <summary>状态栏内边距（DIP）。原来写死在 XAML 里，窄档下相对偏大。</summary>
    private Thickness _statusBarPadding = new(12, 6, 12, 6);
    public Thickness StatusBarPadding { get => _statusBarPadding; private set => Set(ref _statusBarPadding, value); }

    private double _statusDotSize = 8;
    public double StatusDotSize { get => _statusDotSize; private set => Set(ref _statusDotSize, value); }

    // ---- 内容取舍 ----
    private int _diskRows = 4;
    private int _gpuRows = 2;
    private int _processRows = 5;
    private int _serviceRows = 4;

    private bool _showMetrics = true;
    private bool _showDisks = true;
    private bool _showGpus = true;
    private bool _showDocker = true;
    private bool _showProcesses = true;
    private bool _showServices = true;
    private bool _showFacts = true;

    /// <summary>每张卡片最多画几个挂载点。</summary>
    public int DiskRows { get => _diskRows; private set => Set(ref _diskRows, value); }
    /// <summary>每张卡片最多画几块 GPU。</summary>
    public int GpuRows { get => _gpuRows; private set => Set(ref _gpuRows, value); }
    /// <summary>top-N 进程取前几个（按 CPU 排序）。</summary>
    public int ProcessRows { get => _processRows; private set => Set(ref _processRows, value); }
    public int ServiceRows { get => _serviceRows; private set => Set(ref _serviceRows, value); }

    /// <summary>整块指标区（CPU / 内存 / 磁盘 / GPU / docker / 进程）是否显示。</summary>
    public bool ShowMetrics { get => _showMetrics; private set => Set(ref _showMetrics, value); }
    public bool ShowDisks { get => _showDisks; private set => Set(ref _showDisks, value); }
    public bool ShowGpus { get => _showGpus; private set => Set(ref _showGpus, value); }
    public bool ShowDocker { get => _showDocker; private set => Set(ref _showDocker, value); }
    public bool ShowProcesses { get => _showProcesses; private set => Set(ref _showProcesses, value); }
    public bool ShowServices { get => _showServices; private set => Set(ref _showServices, value); }
    /// <summary>facts 那一行（内核 / CPU 型号 / 运行时长）—— 次要信息，矮窗口先丢它。</summary>
    public bool ShowFacts { get => _showFacts; private set => Set(ref _showFacts, value); }

    /// <summary>由 MainWindow 的 RootGrid.SizeChanged 调用。没跨过分层边界就什么都不做。</summary>
    public void Apply(double width, double height)
    {
        if (width <= 0 || height <= 0) return;

        var tier = width < NarrowThreshold ? LayoutTier.Narrow
                 : width > WideThreshold ? LayoutTier.Wide
                 : LayoutTier.Normal;

        bool tall = height >= ShortThreshold;
        bool tiny = height < TinyThreshold;
        bool hidden = height < MetricsHiddenThreshold;

        // 分层 + 三个高度档位，全都没变就直接返回（SizeChanged 在拖动时会疯狂触发）。
        if (_initialized && tier == Tier && tall == !IsShort && tiny == _tiny && hidden == _metricsHidden) return;

        Tier = tier;
        IsShort = !tall;
        _tiny = tiny;
        _metricsHidden = hidden;
        _initialized = true;

        Raise(nameof(Tier));
        Raise(nameof(IsShort));
        Recompute();
    }

    private bool _tiny;
    private bool _metricsHidden;

    private void Recompute()
    {
        switch (Tier)
        {
            case LayoutTier.Narrow:
                TitleBarHeight = 34;
                ButtonWidth = 27;
                ButtonHeight = 25;
                ButtonIconSize = 10;
                ButtonSpacing = 1;
                // 窄档先把标题字去掉：系统那三个按钮固定占掉约 140 DIP，
                // 这点宽度必须让给按键，否则按键会被挤出去。
                AppTitleVisibility = Visibility.Collapsed;
                TitleText = "远程面板";

                TitleFontSize = 11.5;
                BodyFontSize = 10.5;
                SmallFontSize = 9.5;
                MonoFontSize = 10;
                BadgeFontSize = 9;

                CardPadding = new Thickness(8, 7, 8, 7);
                CardMargin = new Thickness(0, 0, 0, 6);
                InnerPadding = new Thickness(7, 6, 7, 6);
                ScrollPadding = new Thickness(8, 0, 8, 8);
                CardSpacing = 6;
                SectionSpacing = 4;

                BarHeight = 4;
                DiskValueMinWidth = 128;
                MetricLabelWidth = 40;
                TitleGlyphMargin = new Thickness(8, 0, 6, 0);
                StatusBarPadding = new Thickness(8, 5, 8, 5);
                ProcPidWidth = 40;
                ProcCpuWidth = 42;
                ProcUserWidth = 44;
                RowHeight = 16;
                StatusDotSize = 8;
                HeaderMargin = new Thickness(8, 0, 8, 6);

                DiskRows = 2;
                GpuRows = 1;
                ProcessRows = 3;
                ServiceRows = 2;
                break;

            case LayoutTier.Wide:
                TitleBarHeight = 44;
                ButtonWidth = 34;
                ButtonHeight = 31;
                ButtonIconSize = 13;
                ButtonSpacing = 3;
                AppTitleVisibility = Visibility.Visible;
                TitleText = "远程目标面板";

                TitleFontSize = 13.5;
                BodyFontSize = 12;
                SmallFontSize = 11;
                MonoFontSize = 12;
                BadgeFontSize = 11;

                CardPadding = new Thickness(12, 12, 12, 12);
                CardMargin = new Thickness(0, 0, 0, 10);
                InnerPadding = new Thickness(11, 9, 11, 9);
                ScrollPadding = new Thickness(12, 0, 12, 12);
                CardSpacing = 11;
                SectionSpacing = 6;

                BarHeight = 6;
                DiskValueMinWidth = 178;
                MetricLabelWidth = 54;
                TitleGlyphMargin = new Thickness(14, 0, 10, 0);
                StatusBarPadding = new Thickness(14, 7, 14, 7);
                ProcPidWidth = 54;
                ProcCpuWidth = 54;
                ProcUserWidth = 68;
                RowHeight = 20;
                StatusDotSize = 9;
                HeaderMargin = new Thickness(12, 0, 12, 10);

                DiskRows = 8;
                GpuRows = 4;
                ProcessRows = 8;
                ServiceRows = 6;
                break;

            default: // Normal
                TitleBarHeight = 40;
                ButtonWidth = 30;
                ButtonHeight = 28;
                ButtonIconSize = 12;
                ButtonSpacing = 2;
                AppTitleVisibility = Visibility.Visible;
                TitleText = "远程目标面板";

                TitleFontSize = 12.5;
                BodyFontSize = 11;
                SmallFontSize = 10.5;
                MonoFontSize = 11;
                BadgeFontSize = 10;

                CardPadding = new Thickness(10, 10, 10, 10);
                CardMargin = new Thickness(0, 0, 0, 8);
                InnerPadding = new Thickness(9, 7, 9, 7);
                ScrollPadding = new Thickness(10, 0, 10, 10);
                CardSpacing = 9;
                SectionSpacing = 5;

                BarHeight = 5;
                DiskValueMinWidth = 150;
                MetricLabelWidth = 46;
                TitleGlyphMargin = new Thickness(12, 0, 8, 0);
                StatusBarPadding = new Thickness(12, 6, 12, 6);
                ProcPidWidth = 46;
                ProcCpuWidth = 46;
                ProcUserWidth = 56;
                RowHeight = 18;
                StatusDotSize = 8;
                HeaderMargin = new Thickness(10, 0, 10, 8);

                DiskRows = 4;
                GpuRows = 2;
                ProcessRows = 5;
                ServiceRows = 4;
                break;
        }

        // 矮窗口逐层降级。窗口被压扁时，留下的必须仍然是
        // 「哪个目标挂了 / 哪台机器快撑不住了」这个最核心的信息。
        ShowMetrics = true;
        ShowDisks = true;
        ShowGpus = true;
        ShowDocker = true;
        ShowProcesses = true;
        ShowServices = true;
        ShowFacts = true;

        if (IsShort)
        {
            // 第一层：丢掉「明细」（进程、容器、服务），它们行数最多、也最不紧急。
            ShowProcesses = false;
            ShowDocker = false;
            ShowServices = false;
            ProcessRows = Math.Min(ProcessRows, 3);
        }

        if (_tiny)
        {
            // 第二层：只留 CPU 与内存这两个一眼能判断的数字。
            ShowDisks = false;
            ShowGpus = false;
            ShowFacts = false;
        }

        if (_metricsHidden)
        {
            // 第三层：整块指标收起，只剩状态行 —— 但卡片本身还在，名字和状态永远看得见。
            ShowMetrics = false;
        }
    }
}


