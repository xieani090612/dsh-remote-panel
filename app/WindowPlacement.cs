using System.IO;
using System.Text.Json;

namespace DshWsxPanel;

/// <summary>
/// 窗口位置/大小与几个开关的持久化。
///
/// 首选位置是需求指定的 <c>%LOCALAPPDATA%\DshWsxPanel\window.json</c>。
/// 但那个目录**不保证可写**（实测过：某些受限/沙箱化的运行环境里，面板进程对
/// <c>%LOCALAPPDATA%</c> 的写入会被拒绝，而同一台机器上的 shell 却能写）。
/// 所以这里先探测首选项，写不进去才退到 exe 旁边，并把用了哪一条记进日志 ——
/// 「位置记忆静默失效」是最难查的一类 bug，宁可留一条痕迹。
///
/// 单位统一是 **DIP（有效像素）**，不是物理像素：XAML 布局和尺寸分层判断都用 DIP，
/// 存成 DIP 才能在不同 DPI 的显示器之间保持「看起来一样大」。
/// 换算成物理像素只发生在调用 AppWindow 的那一处（见 MainWindow.Scale）。
/// </summary>
public sealed class WindowPlacement
{
    public int X { get; set; } = -1;
    public int Y { get; set; } = -1;
    public int Width { get; set; } = DefaultWidth;
    public int Height { get; set; } = DefaultHeight;
    public bool Topmost { get; set; } = true;
    public bool Compact { get; set; }
    /// <summary>"System" | "Light" | "Dark"</summary>
    public string Theme { get; set; } = "System";

    /// <summary>默认窗口尺寸（DIP）。440 宽落在标准档；620 高在 125% 缩放的 1080p 上也放得下。</summary>
    public const int DefaultWidth = 440;
    public const int DefaultHeight = 620;

    /// <summary>最小尺寸（DIP）。要允许用户真的走到「窄」和「矮」两个降级档。</summary>
    public const int MinWidth = 380;
    public const int MinHeight = 320;

    /// <summary>需求指定的正式位置。</summary>
    public static string PrimaryPath => Path.Combine(Log.LocalAppDataFolder(), "DshWsxPanel", "window.json");

    /// <summary>首选目录不可写时的退路（exe 旁边）。</summary>
    public static string FallbackPath => Path.Combine(AppContext.BaseDirectory, "window.json");

    /// <summary>
    /// 第三条候选：状态文件旁边（<c>$DSH_HOME\remote-panel\window.json</c>）。
    ///
    /// 这条不是凑数 —— 它是目前**最可靠**的一条：面板既然能读到同目录下的
    /// <c>state.json</c>，就说明这个目录对它可读；而它由宿主插件创建，权限正常。
    /// 相比之下 exe 旁边那条落在 <c>dist\</c>，是构建产物，每次重新发布都会被顶掉。
    /// 顺序把这条排在 exe 旁边**之前**，就是为了让设置活过一次重新构建。
    /// </summary>
    public static string StateDirPath
    {
        get
        {
            try
            {
                string state = App.Options.StatePath;
                string? dir = Path.GetDirectoryName(state);
                if (!string.IsNullOrWhiteSpace(dir)) return Path.Combine(dir, "window.json");
            }
            catch
            {
                // 状态路径解析失败就跳过这条候选。
            }
            return Path.Combine(Path.GetTempPath(), "DshWsxPanel", "window.json");
        }
    }

    /// <summary>
    /// 按优先级排列的候选路径。读取取第一个**含有效内容**的，写入写进所有可写的。
    ///
    /// 顺序是实测倒推出来的，不是照文档抄的。关键约束：
    /// **读取顺序里不能有一个「读得到但永远写不进」的路径排在前面** ——
    /// 那会让它永远是一份陈旧副本，并且每次启动都盖掉真正最新的那一份。
    ///
    /// 实测（面板进程内）：<c>%LOCALAPPDATA%\DshWsxPanel</c> 与 <c>%TEMP%</c>
    /// 的写入都会被拒（UnauthorizedAccessException，同一用户在 shell 里却能写），
    /// 只有**工作区内的 exe 旁边**写得进去。而 <c>%LOCALAPPDATA%</c> 里那份是
    /// 早先某次运行留下的旧值 —— 它排在前面时，就会出现
    /// 「拖动窗口 → 关掉 → 再打开又回到旧位置」。
    ///
    /// 所以把可写的放前面：
    ///   1. exe 旁边（实测唯一稳定可写；重新构建会顶掉，故有 2）
    ///   2. 状态文件旁边（宿主同目录，权限正常；同样持久）
    ///   3. %LOCALAPPDATA%（按需求保留，受限环境下只读也不影响前两条）
    /// </summary>
    private static IEnumerable<string> Candidates()
    {
        yield return FallbackPath;
        yield return StateDirPath;
        yield return PrimaryPath;
    }

    /// <summary>给 --dump-status 用的诊断：每条候选路径各自能不能写。</summary>
    public static string ProbeWritable()
    {
        var parts = new List<string>();
        foreach (string candidate in Candidates())
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(candidate)!);
                using (new FileStream(candidate, FileMode.OpenOrCreate, FileAccess.Write, FileShare.ReadWrite)) { }
                parts.Add($"{candidate} = ok");
            }
            catch (Exception ex)
            {
                parts.Add($"{candidate} = {ex.GetType().Name}: {ex.Message}");
            }
        }
        return string.Join(" | ", parts);
    }

    /// <summary>当前实际使用的路径（诊断/展示用）。</summary>
    public static string FilePath
    {
        get
        {
            foreach (string candidate in Candidates())
            {
                try { if (File.Exists(candidate)) return candidate; } catch { /* ignore */ }
            }
            return PrimaryPath;
        }
    }

    public static WindowPlacement Load()
    {
        // 读第一个存在的候选。只读，不创建、不写。
        foreach (string candidate in Candidates())
        {
            try
            {
                if (!File.Exists(candidate)) continue;
                string json = File.ReadAllText(candidate);
                var loaded = JsonSerializer.Deserialize<WindowPlacement>(json);
                if (loaded is null) continue;

                loaded.Width = Math.Clamp(loaded.Width, MinWidth, 4000);
                loaded.Height = Math.Clamp(loaded.Height, MinHeight, 4000);
                Log.Write($"读到窗口位置：{candidate}");
                return loaded;
            }
            catch (Exception ex)
            {
                Log.Write($"读取窗口位置失败（{candidate}）：{ex.GetType().Name}: {ex.Message}");
            }
        }

        // 配置损坏就回到默认值，绝不能因此打不开窗口。
        return new WindowPlacement();
    }

    /// <summary>
    /// 保存到**所有**可写的候选路径。
    ///
    /// 为什么不是「写到第一个可写的那条」：两条候选的可写性在这台机器上**并不稳定** ——
    /// 实测面板进程对 <c>%LOCALAPPDATA%\DshWsxPanel</c> 的写入会被拒
    /// （UnauthorizedAccessException，而同一个用户在 shell 里却能写），于是退路变成
    /// exe 旁边的 <c>dist\window.json</c>。而 <c>dist\</c> 是构建产物，**每次
    /// build.ps1 -Pack 都会被覆盖重建**，记住的设置就这么被清掉了。
    ///
    /// 写多份的收益：只要有一条候选活下来，设置就不会丢；读取侧按同样的优先级取
    /// 「第一个存在的」，于是数据来源与写入目标天然一致，也不会出现
    /// 「从一个文件读、往另一个文件写」的分裂。
    /// 代价只是多写一个几百字节的小 JSON —— 对「设置能不能记住」这个体验完全不值一提。
    /// </summary>
    public void Save()
    {
        string payload;
        try
        {
            payload = JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true });
        }
        catch (Exception ex)
        {
            Log.Write($"序列化窗口位置失败：{ex.GetType().Name}: {ex.Message}");
            return;
        }

        int written = 0;
        foreach (string candidate in Candidates())
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(candidate)!);
                // 原子替换：临时文件 + 覆盖式 move，避免读者看到半截 JSON，
                // 也避免「写到一半进程没了」留下一个解析不了的文件。
                string tmp = candidate + ".tmp";
                File.WriteAllText(tmp, payload);
                File.Move(tmp, candidate, overwrite: true);
                written++;
                Log.Write($"窗口位置已写入：{candidate}");
            }
            catch (Exception ex)
            {
                Log.Write($"保存窗口位置失败（{candidate}）：{ex.GetType().Name}: {ex.Message}");
            }
        }

        if (written == 0) Log.Write("保存窗口位置失败：没有任何一条候选路径可写（设置将无法记住）");
    }
}
